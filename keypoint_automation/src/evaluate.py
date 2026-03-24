"""
Evaluate all three keypoint prediction methods over the patient dataset.

Usage
-----
  # Full evaluation (requires ANTHROPIC_API_KEY):
  python src/evaluate.py

  # Skip Claude API calls (fast, offline):
  python src/evaluate.py --no-claude

  # Save visualisation images to a directory:
  python src/evaluate.py --output-dir results/

Metrics
-------
- Per-keypoint mean Euclidean error (normalised units)
- Per-keypoint median error
- % keypoints with error < 0.05 (within 5% of foot dimension)
- % keypoints auto-accepted by the ensemble confidence check
"""

import argparse
import pathlib
import sys
import os

from typing import Optional
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

sys.path.insert(0, str(pathlib.Path(__file__).parent))

from data_loader import (
    all_patient_ids, load_patient, get_keypoint_array, KEYPOINT_NAMES
)
from visualize import render_with_keypoints, save_image
import geometric_keypoints
import supervised_keypoints
import claude_keypoints
import predict_keypoints as pred_module

SIDES = ['left', 'right']


def euclidean_errors(pred: np.ndarray, gt: np.ndarray) -> np.ndarray:
    """Both (6,2). Returns (6,) distance array; NaN where gt is NaN."""
    diff = pred - gt
    return np.sqrt((diff ** 2).sum(axis=1))


def run_evaluation(
    run_claude: bool = True,
    output_dir: Optional[pathlib.Path] = None,
):
    if output_dir:
        output_dir.mkdir(parents=True, exist_ok=True)

    patient_ids = all_patient_ids()

    # Exclude few-shot example patients from quantitative evaluation
    eval_ids = [pid for pid in patient_ids
                if pid not in claude_keypoints.FEW_SHOT_PATIENT_IDS]
    print(f'Evaluating on {len(eval_ids)} patients '
          f'({len(patient_ids) - len(eval_ids)} held out as few-shot examples)')

    # ---- Pre-load all data ----
    patients = {}
    for pid in eval_ids:
        try:
            patients[pid] = load_patient(pid)
        except Exception as e:
            print(f'  Skipping {pid}: {e}')

    # ---- Supervised model: LOO-CV per side ----
    sup_preds = {side: {} for side in SIDES}
    for side in SIDES:
        templates   = [patients[pid][f'{side}_template'] for pid in patients]
        kp_arrays   = [get_keypoint_array(patients[pid]['keypoints'], side)
                       for pid in patients]
        pid_list    = list(patients.keys())

        loo_results = supervised_keypoints.fit_and_predict_loo(templates, kp_arrays)
        for i, pid in enumerate(pid_list):
            sup_preds[side][pid] = loo_results[i]

    # ---- Claude + Geometric (and collect results) ----
    # Storage: errors[method][side] = list of (6,) error arrays
    errors = {
        'geometric':  {s: [] for s in SIDES},
        'claude':     {s: [] for s in SIDES},
        'supervised': {s: [] for s in SIDES},
        'ensemble':   {s: [] for s in SIDES},
    }
    confidence_flags = {s: [] for s in SIDES}

    anthropic_client = None
    if run_claude:
        import anthropic as _anthropic
        anthropic_client = _anthropic.Anthropic()

    for pid in patients:
        patient = patients[pid]
        for side in SIDES:
            template = patient[f'{side}_template']
            gt = get_keypoint_array(patient['keypoints'], side)

            if np.all(np.isnan(gt)):
                continue  # no ground truth for this side

            geo_pred = geometric_keypoints.estimate_keypoints(template, side)
            sup_pred = sup_preds[side].get(pid, np.full((6, 2), np.nan))

            if run_claude:
                cl_pred = claude_keypoints.predict_keypoints(
                    template, side, client=anthropic_client
                )
            else:
                cl_pred = np.full((6, 2), np.nan)

            all_p = np.stack([geo_pred, cl_pred, sup_pred], axis=0)
            ens = np.nanmean(all_p, axis=0)
            conf = pred_module._compute_confidence(all_p)

            errors['geometric'][side].append(euclidean_errors(geo_pred, gt))
            errors['claude'][side].append(euclidean_errors(cl_pred, gt))
            errors['supervised'][side].append(euclidean_errors(sup_pred, gt))
            errors['ensemble'][side].append(euclidean_errors(ens, gt))
            confidence_flags[side].append(conf)

            # Save visualisation if requested
            if output_dir:
                _save_vis(output_dir, pid, side, template, gt,
                          geo_pred, cl_pred, sup_pred, ens, conf)

    # ---- Print summary table ----
    print_summary(errors, confidence_flags)
    if output_dir:
        plot_error_bars(errors, output_dir)


def print_summary(errors: dict, confidence_flags: dict):
    methods = ['geometric', 'supervised', 'claude', 'ensemble']
    threshold = 0.05

    print('\n' + '=' * 80)
    print('EVALUATION SUMMARY  (normalised Euclidean distance, lower is better)')
    print('=' * 80)

    for side in SIDES:
        print(f'\n--- {side.upper()} FOOT ---')
        print(f'  {"Method":<14}', end='')
        for name in KEYPOINT_NAMES:
            print(f'  {name[:6]:>8}', end='')
        print(f'  {"Mean":>8}  {"<0.05":>6}')
        print('  ' + '-' * (14 + 10 * len(KEYPOINT_NAMES) + 20))

        for method in methods:
            errs_list = errors[method][side]
            if not errs_list:
                continue
            errs = np.array(errs_list)     # (N, 6)
            col_means = np.nanmean(errs, axis=0)
            overall_mean = np.nanmean(col_means)
            pct_under = 100 * np.mean(~np.isnan(errs) & (errs < threshold))
            print(f'  {method:<14}', end='')
            for cm in col_means:
                print(f'  {cm:>8.3f}', end='')
            print(f'  {overall_mean:>8.3f}  {pct_under:>5.1f}%')

        # Confidence auto-accept rate
        if confidence_flags[side]:
            all_conf = np.array(confidence_flags[side])  # (N, 6)
            auto_rate = 100 * all_conf.mean()
            print(f'\n  Auto-accept rate (ensemble confidence): {auto_rate:.1f}%')

    print('\n' + '=' * 80)


def _save_vis(out_dir, pid, side, template, gt, geo, cl, sup, ens, conf):
    """Save a 4-panel comparison image for one patient/side."""
    panels = [
        ('Ground Truth', gt),
        ('Geometric',    geo),
        ('Claude',       cl),
        ('Supervised',   sup),
        ('Ensemble',     ens),
    ]
    fig, axes = plt.subplots(1, len(panels), figsize=(4 * len(panels), 5))
    for ax, (title, coords) in zip(axes, panels):
        rgb = render_with_keypoints(template, coords, KEYPOINT_NAMES,
                                    title=title, colormap='hot')
        ax.imshow(rgb)
        ax.axis('off')
        ax.set_title(title, fontsize=9)
    plt.suptitle(f'{pid[:8]}… {side} foot', fontsize=10)
    plt.tight_layout()
    out_path = out_dir / f'{pid}_{side}.png'
    plt.savefig(out_path, dpi=80, bbox_inches='tight')
    plt.close()


def plot_error_bars(errors: dict, out_dir: pathlib.Path):
    """Save a per-keypoint error bar chart."""
    methods = ['geometric', 'supervised', 'claude', 'ensemble']
    colors  = ['steelblue', 'orange', 'green', 'red']

    for side in SIDES:
        fig, ax = plt.subplots(figsize=(10, 4))
        x = np.arange(len(KEYPOINT_NAMES))
        width = 0.2

        for k, (method, color) in enumerate(zip(methods, colors)):
            errs_list = errors[method][side]
            if not errs_list:
                continue
            errs = np.array(errs_list)  # (N, 6)
            means  = np.nanmean(errs, axis=0)
            stds   = np.nanstd(errs, axis=0)
            ax.bar(x + k * width, means, width, label=method,
                   color=color, alpha=0.75, yerr=stds, capsize=3)

        ax.set_xticks(x + 1.5 * width)
        ax.set_xticklabels([n[:6] for n in KEYPOINT_NAMES], fontsize=9)
        ax.set_ylabel('Normalised error')
        ax.set_title(f'Per-keypoint error – {side} foot')
        ax.legend(fontsize=8)
        ax.axhline(0.05, color='grey', linestyle='--', linewidth=0.8,
                   label='5% threshold')
        plt.tight_layout()
        plt.savefig(out_dir / f'error_bars_{side}.png', dpi=100)
        plt.close()


def main():
    parser = argparse.ArgumentParser(description='Evaluate keypoint predictors')
    parser.add_argument('--no-claude', action='store_true',
                        help='Skip Claude API calls (offline mode)')
    parser.add_argument('--output-dir', type=str, default=None,
                        help='Directory to save visualisation images')
    args = parser.parse_args()

    out = pathlib.Path(args.output_dir) if args.output_dir else None
    run_evaluation(run_claude=not args.no_claude, output_dir=out)


if __name__ == '__main__':
    main()
