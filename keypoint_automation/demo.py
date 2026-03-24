"""
Demo: auto-detect keypoints for a single patient and display the result.

Usage
-----
  # Run on a specific patient (both feet):
  python demo.py --patient 072bc0ef886c2b0b9608bcf2b0f634bd

  # Run on a random patient:
  python demo.py

  # Skip Claude API (offline, geometry + supervised only):
  python demo.py --no-claude

  # Save output images:
  python demo.py --output-dir demo_output/

Requires ANTHROPIC_API_KEY in environment when --no-claude is not set.
"""

import argparse
import pathlib
import random
import sys
import os

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).parent / 'src'))

from data_loader import (
    all_patient_ids, load_patient, get_keypoint_array, KEYPOINT_NAMES
)
from visualize import render_with_keypoints, save_image
import geometric_keypoints
import supervised_keypoints
import claude_keypoints
import predict_keypoints as pred_module


def main():
    parser = argparse.ArgumentParser(description='Keypoint detection demo')
    parser.add_argument('--patient',    type=str, default=None,
                        help='Patient ID hash (default: random)')
    parser.add_argument('--side',       type=str, default=None,
                        choices=['left', 'right'],
                        help='Foot side (default: both)')
    parser.add_argument('--no-claude',  action='store_true',
                        help='Skip Claude Vision API call')
    parser.add_argument('--output-dir', type=str, default='demo_output',
                        help='Directory for output images (default: demo_output/)')
    args = parser.parse_args()

    # ---- Select patient ----
    all_ids = all_patient_ids()
    if args.patient:
        patient_id = args.patient
        if patient_id not in all_ids:
            print(f'Patient {patient_id} not found.  Available IDs:')
            for pid in all_ids:
                print(f'  {pid}')
            sys.exit(1)
    else:
        patient_id = random.choice(all_ids)
        print(f'Randomly selected patient: {patient_id}')

    patient = load_patient(patient_id)
    sides = [args.side] if args.side else ['left', 'right']

    out_dir = pathlib.Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    # ---- Build supervised model from all other patients ----
    print('\nTraining supervised model (leave-one-out)…')
    other_ids = [pid for pid in all_ids if pid != patient_id]
    train_templates = {'left': [], 'right': []}
    train_kps       = {'left': [], 'right': []}
    for pid in other_ids:
        try:
            p = load_patient(pid)
        except Exception:
            continue
        for side in sides:
            train_templates[side].append(p[f'{side}_template'])
            train_kps[side].append(get_keypoint_array(p['keypoints'], side))

    sup_models = {}
    for side in sides:
        if len(train_templates[side]) >= 3:
            try:
                sup_models[side] = supervised_keypoints.fit(
                    train_templates[side], train_kps[side]
                )
                print(f'  Supervised model trained on {len(train_templates[side])} patients ({side} foot)')
            except Exception as e:
                print(f'  Supervised model training failed ({side}): {e}')
        else:
            print(f'  Not enough training data for supervised model ({side})')

    # ---- Anthropic client ----
    anthropic_client = None
    if not args.no_claude:
        try:
            import anthropic
            anthropic_client = anthropic.Anthropic()
        except Exception as e:
            print(f'Warning: could not initialise Anthropic client: {e}')
            args.no_claude = True

    # ---- Run predictions for each side ----
    for side in sides:
        print(f'\n{"=" * 60}')
        print(f'Processing {side.upper()} foot…')

        template = patient[f'{side}_template']
        gt_coords = get_keypoint_array(patient['keypoints'], side)

        result = pred_module.predict(
            template=template,
            side=side,
            supervised_model=sup_models.get(side),
            anthropic_client=anthropic_client,
            run_claude=not args.no_claude,
        )

        print(pred_module.format_result(result))

        # ---- Compute error vs ground truth ----
        if not np.all(np.isnan(gt_coords)):
            ens = result['ensemble']
            valid = ~np.any(np.isnan(gt_coords), axis=1) & ~np.any(np.isnan(ens), axis=1)
            if valid.any():
                errs = np.linalg.norm(ens[valid] - gt_coords[valid], axis=1)
                print(f'\nEnsemble error vs ground truth:')
                for i, name in enumerate(KEYPOINT_NAMES):
                    if valid[i]:
                        print(f'  {name:<24}  {errs[valid[:i+1].sum()-1]:.4f}')
                print(f'  Mean: {errs.mean():.4f}')

        # ---- Save visualisation images ----
        panels = [
            ('Ground Truth', gt_coords),
            ('Geometric',    result['geometric']),
            ('Claude',       result['claude']),
            ('Supervised',   result['supervised']),
            ('Ensemble',     result['ensemble']),
        ]

        import matplotlib
        matplotlib.use('Agg')
        import matplotlib.pyplot as plt

        fig, axes = plt.subplots(1, len(panels), figsize=(4 * len(panels), 5))
        for ax, (title, coords) in zip(axes, panels):
            rgb = render_with_keypoints(
                template, coords, KEYPOINT_NAMES,
                title=title, colormap='hot'
            )
            ax.imshow(rgb)
            ax.axis('off')
            ax.set_title(title, fontsize=9)

        conf_count = int(result['confidence'].sum())
        plt.suptitle(
            f'Patient {patient_id[:8]}…  {side} foot  '
            f'({conf_count}/{len(KEYPOINT_NAMES)} keypoints auto-accepted)',
            fontsize=10
        )
        plt.tight_layout()
        out_path = out_dir / f'{patient_id}_{side}.png'
        plt.savefig(out_path, dpi=100, bbox_inches='tight')
        plt.close()
        print(f'\nSaved visualisation → {out_path}')


if __name__ == '__main__':
    main()
