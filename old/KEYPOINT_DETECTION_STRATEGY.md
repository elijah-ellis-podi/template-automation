# Keypoint Detection Strategy

## Overview

This document describes the automatic keypoint detection approach used in `auto_keypoint_detection.py`. The goal is to automatically place 6 anatomical keypoints on each foot in a raw mat thermogram, replacing the current manual placement process.

## Coordinate Convention

In the raw mat thermogram:
- The **left foot** appears on the **left side** of the image (lower column indices)
- The **right foot** appears on the **right side** (higher column indices)
- This is as if viewing the soles from below, with the patient standing on the mat

For both feet, the **medial** (inner) edge faces the image center, and the **lateral** (outer) edge faces the image boundary.

**Important:** The `keypoints.json` ground truth files store coordinates in **template-registered** space (post-alignment via `cleats` registration), not raw thermogram space. The template pipeline applies `numpy.fliplr` and affine transforms. Direct pixel comparison between raw-thermogram detections and ground truth is therefore not meaningful.

## Pipeline

### Step 1: Two-Threshold Segmentation

Simple Otsu thresholding often misses cooler extremities (especially toes), so we use a **two-threshold** approach:

1. **Core mask** — Otsu threshold cleanly captures the warm foot body (sole, heel, ball)
2. **Extended mask** — A lower threshold set at `background_median + 0.35 * (otsu - background_median)` captures cooler toes and foot edges
3. **Constraint** — Extended pixels are only kept if within 15px of the core mask (morphological dilation), preventing background noise pickup
4. **Cleanup** — Morphological closing fills small gaps, then small components (<500px) are removed

This reliably captures ~90% of the foot area including toes in most scans, though very cool toes (common in patients with poor circulation — exactly the clinical population) may still be truncated.

### Step 2: Foot Identification

Connected components in the cleaned mask are labeled and sorted by centroid x-position. The leftmost blob is the left foot, the rightmost is the right foot.

### Step 3: Anatomical Search Regions

Each keypoint has a bounded search region defined as fractional ranges within the foot's bounding box. This constrains the search to anatomically plausible locations.

Two axes define the region:
- **y-axis** — 0.0 = toe end (top of bbox), 1.0 = heel end (bottom of bbox)
- **x-axis** — 0.0 = medial edge (toward image center), 1.0 = lateral edge (toward image boundary)

The x-axis mapping flips between feet:
- **Right foot**: medial(0) = left edge of bbox, lateral(1) = right edge → direct mapping
- **Left foot**: medial(0) = right edge of bbox, lateral(1) = left edge → reversed mapping

#### Region Definitions

| Keypoint | y-range | x-range (med→lat) | Strategy | Anatomical Rationale |
|---|---|---|---|---|
| **Hallux** | 0.00–0.20 | 0.00–0.55 | `warmest` | Big toe: topmost, medial. Prominent thermal peak from terminal phalanx blood supply. |
| **1st Metatarsal Head** | 0.15–0.40 | 0.00–0.40 | `warmest` | Medial ball of foot. High-pressure point with strong thermal signature. |
| **3rd Metatarsal Head** | 0.18–0.42 | 0.25–0.75 | `warmest` | Center of metatarsal line. Middle of the forefoot width. |
| **5th Metatarsal Head** | 0.20–0.48 | 0.55–1.00 | `warmest` | Lateral ball of foot. The bony prominence is a reliable thermal peak. |
| **Arch** | 0.40–0.65 | 0.10–0.90 | `warmest_centroid` | Midfoot. Broad area, no single peak — centroid is more stable. |
| **Heel** | 0.68–0.95 | 0.10–0.90 | `warmest_centroid` | Rear of foot. Large warm region, centroid gives center. |

The y-ranges overlap slightly between metatarsal heads to accommodate anatomical variation. All regions are intersected with the foot segmentation mask to exclude background pixels.

### Step 4: Peak-Finding Strategies

#### `warmest` — Hallux, 1st/3rd/5th Metatarsal Heads

Finds the **single warmest pixel** in the masked search region (`argmax`).

**Why this works:** The metatarsal heads and hallux are bony prominences close to the skin surface with concentrated blood flow. They appear as sharp local temperature peaks. The search region constraint prevents the global maximum from pulling the detection to an unrelated hot spot.

**Limitation:** If the foot has a hot artifact (e.g., recent contact with warm surface), the warmest pixel may not be the anatomical landmark. A Gaussian-smoothed version could reduce this sensitivity.

#### `warmest_centroid` — Arch, Heel

Computes the **temperature-weighted centroid of the top 10% warmest pixels** in the region.

**Why this works:** The arch and heel are broad anatomical features without a single sharp peak. A centroid produces a more stable, centered placement. The 90th percentile threshold focuses the centroid on the warmest cluster while excluding cooler boundary pixels.

**Why temperature weighting:** Simple geometric centroid of the threshold mask would be biased by the mask shape. Temperature weighting pulls the point toward the thermal center of the feature, which better represents the anatomical center.

## Known Limitations

1. **Toes truncated in segmentation** — Patients with poor peripheral circulation (the target clinical population) often have toes cooler than the background threshold. The extended threshold helps but does not fully solve this. The Hallux detection is most affected.

2. **No orientation detection** — Assumes toes are at the top. Upside-down scans (patient stepped on backwards) would produce nonsensical results. The production pipeline handles this via `cleats` registration; a standalone detector would need rotation detection.

3. **Bilateral only** — Assumes two feet are present. Single-foot scans need modified identification logic.

4. **Raw thermogram vs. template space** — These detections are in raw image coordinates. To compare with `keypoints.json` ground truth or feed into the asymmetry calculation pipeline, the coordinates would need to go through the same registration/alignment transforms used by `cleats`.

5. **Fixed proportions** — The search region fractions assume average foot proportions. Patients with amputations, severe Charcot deformity, or unusual foot aspect ratios may need adaptive region sizing.

## Future Improvements

- **Gaussian pre-smoothing** (sigma ~2-3px) before peak-finding to reduce noise
- **Gradient-based refinement** — snap detected points to local temperature ridge centers
- **Multi-scale search** — coarse region detection, then fine peak within a smaller neighborhood
- **Template-aware detection** — use `masks.json` template data for precise foot boundaries before keypoint search
- **Cross-patient learning** — fit search region parameters to the existing labeled keypoints across the full patient cohort
- **Orientation detection** — classify toe-up vs toe-down before keypoint search
