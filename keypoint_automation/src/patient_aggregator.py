"""
Aggregate per-scan keypoint predictions into a single per-patient result.

Aggregation strategy:
- Median keypoint position across N valid scans (robust to outliers)
- Per-keypoint standard deviation as consistency measure
- Confidence tier based on n_good_scans and consistency

Output confidence tiers:
  AUTO_ACCEPT   — enough consistent scans, skip human review
  REVIEW        — some scans but inconsistent or too few
  REQUIRED      — no valid scans at all, must have human review
"""

import numpy as np
from typing import List
from data_loader import KEYPOINT_NAMES

# Confidence thresholds
MIN_SCANS_AUTO     = 3      # need at least this many good scans for auto-accept
MIN_SCANS_TENTATIVE = 2     # need at least this many for tentative accept
MAX_STD_AUTO       = 0.05   # max inter-scan std for auto-accept
MAX_STD_TENTATIVE  = 0.10   # max inter-scan std for tentative accept
MIN_QUALITY_SCORE  = 0.4    # minimum per-scan quality to include in aggregation

CONFIDENCE_AUTO     = 'AUTO_ACCEPT'
CONFIDENCE_REVIEW   = 'REVIEW'
CONFIDENCE_REQUIRED = 'REQUIRED_REVIEW'


def aggregate(scan_results: List[dict], side: str) -> dict:
    """
    Aggregate per-scan predictions for one side of one patient.

    Parameters
    ----------
    scan_results : list of non-skipped dicts from scan_predictor.predict_from_scans()
                   (already filtered to exclude skipped scans)
    side         : 'left' or 'right'

    Returns
    -------
    dict with keys:
      side               str
      median_coords      (6, 2) float  — aggregated best-guess keypoints
      std_per_keypoint   (6,) float    — inter-scan std per keypoint
      n_scans_used       int
      quality_scores     list of float — per-scan quality scores used
      mean_quality       float
      confidence         str  — AUTO_ACCEPT / REVIEW / REQUIRED_REVIEW
      review_flag        bool
      flagged_keypoints  list of str   — keypoints with high std
    """
    # Filter to this side with sufficient quality
    side_results = [
        r for r in scan_results
        if r.get('side') == side and r.get('scan_quality', 0) >= MIN_QUALITY_SCORE
    ]

    if not side_results:
        return dict(
            side=side,
            median_coords=np.full((6, 2), np.nan),
            std_per_keypoint=np.full(6, np.nan),
            n_scans_used=0,
            quality_scores=[],
            mean_quality=0.0,
            confidence=CONFIDENCE_REQUIRED,
            review_flag=True,
            flagged_keypoints=KEYPOINT_NAMES[:],
        )

    # Stack coords: (N, 6, 2)
    coords_stack = np.stack([r['coords'] for r in side_results], axis=0)
    quality_scores = [r['scan_quality'] for r in side_results]

    # Median and std across scans
    median_coords = np.nanmedian(coords_stack, axis=0)   # (6, 2)
    std_per_kp    = np.nanstd(coords_stack, axis=0)      # (6, 2)
    std_scalar    = np.linalg.norm(std_per_kp, axis=1)   # (6,) combined x+y std

    n = len(side_results)
    max_std = float(np.nanmax(std_scalar))
    mean_quality = float(np.mean(quality_scores))

    # Confidence tier
    if n >= MIN_SCANS_AUTO and max_std <= MAX_STD_AUTO:
        confidence = CONFIDENCE_AUTO
        review_flag = False
    elif n >= MIN_SCANS_TENTATIVE and max_std <= MAX_STD_TENTATIVE:
        confidence = CONFIDENCE_REVIEW
        review_flag = True
    elif n == 1:
        confidence = CONFIDENCE_REVIEW
        review_flag = True   # single scan — always review
    else:
        confidence = CONFIDENCE_REQUIRED
        review_flag = True

    # Identify which keypoints are most inconsistent
    flagged = [
        KEYPOINT_NAMES[i] for i, s in enumerate(std_scalar)
        if not np.isnan(s) and s > MAX_STD_AUTO
    ]

    return dict(
        side=side,
        median_coords=median_coords,
        std_per_keypoint=std_scalar,
        n_scans_used=n,
        quality_scores=quality_scores,
        mean_quality=mean_quality,
        confidence=confidence,
        review_flag=review_flag,
        flagged_keypoints=flagged,
        # keep per-scan detail for visualisation
        scan_results=side_results,
    )


def aggregate_patient(scan_results: List[dict]) -> dict:
    """
    Aggregate both left and right sides for a patient.

    Returns dict with keys 'left' and 'right', each containing
    the output of aggregate().
    """
    return dict(
        left=aggregate(scan_results, 'left'),
        right=aggregate(scan_results, 'right'),
    )


def format_summary(agg: dict, patient_id: str = '') -> str:
    """Pretty-print aggregation result for one patient."""
    lines = []
    if patient_id:
        lines.append(f'Patient: {patient_id[:12]}…')
    for side in ('left', 'right'):
        r = agg[side]
        conf_symbol = {'AUTO_ACCEPT': '✓', 'REVIEW': '?', 'REQUIRED_REVIEW': '✗'}
        sym = conf_symbol.get(r['confidence'], '?')
        lines.append(
            f'  {side.upper():5s} {sym} {r["confidence"]:<16}  '
            f'n_scans={r["n_scans_used"]}  '
            f'mean_quality={r["mean_quality"]:.2f}'
        )
        if r['flagged_keypoints']:
            lines.append(f'         Flagged: {", ".join(r["flagged_keypoints"])}')
    return '\n'.join(lines)
