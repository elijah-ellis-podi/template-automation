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
import logging
import traceback
from dataclasses import dataclass
from typing import List, Optional

import numpy as np

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format='%(name)s %(levelname)s: %(message)s')

# ── brannock template library ─────────────────────────────────────────────────
# brannock_clean lives at the repo root: template-automation/brannock_clean/
_REPO_ROOT = pathlib.Path(__file__).parent.parent.parent
_BRANNOCK_TMPL = _REPO_ROOT / 'brannock_clean' / 'brannock_smartmat_plus' / 'template'
sys.path.insert(0, str(_BRANNOCK_TMPL))
from template import build_templates, smooth_template, is_left_foot  # noqa: E402

# ── keypoint predictors ───────────────────────────────────────────────────────
sys.path.insert(0, str(pathlib.Path(__file__).parent))
import notebook_model
import geometric_keypoints
import supervised_keypoints
from data_loader import KEYPOINT_NAMES


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
    match_threshold: float = 0.7,
    required_matches: int = 2,
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
        logger.warning('build: no thermograms provided')
        return _empty

    logger.info(f'build: received {len(mat_thermograms)} thermogram(s)')
    for i, t in enumerate(mat_thermograms):
        logger.info(f'  thermogram[{i}]: shape={t.shape}, dtype={t.dtype}, '
                     f'min={t.min():.2f}, max={t.max():.2f}, '
                     f'nonzero={np.count_nonzero(t)}/{t.size}')

    # ── Step 1: build raw boolean template(s) from brannock ──────────────────
    logger.info(f'build step 1: calling build_templates(match_threshold={match_threshold}, '
                f'required_matches={required_matches})')
    try:
        raw_templates = build_templates(
            mat_thermograms,
            match_threshold=match_threshold,
            required_matches=required_matches,
        )
    except Exception as e:
        logger.error(f'build step 1 FAILED: build_templates() raised {type(e).__name__}: {e}')
        logger.debug(traceback.format_exc())
        return _empty

    if not raw_templates:
        logger.warning('build step 1: build_templates() returned empty/None — '
                       'not enough matching scans to form a template')
        return _empty

    logger.info(f'build step 1 OK: got {len(raw_templates)} raw template(s)')
    for i, t in enumerate(raw_templates):
        logger.info(f'  raw_template[{i}]: shape={t.shape}, dtype={t.dtype}, '
                     f'nonzero_frac={np.count_nonzero(t) / t.size:.3f}')

    n_scans_used = len(mat_thermograms)

    # ── Step 2: determine bilateral vs single-foot ────────────────────────────
    single_foot_side: Optional[str] = None

    if len(raw_templates) == 2:
        # build_templates() returns raw orientation. The legacy brannock desktop
        # applies numpy.fliplr() before saving/displaying, so the PADS ground-truth
        # keypoints are in flipped coordinates. We must flip here to match.
        raw_left = np.fliplr(raw_templates[0])
        raw_right = np.fliplr(raw_templates[1])
        sides = [('left', raw_left), ('right', raw_right)]
        logger.info('build step 2: bilateral (2 templates, fliplr applied)')
    elif len(raw_templates) == 1:
        raw_single = np.fliplr(raw_templates[0])
        try:
            is_left = is_left_foot(raw_single)
            side = 'left' if is_left == 1 else 'right'
            logger.info(f'build step 2: single foot, is_left_foot() returned {is_left} → {side} (fliplr applied)')
        except Exception as e:
            side = 'right'
            logger.warning(f'build step 2: is_left_foot() failed ({e}), defaulting to right')
        single_foot_side = side
        sides = [(side, raw_single)]
    else:
        logger.warning(f'build step 2: unexpected template count ({len(raw_templates)}), aborting')
        return _empty

    # ── Step 3: smooth each raw bool template ────────────────────────────────
    smoothed: dict[str, np.ndarray] = {}
    for side_name, raw in sides:
        try:
            smoothed[side_name] = smooth_template(raw)
            logger.info(f'build step 3: smooth_template({side_name}) OK — '
                        f'shape={smoothed[side_name].shape}, '
                        f'min={smoothed[side_name].min():.4f}, max={smoothed[side_name].max():.4f}')
        except Exception as e:
            logger.warning(f'build step 3: smooth_template({side_name}) failed ({e}), using raw float')
            smoothed[side_name] = raw.astype(float)

    # ── Step 4: predict keypoints ─────────────────────────────────────────────
    kp: dict[str, Optional[np.ndarray]] = {}
    for side_name, tmpl in smoothed.items():
        logger.info(f'build step 4: predicting keypoints for {side_name} using model={model}')
        kp[side_name] = _predict_keypoints(tmpl, side_name, model, supervised_model)
        if kp[side_name] is not None:
            valid_count = np.sum(~np.any(np.isnan(kp[side_name]), axis=1))
            logger.info(f'  {side_name} keypoints: {valid_count}/6 valid')
            for j, name in enumerate(KEYPOINT_NAMES):
                x, y = kp[side_name][j]
                status = f'({x:.3f}, {y:.3f})' if not np.isnan(x) else 'NaN'
                logger.info(f'    {name}: {status}')
        else:
            logger.warning(f'  {side_name} keypoints: None (prediction failed)')

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
    logger.info(f'_predict_keypoints: template shape={template.shape}, side={side}, model={model}')

    if model == 'supervised':
        if supervised_model is not None:
            try:
                coords = supervised_keypoints.predict(supervised_model, template)
                if not np.all(np.isnan(coords)):
                    logger.info('  supervised model returned valid coords')
                    return coords
                logger.warning('  supervised model returned all-NaN, falling through to notebook')
            except Exception as e:
                logger.warning(f'  supervised model failed ({e}), falling through to notebook')
        else:
            logger.info('  no supervised_model provided, falling through to notebook')

    if model == 'geometric':
        try:
            coords = geometric_keypoints.estimate_keypoints(template, side)
            logger.info(f'  geometric model returned coords')
            return coords
        except Exception as e:
            logger.error(f'  geometric model failed: {e}')
            return None

    # 'notebook' (default) or fallback from supervised
    try:
        logger.info('  trying notebook_model...')
        coords = notebook_model.estimate_keypoints(template, side)
        if not np.all(np.isnan(coords)):
            logger.info('  notebook_model returned valid coords')
            return coords
        logger.warning('  notebook_model returned all-NaN, falling through to geometric')
    except Exception as e:
        logger.warning(f'  notebook_model failed ({e}), falling through to geometric')

    # last resort
    try:
        logger.info('  trying geometric (last resort)...')
        coords = geometric_keypoints.estimate_keypoints(template, side)
        logger.info('  geometric model returned coords')
        return coords
    except Exception as e:
        logger.error(f'  geometric model also failed: {e}')
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
