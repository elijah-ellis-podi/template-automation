"""
Geometric / anatomy-based keypoint estimation.

The smooth template array encodes foot probability.  We threshold it to
get a binary mask, then use spatial statistics to locate the 6 anatomical
landmarks without any machine-learning model.

Coordinate system (matches stored keypoints.json):
  x  = column fraction  0 → left edge,  1 → right edge
  y  = row fraction     0 → top (toes), 1 → bottom (heel)
"""

import numpy as np
from scipy import ndimage

from data_loader import KEYPOINT_NAMES


def _binary_mask(template: np.ndarray, quantile: float = 0.5) -> np.ndarray:
    """Threshold at the given quantile of non-zero values."""
    nonzero = template[template > 0]
    if len(nonzero) == 0:
        return template > 0
    thresh = np.quantile(nonzero, quantile)
    return template >= thresh


def _centroid_normalized(mask: np.ndarray, row_slice=None, col_slice=None) -> tuple[float, float]:
    """
    Return normalised (x, y) centroid of mask pixels within optional slices,
    where x is column fraction and y is row fraction of the *full* mask.
    """
    H, W = mask.shape
    sub = mask.copy()
    if row_slice is not None:
        rmin, rmax = row_slice
        outside = np.ones_like(sub, dtype=bool)
        outside[rmin:rmax, :] = False
        sub[outside] = 0
    if col_slice is not None:
        cmin, cmax = col_slice
        outside = np.ones_like(sub, dtype=bool)
        outside[:, cmin:cmax] = False
        sub[outside] = 0
    rows, cols = np.where(sub)
    if len(rows) == 0:
        return (np.nan, np.nan)
    return float(cols.mean() / W), float(rows.mean() / H)


def _lateral_extreme(mask: np.ndarray, row_slice, side: str) -> tuple[float, float]:
    """
    Return the lateral-most (leftmost or rightmost) point within a row band.
    side: 'left' | 'right'
    """
    H, W = mask.shape
    rmin, rmax = row_slice
    band = mask[rmin:rmax, :]
    rows, cols = np.where(band)
    if len(rows) == 0:
        return (np.nan, np.nan)
    if side == 'left':
        idx = cols.argmin()
    else:
        idx = cols.argmax()
    r = rows[idx] + rmin
    c = cols[idx]
    return float(c / W), float(r / H)


def estimate_keypoints(template: np.ndarray, side: str) -> np.ndarray:
    """
    Estimate keypoints from a smooth foot template array.

    Parameters
    ----------
    template : 2D float array  (the feet.json 'left_foot' or 'right_foot' array)
    side     : 'left' or 'right'

    Returns
    -------
    coords : (6, 2) float array of normalised (x, y) in KEYPOINT_NAMES order
             [Hallux, 1st Met, 3rd Met, 5th Met, Arch, Heel]
    """
    mask = _binary_mask(template)
    H, W = mask.shape

    rows, cols = np.where(mask)
    if len(rows) == 0:
        return np.full((6, 2), np.nan)

    r_min, r_max = rows.min(), rows.max()
    foot_height = r_max - r_min

    # ---- Row bands relative to the foot bounding box ----
    # Divide foot into quarters from top (toes) to bottom (heel)
    toe_band    = (r_min, r_min + int(0.20 * foot_height))  # top 0–20%
    forefoot    = (r_min + int(0.15 * foot_height),
                   r_min + int(0.42 * foot_height))          # 15–42%
    midfoot     = (r_min + int(0.40 * foot_height),
                   r_min + int(0.65 * foot_height))          # 40–65%
    heel_band   = (r_min + int(0.70 * foot_height), r_max)  # 70–100%

    # ---- Foot side determines medial/lateral ----
    # Right foot: medial = right side (high x), lateral = left (low x)
    # Left  foot: medial = left  side (low  x), lateral = right (high x)
    if side == 'right':
        medial_side, lateral_side = 'right', 'left'
    else:
        medial_side, lateral_side = 'left', 'right'

    # Hallux: centroid of the top 20% of the mask, weighted toward medial side
    hallux = _centroid_normalized(mask, row_slice=toe_band)

    # 3rd Metatarsal Head: centroid of the forefoot zone center
    met3 = _centroid_normalized(mask, row_slice=forefoot)

    # 1st Metatarsal Head: medial-most point in the forefoot band
    met1 = _lateral_extreme(mask, forefoot, medial_side)

    # 5th Metatarsal Head: lateral-most point in the forefoot band
    met5 = _lateral_extreme(mask, forefoot, lateral_side)

    # Arch: medial-edge centroid in the midfoot band
    arch = _lateral_extreme(mask, midfoot, medial_side)

    # Heel: centroid of the bottom 30% of the mask
    heel = _centroid_normalized(mask, row_slice=heel_band)

    coords = np.array([hallux, met1, met3, met5, arch, heel])
    return coords  # (6, 2)
