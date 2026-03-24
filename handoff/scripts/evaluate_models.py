"""
Head-to-head keypoint model comparison on all labeled patients.

Compares three models on the 20 labeled patients (those with keypoints.json):
  1. notebook_model  — port of finalized_model from keypoints_prediction.ipynb
  2. geometric       — band-based centroid/extreme from src/geometric_keypoints.py
  3. supervised      — HOG + Ridge LOO-CV from src/supervised_keypoints.py

Usage
-----
  python scripts/evaluate_models.py

Output: per-keypoint mean normalized euclidean error table + overall winner.
"""

import sys
import pathlib
import numpy as np

ROOT = pathlib.Path(__file__).parent.parent
sys.path.insert(0, str(ROOT / 'src'))

from data_loader import all_patient_ids, load_patient, get_keypoint_array, KEYPOINT_NAMES
import geometric_keypoints
import supervised_keypoints
import notebook_model


def _euclidean_error(pred: np.ndarray, gt: np.ndarray) -> np.ndarray:
    """Per-keypoint euclidean distance. (6,2) arrays → (6,) errors."""
    diff = pred - gt
    return np.sqrt((diff ** 2).sum(axis=1))


def main():
    patient_ids = all_patient_ids()

    # Gather templates and GT keypoints for patients that have keypoints.json
    templates_left, templates_right = [], []
    gt_left, gt_right = [], []
    valid_ids = []

    for pid in patient_ids:
        try:
            p = load_patient(pid)
        except Exception:
            continue
        kp = p.get('keypoints')
        lt = p.get('left_template')
        rt = p.get('right_template')
        if kp is None or lt is None or rt is None:
            continue
        gl = get_keypoint_array(kp, 'left')
        gr = get_keypoint_array(kp, 'right')
        if np.all(np.isnan(gl)) and np.all(np.isnan(gr)):
            continue
        templates_left.append(lt)
        templates_right.append(rt)
        gt_left.append(gl)
        gt_right.append(gr)
        valid_ids.append(pid)

    N = len(valid_ids)
    if N == 0:
        print('No labeled patients found.')
        return

    print(f'Evaluating on {N} labeled patients...\n')

    # ── supervised: LOO-CV on combined left+right ─────────────────────────────
    # Run separately per side so LOO is meaningful
    sup_preds_left  = supervised_keypoints.fit_and_predict_loo(templates_left,  gt_left)
    sup_preds_right = supervised_keypoints.fit_and_predict_loo(templates_right, gt_right)

    # ── Collect per-keypoint errors for each model ────────────────────────────
    errors = {
        'notebook':    {name: [] for name in KEYPOINT_NAMES},
        'geometric':   {name: [] for name in KEYPOINT_NAMES},
        'supervised':  {name: [] for name in KEYPOINT_NAMES},
    }

    for i in range(N):
        for side, tmpl, gt, sup_pred in [
            ('left',  templates_left[i],  gt_left[i],  sup_preds_left[i]),
            ('right', templates_right[i], gt_right[i], sup_preds_right[i]),
        ]:
            if np.all(np.isnan(gt)):
                continue

            nb_pred  = notebook_model.estimate_keypoints(tmpl, side)
            geo_pred = geometric_keypoints.estimate_keypoints(tmpl, side)

            for j, name in enumerate(KEYPOINT_NAMES):
                if np.isnan(gt[j, 0]) or np.isnan(gt[j, 1]):
                    continue
                for model_name, pred in [
                    ('notebook',   nb_pred),
                    ('geometric',  geo_pred),
                    ('supervised', sup_pred),
                ]:
                    if not np.isnan(pred[j, 0]):
                        err = float(np.sqrt(((pred[j] - gt[j]) ** 2).sum()))
                        errors[model_name][name].append(err)

    # ── Print table ───────────────────────────────────────────────────────────
    model_names = ['notebook', 'geometric', 'supervised']
    col_w = 12

    header = f'  {"Keypoint":<26}' + ''.join(f'{m:>{col_w}}' for m in model_names)
    print(header)
    print('  ' + '-' * (26 + col_w * len(model_names)))

    overall = {m: [] for m in model_names}
    for name in KEYPOINT_NAMES:
        row = f'  {name:<26}'
        for m in model_names:
            errs = errors[m][name]
            if errs:
                mean_err = np.mean(errs)
                overall[m].extend(errs)
                row += f'{mean_err:>{col_w}.4f}'
            else:
                row += f'{"N/A":>{col_w}}'
        print(row)

    print('  ' + '-' * (26 + col_w * len(model_names)))
    row = f'  {"OVERALL MEAN":<26}'
    best_model, best_err = None, float('inf')
    for m in model_names:
        if overall[m]:
            mean_err = float(np.mean(overall[m]))
            row += f'{mean_err:>{col_w}.4f}'
            if mean_err < best_err:
                best_err = mean_err
                best_model = m
        else:
            row += f'{"N/A":>{col_w}}'
    print(row)
    print()
    print(f'  Winner: {best_model}  (mean error = {best_err:.4f})')
    print()
    print('  → Use this model as the primary predictor in template_builder.py')


if __name__ == '__main__':
    main()
