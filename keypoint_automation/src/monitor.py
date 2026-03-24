"""
Monitoring dashboard.

Produces a per-patient + cohort-level report:
  - Confidence tier breakdown (auto-accept / review / required)
  - Mean quality score per patient
  - Error vs ground truth (for patients with known keypoints.json)
  - Inter-scan consistency (std per keypoint)
  - Correlation between scan quality score and keypoint error

Output: terminal table + monitoring_report.json
"""

import json
import pathlib
import sys
from typing import List, Optional

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).parent))

from data_loader import KEYPOINT_NAMES, load_patient, get_keypoint_array
from patient_aggregator import CONFIDENCE_AUTO, CONFIDENCE_REVIEW, CONFIDENCE_REQUIRED


def _euclidean_errors(pred: np.ndarray, gt: np.ndarray) -> np.ndarray:
    diff = pred - gt
    return np.sqrt((diff ** 2).sum(axis=1))


def run_report(
    patient_aggregations: dict,   # {patient_id: agg from aggregate_patient()}
    output_dir: Optional[pathlib.Path] = None,
) -> dict:
    """
    Generate monitoring report.

    Parameters
    ----------
    patient_aggregations : dict mapping patient_id → aggregate_patient() output
    output_dir           : if given, write monitoring_report.json here

    Returns
    -------
    report dict
    """
    rows = []
    per_keypoint_errors = {name: [] for name in KEYPOINT_NAMES}
    quality_scores_all  = []
    errors_all          = []
    confidence_counts   = {CONFIDENCE_AUTO: 0, CONFIDENCE_REVIEW: 0, CONFIDENCE_REQUIRED: 0}

    for patient_id, agg in patient_aggregations.items():
        # Try loading ground truth
        try:
            patient = load_patient(patient_id)
            has_gt = True
        except Exception:
            has_gt = False

        for side in ('left', 'right'):
            r = agg[side]
            confidence_counts[r['confidence']] = confidence_counts.get(r['confidence'], 0) + 1

            gt_error = None
            if has_gt:
                gt = get_keypoint_array(patient['keypoints'], side)
                pred = r['median_coords']
                if not np.all(np.isnan(gt)) and not np.all(np.isnan(pred)):
                    errs = _euclidean_errors(pred, gt)
                    gt_error = float(np.nanmean(errs))
                    errors_all.append(gt_error)
                    for i, name in enumerate(KEYPOINT_NAMES):
                        if not np.isnan(errs[i]):
                            per_keypoint_errors[name].append(errs[i])

            quality_scores_all.extend(r.get('quality_scores', []))

            rows.append(dict(
                patient_id=patient_id,
                side=side,
                confidence=r['confidence'],
                n_scans=r['n_scans_used'],
                mean_quality=r['mean_quality'],
                max_std=float(np.nanmax(r['std_per_keypoint']))
                    if not np.all(np.isnan(r['std_per_keypoint'])) else None,
                gt_error=gt_error,
                flagged_keypoints=r['flagged_keypoints'],
            ))

    # Cohort summary
    n_total = len(rows)
    n_auto  = confidence_counts.get(CONFIDENCE_AUTO, 0)
    n_review = confidence_counts.get(CONFIDENCE_REVIEW, 0)
    n_required = confidence_counts.get(CONFIDENCE_REQUIRED, 0)

    cohort = dict(
        n_patients_sides=n_total,
        auto_accept_pct=100 * n_auto / n_total if n_total else 0,
        review_pct=100 * n_review / n_total if n_total else 0,
        required_review_pct=100 * n_required / n_total if n_total else 0,
        mean_gt_error=float(np.mean(errors_all)) if errors_all else None,
        mean_quality_score=float(np.mean(quality_scores_all)) if quality_scores_all else None,
        per_keypoint_mean_error={
            name: float(np.mean(v)) if v else None
            for name, v in per_keypoint_errors.items()
        },
    )

    report = dict(cohort=cohort, patients=rows)

    _print_report(cohort, rows)

    if output_dir:
        output_dir.mkdir(parents=True, exist_ok=True)
        out_path = output_dir / 'monitoring_report.json'
        with open(out_path, 'w') as f:
            json.dump(report, f, indent=2)
        print(f'\nReport saved → {out_path}')

    return report


def _print_report(cohort: dict, rows: list):
    print('\n' + '=' * 70)
    print('MONITORING REPORT')
    print('=' * 70)

    print(f'\n  Auto-accept:     {cohort["auto_accept_pct"]:.1f}%')
    print(f'  Optional review: {cohort["review_pct"]:.1f}%')
    print(f'  Required review: {cohort["required_review_pct"]:.1f}%')

    if cohort['mean_quality_score'] is not None:
        print(f'  Mean scan quality score: {cohort["mean_quality_score"]:.3f}')

    if cohort['mean_gt_error'] is not None:
        print(f'\n  Mean keypoint error vs ground truth: {cohort["mean_gt_error"]:.4f}')
        print('\n  Per-keypoint mean error:')
        for name, err in cohort['per_keypoint_mean_error'].items():
            if err is not None:
                bar = '█' * int(err * 100)
                print(f'    {name:<24} {err:.4f}  {bar}')

    print('\n  Per-patient breakdown:')
    print(f'  {"Patient":>12}  {"Side":>5}  {"Conf":>14}  {"N":>3}  {"Quality":>7}  {"GT err":>7}  Flags')
    print('  ' + '-' * 72)
    for r in rows:
        pid = r['patient_id'][:10]
        conf_sym = {'AUTO_ACCEPT': '✓', 'REVIEW': '?', 'REQUIRED_REVIEW': '✗'}.get(r['confidence'], '?')
        gt_str = f'{r["gt_error"]:.4f}' if r['gt_error'] is not None else '   N/A'
        q_str  = f'{r["mean_quality"]:.2f}' if r['mean_quality'] else '  N/A'
        flags  = ','.join(r['flagged_keypoints'][:2]) if r['flagged_keypoints'] else ''
        print(f'  {pid:>12}  {r["side"]:>5}  {conf_sym} {r["confidence"]:<13}  '
              f'{r["n_scans"]:>3}  {q_str:>7}  {gt_str:>7}  {flags}')

    print('\n' + '=' * 70)
