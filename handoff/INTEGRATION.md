# Integration Guide: Auto Keypoint Pipeline for Brannock Desktop

This guide shows the next developer how to wire the automatic keypoint placement
pipeline into the brannock desktop demo.

---

## Overview

The pipeline has 5 stages. The first 3 are free (no API calls); Claude is called
only for borderline cases (~10-20% of patients).

```
Raw bilateral scan thermograms
        │
        ▼
[1] template_builder.build_patient_template_and_keypoints()
        │   brannock build_templates() + smooth_template()
        │   + notebook_model (winner: mean error 0.047 on 20 patients)
        │
        ▼  TemplateAndKeypoints(left_template, right_template,
           left_keypoints, right_keypoints)
        │
        ▼
[2] anatomical_validator.validate(coords, side)
        │   6 hard anatomical rules, deterministic, ~0 cost
        ├── overall_score ≥ 0.9 ──► AUTO_ACCEPT ✓
        └── overall_score < 0.9 ──► Claude reviewer ↓
        │
        ▼
[3] claude_reviewer.review_keypoints(template, coords, side, client)
        │   Claude haiku, ~$0.001–0.003/call
        ├── accept=True ──────────► ACCEPT ✓
        └── accept=False ─────────► human QA queue ↓
        │
        ▼
[4] Human QA (review_app.py)
        │   QA sees Claude's per-keypoint issue pre-filled
        └── submit correction ──► label_store.record_correction()
                                       └── active_learner.maybe_retrain()
        │
        ▼
[5] Active learning (auto, after 5+ corrections)
        supervised model improved → fewer Claude calls over time
```

### Cost

| Step | Frequency | Cost |
|------|-----------|------|
| Template + keypoints | every patient | ~$0 |
| Anatomical validator | every patient | ~$0 |
| Claude reviewer | ~10–20% of patients | ~$0.001–0.003 |
| Human QA | rare; Claude pre-fills issues | minimal effort |
| **Total per patient** | | **≈ $0.0003–0.001** |

---

## Prerequisites

```bash
pip install -r requirements.txt   # anthropic, scikit-image, scikit-learn, scipy, streamlit
```

For Claude reviewer (optional — only needed for borderline cases):
```bash
export ANTHROPIC_API_KEY=<your key>
# or store in .env/key and: export ANTHROPIC_API_KEY=$(cat .env/key)
```

> **scikit-image compatibility note:** `build_patient_template_and_keypoints()` (raw-scan path)
> calls `brannock.build_templates()` which requires **scikit-image < 0.20**. The `skimage.filters.thresholding`
> submodule was removed in scikit-image 0.20+. The brannock desktop app runs in its own environment
> where this is satisfied.
>
> For the demo and existing patients, use `predict_from_existing_template()` instead — it loads
> `feet.json` directly and has no brannock dependency.

---

## Quick Start

### Demo / existing patients (feet.json already built)

```python
import sys
sys.path.insert(0, 'src')

from template_builder import predict_from_existing_template
from data_loader import KEYPOINT_NAMES

result = predict_from_existing_template('your-patient-id')

if result.left_template is not None:
    for name, xy in zip(KEYPOINT_NAMES, result.left_keypoints):
        print(f'{name}: x={xy[0]:.3f}  y={xy[1]:.3f}')
```

### New patients (raw scans, requires brannock environment with scikit-image < 0.20)

```python
import sys
sys.path.insert(0, 'src')

from data_loader import load_patient_scans
from template_builder import build_patient_template_and_keypoints

scans = load_patient_scans('your-patient-id')
result = build_patient_template_and_keypoints([s['thermogram'] for s in scans])

if result.left_template is not None:
    print('Left keypoints:', result.left_keypoints)   # (6, 2) array
```

---

## Full Pipeline (with QA)

```python
import anthropic
import sys, pathlib
sys.path.insert(0, 'src')

from data_loader import load_patient_scans
from template_builder import build_patient_template_and_keypoints
from anatomical_validator import validate
from claude_reviewer import review_keypoints
from label_store import record_correction
from active_learner import maybe_retrain

client = anthropic.Anthropic()   # reads ANTHROPIC_API_KEY from env
scans = load_patient_scans('your-patient-id')
thermograms = [s['thermogram'] for s in scans]

result = build_patient_template_and_keypoints(thermograms)

for side, template, coords in [
    ('left',  result.left_template,  result.left_keypoints),
    ('right', result.right_template, result.right_keypoints),
]:
    if template is None or coords is None:
        continue

    # Step 2: anatomical check (free)
    val = validate(coords, side)
    if val.overall_score >= 0.9:
        print(f'{side}: AUTO_ACCEPT (score={val.overall_score:.2f})')
        continue

    # Step 3: Claude reviewer (~$0.002)
    review = review_keypoints(template, coords, side, client,
                              validator_violations=val.violations)
    if review.accept:
        print(f'{side}: ACCEPT (Claude confidence={review.overall_confidence:.2f})')
    else:
        print(f'{side}: QA NEEDED')
        for name, kpr in review.keypoints.items():
            if kpr.status != 'correct':
                print(f'  ⚠ {name}: {kpr.issue}')
        # → send to review_app.py (Streamlit) with Claude feedback pre-filled
```

---

## Integrating into Brannock Desktop

The brannock desktop app auto-generates `feet.json` after collecting enough scans.
Wire the keypoint pipeline immediately after template generation:

**Hook point:** After `build_templates()` completes and `feet.json` is written,
call `build_patient_template_and_keypoints()` with the same `mat_thermograms` list.

**Persisting results:** Save the output alongside the existing brannock files:

```
patient_data/{patient_id}/
  template/
    feet.json          ← existing brannock template
    keypoints.json     ← NEW: auto-placed keypoints (write this)
    keypoints_meta.json ← NEW: confidence / review status
```

Example write:
```python
import json
from data_loader import KEYPOINT_NAMES

def save_auto_keypoints(patient_id, result, side, coords, review_status):
    out_dir = pathlib.Path('patient_data') / patient_id / 'template'
    out_dir.mkdir(exist_ok=True)

    kp_data = {}
    for i, name in enumerate(KEYPOINT_NAMES):
        kp_data[name] = {
            f'{side}_normalized_coordinate': {
                'x': float(coords[i, 0]),
                'y': float(coords[i, 1]),
            }
        }

    kp_path = out_dir / 'keypoints.json'
    # Merge with existing if file already has the other side
    existing = json.loads(kp_path.read_text()) if kp_path.exists() else {'keypoints': {}}
    for name, v in kp_data.items():
        existing['keypoints'].setdefault(name, {}).update(v)
    kp_path.write_text(json.dumps(existing, indent=2))
```

---

## Model Selection

Both `predict_from_existing_template()` and `build_patient_template_and_keypoints()`
accept a `model` parameter. Three options:

| `model=` | Mean error | When to use |
|----------|-----------|-------------|
| `'notebook'` | **0.047** (default) | Best accuracy out of the box |
| `'geometric'` | 0.163 | No dependencies, fastest, useful as sanity check |
| `'supervised'` | 0.260 (base) | After active learning accumulates corrections — improves over time |

```python
from template_builder import predict_from_existing_template

# Default (best accuracy)
result = predict_from_existing_template(patient_id)

# Explicitly pick a model
result = predict_from_existing_template(patient_id, model='notebook')
result = predict_from_existing_template(patient_id, model='geometric')

# Supervised — load the latest retrained model
from active_learner import load_active_model
result = predict_from_existing_template(patient_id, model='supervised',
                                        supervised_model=load_active_model())
```

The supervised model auto-retrains after 5+ human corrections accumulate.
Check status:
```python
from label_store import count_unprocessed, get_correction_frequency_per_keypoint
print('Pending corrections:', count_unprocessed())
print('Corrections per keypoint:', get_correction_frequency_per_keypoint())
```

---

## Running the Model Evaluation

To reproduce the model comparison (notebook vs geometric vs supervised on 20 patients):

```bash
python3 scripts/evaluate_models.py
```

Expected output (from initial run):
```
  Keypoint                      notebook   geometric  supervised
  --------------------------------------------------------------
  Hallux                          0.0443      0.1370      0.2503
  1st Metatarsal Head             0.0483      0.1815      0.2511
  3rd Metatarsal Head             0.0342      0.0450      0.2533
  5th Metatarsal Head             0.0418      0.1711      0.2730
  Arch                            0.0834      0.4182      0.2639
  Heel                            0.0296      0.0233      0.2694
  --------------------------------------------------------------
  OVERALL MEAN                    0.0469      0.1627      0.2602

  Winner: notebook  (mean error = 0.0469)
```

---

## Key Files

| File | Purpose |
|------|---------|
| [src/template_builder.py](src/template_builder.py) | **Entry point** — call this to get template + keypoints |
| [src/notebook_model.py](src/notebook_model.py) | Primary keypoint predictor (ported from notebook) |
| [src/anatomical_validator.py](src/anatomical_validator.py) | Free anatomical rule checker |
| [src/claude_reviewer.py](src/claude_reviewer.py) | Claude haiku reviewer for borderline cases |
| [src/label_store.py](src/label_store.py) | SQLite store for human corrections |
| [src/active_learner.py](src/active_learner.py) | Supervised model retraining loop |
| [scripts/evaluate_models.py](scripts/evaluate_models.py) | Benchmark all 3 keypoint models |
| [src/geometric_keypoints.py](src/geometric_keypoints.py) | Fallback predictor (band-based) |
| [src/supervised_keypoints.py](src/supervised_keypoints.py) | HOG+Ridge model (`fit()` for active learning) |
