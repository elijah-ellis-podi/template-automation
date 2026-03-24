"""
Ensemble predictor: combines Claude Vision API, geometric heuristics, and
the supervised Ridge model.  Outputs per-keypoint confidence flags.

Confidence rule
---------------
For each keypoint, compute the pairwise distances between the three
predictions.  If ALL pairwise distances are below AUTO_ACCEPT_THRESHOLD
the keypoint is marked auto-accepted.  The overall prediction is the
unweighted mean of all three methods (NaN-safe).
"""

from typing import Optional
import numpy as np
import anthropic

import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).parent))

from data_loader import KEYPOINT_NAMES
import geometric_keypoints
import claude_keypoints
import supervised_keypoints

# Normalised distance threshold for auto-accept (≈5% of foot dimension)
AUTO_ACCEPT_THRESHOLD = 0.05


def predict(
    template: np.ndarray,
    side: str,
    supervised_model=None,
    anthropic_client: Optional[anthropic.Anthropic] = None,
    run_claude: bool = True,
) -> dict:
    """
    Run all three prediction methods and ensemble the results.

    Parameters
    ----------
    template         : 2D float array  (smooth foot template)
    side             : 'left' or 'right'
    supervised_model : fitted sklearn Pipeline from supervised_keypoints.fit()
                       If None the supervised prediction is skipped.
    anthropic_client : optional pre-built client (saves auth overhead in loops)
    run_claude       : set False to skip the API call (useful for offline testing)

    Returns
    -------
    dict with keys:
      ensemble      (6, 2) float  – final predicted coords
      confidence    (6,)   bool   – True = auto-accepted
      geometric     (6, 2) float
      claude        (6, 2) float  (NaN if run_claude=False)
      supervised    (6, 2) float  (NaN if no model)
    """
    # 1. Geometric
    geo_coords = geometric_keypoints.estimate_keypoints(template, side)

    # 2. Claude Vision API
    if run_claude:
        claude_coords = claude_keypoints.predict_keypoints(
            template, side, client=anthropic_client
        )
    else:
        claude_coords = np.full((len(KEYPOINT_NAMES), 2), np.nan)

    # 3. Supervised model
    if supervised_model is not None:
        sup_coords = supervised_keypoints.predict(supervised_model, template)
    else:
        sup_coords = np.full((len(KEYPOINT_NAMES), 2), np.nan)

    # Stack into (3, 6, 2) and compute NaN-safe ensemble
    all_preds = np.stack([geo_coords, claude_coords, sup_coords], axis=0)  # (3, 6, 2)
    ensemble = np.nanmean(all_preds, axis=0)  # (6, 2)

    # Confidence: all pairwise distances < threshold
    confidence = _compute_confidence(all_preds)

    return dict(
        ensemble=ensemble,
        confidence=confidence,
        geometric=geo_coords,
        claude=claude_coords,
        supervised=sup_coords,
    )


def _compute_confidence(all_preds: np.ndarray) -> np.ndarray:
    """
    all_preds: (3, 6, 2)
    Returns (6,) bool array: True if all pairwise distances < threshold.
    """
    n_methods, n_kp, _ = all_preds.shape
    confidence = np.zeros(n_kp, dtype=bool)

    for k in range(n_kp):
        pts = all_preds[:, k, :]  # (3, 2)
        valid = ~np.any(np.isnan(pts), axis=1)  # which methods produced a value
        valid_pts = pts[valid]
        if len(valid_pts) < 2:
            continue   # can't compute agreement with fewer than 2 predictions
        # All pairwise distances
        max_dist = 0.0
        for i in range(len(valid_pts)):
            for j in range(i + 1, len(valid_pts)):
                d = float(np.linalg.norm(valid_pts[i] - valid_pts[j]))
                max_dist = max(max_dist, d)
        confidence[k] = max_dist < AUTO_ACCEPT_THRESHOLD

    return confidence


def format_result(result: dict) -> str:
    """Pretty-print the prediction result."""
    lines = ['Keypoint predictions (x, y normalised):']
    lines.append(f'  {"Name":<24} {"Ensemble":>18}  {"Geo":>18}  {"Claude":>18}  {"Supervised":>18}  Conf')
    lines.append('  ' + '-' * 105)
    for i, name in enumerate(KEYPOINT_NAMES):
        ex, ey = result['ensemble'][i]
        gx, gy = result['geometric'][i]
        cx, cy = result['claude'][i]
        sx, sy = result['supervised'][i]
        conf   = '✓' if result['confidence'][i] else '·'

        def fmt(x, y):
            if np.isnan(x):
                return '        N/A       '
            return f'({x:.3f}, {y:.3f})'

        lines.append(
            f'  {name:<24} {fmt(ex,ey):>18}  {fmt(gx,gy):>18}  {fmt(cx,cy):>18}  {fmt(sx,sy):>18}  {conf}'
        )
    n_conf = int(result['confidence'].sum())
    lines.append(f'\nAuto-accepted: {n_conf}/{len(KEYPOINT_NAMES)} keypoints')
    return '\n'.join(lines)
