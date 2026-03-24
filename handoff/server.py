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

import json
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
        'patients': len(list(PATIENT_DATA_DIR.iterdir())) if PATIENT_DATA_DIR.exists() else 0,
    }


# ══════════════════════════════════════════════════════════════
# Patient & scan data from filesystem (patient_scan_data/)
# ══════════════════════════════════════════════════════════════

PATIENT_DATA_DIR = pathlib.Path(__file__).parent.parent / 'patient_scan_data'


@app.get('/patients')
async def list_patients():
    """List all patients from the local patient_scan_data directory."""
    if not PATIENT_DATA_DIR.exists():
        raise HTTPException(500, f'patient_scan_data directory not found at {PATIENT_DATA_DIR}')

    patients = []
    for d in sorted(PATIENT_DATA_DIR.iterdir()):
        if not d.is_dir():
            continue
        patient_json = d / 'patient.json'
        if patient_json.exists():
            with open(patient_json) as f:
                p = json.load(f)
            # Count scans
            scans_dir = d / 'scans'
            n_scans = len(list(scans_dir.glob('*_mat.json'))) if scans_dir.exists() else 0
            patients.append({
                'patient_id': p.get('patient_id', d.name),
                'patient_designation': p.get('patient_designation') or p.get('last_name', d.name),
                'n_scans': n_scans,
                'has_template': (d / 'template' / 'feet.json').exists(),
            })
        else:
            patients.append({
                'patient_id': d.name,
                'patient_designation': d.name[:12],
                'n_scans': 0,
                'has_template': False,
            })

    return {'patients': patients}


@app.get('/patients/{patient_id}')
async def get_patient(patient_id: str):
    """Get a single patient's info."""
    patient_dir = PATIENT_DATA_DIR / patient_id
    if not patient_dir.exists():
        raise HTTPException(404, f'Patient {patient_id} not found')

    patient_json = patient_dir / 'patient.json'
    if patient_json.exists():
        with open(patient_json) as f:
            p = json.load(f)
    else:
        p = {'patient_id': patient_id}

    scans_dir = patient_dir / 'scans'
    n_scans = len(list(scans_dir.glob('*_mat.json'))) if scans_dir.exists() else 0

    return {
        'patient_id': p.get('patient_id', patient_id),
        'patient_designation': p.get('patient_designation') or p.get('last_name', patient_id[:12]),
        'n_scans': n_scans,
        'has_template': (patient_dir / 'template' / 'feet.json').exists(),
    }


@app.get('/patients/{patient_id}/scans')
async def get_patient_scans(patient_id: str, max_scans: int = 15):
    """
    Return the most recent scans with their thermograms inline.
    This replaces two PADS API calls (scan list + thermogram fetch) in one response.
    """
    scans_dir = PATIENT_DATA_DIR / patient_id / 'scans'
    if not scans_dir.exists():
        return {'scans': []}

    # Pair scan + mat files, sorted newest first (filename starts with timestamp)
    mat_files = sorted(scans_dir.glob('*_mat.json'), reverse=True)

    scans = []
    for mat_file in mat_files[:max_scans]:
        prefix = mat_file.name.replace('_mat.json', '')
        scan_file = scans_dir / f'{prefix}_scan.json'

        # Load thermogram
        try:
            with open(mat_file) as f:
                mat_data = json.load(f)
            thermogram = mat_data.get('thermogram')
            if thermogram is None:
                continue
        except Exception:
            continue

        # Load scan metadata (optional)
        scan_meta = {}
        if scan_file.exists():
            try:
                with open(scan_file) as f:
                    raw = json.load(f)
                scan_meta = raw.get('scan', raw)
            except Exception:
                pass

        scans.append({
            'scan_id': scan_meta.get('scan_id', prefix),
            'when_scan_completed': scan_meta.get('when_scan_completed', ''),
            'scan_status': scan_meta.get('scan_status'),
            'thermogram': thermogram,
        })

    log.info(f'  /patients/{patient_id}/scans: {len(scans)} scans loaded')
    return {'scans': scans}


# ══════════════════════════════════════════════════════════════
# Review Queue — builds templates for all patients, caches results
# ══════════════════════════════════════════════════════════════

_review_cache: dict | None = None


def _load_thermograms(patient_id: str, max_scans: int = 15):
    """Load raw thermograms from filesystem."""
    scans_dir = PATIENT_DATA_DIR / patient_id / 'scans'
    if not scans_dir.exists():
        return []
    mat_files = sorted(scans_dir.glob('*_mat.json'), reverse=True)
    thermos = []
    for mf in mat_files[:max_scans]:
        try:
            with open(mf) as f:
                t = json.load(f).get('thermogram')
            if t:
                thermos.append(np.array(t, dtype=np.float32))
        except Exception:
            continue
    return thermos


def _build_review_queue():
    """Build templates for all patients and return review items."""
    global _review_cache
    if _review_cache is not None:
        return _review_cache

    log.info('=== Building review queue for all patients ===')
    items = []

    for d in sorted(PATIENT_DATA_DIR.iterdir()):
        if not d.is_dir() or d.name.startswith('.'):
            continue
        patient_id = d.name

        # Load patient info
        patient_json = d / 'patient.json'
        designation = patient_id[:12]
        if patient_json.exists():
            with open(patient_json) as f:
                p = json.load(f)
            designation = p.get('patient_designation') or p.get('last_name', designation)

        # Load thermograms
        thermos = _load_thermograms(patient_id)
        if len(thermos) == 0:
            log.info(f'  {designation}: no thermograms, skipping')
            continue

        log.info(f'  {designation}: {len(thermos)} scans, building...')

        # Build template
        try:
            result = build_patient_template_and_keypoints(thermos, model='notebook')
        except Exception as e:
            log.warning(f'  {designation}: build failed: {e}')
            continue

        if result.left_template is None and result.right_template is None:
            log.info(f'  {designation}: no template produced')
            continue

        # Validate each side
        for side in ['left', 'right']:
            template = getattr(result, f'{side}_template')
            kp_coords = getattr(result, f'{side}_keypoints')
            if template is None or kp_coords is None:
                continue

            try:
                val = anatomical_validate(kp_coords, side, template=template)
            except Exception:
                val = None

            score = val.overall_score if val else 0.5
            violations = val.violations if val else []
            tier = 'high' if score >= 0.9 else 'medium' if score >= 0.7 else 'low'

            # Build keypoint list
            kps = []
            for i, name in enumerate(KEYPOINT_NAMES):
                x, y = kp_coords[i]
                conf = round(float(val.per_keypoint_scores[i]), 3) if val else None
                if np.isnan(x) or np.isnan(y):
                    kps.append({'name': name, 'x': None, 'y': None, 'confidence': conf})
                else:
                    kps.append({'name': name, 'x': round(float(x), 5), 'y': round(float(y), 5), 'confidence': conf})

            items.append({
                'id': f'{patient_id}_{side}',
                'patient_id': patient_id,
                'patient_designation': designation,
                'side': side,
                'confidence_tier': tier,
                'overall_score': round(score, 3),
                'violations': violations,
                'n_scans_used': result.n_scans_used,
                'keypoints': kps,
                'template': template.tolist(),
                'review_status': 'pending',
            })

            status = '✓' if tier == 'high' else '?' if tier == 'medium' else '✗'
            log.info(f'  {designation} {side}: score={score:.2f} tier={tier} {status}')

    # Sort: low first, then medium, then high
    tier_order = {'low': 0, 'medium': 1, 'high': 2}
    items.sort(key=lambda x: (tier_order.get(x['confidence_tier'], 9), x['patient_designation']))

    summary = {
        'total': len(items),
        'low': sum(1 for i in items if i['confidence_tier'] == 'low'),
        'medium': sum(1 for i in items if i['confidence_tier'] == 'medium'),
        'high': sum(1 for i in items if i['confidence_tier'] == 'high'),
    }

    log.info(f'=== Review queue built: {summary} ===')
    _review_cache = {'items': items, 'summary': summary}
    return _review_cache


@app.get('/review-queue')
async def get_review_queue():
    """Return the review queue with all patients processed."""
    data = _build_review_queue()
    # Return items without the large template arrays (for the list view)
    items_slim = []
    for item in data['items']:
        slim = {k: v for k, v in item.items() if k != 'template'}
        items_slim.append(slim)
    return {'items': items_slim, 'summary': data['summary']}


@app.get('/review-queue/{review_id}')
async def get_review_item(review_id: str):
    """Return a single review item with template + latest thermogram."""
    data = _build_review_queue()
    item = next((i for i in data['items'] if i['id'] == review_id), None)
    if item is None:
        raise HTTPException(404, f'Review item {review_id} not found')

    # Load the latest thermogram for this patient
    thermos = _load_thermograms(item['patient_id'], max_scans=1)
    latest_thermogram = thermos[0].tolist() if thermos else None

    return {
        **item,
        'latest_thermogram': latest_thermogram,
    }


@app.post('/review-queue/rebuild')
async def rebuild_review_queue():
    """Force rebuild the review queue cache."""
    global _review_cache
    _review_cache = None
    data = _build_review_queue()
    return {'message': 'Rebuilt', 'summary': data['summary']}
