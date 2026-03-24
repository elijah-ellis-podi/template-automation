"""
Keypoint estimation ported from keypoints_prediction.ipynb (finalized_model).

This is a direct port of the angle-and-contour approach developed in the notebook,
with two adaptations:
  1. Outputs normalized (x, y) in [0, 1] instead of pixel coordinates.
  2. Handles right foot internally by flipping the template and un-flipping the output,
     so the caller can pass the raw template + side without pre-processing.

Parameters were tuned empirically in the notebook for the canonical left-foot orientation.
The Arch keypoint has an extra lateral shift (+30 % of the centroid→contour distance).

Coordinate system (same as geometric_keypoints and keypoints.json):
  x = column fraction  0 → left edge,  1 → right edge
  y = row fraction     0 → top (toes), 1 → bottom (heel)
"""

import math
import numpy as np
from skimage import measure

import sys
import pathlib
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from data_loader import KEYPOINT_NAMES

# ── Per-keypoint parameters tuned for left-foot orientation ──────────────────
# pre_loc  : 'higher' → contour points above centroid (y < y0)
#            'lower'  → contour points below centroid (y > y0)
# length_rate : fraction along centroid→contour-point line for prediction
# target_angle: target angle (degrees) from centroid to find the right contour point

_PARAMS: dict = {
    'Hallux':               {'pre_loc': 'higher', 'length_rate': 0.80, 'target_angle':  13.62},
    '1st Metatarsal Head':  {'pre_loc': 'higher', 'length_rate': 0.55, 'target_angle':  22.27},
    '3rd Metatarsal Head':  {'pre_loc': 'higher', 'length_rate': 0.50, 'target_angle':  -4.22},
    '5th Metatarsal Head':  {'pre_loc': 'higher', 'length_rate': 0.65, 'target_angle': -32.42},
    'Arch':                 {'pre_loc': 'lower',  'length_rate': 0.20, 'target_angle':  17.33},
    'Heel':                 {'pre_loc': 'lower',  'length_rate': 0.70, 'target_angle':  -0.92},
}


# ── Private helpers (ported verbatim from notebook) ───────────────────────────

def _find_centroid(template: np.ndarray):
    """Return (x0, y0) centroid in pixel coords of the largest region at threshold 0.5."""
    label_img = measure.label(template >= 0.5)
    regions = measure.regionprops(label_img)
    if not regions:
        # Fallback: use array mass centroid
        rows, cols = np.where(template >= 0.5)
        if len(rows) == 0:
            H, W = template.shape
            return W / 2.0, H / 2.0
        return float(cols.mean()), float(rows.mean())
    y0, x0 = max(regions, key=lambda r: r.area).centroid
    return float(x0), float(y0)


def _calc_angle(x1: float, y1: float, x2: float, y2: float) -> float:
    """Angle from (x1,y1) toward (x2,y2) in degrees. dy=0 → ±90."""
    dy = y2 - y1
    dx = x2 - x1
    if dy == 0:
        return 90.0 if dx > 0 else -90.0
    return math.atan(dx / dy) * 180.0 / math.pi


def _coords_by_ratio(x0: float, y0: float, x1: float, y1: float, ratio: float):
    """Point ratio-of-the-way from (x0,y0) to (x1,y1). ratio=0 → origin, ratio=1 → target."""
    if ratio >= 1.0:
        return x1, y1
    k = ratio / (1.0 - ratio)
    return (x0 + k * x1) / (1.0 + k), (y0 + k * y1) / (1.0 + k)


def _closest_idx(lst, target: float) -> int:
    """Return index of element in lst closest to target."""
    arr = np.asarray(lst)
    return int(np.abs(arr - target).argmin())


def _get_contours(template: np.ndarray):
    """
    Extract contour points at threshold 0.5. Returns an (N, 2) array of (row, col) points.
    If multiple contours exist, returns the longest one.
    """
    contours = measure.find_contours(template, 0.5)
    if not contours:
        return np.empty((0, 2))
    return max(contours, key=len)   # (N, 2) each row is [row, col]


# ── Single-keypoint prediction (ported from finalized_model) ─────────────────

def _predict_one(
    template: np.ndarray,
    keypoint_name: str,
) -> tuple[float, float]:
    """
    Predict one keypoint in **pixel coords** for a left-orientation template.
    Returns (pred_x_px, pred_y_px).
    """
    params = _PARAMS[keypoint_name]
    pre_loc    = params['pre_loc']
    length_rate = params['length_rate']
    target_angle = params['target_angle']

    x0, y0 = _find_centroid(template)
    contour = _get_contours(template)  # (N, 2): rows then cols

    if len(contour) == 0:
        # Can't find contour → return centroid
        return x0, y0

    # Filter contour points by pre_loc
    if pre_loc == 'higher':
        # Points above centroid (row < y0)
        pts = [(r, c) for r, c in contour if r < y0]
    elif pre_loc == 'lower':
        # Points below centroid (row > y0)
        pts = [(r, c) for r, c in contour if r > y0]
    else:
        pts = [(r, c) for r, c in contour]

    if not pts:
        # No points in region → use all contour points
        pts = [(r, c) for r, c in contour]

    # Calculate angles from centroid to each contour point
    # note: contour is (row, col) so x=col, y=row
    angle_list = [_calc_angle(x0, y0, c, r) for r, c in pts]

    # Find contour point whose angle is closest to target_angle
    idx = _closest_idx(angle_list, target_angle)
    r_target, c_target = pts[idx]

    # Interpolate between centroid and the contour point
    pred_x, pred_y = _coords_by_ratio(x0, y0, c_target, r_target, length_rate)

    # Arch: extra lateral shift (+30% of centroid→contour-x distance)
    if keypoint_name == 'Arch':
        shift = (c_target - x0) * 0.3
        pred_x += shift

    return float(pred_x), float(pred_y)


# ── Public API ────────────────────────────────────────────────────────────────

def estimate_keypoints(template: np.ndarray, side: str) -> np.ndarray:
    """
    Estimate all 6 keypoints from a smooth foot template array.

    Parameters
    ----------
    template : 2D float array (from feet.json 'left_foot' or 'right_foot')
    side     : 'left' or 'right'

    Returns
    -------
    coords : (6, 2) float array of normalised (x, y) in KEYPOINT_NAMES order.
             Entries are NaN if prediction fails.
    """
    H, W = template.shape

    # Right foot: work in flipped (canonical left) space
    tmpl = np.fliplr(template) if side == 'right' else template

    coords = np.full((len(KEYPOINT_NAMES), 2), np.nan)

    for i, name in enumerate(KEYPOINT_NAMES):
        try:
            px, py = _predict_one(tmpl, name)
            # Normalize to [0, 1]
            x_norm = float(px / W)
            y_norm = float(py / H)
            # Right foot: un-flip the x coordinate
            if side == 'right':
                x_norm = 1.0 - x_norm
            coords[i] = [np.clip(x_norm, 0.0, 1.0), np.clip(y_norm, 0.0, 1.0)]
        except Exception:
            pass  # leave as NaN

    return coords
