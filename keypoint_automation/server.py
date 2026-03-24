"""
FastAPI server exposing keypoint detection models for the web demo.

Endpoints
---------
POST /predict
  Body: { "thermogram": [[...]], "side": "left" | "right" | "both",
          "models": ["geometric", "claude", "ensemble"] }
  Returns per-model keypoint predictions.

GET /health
  Returns { "status": "ok" }

Usage
-----
  cd keypoint_automation
  pip install -r requirements.txt
  pip install fastapi uvicorn
  ANTHROPIC_API_KEY=... uvicorn server:app --port 8787 --reload
"""

import os
import sys
import pathlib
import json
from typing import Optional

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

# ── Add src/ to path ──
sys.path.insert(0, str(pathlib.Path(__file__).parent / 'src'))

from data_loader import KEYPOINT_NAMES
import geometric_keypoints
import claude_keypoints

app = FastAPI(title='Keypoint Detection API', version='0.1.0')

# Allow the Vite dev server and any local origin
app.add_middleware(
    CORSMiddleware,
    allow_origins=['http://localhost:5173', 'http://localhost:3000', '*'],
    allow_credentials=True,
    allow_methods=['*'],
    allow_headers=['*'],
)

# ── Anthropic client (lazy init) ──
_anthropic_client = None

def _get_anthropic_client():
    global _anthropic_client
    if _anthropic_client is None:
        try:
            import anthropic
            _anthropic_client = anthropic.Anthropic()
        except Exception as e:
            print(f'Warning: Anthropic client init failed: {e}')
            return None
    return _anthropic_client


# ── Request / Response models ──
class PredictRequest(BaseModel):
    thermogram: list[list[float]]
    side: str = Field(default='both', pattern='^(left|right|both)$')
    models: list[str] = Field(default=['geometric', 'claude', 'ensemble'])


class KeypointCoord(BaseModel):
    name: str
    x: Optional[float] = None
    y: Optional[float] = None


class ModelResult(BaseModel):
    model: str
    side: str
    keypoints: list[KeypointCoord]
    error: Optional[str] = None


class PredictResponse(BaseModel):
    results: list[ModelResult]


def _coords_to_keypoints(coords: np.ndarray) -> list[KeypointCoord]:
    """Convert (6,2) numpy array to list of KeypointCoord."""
    out = []
    for i, name in enumerate(KEYPOINT_NAMES):
        x, y = coords[i]
        if np.isnan(x) or np.isnan(y):
            out.append(KeypointCoord(name=name, x=None, y=None))
        else:
            out.append(KeypointCoord(name=name, x=round(float(x), 5), y=round(float(y), 5)))
    return out


def _split_thermogram(thermo: np.ndarray) -> dict[str, np.ndarray]:
    """
    Split a full mat thermogram (both feet) into left/right halves.
    Left foot is the right half of the image, right foot is the left half.
    """
    H, W = thermo.shape
    mid = W // 2
    return {
        'right': thermo[:, :mid],
        'left': thermo[:, mid:],
    }


def _run_geometric(thermo: np.ndarray, side: str) -> ModelResult:
    try:
        coords = geometric_keypoints.estimate_keypoints(thermo, side)
        return ModelResult(model='geometric', side=side, keypoints=_coords_to_keypoints(coords))
    except Exception as e:
        return ModelResult(model='geometric', side=side, keypoints=[], error=str(e))


def _run_claude(thermo: np.ndarray, side: str) -> ModelResult:
    client = _get_anthropic_client()
    if client is None:
        return ModelResult(model='claude', side=side, keypoints=[],
                          error='ANTHROPIC_API_KEY not set or client init failed')
    try:
        coords = claude_keypoints.predict_keypoints(thermo, side, client=client)
        return ModelResult(model='claude', side=side, keypoints=_coords_to_keypoints(coords))
    except Exception as e:
        return ModelResult(model='claude', side=side, keypoints=[], error=str(e))


def _run_ensemble(thermo: np.ndarray, side: str) -> ModelResult:
    """Geometric + Claude averaged (NaN-safe)."""
    client = _get_anthropic_client()

    geo_coords = geometric_keypoints.estimate_keypoints(thermo, side)

    if client is not None:
        try:
            claude_coords = claude_keypoints.predict_keypoints(thermo, side, client=client)
        except Exception:
            claude_coords = np.full((6, 2), np.nan)
    else:
        claude_coords = np.full((6, 2), np.nan)

    stacked = np.stack([geo_coords, claude_coords], axis=0)
    ensemble = np.nanmean(stacked, axis=0)

    return ModelResult(model='ensemble', side=side, keypoints=_coords_to_keypoints(ensemble))


@app.post('/predict', response_model=PredictResponse)
async def predict(req: PredictRequest):
    try:
        thermo = np.array(req.thermogram, dtype=np.float32)
    except Exception:
        raise HTTPException(400, 'Invalid thermogram data')

    if thermo.ndim != 2 or thermo.size == 0:
        raise HTTPException(400, f'Thermogram must be a 2D array, got shape {thermo.shape}')

    # Determine which sides to process
    if req.side == 'both':
        halves = _split_thermogram(thermo)
        sides_to_run = ['left', 'right']
    else:
        halves = {req.side: thermo}
        sides_to_run = [req.side]

    results: list[ModelResult] = []

    for side in sides_to_run:
        foot = halves[side]
        for model_name in req.models:
            if model_name == 'geometric':
                results.append(_run_geometric(foot, side))
            elif model_name == 'claude':
                results.append(_run_claude(foot, side))
            elif model_name == 'ensemble':
                results.append(_run_ensemble(foot, side))
            else:
                results.append(ModelResult(model=model_name, side=side, keypoints=[],
                                          error=f'Unknown model: {model_name}'))

    return PredictResponse(results=results)


@app.get('/health')
async def health():
    has_key = bool(os.environ.get('ANTHROPIC_API_KEY'))
    return {'status': 'ok', 'anthropic_key_set': has_key, 'models': ['geometric', 'claude', 'ensemble']}
