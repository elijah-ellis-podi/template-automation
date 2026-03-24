"""
Per-scan keypoint prediction pipeline — no template required.

For each raw scan thermogram:
  1. Calibration gate   → is_accuracy_thermogram()
  2. Foot detection     → split_thermogram_by_peaks()
  3. Align              → extract_and_align()
  4. Scan quality score → template-independent signals (peak prominence,
                          mask area, mask compactness, temperature spread)
  5. Predict keypoints  → geometric + Claude Vision ensemble

All quality signals are derived purely from the raw thermogram — no
stored patient template is consulted.
"""

import sys
import pathlib
import numpy as np

# ---- Import brannock processing functions ----
_BRANNOCK = pathlib.Path(__file__).parent.parent / \
    'brannock_clean' / 'brannock_smartmat_plus'
sys.path.insert(0, str(_BRANNOCK / 'template'))
sys.path.insert(0, str(_BRANNOCK / 'cleats'))

import template as _tmpl          # is_accuracy_thermogram, split_thermogram_by_peaks,
                                   # extract_and_align, extract_mask_and_region
import skimage.measure

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import predict_keypoints
import geometric_keypoints
import claude_keypoints
from data_loader import KEYPOINT_NAMES

import anthropic as _anthropic
from typing import Optional, List


# ── Quality thresholds ─────────────────────────────────────────────────────
MIN_PEAK_PROMINENCE  = 0.5   # below this → scan too noisy
MIN_MASK_AREA        = 200   # pixels — foot region must be at least this large
MAX_MASK_AREA        = 5000  # pixels — sanity cap
MIN_COMPACTNESS      = 0.05  # area / perimeter² — rejects fragmented masks
MIN_TEMP_SPREAD      = 0.5   # °C std within foot region


def _scan_quality_score(
    thermogram: np.ndarray,
    peak_prominences: list,
    mask,
) -> float:
    """
    Compute a template-independent quality score in [0, 1].
    Returns 0.0 if any hard failure (invalid scan).
    """
    scores = []

    # Peak prominence: normalise to [0, 1] using soft sigmoid
    if peak_prominences:
        mean_prom = float(np.mean(peak_prominences))
        prom_score = min(1.0, mean_prom / 3.0)   # 3.0 = "very good" prominence
        scores.append(prom_score)
        if mean_prom < MIN_PEAK_PROMINENCE:
            return 0.0
    else:
        return 0.0

    # Mask area
    rows, cols = np.where(mask)
    area = len(rows)
    if area < MIN_MASK_AREA or area > MAX_MASK_AREA:
        return 0.0
    area_score = 1.0 - abs(area - 1000) / 2000   # peak at ~1000 px
    scores.append(max(0.0, min(1.0, area_score)))

    # Compactness (area / perimeter²) — requires label image
    labels = skimage.measure.label(mask)
    regions = skimage.measure.regionprops(labels)
    if regions:
        region = max(regions, key=lambda r: r.area)
        perimeter = max(region.perimeter, 1)
        compactness = region.area / (perimeter ** 2)
        if compactness < MIN_COMPACTNESS:
            return 0.0
        comp_score = min(1.0, compactness / 0.08)
        scores.append(comp_score)

    # Temperature spread within foot region
    foot_temps = thermogram[mask]
    temp_std = float(np.std(foot_temps)) if len(foot_temps) > 0 else 0.0
    if temp_std < MIN_TEMP_SPREAD:
        return 0.0
    spread_score = min(1.0, temp_std / 4.0)   # 4°C std = excellent
    scores.append(spread_score)

    return float(np.mean(scores)) if scores else 0.0


def predict_from_scan(
    scan: dict,
    anthropic_client: Optional[_anthropic.Anthropic] = None,
    run_claude: bool = True,
    supervised_model=None,
) -> List[dict]:
    """
    Predict keypoints from a single raw scan thermogram.

    Parameters
    ----------
    scan : dict from load_patient_scans()  — must have 'thermogram' key
    anthropic_client : optional pre-built Anthropic client
    run_claude : if False, skip the API call
    supervised_model : optional fitted sklearn Pipeline

    Returns
    -------
    List of per-foot result dicts (0, 1, or 2 entries):
      side             'left' | 'right'
      aligned_thermo   np.ndarray  aligned/cropped foot thermogram
      coords           (6, 2) float  ensemble predicted keypoints
      confidence       (6,) bool
      scan_quality     float  0–1 template-independent score
      quality_signals  dict   breakdown of quality sub-scores
      scan_id          str
      skipped          bool   True if quality gate failed
      skip_reason      str
    """
    thermogram = scan['thermogram']
    scan_id    = scan.get('scan_id', '')

    def _skip(reason):
        return [dict(side=None, skipped=True, skip_reason=reason,
                     scan_id=scan_id, scan_quality=0.0)]

    # 1. Calibration gate
    try:
        if not _tmpl.is_accuracy_thermogram(thermogram):
            return _skip('calibration_failed')
    except Exception as e:
        return _skip(f'calibration_error: {e}')

    # 2. Foot detection
    try:
        split = _tmpl.split_thermogram_by_peaks(thermogram)
    except Exception as e:
        return _skip(f'peak_detection_error: {e}')

    if len(split) == 0:
        return _skip('no_peaks')

    results = []
    sides = ['left', 'right'] if len(split) == 2 else ['single']

    for i, foot_thermo in enumerate(split):
        side = sides[i] if len(sides) > 1 else sides[0]

        # 3. Align
        try:
            aligned_thermo, aligned_mask = _tmpl.extract_and_align(foot_thermo)
        except Exception as e:
            results.append(dict(side=side, skipped=True,
                                skip_reason=f'align_error: {e}',
                                scan_id=scan_id, scan_quality=0.0))
            continue

        # Determine foot side for single-foot scans
        if side == 'single':
            try:
                is_left = _tmpl.is_left_foot(foot_thermo)
                side = 'left' if is_left else 'right'
            except Exception:
                side = 'left'   # fallback

        # 4. Scan quality score (template-independent)
        from scipy.signal import find_peaks
        projected = np.mean(thermogram, axis=0)
        _, props = find_peaks(projected, prominence=(0.5, None))
        prominences = props.get('prominences', []).tolist()

        quality_score = _scan_quality_score(thermogram, prominences, aligned_mask)
        quality_signals = dict(
            peak_prominences=prominences,
            mask_area=int(np.sum(aligned_mask)),
            temp_spread_std=float(np.std(aligned_thermo[aligned_mask > 0]))
            if np.any(aligned_mask) else 0.0,
            calibration_passed=True,
        )

        if quality_score == 0.0:
            results.append(dict(
                side=side, skipped=True, skip_reason='quality_gate_failed',
                scan_id=scan_id, scan_quality=0.0,
                quality_signals=quality_signals,
            ))
            continue

        # 5. Predict keypoints
        pred = predict_keypoints.predict(
            template=aligned_thermo,
            side=side,
            supervised_model=supervised_model,
            anthropic_client=anthropic_client,
            run_claude=run_claude,
        )

        results.append(dict(
            side=side,
            skipped=False,
            skip_reason=None,
            scan_id=scan_id,
            scan_quality=quality_score,
            quality_signals=quality_signals,
            aligned_thermo=aligned_thermo,
            coords=pred['ensemble'],
            confidence=pred['confidence'],
            detail=pred,   # full method breakdown
        ))

    return results


def predict_from_scans(
    scans: List[dict],
    anthropic_client: Optional[_anthropic.Anthropic] = None,
    run_claude: bool = True,
    supervised_model=None,
) -> List[dict]:
    """
    Run predict_from_scan() over a list of scans and return all
    non-skipped results flattened into a single list.
    """
    all_results = []
    for scan in scans:
        per_scan = predict_from_scan(
            scan, anthropic_client=anthropic_client,
            run_claude=run_claude, supervised_model=supervised_model,
        )
        for r in per_scan:
            if not r.get('skipped', True):
                all_results.append(r)
    return all_results
