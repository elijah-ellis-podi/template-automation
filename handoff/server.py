"""
Template Builder API — v2

Clean server backed entirely by the handoff pipeline:
  template_builder → notebook_model → anatomical_validator

Endpoints
---------
POST /build-template
  Accepts raw mat thermograms, builds a template, predicts keypoints,
  validates anatomy. Returns template arrays + keypoint coords + validation.

GET /health
  Status check.

Usage
-----
  cd handoff
  pip install fastapi uvicorn
  uvicorn server:app --port 8787 --reload
"""

import logging
import sys
import pathlib
from typing import Optional

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

# ── Set up imports ──
# handoff/src has template_builder, anatomical_validator, notebook_model, etc.
# keypoint_automation/src has data_loader, geometric_keypoints, supervised_keypoints
sys.path.insert(0, str(pathlib.Path(__file__).parent / 'src'))
sys.path.insert(0, str(pathlib.Path(__file__).parent.parent / 'keypoint_automation' / 'src'))

from data_loader import KEYPOINT_NAMES
from template_builder import (
    build_patient_template_and_keypoints,
    TemplateAndKeypoints,
    MODELS,
)
from anatomical_validator import validate as anatomical_validate

logging.basicConfig(level=logging.INFO, format='%(name)s %(levelname)s: %(message)s')
log = logging.getLogger('server')

app = FastAPI(title='Template Builder API', version='2.0.0')

app.add_middleware(
    CORSMiddleware,
    allow_origins=['*'],
    allow_credentials=True,
    allow_methods=['*'],
    allow_headers=['*'],
)


# ══════════════════════════════════════════════════════════════
# Request / Response models
# ══════════════════════════════════════════════════════════════

class ThermogramInput(BaseModel):
    scan_id: str
    thermogram: list[list[float]]


class BuildTemplateRequest(BaseModel):
    patient_id: str
    scan_ids: list[str] = []
    thermograms: list[ThermogramInput]
    model: str = Field(default='notebook', pattern='^(notebook|geometric|supervised)$')


class KeypointCoord(BaseModel):
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
    left_keypoints: Optional[list[KeypointCoord]] = None
    right_keypoints: Optional[list[KeypointCoord]] = None
    left_validation: Optional[ValidationInfo] = None
    right_validation: Optional[ValidationInfo] = None
    foot_count: str = 'pair'
    detected_feet: list[str] = []
    quality_score: float = 0.0
    earliest_scan_id: Optional[str] = None
    n_scans_used: int = 0
    model_used: str = 'notebook'
    error: Optional[str] = None


# ══════════════════════════════════════════════════════════════
# Helpers
# ══════════════════════════════════════════════════════════════

def _to_keypoint_list(
    coords: np.ndarray,
    validation=None,
) -> list[KeypointCoord]:
    """Convert (6,2) numpy array to response keypoints."""
    out = []
    for i, name in enumerate(KEYPOINT_NAMES):
        x, y = coords[i]
        conf = None
        if validation is not None:
            conf = round(float(validation.per_keypoint_scores[i]), 3)
        if np.isnan(x) or np.isnan(y):
            out.append(KeypointCoord(name=name, x=None, y=None, confidence=conf))
        else:
            out.append(KeypointCoord(name=name, x=round(float(x), 5), y=round(float(y), 5), confidence=conf))
    return out


# ══════════════════════════════════════════════════════════════
# POST /build-template
# ══════════════════════════════════════════════════════════════

@app.post('/build-template', response_model=BuildTemplateResponse)
async def build_template(req: BuildTemplateRequest):
    log.info(f'=== /build-template ===')
    log.info(f'  patient_id={req.patient_id}, model={req.model}, '
             f'{len(req.thermograms)} thermogram(s)')

    if not req.thermograms:
        raise HTTPException(400, 'No thermograms provided')

    # Parse thermograms
    mat_thermograms: list[np.ndarray] = []
    for i, t in enumerate(req.thermograms):
        try:
            arr = np.array(t.thermogram, dtype=np.float32)
            if arr.ndim == 2 and arr.size > 0:
                mat_thermograms.append(arr)
                log.info(f'  [{i}] {t.scan_id[:20]}… shape={arr.shape} '
                         f'min={arr.min():.1f} max={arr.max():.1f}')
            else:
                log.warning(f'  [{i}] skipped — bad shape {arr.shape}')
        except Exception as e:
            log.warning(f'  [{i}] skipped — {e}')

    if not mat_thermograms:
        raise HTTPException(400, 'No valid thermograms after parsing')

    earliest_scan_id = req.scan_ids[-1] if req.scan_ids else None

    # ── Build ──
    log.info(f'  building template (model={req.model}, {len(mat_thermograms)} scans)…')
    try:
        result: TemplateAndKeypoints = build_patient_template_and_keypoints(
            mat_thermograms, model=req.model
        )
    except Exception as e:
        import traceback
        log.error(f'  BUILD FAILED: {e}')
        log.error(traceback.format_exc())
        return BuildTemplateResponse(
            error=f'Template build failed: {type(e).__name__}: {e}',
            model_used=req.model,
        )

    log.info(f'  result: left={"None" if result.left_template is None else result.left_template.shape}, '
             f'right={"None" if result.right_template is None else result.right_template.shape}, '
             f'n_scans={result.n_scans_used}')

    if result.left_template is None and result.right_template is None:
        return BuildTemplateResponse(
            n_scans_used=result.n_scans_used,
            error='Could not build template — not enough matching scans',
            model_used=req.model,
        )

    # ── Feet config ──
    detected_feet: list[str] = []
    if result.left_template is not None:
        detected_feet.append('left')
    if result.right_template is not None:
        detected_feet.append('right')
    foot_count = 'pair' if len(detected_feet) == 2 else 'single'

    # ── Validate ──
    left_val = None
    right_val = None
    quality_scores: list[float] = []

    if result.left_keypoints is not None:
        try:
            left_val = anatomical_validate(result.left_keypoints, 'left', template=result.left_template)
            quality_scores.append(left_val.overall_score)
            log.info(f'  left validation: {left_val.overall_score:.3f} '
                     f'({len(left_val.violations)} violations)')
        except Exception as e:
            log.warning(f'  left validation failed: {e}')

    if result.right_keypoints is not None:
        try:
            right_val = anatomical_validate(result.right_keypoints, 'right', template=result.right_template)
            quality_scores.append(right_val.overall_score)
            log.info(f'  right validation: {right_val.overall_score:.3f} '
                     f'({len(right_val.violations)} violations)')
        except Exception as e:
            log.warning(f'  right validation failed: {e}')

    quality_score = float(np.mean(quality_scores)) if quality_scores else 0.0
    log.info(f'  quality_score={quality_score:.3f}, foot_count={foot_count}')

    return BuildTemplateResponse(
        left_template=result.left_template.tolist() if result.left_template is not None else None,
        right_template=result.right_template.tolist() if result.right_template is not None else None,
        left_keypoints=_to_keypoint_list(result.left_keypoints, left_val) if result.left_keypoints is not None else None,
        right_keypoints=_to_keypoint_list(result.right_keypoints, right_val) if result.right_keypoints is not None else None,
        left_validation=ValidationInfo(
            overall_score=round(left_val.overall_score, 3),
            violations=left_val.violations,
        ) if left_val else None,
        right_validation=ValidationInfo(
            overall_score=round(right_val.overall_score, 3),
            violations=right_val.violations,
        ) if right_val else None,
        foot_count=foot_count,
        detected_feet=detected_feet,
        quality_score=round(quality_score, 3),
        earliest_scan_id=earliest_scan_id,
        n_scans_used=result.n_scans_used,
        model_used=req.model,
    )


# ══════════════════════════════════════════════════════════════
# GET /health
# ══════════════════════════════════════════════════════════════

@app.get('/health')
async def health():
    return {
        'status': 'ok',
        'version': '2.0.0',
        'models': list(MODELS),
        'keypoint_names': list(KEYPOINT_NAMES),
    }
