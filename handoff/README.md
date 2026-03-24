# Handoff: Auto Keypoint Pipeline

## What's in this folder

| File | Drop into | Purpose |
|------|-----------|---------|
| `src/notebook_model.py` | `src/` | Primary keypoint predictor (ported from notebook, mean error 0.047) |
| `src/template_builder.py` | `src/` | **Main entry point** — template + keypoints from scans or feet.json |
| `src/anatomical_validator.py` | `src/` | Free anatomical rule checker (6 hard rules) |
| `src/claude_reviewer.py` | `src/` | Claude haiku reviewer for borderline cases (~$0.002/call) |
| `src/label_store.py` | `src/` | SQLite store for human corrections |
| `src/active_learner.py` | `src/` | Retrains supervised model after 5+ corrections |
| `scripts/evaluate_models.py` | `scripts/` | Benchmarks all 3 keypoint models on 20 patients |
| `INTEGRATION.md` | repo root | Full integration guide |

## Existing files these depend on (already in the repo)

`src/geometric_keypoints.py`, `src/supervised_keypoints.py`, `src/data_loader.py`,
`src/visualize.py`, `brannock_clean/` (template library)

## Quick start

Read `INTEGRATION.md` — start with the **Quick Start** section.
The demo path is one call:

```python
from template_builder import predict_from_existing_template
result = predict_from_existing_template('patient-id')
# result.left_keypoints  → (6, 2) normalized coords
# result.right_keypoints → (6, 2) normalized coords
```
