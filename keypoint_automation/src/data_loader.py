"""
Load patient thermogram templates, masks, ground-truth keypoints, and raw scans.

feet.json  → {"masks": {"left_foot": [[...]], "right_foot": [[...]]}}
             Gaussian-smoothed foot template (float, values near 0–0.02)
masks.json → same structure (binary/probability mask)
keypoints.json → 6 anatomical keypoints as normalized (x,y) coords
scans/
  *_scan.json → scan metadata (scan_status, scan_type, ...)
  *_mat.json  → {"thermogram": [[...]]} raw 140×205 or 88×120 array, or null
"""

import json
import pathlib
from typing import List, Optional
import numpy as np

KEYPOINT_NAMES = [
    'Hallux',
    '1st Metatarsal Head',
    '3rd Metatarsal Head',
    '5th Metatarsal Head',
    'Arch',
    'Heel',
]

DATA_DIR = pathlib.Path(__file__).parent.parent / 'patient_data'


def load_patient(patient_id: str) -> dict:
    """
    Returns a dict with keys:
      left_template   np.ndarray  2D smooth template for left foot
      right_template  np.ndarray  2D smooth template for right foot
      left_mask       np.ndarray  2D mask for left foot (may be same as template)
      right_mask      np.ndarray  2D mask for right foot
      keypoints       dict        {name: {left_normalized_coordinate, right_normalized_coordinate}}
      patient_id      str
    """
    folder = DATA_DIR / patient_id / 'template'

    with open(folder / 'feet.json') as f:
        feet = json.load(f)
    with open(folder / 'masks.json') as f:
        masks = json.load(f)
    with open(folder / 'keypoints.json') as f:
        kp_data = json.load(f)

    left_template  = np.array(feet['masks']['left_foot'],  dtype=np.float32)
    right_template = np.array(feet['masks']['right_foot'], dtype=np.float32)
    left_mask      = np.array(masks['masks']['left_foot'],  dtype=np.float32)
    right_mask     = np.array(masks['masks']['right_foot'], dtype=np.float32)

    return dict(
        patient_id=patient_id,
        left_template=left_template,
        right_template=right_template,
        left_mask=left_mask,
        right_mask=right_mask,
        keypoints=kp_data['keypoints'],
    )


def all_patient_ids() -> List[str]:
    return [p.name for p in DATA_DIR.iterdir() if p.is_dir()]


def load_patient_scans(patient_id: str, max_scans: int = 10) -> List[dict]:
    """
    Load the most recent N raw scan thermograms for a patient.

    Returns a list (sorted newest-first) of dicts:
      scan_id        str
      thermogram     np.ndarray (H, W) float32  — the raw mat thermogram
      scan_type      str  ('user' | 'diagnostic')
      scan_status    str  ('success' | 'failure' | ...)
      when_completed str  ISO timestamp

    Only scans with scan_status == 'success' AND non-null thermogram are included.
    """
    scans_dir = DATA_DIR / patient_id / 'scans'
    if not scans_dir.exists():
        return []

    # Pair up scan + mat files by shared prefix (timestamp_id)
    scan_files = sorted(scans_dir.glob('*_scan.json'), reverse=True)

    results = []
    for scan_file in scan_files:
        if len(results) >= max_scans:
            break

        prefix = scan_file.name.replace('_scan.json', '')
        mat_file = scans_dir / f'{prefix}_mat.json'

        if not mat_file.exists():
            continue

        # Load scan metadata
        try:
            with open(scan_file) as f:
                scan_meta = json.load(f)
        except Exception:
            continue

        if scan_meta.get('scan_status') != 'success':
            continue

        # Load thermogram — skip if null/placeholder
        try:
            with open(mat_file) as f:
                mat_data = json.load(f)
        except Exception:
            continue

        thermo = mat_data.get('thermogram')
        if thermo is None:
            continue

        arr = np.array(thermo, dtype=np.float32)
        if arr.ndim != 2 or arr.size == 0:
            continue

        results.append(dict(
            scan_id=scan_meta.get('scan_id', prefix),
            thermogram=arr,
            scan_type=scan_meta.get('scan_type', 'unknown'),
            scan_status=scan_meta.get('scan_status', 'unknown'),
            when_completed=scan_meta.get('when_completed', ''),
        ))

    return results


def get_keypoint_array(keypoints: dict, side: str) -> np.ndarray:
    """
    Returns shape (6, 2) array of normalized (x, y) coords for given side
    ('left' or 'right'), in KEYPOINT_NAMES order.
    Missing coords are NaN.
    """
    coord_key = f'{side}_normalized_coordinate'
    result = np.full((len(KEYPOINT_NAMES), 2), np.nan)
    for i, name in enumerate(KEYPOINT_NAMES):
        coord = keypoints.get(name, {}).get(coord_key)
        if coord is not None:
            result[i, 0] = coord['x']
            result[i, 1] = coord['y']
    return result
