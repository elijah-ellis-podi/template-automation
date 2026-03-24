# Build Backend Specification

This document specifies the API contract that the template build backend must implement. The frontend at `src/routes/manual-build.tsx` calls this server to build templates with auto-placed keypoints from a set of raw scan thermograms.

## Endpoint

```
POST /build-template
```

**Server location:** `http://localhost:8787` (same FastAPI server as `keypoint_automation/server.py`, or a new endpoint on it).

## Request

```json
{
  "patient_id": "fa4a56521d93238218b29d027b4d32c6",
  "scan_ids": ["20260322131342927RAGxafiQ4pTuS", "20260321133014156eTumXfntZNyGP", ...],
  "thermograms": [
    {
      "scan_id": "20260322131342927RAGxafiQ4pTuS",
      "thermogram": [[18.57, 18.56, ...], ...]
    },
    ...
  ]
}
```

| Field | Type | Description |
|---|---|---|
| `patient_id` | string | The patient these scans belong to |
| `scan_ids` | string[] | Ordered list of scan IDs used for building |
| `thermograms` | array | Each entry has `scan_id` (string) and `thermogram` (2D float array — the raw mat thermogram, typically 140x205) |

The frontend fetches the thermograms from the PADS API and sends them in the request body. This avoids the backend needing PADS credentials.

Expect 4-15 thermograms per request. Each thermogram is ~140 rows x 205 cols of float values (temperatures in Celsius, range ~18-31).

## Response

```json
{
  "left_template": [[0.0, 0.0, ...], ...],
  "right_template": [[0.0, 0.0, ...], ...],
  "left_keypoints": [
    {"name": "Hallux", "x": 0.263, "y": 0.137, "confidence": 0.92},
    {"name": "1st Metatarsal Head", "x": 0.401, "y": 0.276, "confidence": 0.88},
    {"name": "3rd Metatarsal Head", "x": 0.512, "y": 0.281, "confidence": 0.91},
    {"name": "5th Metatarsal Head", "x": 0.698, "y": 0.338, "confidence": 0.85},
    {"name": "Arch", "x": 0.601, "y": 0.468, "confidence": 0.79},
    {"name": "Heel", "x": 0.466, "y": 0.803, "confidence": 0.94}
  ],
  "right_keypoints": [
    {"name": "Hallux", "x": 0.699, "y": 0.116, "confidence": 0.90},
    ...
  ],
  "foot_count": "pair",
  "detected_feet": ["left", "right"],
  "quality_score": 0.87,
  "earliest_scan_id": "20260321133014156eTumXfntZNyGP"
}
```

| Field | Type | Description |
|---|---|---|
| `left_template` | float[][] or null | The built left foot template (smooth mask, values 0-1). Null if single-foot right. |
| `right_template` | float[][] or null | The built right foot template. Null if single-foot left. |
| `left_keypoints` | array or null | 6 keypoints for left foot. Null entries for absent anatomy. |
| `right_keypoints` | array or null | 6 keypoints for right foot. |
| `foot_count` | "single" or "pair" | Whether the result is bilateral or single-foot |
| `detected_feet` | string[] | Which feet were detected: `["left"]`, `["right"]`, or `["left", "right"]` |
| `quality_score` | float 0-1 | Overall confidence in the built template |
| `earliest_scan_id` | string | The scan_id of the earliest scan used, for provenance |

### Keypoint object

```json
{
  "name": "Hallux",
  "x": 0.263,
  "y": 0.137,
  "confidence": 0.92
}
```

| Field | Type | Description |
|---|---|---|
| `name` | string | One of the 6 keypoint names (see below) |
| `x` | float 0-1 or null | Normalized x coordinate within the foot template. Null = anatomy absent. |
| `y` | float 0-1 or null | Normalized y coordinate. Null = anatomy absent. |
| `confidence` | float 0-1 or null | Model confidence. Null if no prediction was possible. |

### The 6 keypoint names (in order)

1. `Hallux` — tip of the big toe
2. `1st Metatarsal Head` — medial forefoot, base of big toe
3. `3rd Metatarsal Head` — center forefoot, widest point of ball
4. `5th Metatarsal Head` — lateral forefoot, base of little toe
5. `Arch` — midfoot, concave arch region
6. `Heel` — center of calcaneus

### Coordinate system

- `x = 0.0` = left edge of the template image, `x = 1.0` = right edge
- `y = 0.0` = top (toes), `y = 1.0` = bottom (heel)
- Coordinates are normalized to the foot template dimensions, not the original mat thermogram

## What the backend must do

1. **Split thermograms into feet.** Each input thermogram shows the full mat (both feet side-by-side). Split into left and right halves. Left foot is in the right half, right foot in the left half (anatomical convention — the patient faces the mat).

2. **Build the template.** Stack/align the split foot thermograms across scans to produce a smooth foot-shaped mask (values 0-1). This is what the legacy `cleats.templates.stack_thermograms()` or `template.build_templates()` does. The output should be a clean foot-shaped probability mask.

3. **Detect keypoints.** Run the keypoint detection model(s) on the built template. Options:
   - Geometric model (`keypoint_automation/src/geometric_keypoints.py`) — fast, no API calls
   - Claude Vision (`keypoint_automation/src/claude_keypoints.py`) — higher accuracy, costs money per call
   - Ensemble of both

   Return per-keypoint confidence scores.

4. **Return the result.** The frontend renders the template as a heatmap with keypoint markers overlaid. The operator reviews and can approve or request manual adjustment.

## Implementation location

Add the endpoint to `keypoint_automation/server.py` alongside the existing `/predict` endpoint. The build logic can import from:

- `keypoint_automation/src/geometric_keypoints.py` — for keypoint detection
- `keypoint_automation/src/claude_keypoints.py` — for vision-based detection
- The `cleats` library (if available in the Python env) — for template building
- Or a new module that implements template building from raw thermograms

## Error handling

Return 400 for:
- Empty thermograms list
- Thermograms with unexpected dimensions
- All thermograms failing quality checks

Return 500 for:
- Model errors
- Unexpected failures

Always include an `error` field in the response body on failure:
```json
{"detail": "Not enough valid scans to build template (need at least 4)"}
```

## CORS

The server must allow `http://localhost:5173` origin (already configured in `server.py`).
