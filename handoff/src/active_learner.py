"""
Active learning loop: retrain the supervised keypoint model when corrections accumulate.

Trigger: call maybe_retrain() after each human correction. It retrains only when
≥5 unprocessed corrections have accumulated since the last evaluation.

Strategy
--------
1. Load original 20 labeled patients as base training set.
2. Apply all human corrections from label_store (corrections override the original
   keypoint for that patient/side/keypoint, or add a new pseudo-patient if the
   patient wasn't originally labeled).
3. Run LOO-CV on the augmented set via supervised_keypoints.fit_and_predict_loo().
4. Deploy new model only if mean error improves by > 0.001 over the current best.
5. Save versioned pkl: pipeline_output/models/supervised_v{YYYYMMDD_HHMMSS}.pkl
6. Update model_registry.json: track all versions + active flag (enables rollback).
7. Update label_store with the evaluation result.
"""

import pickle
import json
import pathlib
import sys
from datetime import datetime, timezone
from typing import List, Optional, Tuple

import numpy as np

ROOT = pathlib.Path(__file__).parent.parent
sys.path.insert(0, str(pathlib.Path(__file__).parent))

from data_loader import all_patient_ids, load_patient, get_keypoint_array, KEYPOINT_NAMES
import supervised_keypoints
import label_store as ls


MODELS_DIR   = ROOT / 'pipeline_output' / 'models'
REGISTRY_PATH = MODELS_DIR / 'model_registry.json'
MIN_CORRECTIONS_TO_RETRAIN = 5
MIN_IMPROVEMENT = 0.001    # must beat current best by this margin


def _load_registry() -> dict:
    if REGISTRY_PATH.exists():
        with open(REGISTRY_PATH) as f:
            return json.load(f)
    return {'versions': [], 'active': None}


def _save_registry(reg: dict) -> None:
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    with open(REGISTRY_PATH, 'w') as f:
        json.dump(reg, f, indent=2)


def _build_augmented_dataset(
    corrections: List[dict],
) -> Tuple[List[np.ndarray], List[np.ndarray], List[str]]:
    """
    Build augmented training set: original labeled patients + human corrections.

    Returns
    -------
    templates : list of 2D template arrays (one per training sample)
    kp_arrays : list of (6, 2) keypoint arrays
    labels    : list of 'patient_id/side' strings for debugging
    """
    templates: List[np.ndarray] = []
    kp_arrays: List[np.ndarray] = []
    labels:    List[str]        = []

    # ── Load base dataset (original 20 labeled patients) ─────────────────────
    base: dict = {}   # key = 'patient_id/side' → {'template': ..., 'kp': (6,2) array}
    for pid in all_patient_ids():
        try:
            p = load_patient(pid)
        except Exception:
            continue
        kp_dict = p.get('keypoints')
        if kp_dict is None:
            continue
        for side in ('left', 'right'):
            tmpl = p.get(f'{side}_template')
            if tmpl is None:
                continue
            kp = get_keypoint_array(kp_dict, side)
            if np.all(np.isnan(kp)):
                continue
            key = f'{pid}/{side}'
            base[key] = {'template': tmpl, 'kp': kp.copy()}

    # ── Apply corrections: override individual keypoint values ───────────────
    for corr in corrections:
        pid   = corr['patient_id']
        side  = corr['side']
        kname = corr['keypoint_name']
        cx, cy = corr['corrected_xy']
        key = f'{pid}/{side}'

        if key not in base:
            # Correction for a patient not in the base set — skip
            # (without the template we can't add it to training)
            continue

        kp_idx = KEYPOINT_NAMES.index(kname) if kname in KEYPOINT_NAMES else -1
        if kp_idx < 0:
            continue

        base[key]['kp'][kp_idx] = [float(cx), float(cy)]

    for key, entry in base.items():
        templates.append(entry['template'])
        kp_arrays.append(entry['kp'])
        labels.append(key)

    return templates, kp_arrays, labels


def _mean_error(
    predictions: List[np.ndarray],
    ground_truth: List[np.ndarray],
) -> float:
    errors = []
    for pred, gt in zip(predictions, ground_truth):
        if np.all(np.isnan(pred)) or np.all(np.isnan(gt)):
            continue
        diff = pred - gt
        errs = np.sqrt((diff ** 2).sum(axis=1))
        errors.extend(float(e) for e in errs if not np.isnan(e))
    return float(np.mean(errors)) if errors else float('inf')


def maybe_retrain(
    db_path: pathlib.Path = ls._DEFAULT_DB,
) -> Optional[str]:
    """
    Retrain supervised model if enough new corrections have accumulated.

    Returns the version string of the newly deployed model, or None if no
    retrain happened (not enough corrections, or new model didn't improve).
    """
    n_unprocessed = ls.count_unprocessed(db_path=db_path)
    if n_unprocessed < MIN_CORRECTIONS_TO_RETRAIN:
        return None

    corrections = ls.get_corrections_as_arrays(db_path=db_path)
    templates, kp_arrays, labels = _build_augmented_dataset(corrections)

    if len(templates) < 3:
        return None

    # ── LOO-CV on augmented set ───────────────────────────────────────────────
    preds = supervised_keypoints.fit_and_predict_loo(templates, kp_arrays)
    new_error = _mean_error(preds, kp_arrays)

    # ── Compare with current best ─────────────────────────────────────────────
    reg = _load_registry()
    best_error = float('inf')
    if reg['versions']:
        errors = [v['mean_error'] for v in reg['versions']]
        best_error = min(errors) if errors else float('inf')

    if new_error >= best_error - MIN_IMPROVEMENT:
        # No meaningful improvement — don't deploy
        version = f'supervised_v{_ts()}'
        reg['versions'].append({
            'version': version,
            'mean_error': new_error,
            'n_samples': len(templates),
            'deployed': False,
            'reason_skipped': f'error {new_error:.5f} not better than best {best_error:.5f}',
        })
        _save_registry(reg)
        ls.record_model_evaluation(version, new_error, set_active=False, db_path=db_path)
        return None

    # ── Train final model on full augmented set and save ─────────────────────
    final_model = supervised_keypoints.fit(templates, kp_arrays)
    version = f'supervised_v{_ts()}'
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    model_path = MODELS_DIR / f'{version}.pkl'
    with open(model_path, 'wb') as f:
        pickle.dump(final_model, f)

    # Update registry
    reg['versions'].append({
        'version': version,
        'mean_error': new_error,
        'n_samples': len(templates),
        'model_path': str(model_path),
        'deployed': True,
    })
    # Deactivate old active
    for v in reg['versions'][:-1]:
        v['deployed'] = False
    reg['active'] = version
    _save_registry(reg)

    ls.record_model_evaluation(version, new_error, set_active=True, db_path=db_path)

    return version


def load_active_model():
    """
    Load and return the currently active supervised model Pipeline, or None.
    """
    reg = _load_registry()
    if not reg.get('active'):
        return None
    for v in reversed(reg['versions']):
        if v.get('deployed') and v.get('model_path'):
            p = pathlib.Path(v['model_path'])
            if p.exists():
                with open(p, 'rb') as f:
                    return pickle.load(f)
    return None


def _ts() -> str:
    return datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')
