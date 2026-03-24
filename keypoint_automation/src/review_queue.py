"""
Review queue management.

Maintains two JSON files:
  review_queue.json      — patients flagged for human review (auto-updated by pipeline)
  approved_keypoints.json — accepted/corrected keypoints (written by reviewer)

These files live in the pipeline output directory.
"""

import json
import pathlib
import numpy as np
from typing import Optional, List
from data_loader import KEYPOINT_NAMES


def _coords_to_dict(coords: np.ndarray, side: str) -> dict:
    """Convert (6, 2) array → keypoints dict matching keypoints.json schema."""
    result = {}
    coord_key = f'{side}_normalized_coordinate'
    for i, name in enumerate(KEYPOINT_NAMES):
        x, y = coords[i]
        result[name] = {coord_key: {'x': float(x), 'y': float(y)}}
    return result


def build_queue(
    patient_aggregations: dict,   # {patient_id: agg_result from aggregate_patient()}
    output_dir: pathlib.Path,
):
    """
    Write review_queue.json from aggregated results.
    Only includes patients flagged for review.
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    queue = []

    for patient_id, agg in patient_aggregations.items():
        for side in ('left', 'right'):
            r = agg[side]
            if not r['review_flag']:
                continue

            # Convert median coords to serialisable format
            coords = r['median_coords']
            if np.all(np.isnan(coords)):
                coords_list = None
            else:
                coords_list = coords.tolist()

            queue.append(dict(
                patient_id=patient_id,
                side=side,
                confidence=r['confidence'],
                n_scans_used=r['n_scans_used'],
                mean_quality=r['mean_quality'],
                flagged_keypoints=r['flagged_keypoints'],
                std_per_keypoint=r['std_per_keypoint'].tolist()
                    if not np.all(np.isnan(r['std_per_keypoint'])) else None,
                predicted_coords=coords_list,
                reviewed=False,
                reviewer_coords=None,
                accepted=False,
            ))

    queue_path = output_dir / 'review_queue.json'
    with open(queue_path, 'w') as f:
        json.dump(queue, f, indent=2)

    print(f'Review queue: {len(queue)} items → {queue_path}')
    return queue_path


def load_queue(output_dir: pathlib.Path) -> list:
    queue_path = output_dir / 'review_queue.json'
    if not queue_path.exists():
        return []
    with open(queue_path) as f:
        return json.load(f)


def save_queue(queue: list, output_dir: pathlib.Path):
    queue_path = output_dir / 'review_queue.json'
    with open(queue_path, 'w') as f:
        json.dump(queue, f, indent=2)


def accept(patient_id: str, side: str, output_dir: pathlib.Path):
    """Accept the predicted keypoints without correction."""
    queue = load_queue(output_dir)
    for item in queue:
        if item['patient_id'] == patient_id and item['side'] == side:
            item['reviewed'] = True
            item['accepted'] = True
            item['reviewer_coords'] = item['predicted_coords']
            break
    save_queue(queue, output_dir)
    _write_approved(patient_id, side, item['predicted_coords'], output_dir)


def submit_correction(
    patient_id: str,
    side: str,
    corrected_coords: List[List[float]],  # [[x,y], ...] length 6
    output_dir: pathlib.Path,
):
    """Submit human-corrected keypoints."""
    queue = load_queue(output_dir)
    for item in queue:
        if item['patient_id'] == patient_id and item['side'] == side:
            item['reviewed'] = True
            item['accepted'] = True
            item['reviewer_coords'] = corrected_coords
            break
    save_queue(queue, output_dir)
    _write_approved(patient_id, side, corrected_coords, output_dir)


def _write_approved(patient_id, side, coords_list, output_dir):
    approved_path = output_dir / 'approved_keypoints.json'
    try:
        with open(approved_path) as f:
            approved = json.load(f)
    except FileNotFoundError:
        approved = {}

    if patient_id not in approved:
        approved[patient_id] = {}

    approved[patient_id][side] = dict(
        keypoints=coords_list,
        keypoint_names=KEYPOINT_NAMES,
    )

    with open(approved_path, 'w') as f:
        json.dump(approved, f, indent=2)
