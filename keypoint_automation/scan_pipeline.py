"""
Scan-direct keypoint detection pipeline — no template required.

Usage
-----
  # Process all patients (offline, no Claude):
  python scan_pipeline.py --no-claude --output-dir pipeline_output/

  # Process all patients with Claude:
  ANTHROPIC_API_KEY=... python scan_pipeline.py --output-dir pipeline_output/

  # Process a single patient:
  python scan_pipeline.py --patient 072bc0ef886c2b0b9608bcf2b0f634bd --no-claude

  # Open the review UI after processing:
  streamlit run src/review_app.py -- --output-dir pipeline_output/

  # Re-evaluate against ground truth keypoints:
  python scan_pipeline.py --no-claude --evaluate
"""

import argparse
import pathlib
import sys
import json

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).parent / 'src'))

from data_loader import all_patient_ids, load_patient_scans
from scan_predictor import predict_from_scans
from patient_aggregator import aggregate_patient, format_summary
from review_queue import build_queue
from monitor import run_report


def main():
    parser = argparse.ArgumentParser(description='Scan-direct keypoint pipeline')
    parser.add_argument('--patient',    type=str, default=None,
                        help='Process a single patient ID')
    parser.add_argument('--no-claude',  action='store_true',
                        help='Skip Claude Vision API calls')
    parser.add_argument('--output-dir', type=str, default='pipeline_output',
                        help='Directory for results (default: pipeline_output/)')
    parser.add_argument('--max-scans',  type=int, default=10,
                        help='Max recent scans per patient (default: 10)')
    parser.add_argument('--evaluate',   action='store_true',
                        help='Compare results to ground-truth keypoints.json')
    args = parser.parse_args()

    output_dir = pathlib.Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # ── Anthropic client ──────────────────────────────────────────────────
    anthropic_client = None
    if not args.no_claude:
        try:
            import anthropic
            anthropic_client = anthropic.Anthropic()
            print('Claude Vision API enabled.')
        except Exception as e:
            print(f'Warning: Anthropic client failed ({e}). Running without Claude.')
            args.no_claude = True

    # ── Patient list ──────────────────────────────────────────────────────
    if args.patient:
        patient_ids = [args.patient]
    else:
        patient_ids = all_patient_ids()

    print(f'\nProcessing {len(patient_ids)} patient(s) '
          f'(max {args.max_scans} scans each, Claude={not args.no_claude})\n')

    # ── Main loop ─────────────────────────────────────────────────────────
    all_aggregations = {}

    for patient_id in patient_ids:
        print(f'  Patient {patient_id[:12]}…', end='  ', flush=True)

        scans = load_patient_scans(patient_id, max_scans=args.max_scans)
        if not scans:
            print('no scans found — skipped')
            continue

        print(f'{len(scans)} scan(s) loaded', end='  ', flush=True)

        scan_results = predict_from_scans(
            scans,
            anthropic_client=anthropic_client,
            run_claude=not args.no_claude,
        )

        n_valid = len(scan_results)
        print(f'{n_valid} valid prediction(s)', end='  ', flush=True)

        agg = aggregate_patient(scan_results)
        all_aggregations[patient_id] = agg

        # Print confidence tier
        left_conf  = agg['left']['confidence']
        right_conf = agg['right']['confidence']
        sym = lambda c: {'AUTO_ACCEPT': '✓', 'REVIEW': '?', 'REQUIRED_REVIEW': '✗'}.get(c, '?')
        print(f'L:{sym(left_conf)} R:{sym(right_conf)}')

    # ── Save aggregated predictions ───────────────────────────────────────
    _save_predictions(all_aggregations, output_dir)

    # ── Build review queue ────────────────────────────────────────────────
    flagged_aggs = {pid: agg for pid, agg in all_aggregations.items()
                    if agg['left']['review_flag'] or agg['right']['review_flag']}
    if flagged_aggs:
        build_queue(flagged_aggs, output_dir)
        print(f'\n{len(flagged_aggs)} patient(s) flagged for review.')
        print(f'  Open review UI:  streamlit run src/review_app.py -- --output-dir {output_dir}/')
    else:
        print('\nAll patients auto-accepted. No review needed.')

    # ── Monitoring report ─────────────────────────────────────────────────
    if all_aggregations:
        run_report(all_aggregations, output_dir=output_dir if args.evaluate else None)


def _save_predictions(aggregations: dict, output_dir: pathlib.Path):
    """Save aggregated predictions to predictions.json."""
    out = {}
    for patient_id, agg in aggregations.items():
        out[patient_id] = {}
        for side in ('left', 'right'):
            r = agg[side]
            coords = r['median_coords']
            out[patient_id][side] = dict(
                confidence=r['confidence'],
                n_scans_used=r['n_scans_used'],
                mean_quality=r['mean_quality'],
                review_flag=r['review_flag'],
                keypoints=[
                    dict(
                        name=name,
                        x=float(coords[i, 0]) if not np.isnan(coords[i, 0]) else None,
                        y=float(coords[i, 1]) if not np.isnan(coords[i, 1]) else None,
                        std=float(r['std_per_keypoint'][i])
                            if r['std_per_keypoint'] is not None
                            and not np.isnan(r['std_per_keypoint'][i]) else None,
                    )
                    for i, name in enumerate(
                        __import__('data_loader').KEYPOINT_NAMES
                    )
                ],
            )

    pred_path = output_dir / 'predictions.json'
    with open(pred_path, 'w') as f:
        json.dump(out, f, indent=2)
    print(f'\nPredictions saved → {pred_path}')


if __name__ == '__main__':
    main()
