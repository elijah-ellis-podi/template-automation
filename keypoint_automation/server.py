"""
FastAPI server exposing keypoint detection models for the web demo.

Endpoints
---------
POST /predict
  Body: { "thermogram": [[...]], "side": "left" | "right" | "both",
          "models": ["geometric", "claude", "ensemble"] }
  Returns per-model keypoint predictions.

POST /build-template
  Body: { "patient_id": "...", "scan_ids": [...],
          "thermograms": [{"scan_id": "...", "thermogram": [[...]]}] }
  Builds a template from raw scans and returns auto-placed keypoints.

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
# ── Add handoff/src/ to path (template builder + validator) ──
sys.path.insert(0, str(pathlib.Path(__file__).parent.parent / 'handoff' / 'src'))

from data_loader import KEYPOINT_NAMES
import geometric_keypoints
import claude_keypoints
import notebook_model
from template_builder import build_patient_template_and_keypoints, TemplateAndKeypoints
from anatomical_validator import validate as anatomical_validate

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
    confidence: Optional[float] = None


class ImageClassification(BaseModel):
    foot_count: Optional[str] = None
    detected_feet: Optional[list[str]] = None
    anomalies: Optional[str] = None


class ModelResult(BaseModel):
    model: str
    side: str
    keypoints: list[KeypointCoord]
    error: Optional[str] = None
    image_classification: Optional[ImageClassification] = None


class PredictResponse(BaseModel):
    results: list[ModelResult]


def _coords_to_keypoints(coords: np.ndarray, confidences: Optional[dict] = None) -> list[KeypointCoord]:
    """Convert (6,2) numpy array to list of KeypointCoord.
    confidences: optional dict mapping keypoint name to float confidence."""
    out = []
    for i, name in enumerate(KEYPOINT_NAMES):
        x, y = coords[i]
        conf = confidences.get(name) if confidences else None
        if np.isnan(x) or np.isnan(y):
            out.append(KeypointCoord(name=name, x=None, y=None, confidence=conf))
        else:
            out.append(KeypointCoord(name=name, x=round(float(x), 5), y=round(float(y), 5), confidence=conf))
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
        raw_result = claude_keypoints.predict_keypoints_full(thermo, side, client=client)

        # New format: { image_classification: {...}, feet: { left: {...}, right: {...} } }
        if isinstance(raw_result, dict) and 'feet' in raw_result:
            feet_data = raw_result.get('feet', {})
            foot_data = feet_data.get(side, {})
            img_class_raw = raw_result.get('image_classification')

            img_class = None
            if img_class_raw:
                img_class = ImageClassification(
                    foot_count=img_class_raw.get('foot_count'),
                    detected_feet=img_class_raw.get('detected_feet'),
                    anomalies=img_class_raw.get('anomalies'),
                )

            kps = []
            confidences = {}
            coords = np.full((len(KEYPOINT_NAMES), 2), np.nan)
            for i, name in enumerate(KEYPOINT_NAMES):
                entry = foot_data.get(name)
                if entry is not None and 'x' in entry and 'y' in entry:
                    coords[i] = [entry['x'], entry['y']]
                    if 'confidence' in entry:
                        confidences[name] = entry['confidence']

            return ModelResult(
                model='claude', side=side,
                keypoints=_coords_to_keypoints(coords, confidences),
                image_classification=img_class,
            )

        # Legacy format: (6,2) numpy array
        if isinstance(raw_result, np.ndarray):
            return ModelResult(model='claude', side=side, keypoints=_coords_to_keypoints(raw_result))

        return ModelResult(model='claude', side=side, keypoints=[], error='Unexpected response format')
    except Exception as e:
        # Fallback to old API if predict_keypoints_full doesn't exist
        try:
            coords = claude_keypoints.predict_keypoints(thermo, side, client=client)
            return ModelResult(model='claude', side=side, keypoints=_coords_to_keypoints(coords))
        except Exception as e2:
            return ModelResult(model='claude', side=side, keypoints=[], error=str(e2))


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
    return {
        'status': 'ok',
        'anthropic_key_set': has_key,
        'models': ['geometric', 'claude', 'ensemble'],
        'template_builder_available': True,
    }


# ══════════════════════════════════════════════════════════════
# POST /build-template — Build template + auto-place keypoints
# ══════════════════════════════════════════════════════════════

class ThermogramInput(BaseModel):
    scan_id: str
    thermogram: list[list[float]]


class BuildTemplateRequest(BaseModel):
    patient_id: str
    scan_ids: list[str]
    thermograms: list[ThermogramInput]
    model: str = Field(default='notebook', pattern='^(notebook|geometric|supervised)$')


class BuildKeypointCoord(BaseModel):
    name: str
    x: Optional[float] = None
    y: Optional[float] = None
    confidence: Optional[float] = None


class ValidationInfo(BaseModel):
    overall_score: float
    violations: list[str]


class BuildTemplateResponse(BaseModel):
    left_template: Optional[list[list[float]]] = None
    right_template: Optional[list[list[float]]] = None
    left_keypoints: Optional[list[BuildKeypointCoord]] = None
    right_keypoints: Optional[list[BuildKeypointCoord]] = None
    left_validation: Optional[ValidationInfo] = None
    right_validation: Optional[ValidationInfo] = None
    foot_count: str  # 'single' | 'pair'
    detected_feet: list[str]
    quality_score: float
    earliest_scan_id: Optional[str] = None
    n_scans_used: int = 0
    model_used: str = 'notebook'
    error: Optional[str] = None


def _ndarray_to_keypoints(coords: np.ndarray, validation=None) -> list[BuildKeypointCoord]:
    """Convert (6,2) array to list of BuildKeypointCoord with optional validation scores."""
    out = []
    for i, name in enumerate(KEYPOINT_NAMES):
        x, y = coords[i]
        conf = None
        if validation is not None:
            # Use per-keypoint anatomical validation score as confidence proxy
            conf = round(float(validation.per_keypoint_scores[i]), 3)
        if np.isnan(x) or np.isnan(y):
            out.append(BuildKeypointCoord(name=name, x=None, y=None, confidence=conf))
        else:
            out.append(BuildKeypointCoord(name=name, x=round(float(x), 5), y=round(float(y), 5), confidence=conf))
    return out


@app.post('/build-template', response_model=BuildTemplateResponse)
async def build_template_endpoint(req: BuildTemplateRequest):
    import logging
    log = logging.getLogger('build-template')

    log.info(f'=== /build-template request ===')
    log.info(f'  patient_id: {req.patient_id}')
    log.info(f'  scan_ids: {len(req.scan_ids)} scans')
    log.info(f'  thermograms: {len(req.thermograms)} provided')
    log.info(f'  model: {req.model}')

    if not req.thermograms:
        raise HTTPException(400, 'No thermograms provided')

    # Convert thermograms to numpy arrays
    mat_thermograms = []
    for i, t in enumerate(req.thermograms):
        try:
            arr = np.array(t.thermogram, dtype=np.float32)
            if arr.ndim == 2 and arr.size > 0:
                mat_thermograms.append(arr)
                log.info(f'  thermogram[{i}] ({t.scan_id[:20]}...): shape={arr.shape}, '
                         f'min={arr.min():.2f}, max={arr.max():.2f}')
            else:
                log.warning(f'  thermogram[{i}] ({t.scan_id[:20]}...): invalid shape {arr.shape}, skipped')
        except Exception as e:
            log.warning(f'  thermogram[{i}]: conversion failed ({e}), skipped')

    if len(mat_thermograms) == 0:
        raise HTTPException(400, 'No valid thermograms in request')

    log.info(f'  {len(mat_thermograms)} valid thermograms after filtering')
    earliest_scan_id = req.scan_ids[-1] if req.scan_ids else None

    # ── Build template using brannock + handoff pipeline ──
    log.info(f'  calling build_patient_template_and_keypoints(model={req.model})...')
    try:
        result: TemplateAndKeypoints = build_patient_template_and_keypoints(
            mat_thermograms, model=req.model
        )
    except Exception as e:
        import traceback
        log.error(f'  build_patient_template_and_keypoints FAILED: {type(e).__name__}: {e}')
        log.error(traceback.format_exc())
        return BuildTemplateResponse(
            foot_count='pair', detected_feet=[], quality_score=0,
            error=f'Template build failed: {type(e).__name__}: {e}', model_used=req.model
        )

    log.info(f'  build result: left_template={"None" if result.left_template is None else result.left_template.shape}, '
             f'right_template={"None" if result.right_template is None else result.right_template.shape}, '
             f'n_scans_used={result.n_scans_used}, single_foot_side={result.single_foot_side}')

    if result.left_template is None and result.right_template is None:
        log.warning('  both templates are None — returning error')
        return BuildTemplateResponse(
            foot_count='pair', detected_feet=[], quality_score=0,
            n_scans_used=result.n_scans_used,
            error='Could not build template — not enough matching scans',
            model_used=req.model
        )

    # Determine feet configuration
    detected_feet = []
    if result.left_template is not None:
        detected_feet.append('left')
    if result.right_template is not None:
        detected_feet.append('right')
    foot_count = 'pair' if len(detected_feet) == 2 else 'single'

    # Run anatomical validation on each side
    left_val = None
    right_val = None
    quality_scores = []

    if result.left_keypoints is not None:
        try:
            left_val = anatomical_validate(result.left_keypoints, 'left', template=result.left_template)
            quality_scores.append(left_val.overall_score)
        except Exception:
            pass

    if result.right_keypoints is not None:
        try:
            right_val = anatomical_validate(result.right_keypoints, 'right', template=result.right_template)
            quality_scores.append(right_val.overall_score)
        except Exception:
            pass

    quality_score = float(np.mean(quality_scores)) if quality_scores else 0.0

    return BuildTemplateResponse(
        left_template=result.left_template.tolist() if result.left_template is not None else None,
        right_template=result.right_template.tolist() if result.right_template is not None else None,
        left_keypoints=_ndarray_to_keypoints(result.left_keypoints, left_val) if result.left_keypoints is not None else None,
        right_keypoints=_ndarray_to_keypoints(result.right_keypoints, right_val) if result.right_keypoints is not None else None,
        left_validation=ValidationInfo(
            overall_score=round(left_val.overall_score, 3),
            violations=left_val.violations
        ) if left_val else None,
        right_validation=ValidationInfo(
            overall_score=round(right_val.overall_score, 3),
            violations=right_val.violations
        ) if right_val else None,
        foot_count=foot_count,
        detected_feet=detected_feet,
        quality_score=round(quality_score, 3),
        earliest_scan_id=earliest_scan_id,
        n_scans_used=result.n_scans_used,
        model_used=req.model,
    )
