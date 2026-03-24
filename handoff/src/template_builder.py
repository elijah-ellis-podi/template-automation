"""
Template builder: wraps the brannock template pipeline + automatic keypoint prediction.

Two entry points:

1. build_patient_template_and_keypoints(mat_thermograms)
   Input  : list of raw bilateral mat thermograms (2D numpy arrays from raw scans)
   Output : TemplateAndKeypoints — smooth foot templates + normalized (6,2) keypoints
   Note   : requires brannock library with scikit-image < 0.20 installed (the brannock
            desktop app environment). In the demo environment, use entry point 2 instead.

2. predict_from_existing_template(patient_id)          ← demo-friendly shortcut
   Loads the pre-built feet.json template from patient_data/{id}/template/ and runs
   the keypoint predictor on it. Works in any Python environment.

Primary keypoint predictor: notebook_model (mean error 0.047 on 20 patients, evaluated
in scripts/evaluate_models.py). Falls back to geometric_keypoints if notebook fails.

Caller can optionally supply a pre-trained supervised sklearn Pipeline (from
supervised_keypoints.fit()) to override notebook_model.

Typical usage (demo / existing patients with feet.json)
--------------------------------------------------------
    from template_builder import predict_from_existing_template
    result = predict_from_existing_template('072bc0ef886c2b0b9608bcf2b0f634bd')
    print(result.left_keypoints)   # (6, 2) normalized coords

Typical usage (new patients — requires brannock environment)
------------------------------------------------------------
    from data_loader import load_patient_scans
    from template_builder import build_patient_template_and_keypoints
    scans = load_patient_scans(patient_id)
    result = build_patient_template_and_keypoints([s['thermogram'] for s in scans])
"""

import sys
import pathlib
from dataclasses import dataclass
from typing import List, Optional

import numpy as np

# ── brannock template library ─────────────────────────────────────────────────
_BRANNOCK_TMPL = (
    pathlib.Path(__file__).parent.parent
    / 'brannock_clean' / 'brannock_smartmat_plus' / 'template'
)
sys.path.insert(0, str(_BRANNOCK_TMPL))
from template import build_templates, smooth_template, is_left_foot  # noqa: E402

# ── keypoint predictors ───────────────────────────────────────────────────────
sys.path.insert(0, str(pathlib.Path(__file__).parent))
import notebook_model
import geometric_keypoints
import supervised_keypoints


@dataclass
class TemplateAndKeypoints:
    """Result of build_patient_template_and_keypoints()."""
    left_template:   Optional[np.ndarray]   # smooth float array (rows, cols) or None
    right_template:  Optional[np.ndarray]
    left_keypoints:  Optional[np.ndarray]   # (6, 2) normalized (x,y) or None
    right_keypoints: Optional[np.ndarray]
    n_scans_used:    int                    # thermograms that contributed to the template
    single_foot_side: Optional[str]         # 'left' | 'right' if amputation patient


def build_patient_template_and_keypoints(
    mat_thermograms: List[np.ndarray],
    model: str = 'notebook',
    supervised_model=None,
    match_threshold: float = 0.9,
    required_matches: int = 3,
) -> TemplateAndKeypoints:
    """
    Build smooth foot template(s) from raw bilateral mat scans and predict keypoints.

    Parameters
    ----------
    mat_thermograms  : list of 2D float arrays — raw bilateral thermogram mats
                       (output of load_patient_scans()[i]['thermogram'])
    model            : keypoint predictor to use — 'notebook' (default), 'geometric',
                       or 'supervised' (requires supervised_model to be passed)
    supervised_model : fitted sklearn Pipeline from supervised_keypoints.fit().
                       Only used when model='supervised'.
    match_threshold  : Pearson-r similarity threshold for brannock template matching (0–1)
    required_matches : minimum number of matching scans needed to build a template

    Returns
    -------
    TemplateAndKeypoints
        Fields are None when template could not be built (< required_matches scans match).
    """
    _empty = TemplateAndKeypoints(
        left_template=None, right_template=None,
        left_keypoints=None, right_keypoints=None,
        n_scans_used=0, single_foot_side=None,
    )

    if not mat_thermograms:
        return _empty

    # ── Step 1: build raw boolean template(s) from brannock ──────────────────
    try:
        raw_templates = build_templates(
            mat_thermograms,
            match_threshold=match_threshold,
            required_matches=required_matches,
        )
    except Exception:
        return _empty

    if not raw_templates:
        return _empty

    n_scans_used = len(mat_thermograms)   # all were passed; brannock filters internally

    # ── Step 2: determine bilateral vs single-foot ────────────────────────────
    single_foot_side: Optional[str] = None

    if len(raw_templates) == 2:
        # Normal bilateral: brannock convention left_template, right_template
        raw_left, raw_right = raw_templates
        sides = [('left', raw_left), ('right', raw_right)]
    elif len(raw_templates) == 1:
        # Amputation / single-foot patient
        raw_single = raw_templates[0]
        try:
            is_left = is_left_foot(raw_single)
            side = 'left' if is_left == 1 else 'right'
        except Exception:
            side = 'right'   # conservative fallback
        single_foot_side = side
        sides = [(side, raw_single)]
    else:
        return _empty

    # ── Step 3: smooth each raw bool template ────────────────────────────────
    smoothed: dict[str, np.ndarray] = {}
    for side_name, raw in sides:
        try:
            smoothed[side_name] = smooth_template(raw)
        except Exception:
            # If smooth fails, use the raw bool array cast to float as fallback
            smoothed[side_name] = raw.astype(float)

    # ── Step 4: predict keypoints ─────────────────────────────────────────────
    kp: dict[str, Optional[np.ndarray]] = {}
    for side_name, tmpl in smoothed.items():
        kp[side_name] = _predict_keypoints(tmpl, side_name, model, supervised_model)

    # ── Assemble result ───────────────────────────────────────────────────────
    return TemplateAndKeypoints(
        left_template   = smoothed.get('left'),
        right_template  = smoothed.get('right'),
        left_keypoints  = kp.get('left'),
        right_keypoints = kp.get('right'),
        n_scans_used    = n_scans_used,
        single_foot_side = single_foot_side,
    )


MODELS = ('notebook', 'geometric', 'supervised')
"""Valid values for the `model` parameter."""


def _predict_keypoints(
    template: np.ndarray,
    side: str,
    model: str = 'notebook',
    supervised_model=None,
) -> Optional[np.ndarray]:
    """
    Predict (6, 2) normalized keypoint coords for one foot template.

    model : 'notebook'   — finalized_model port (default; mean error 0.047)
            'geometric'  — band-based centroid/extreme (mean error 0.163)
            'supervised' — HOG + Ridge; requires supervised_model to be passed,
                           otherwise falls back to notebook
    """
    if model == 'supervised':
        if supervised_model is not None:
            try:
                coords = supervised_keypoints.predict(supervised_model, template)
                if not np.all(np.isnan(coords)):
                    return coords
            except Exception:
                pass
        # fall through to notebook if supervised not available or fails

    if model == 'geometric':
        try:
            return geometric_keypoints.estimate_keypoints(template, side)
        except Exception:
            return None

    # 'notebook' (default) or fallback from supervised
    try:
        coords = notebook_model.estimate_keypoints(template, side)
        if not np.all(np.isnan(coords)):
            return coords
    except Exception:
        pass

    # last resort
    try:
        return geometric_keypoints.estimate_keypoints(template, side)
    except Exception:
        return None


# ── Demo-friendly shortcut: load from existing feet.json ─────────────────────

def predict_from_existing_template(
    patient_id: str,
    model: str = 'notebook',
    supervised_model=None,
    data_dir: pathlib.Path = pathlib.Path(__file__).parent.parent / 'patient_data',
) -> TemplateAndKeypoints:
    """
    Load the pre-built feet.json template for a patient and predict keypoints.

    Works in any Python environment (no brannock scikit-image dependency).
    Falls back gracefully if feet.json doesn't exist.

    Parameters
    ----------
    patient_id      : patient folder name under data_dir
    model           : 'notebook' (default), 'geometric', or 'supervised'
    supervised_model: fitted sklearn Pipeline — only used when model='supervised'
    data_dir        : root of patient_data directory

    Returns
    -------
    TemplateAndKeypoints  (left/right template and keypoints, or None if not found)
    """
    import json as _json

    feet_path = data_dir / patient_id / 'template' / 'feet.json'
    if not feet_path.exists():
        return TemplateAndKeypoints(
            left_template=None, right_template=None,
            left_keypoints=None, right_keypoints=None,
            n_scans_used=0, single_foot_side=None,
        )

    with open(feet_path) as f:
        feet = _json.load(f)

    masks = feet.get('masks', {})
    left_raw  = np.array(masks['left_foot'],  dtype=np.float32) if 'left_foot'  in masks else None
    right_raw = np.array(masks['right_foot'], dtype=np.float32) if 'right_foot' in masks else None

    # Detect single-foot patients
    single_foot_side: Optional[str] = None
    if left_raw is None and right_raw is not None:
        single_foot_side = 'right'
    elif right_raw is None and left_raw is not None:
        single_foot_side = 'left'

    left_kp  = _predict_keypoints(left_raw,  'left',  model, supervised_model) if left_raw  is not None else None
    right_kp = _predict_keypoints(right_raw, 'right', model, supervised_model) if right_raw is not None else None

    return TemplateAndKeypoints(
        left_template   = left_raw,
        right_template  = right_raw,
        left_keypoints  = left_kp,
        right_keypoints = right_kp,
        n_scans_used    = 0,          # unknown when loading from pre-built template
        single_foot_side = single_foot_side,
    )
