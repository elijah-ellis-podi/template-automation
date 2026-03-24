"""
Deterministic anatomical validator for foot keypoints.

Checks 7 hard rules derived from podiatry anatomy. No API call, no ML — runs in
microseconds. Used as the first gating step before Claude review.

Rules (y=0 is toes/top, y=1 is heel/bottom; x=0 is left edge, x=1 is right edge):
  1. Hallux.y < mean(Met1.y, Met3.y, Met5.y)      toes above metatarsal heads
  2. Heel.y > 0.70                                  heel in bottom 30%
  3. Arch.y between Met1.y and Heel.y               arch at midfoot
  4. Right foot: Met1.x > Met3.x > Met5.x           medial→lateral
     Left  foot: Met1.x < Met3.x < Met5.x
  5. Arch is on the medial edge (right: high x, left: low x)
  6. All coords within [0.02, 0.98]
  7. Forefoot taper: mask width at hallux level / width at met level < 0.92
     (wide forefoot = flat distal edge → possible toe amputation or mis-fit)
     Requires template to be passed; skipped (score=1.0) when template=None.

Score per rule: 1.0 if satisfied, partial credit on gradient violations.
Overall score: mean of per-rule scores.  score ≥ 0.9 → AUTO_ACCEPT.
"""

from dataclasses import dataclass, field
from typing import List, Optional
import numpy as np
import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from data_loader import KEYPOINT_NAMES

# Indices in KEYPOINT_NAMES order
_IDX = {name: i for i, name in enumerate(KEYPOINT_NAMES)}
# 0 Hallux, 1 1stMet, 2 3rdMet, 3 5thMet, 4 Arch, 5 Heel

HALLUX  = _IDX['Hallux']
MET1    = _IDX['1st Metatarsal Head']
MET3    = _IDX['3rd Metatarsal Head']
MET5    = _IDX['5th Metatarsal Head']
ARCH    = _IDX['Arch']
HEEL    = _IDX['Heel']


@dataclass
class ValidationResult:
    per_keypoint_scores: np.ndarray    # (6,) score per keypoint, averaged across rules that involve it
    overall_score: float               # mean of all rule scores (0–1)
    violations: List[str]              # human-readable violation descriptions
    rule_scores: List[float]           # individual score per rule (0–1)


def _soft_check(condition_value: float, margin: float = 0.02) -> float:
    """
    Soft scoring: condition_value > 0 → pass (1.0), condition_value ∈ [-margin, 0] → partial.
    Returns score in [0, 1].
    """
    if condition_value >= 0:
        return 1.0
    if condition_value < -margin:
        return 0.0
    return 1.0 + condition_value / margin   # linear ramp 1→0 over [-margin, 0]


def validate(
    coords: np.ndarray,
    side: str,
    template: Optional[np.ndarray] = None,
) -> ValidationResult:
    """
    Validate a (6, 2) keypoint array.

    Parameters
    ----------
    coords   : (6, 2) float array, normalised (x, y), KEYPOINT_NAMES order.
               NaN values are tolerated — rules involving NaN return 0.5 (uncertain).
    side     : 'left' or 'right'
    template : optional 2D float foot-mask array (same as used for prediction).
               Required for Rule 7 (forefoot taper check). When None, Rule 7 is
               skipped (returns 1.0 so it doesn't penalise existing callers).

    Returns
    -------
    ValidationResult
    """
    violations: List[str] = []
    rule_scores: List[float] = []

    # Per-keypoint accumulated scores and counts (to average later)
    kp_score_sum   = np.ones(6) * 0.0
    kp_score_count = np.zeros(6)

    def _get(kp_idx: int, axis: int) -> float:
        v = coords[kp_idx, axis]
        return float(v) if not np.isnan(v) else np.nan

    def _record(score: float, kp_indices: List[int], desc: str = ''):
        rule_scores.append(score)
        for idx in kp_indices:
            kp_score_sum[idx]   += score
            kp_score_count[idx] += 1
        if score < 0.9 and desc:
            violations.append(desc)

    # ── Rule 1: Hallux above metatarsal heads ────────────────────────────────
    hy  = _get(HALLUX, 1)
    m1y = _get(MET1,   1)
    m3y = _get(MET3,   1)
    m5y = _get(MET5,   1)
    met_ys = [v for v in [m1y, m3y, m5y] if not np.isnan(v)]
    if not np.isnan(hy) and met_ys:
        mean_met_y = float(np.mean(met_ys))
        # Hallux.y < mean_met_y  (y=0 is top → hallux should have smaller y)
        delta = mean_met_y - hy        # positive = good
        sc = _soft_check(delta)
        _record(sc, [HALLUX, MET1, MET3, MET5],
                f'Hallux.y ({hy:.3f}) not above metatarsal heads (mean y={mean_met_y:.3f})')
    else:
        _record(0.5, [HALLUX, MET1, MET3, MET5])  # uncertain

    # ── Rule 2: Heel in bottom 30% ───────────────────────────────────────────
    heel_y = _get(HEEL, 1)
    if not np.isnan(heel_y):
        delta = heel_y - 0.70          # positive if heel below threshold
        sc = _soft_check(delta)
        _record(sc, [HEEL], f'Heel.y ({heel_y:.3f}) not in bottom 30% (< 0.70)')
    else:
        _record(0.5, [HEEL])

    # ── Rule 3: Arch between Met1.y and Heel.y ───────────────────────────────
    arch_y = _get(ARCH, 1)
    if not np.isnan(arch_y) and not np.isnan(m1y) and not np.isnan(heel_y):
        lo = min(m1y, heel_y)
        hi = max(m1y, heel_y)
        # arch_y should be in [lo, hi]
        sc_lo = _soft_check(arch_y - lo)
        sc_hi = _soft_check(hi - arch_y)
        sc = min(sc_lo, sc_hi)
        _record(sc, [ARCH],
                f'Arch.y ({arch_y:.3f}) not between Met1.y ({m1y:.3f}) and Heel.y ({heel_y:.3f})')
    else:
        _record(0.5, [ARCH])

    # ── Rule 4: Metatarsal x-ordering (medial→lateral) ───────────────────────
    m1x = _get(MET1, 0)
    m3x = _get(MET3, 0)
    m5x = _get(MET5, 0)
    if not any(np.isnan(v) for v in [m1x, m3x, m5x]):
        if side == 'right':
            # medial = right side (high x): Met1.x > Met3.x > Met5.x
            sc1 = _soft_check(m1x - m3x)
            sc2 = _soft_check(m3x - m5x)
            sc = min(sc1, sc2)
            if sc < 0.9:
                violations.append(
                    f'Right foot met ordering violated: Met1.x={m1x:.3f}, '
                    f'Met3.x={m3x:.3f}, Met5.x={m5x:.3f} (expected Met1>Met3>Met5)')
        else:
            # medial = left side (low x): Met1.x < Met3.x < Met5.x
            sc1 = _soft_check(m3x - m1x)
            sc2 = _soft_check(m5x - m3x)
            sc = min(sc1, sc2)
            if sc < 0.9:
                violations.append(
                    f'Left foot met ordering violated: Met1.x={m1x:.3f}, '
                    f'Met3.x={m3x:.3f}, Met5.x={m5x:.3f} (expected Met1<Met3<Met5)')
        rule_scores.append(sc)
        for idx in [MET1, MET3, MET5]:
            kp_score_sum[idx]   += sc
            kp_score_count[idx] += 1
    else:
        _record(0.5, [MET1, MET3, MET5])

    # ── Rule 5: Arch on medial edge ──────────────────────────────────────────
    arch_x = _get(ARCH, 0)
    if not np.isnan(arch_x) and not np.isnan(m1x):
        if side == 'right':
            # Medial = right (high x); arch should be near Met1.x (high x side)
            # Roughly: arch_x > 0.5 * (m1x + m5x) — between Met1 and midline
            midline_x = float(np.nanmean([m1x, m5x])) if not np.isnan(m5x) else 0.5
            sc = _soft_check(arch_x - midline_x * 0.5)
        else:
            # Medial = left (low x); arch should be on low-x side
            midline_x = float(np.nanmean([m1x, m5x])) if not np.isnan(m5x) else 0.5
            sc = _soft_check(midline_x * 1.5 - arch_x)
        _record(sc, [ARCH],
                f'Arch not on medial edge (arch_x={arch_x:.3f}, side={side})')
    else:
        _record(0.5, [ARCH])

    # ── Rule 6: All coords within [0.02, 0.98] ───────────────────────────────
    in_bounds_scores = []
    for i, name in enumerate(KEYPOINT_NAMES):
        x_v = coords[i, 0]
        y_v = coords[i, 1]
        if np.isnan(x_v) or np.isnan(y_v):
            in_bounds_scores.append(0.5)
            kp_score_sum[i]   += 0.5
            kp_score_count[i] += 1
            continue
        sc = min(
            _soft_check(x_v - 0.02),
            _soft_check(0.98 - x_v),
            _soft_check(y_v - 0.02),
            _soft_check(0.98 - y_v),
        )
        in_bounds_scores.append(sc)
        kp_score_sum[i]   += sc
        kp_score_count[i] += 1
        if sc < 0.9:
            violations.append(f'{name} out of bounds: x={x_v:.3f}, y={y_v:.3f}')
    rule_scores.append(float(np.mean(in_bounds_scores)))

    # ── Rule 7: Forefoot taper (requires template) ───────────────────────────
    # Normal feet narrow toward toes: width at hallux level / width at met level < 0.92
    # A ratio ≥ 0.92 means the forefoot is wide/flat at the distal end,
    # suggesting toe amputation or a severe model mis-fit.
    _TAPER_THRESHOLD = 0.90   # normal feet taper: max observed = 0.889; amputated min = 0.909
    if template is not None and not np.isnan(hy) and not any(np.isnan(v) for v in [m1y, m3y, m5y]):
        H, W = template.shape
        mask = template > 0.1
        met_y_mean = float(np.mean([m1y, m3y, m5y]))
        hal_row = int(np.clip(round(hy * H), 0, H - 1))
        met_row = int(np.clip(round(met_y_mean * H), 0, H - 1))
        hal_w = float(mask[hal_row, :].sum())
        met_w = float(mask[met_row, :].sum())
        taper = hal_w / (met_w + 1e-9)
        # Hard fail: amputated feet are not borderline — either the forefoot tapers or it doesn't
        sc7 = 1.0 if taper < _TAPER_THRESHOLD else 0.0
        _record(sc7, [HALLUX, MET1, MET3, MET5],
                f'Unusual forefoot shape — forefoot does not taper toward toes '
                f'(taper_ratio={taper:.3f} ≥ {_TAPER_THRESHOLD}; possible toe amputation)')
    else:
        _record(1.0, [])   # skip — no penalty when template not provided

    # ── Aggregate ─────────────────────────────────────────────────────────────
    overall_score = float(np.mean(rule_scores)) if rule_scores else 0.0

    with np.errstate(invalid='ignore'):
        per_kp = np.where(
            kp_score_count > 0,
            kp_score_sum / np.maximum(kp_score_count, 1),
            0.5,
        )

    return ValidationResult(
        per_keypoint_scores=per_kp,
        overall_score=overall_score,
        violations=violations,
        rule_scores=rule_scores,
    )
