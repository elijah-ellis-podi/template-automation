"""
Automatic keypoint detection for foot thermograms using anatomical
search regions and local temperature peak-finding.

See KEYPOINT_DETECTION_STRATEGY.md for a full description of the approach.

NOTE: The ground truth keypoints in keypoints.json are in template-registered
coordinate space (post-alignment), NOT raw thermogram space. Direct pixel
comparison with raw thermogram detections is not meaningful. Instead we
visually verify that detected points land on the correct anatomical features.
"""

import json
import os
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from scipy import ndimage
from skimage import filters, morphology, measure

DATA_DIR = os.path.dirname(os.path.abspath(__file__)) + "/patient_scan_data"

# Single sample for focused iteration
PATIENT_ID = "072bc0ef886c2b0b9608bcf2b0f634bd"
MAT_FILE = "20260310114341731me5YBtSTZav9e_mat.json"

KEYPOINT_NAMES = [
    "Hallux",
    "1st Metatarsal Head",
    "3rd Metatarsal Head",
    "5th Metatarsal Head",
    "Arch",
    "Heel",
]

KEYPOINT_COLORS = {
    "Hallux": "#FF0000",
    "1st Metatarsal Head": "#FF8C00",
    "3rd Metatarsal Head": "#FFD700",
    "5th Metatarsal Head": "#00FF00",
    "Arch": "#1E90FF",
    "Heel": "#9932CC",
}

# Anatomical search region definitions.
# y_range: (top_frac, bottom_frac) along foot length (0=toe, 1=heel)
# x_range: (medial_frac, lateral_frac) across foot width
#   For both feet, medial = toward image center, lateral = toward image edge.
#   0.0 = medial edge, 1.0 = lateral edge.
SEARCH_REGIONS = {
    "Hallux": {
        "y_range": (0.0, 0.20),
        "x_range": (0.0, 0.55),  # medial half — big toe
        "strategy": "warmest",
    },
    "1st Metatarsal Head": {
        "y_range": (0.15, 0.40),
        "x_range": (0.0, 0.40),  # medial side
        "strategy": "warmest",
    },
    "3rd Metatarsal Head": {
        "y_range": (0.18, 0.42),
        "x_range": (0.25, 0.75),  # center
        "strategy": "warmest",
    },
    "5th Metatarsal Head": {
        "y_range": (0.20, 0.48),
        "x_range": (0.55, 1.0),  # lateral side
        "strategy": "warmest",
    },
    "Arch": {
        "y_range": (0.40, 0.65),
        "x_range": (0.10, 0.90),
        "strategy": "warmest_centroid",
    },
    "Heel": {
        "y_range": (0.68, 0.95),
        "x_range": (0.10, 0.90),
        "strategy": "warmest_centroid",
    },
}


def load_thermogram(patient_id, mat_file):
    path = os.path.join(DATA_DIR, patient_id, "scans", mat_file)
    with open(path) as f:
        data = json.load(f)
    return np.array(data["thermogram"])


def segment_feet(thermo):
    """Segment feet using a two-threshold approach.

    Core mask (Otsu) captures the warm foot body. An extended mask at a
    lower threshold captures cooler extremities like toes. The extended
    mask is constrained to pixels adjacent to the core to avoid noise.
    """
    otsu_thresh = filters.threshold_otsu(thermo)

    core = thermo > otsu_thresh
    core = morphology.binary_opening(core, morphology.disk(3))
    core = morphology.binary_closing(core, morphology.disk(5))
    core = morphology.remove_small_objects(core, min_size=500)

    # Extended mask for toes
    bg_median = np.median(thermo[~core]) if (~core).any() else thermo.min()
    low_thresh = bg_median + 0.35 * (otsu_thresh - bg_median)
    extended = thermo > low_thresh

    # Only keep extended pixels near the core
    dilated_core = morphology.binary_dilation(core, morphology.disk(15))
    extended = extended & dilated_core

    combined = core | extended
    combined = morphology.binary_closing(combined, morphology.disk(3))
    combined = morphology.remove_small_objects(combined, min_size=500)

    return combined


def identify_feet(mask):
    """Return (left_mask, right_mask) based on centroid x-position.

    Convention: LEFT foot on LEFT side of image, RIGHT foot on RIGHT side.
    For both feet, the medial (inner) edge faces the image center.
    """
    labeled = measure.label(mask)
    regions = measure.regionprops(labeled)

    if len(regions) < 2:
        print(f"  Warning: found {len(regions)} region(s), expected 2")
        return None, None, labeled

    regions.sort(key=lambda r: r.centroid[1])

    left_mask = labeled == regions[0].label
    right_mask = labeled == regions[1].label
    return left_mask, right_mask, labeled


def find_peak_in_region(thermo, foot_mask, bbox, kp_name, foot_side):
    """Find keypoint within an anatomical search region via peak-finding.

    The x_range is defined as medial(0) → lateral(1).
    For the LEFT foot (left side of image):
      medial = right edge (high col), lateral = left edge (low col)
    For the RIGHT foot (right side of image):
      medial = left edge (low col), lateral = right edge (high col)
    """
    region_def = SEARCH_REGIONS[kp_name]
    min_r, min_c, max_r, max_c = bbox
    foot_h = max_r - min_r
    foot_w = max_c - min_c

    y_lo = min_r + int(region_def["y_range"][0] * foot_h)
    y_hi = min_r + int(region_def["y_range"][1] * foot_h)

    med_frac = region_def["x_range"][0]
    lat_frac = region_def["x_range"][1]

    if foot_side == "right":
        # Right foot: medial = left edge (min_c side), lateral = right edge (max_c side)
        x_lo = min_c + int(med_frac * foot_w)
        x_hi = min_c + int(lat_frac * foot_w)
    else:
        # Left foot: medial = right edge (max_c side), lateral = left edge (min_c side)
        # Flip: medial(0)→max_c, lateral(1)→min_c
        x_hi = max_c - int(med_frac * foot_w)
        x_lo = max_c - int(lat_frac * foot_w)

    # Clamp
    y_lo, y_hi = max(y_lo, 0), min(y_hi, thermo.shape[0])
    x_lo, x_hi = max(x_lo, 0), min(x_hi, thermo.shape[1])

    # Build search mask: bounding box ∩ foot mask
    region_mask = np.zeros_like(foot_mask)
    region_mask[y_lo:y_hi, x_lo:x_hi] = True
    search_mask = region_mask & foot_mask

    if not search_mask.any():
        # Fallback: use bounding box without foot mask
        search_mask = region_mask

    if not search_mask.any():
        return None, (y_lo, x_lo, y_hi, x_hi)

    strategy = region_def["strategy"]
    masked_thermo = np.where(search_mask, thermo, -np.inf)

    if strategy == "warmest":
        peak_idx = np.unravel_index(np.argmax(masked_thermo), masked_thermo.shape)
        return (peak_idx[0], peak_idx[1]), (y_lo, x_lo, y_hi, x_hi)

    elif strategy == "warmest_centroid":
        valid_temps = thermo[search_mask]
        threshold = np.percentile(valid_temps, 90)
        hot_mask = search_mask & (thermo >= threshold)
        if not hot_mask.any():
            hot_mask = search_mask
        ys, xs = np.where(hot_mask)
        weights = thermo[ys, xs]
        cy = np.average(ys, weights=weights)
        cx = np.average(xs, weights=weights)
        return (cy, cx), (y_lo, x_lo, y_hi, x_hi)

    return None, (y_lo, x_lo, y_hi, x_hi)


def detect_keypoints(thermo):
    """Full pipeline: segment → identify feet → peak-find keypoints."""
    mask = segment_feet(thermo)
    left_mask, right_mask, labeled = identify_feet(mask)

    results = {}
    search_boxes = {}

    for side, foot_mask in [("left", left_mask), ("right", right_mask)]:
        if foot_mask is None or not foot_mask.any():
            continue
        props = measure.regionprops(foot_mask.astype(int))
        if not props:
            continue
        bbox = props[0].bbox

        results[side] = {}
        search_boxes[side] = {}
        for kp_name in KEYPOINT_NAMES:
            point, box = find_peak_in_region(thermo, foot_mask, bbox, kp_name, side)
            if point is not None:
                results[side][kp_name] = point
            search_boxes[side][kp_name] = box

    return results, mask, labeled, search_boxes


def plot_results(thermo, detected, mask, search_boxes):
    """4-panel plot: thermogram, search regions, detections with labels, segmentation."""
    M, N = thermo.shape

    fig = plt.figure(figsize=(22, 14))
    fig.suptitle(
        f"Auto Keypoint Detection — Patient ...{PATIENT_ID[-8:]}\n"
        f"Scan: {MAT_FILE[:14]}  |  Shape: {M}x{N}  |  "
        f"Range: [{thermo.min():.1f}, {thermo.max():.1f}]°C",
        fontsize=14, fontweight="bold",
    )

    # --- Panel 1: Raw thermogram ---
    ax1 = fig.add_subplot(2, 2, 1)
    im = ax1.imshow(thermo, cmap="inferno", aspect="equal")
    ax1.set_title("Raw Thermogram", fontsize=12)
    plt.colorbar(im, ax=ax1, label="°C", shrink=0.8)
    ax1.axis("off")

    # --- Panel 2: Search regions ---
    ax2 = fig.add_subplot(2, 2, 2)
    ax2.imshow(thermo, cmap="inferno", aspect="equal")
    ax2.set_title("Anatomical Search Regions", fontsize=12)
    for side in ["left", "right"]:
        if side not in search_boxes:
            continue
        for kp_name, (y_lo, x_lo, y_hi, x_hi) in search_boxes[side].items():
            color = KEYPOINT_COLORS[kp_name]
            rect = plt.Rectangle(
                (x_lo, y_lo), x_hi - x_lo, y_hi - y_lo,
                linewidth=1.5, edgecolor=color, facecolor=color, alpha=0.12,
            )
            ax2.add_patch(rect)
            rect_border = plt.Rectangle(
                (x_lo, y_lo), x_hi - x_lo, y_hi - y_lo,
                linewidth=1.5, edgecolor=color, facecolor="none", linestyle="--",
            )
            ax2.add_patch(rect_border)
            # Label the region
            cx = (x_lo + x_hi) / 2
            cy = (y_lo + y_hi) / 2
            short_name = kp_name.replace("Metatarsal Head", "MH").replace("st ", "").replace("rd ", "").replace("th ", "")
            ax2.text(cx, cy, short_name, color="white", fontsize=6,
                     ha="center", va="center", fontweight="bold",
                     bbox=dict(boxstyle="round,pad=0.15", facecolor=color, alpha=0.6))
    ax2.axis("off")

    # --- Panel 3: Detected keypoints with annotations ---
    ax3 = fig.add_subplot(2, 2, 3)
    ax3.imshow(thermo, cmap="inferno", aspect="equal")
    ax3.set_title("Detected Keypoints", fontsize=12)

    for side in ["left", "right"]:
        if side not in detected:
            continue
        marker = "o" if side == "right" else "s"
        side_label = "R" if side == "right" else "L"
        for kp_name, (r, c) in detected[side].items():
            color = KEYPOINT_COLORS[kp_name]
            ax3.plot(c, r, marker, color=color, markersize=11,
                     markeredgecolor="white", markeredgewidth=2)
            # Label with short name
            short = kp_name.split()[0][:3]
            ax3.annotate(
                f"{short}-{side_label}",
                (c, r), textcoords="offset points", xytext=(8, -8),
                fontsize=7, color="white", fontweight="bold",
                bbox=dict(boxstyle="round,pad=0.2", facecolor="black", alpha=0.6),
            )
    ax3.axis("off")

    # --- Panel 4: Segmentation + foot outlines ---
    ax4 = fig.add_subplot(2, 2, 4)
    # Show thermogram with mask overlay
    ax4.imshow(thermo, cmap="inferno", aspect="equal")
    mask_overlay = np.zeros((*mask.shape, 4))
    mask_overlay[~mask] = [0, 0, 0, 0.6]  # darken background
    ax4.imshow(mask_overlay)
    ax4.set_title("Segmentation (background dimmed)", fontsize=12)
    # Draw foot contours
    from skimage.measure import find_contours
    contours = find_contours(mask.astype(float), 0.5)
    for contour in contours:
        ax4.plot(contour[:, 1], contour[:, 0], "w-", linewidth=1.5, alpha=0.8)
    ax4.axis("off")

    # Legend
    from matplotlib.lines import Line2D
    legend_elements = [
        Line2D([0], [0], marker="o", color="w", markerfacecolor=c, markersize=9, label=n)
        for n, c in KEYPOINT_COLORS.items()
    ]
    legend_elements.extend([
        Line2D([0], [0], marker="o", color="gray", markersize=9, linestyle="None",
               label="Right foot (●)"),
        Line2D([0], [0], marker="s", color="gray", markersize=9, linestyle="None",
               label="Left foot (■)"),
    ])
    fig.legend(handles=legend_elements, loc="lower center", ncol=4, fontsize=10,
               bbox_to_anchor=(0.5, -0.01))

    plt.tight_layout(rect=[0, 0.04, 1, 0.94])
    output_path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                               "keypoint_detection_results.png")
    plt.savefig(output_path, dpi=150, bbox_inches="tight")
    print(f"\nSaved visualization to {output_path}")


def main():
    print(f"Patient: {PATIENT_ID}")
    print(f"Scan:    {MAT_FILE}\n")

    thermo = load_thermogram(PATIENT_ID, MAT_FILE)
    M, N = thermo.shape
    print(f"Thermogram: {M}x{N}, range [{thermo.min():.1f}, {thermo.max():.1f}]°C\n")

    detected, mask, labeled, search_boxes = detect_keypoints(thermo)

    for side in ["left", "right"]:
        if side not in detected:
            continue
        print(f"{side.upper()} foot:")
        for kp_name in KEYPOINT_NAMES:
            if kp_name not in detected[side]:
                print(f"  {kp_name:25s}: NOT FOUND")
                continue
            r, c = detected[side][kp_name]
            temp = thermo[int(round(r)), int(round(c))]
            print(f"  {kp_name:25s}: pixel=({r:6.1f},{c:6.1f})  temp={temp:.2f}°C")
        print()

    plot_results(thermo, detected, mask, search_boxes)


if __name__ == "__main__":
    main()
