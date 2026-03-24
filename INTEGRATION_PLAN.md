# Integration Plan: Auto-Keypoint Detection into PADS

## Architecture Decision: Dumb Frontend vs Separate Backend

**Recommendation: PADS as the sole backend. No separate service.**

Reasons:

1. **The keypoint models must run where the scan data already lives.** The processing pipeline in shoebox already has the raw thermogram, the calibrated/denoised data, and the foot-splitting logic. Adding a separate service would mean re-fetching and re-processing thermograms that shoebox already has in memory.

2. **The event system already exists.** PADS has a mature event-driven pipeline: `transmission_received` → process scan → store results. Auto-keypoint detection is a natural extension of this pipeline, not a separate concern.

3. **The review queue is just a view over scan data.** The dashboard UI needs to filter/sort scans by confidence tier — this is a query against DynamoDB, not a separate datastore. Adding a second backend would mean syncing state between two systems.

4. **Operational simplicity.** One deployment pipeline, one set of permissions, one monitoring stack. A separate backend doubles the infrastructure burden for a feature that processes ~400 scans/day.

The **template-automation frontend** stays as a standalone React SPA that talks to PADS APIs. No BFF, no intermediary.

---

## Integration Plan

### Phase 1: Add keypoint confidence to the scan pipeline

**Where:** `shoebox/processing/__init__.py`, in `process_scan_ddb()`, after the template matching step (currently lines 923-1054).

**What changes:**

Today, keypoints are read from the stored template and used to extract temperatures. The keypoints themselves are never re-evaluated per scan — they're static coordinates set once when the template was built.

The new behavior: after template matching extracts the foot thermograms, run the auto-keypoint models on the matched foot data and store confidence scores alongside the existing temperature asymmetry data.

```python
# After existing template matching (line ~1054 in process_scan_ddb)
# New: Run auto-keypoint detection on the matched foot thermograms

from keypoint_automation.geometric_keypoints import estimate_keypoints
from keypoint_automation.claude_keypoints import predict_keypoints_full

# Geometric model (fast, always runs)
geo_left = estimate_keypoints(left_foot_thermogram, 'left')
geo_right = estimate_keypoints(right_foot_thermogram, 'right')

# Compare model keypoints vs template keypoints
template_kps = scan.get('template_keypoints', {})
agreement_left = compute_agreement(geo_left, template_kps, 'left')
agreement_right = compute_agreement(geo_right, template_kps, 'right')

# Store on the scanCALCULATED record
scan['keypoint_confidence'] = {
    'left': agreement_left,    # per-keypoint confidence scores
    'right': agreement_right,
    'mean_confidence': ...,
    'min_confidence': ...,
    'confidence_tier': 'high' | 'medium' | 'low',
    'review_required': bool,
}
```

**New DynamoDB fields on `scanCALCULATED`:**

| Field | Type | Description |
|---|---|---|
| `keypoint_confidence` | Map | Per-keypoint confidence scores and tier |
| `keypoint_confidence.left` | Map | `{keypoint_name: {confidence: float, model_x: float, model_y: float}}` |
| `keypoint_confidence.right` | Map | Same structure |
| `keypoint_confidence.mean_confidence` | Number | Average confidence across all keypoints |
| `keypoint_confidence.min_confidence` | Number | Lowest confidence keypoint |
| `keypoint_confidence.confidence_tier` | String | `high` (>0.7), `medium` (0.4-0.7), `low` (<0.4) |
| `keypoint_confidence.review_required` | Boolean | True if any keypoint below threshold |

**Confidence computation:**
- Run geometric model on the scan's matched foot thermogram
- Compare model-predicted keypoint positions against the template's stored keypoints
- Agreement = 1.0 - normalized_distance(model_prediction, template_keypoint)
- If distance > threshold → low confidence → flag for review

**Claude Vision (Phase 2 only):** Initially only the geometric model runs in the pipeline (it's fast — no API call). Claude is reserved for the review UI where an operator can trigger it on demand for a specific scan.

### Phase 2: Add the review queue API

**New API endpoints in PADS:**

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/scans/review-queue` | List scans requiring review, filterable by tier, patient, date range |
| `GET` | `/api/v1/scans/review-queue/summary` | Counts by confidence tier for the dashboard cards |
| `POST` | `/api/v1/scans/{scan_id}/review` | Submit a review decision (approve, reject, manual_override) |
| `POST` | `/api/v1/scans/{scan_id}/keypoints-override` | Operator submits corrected keypoints for a scan |

**Implementation in PADS:**

The review queue is a **DynamoDB query** — not a separate table. It uses the existing `scanCALCULATED` records with the new `keypoint_confidence` fields.

```
GET /scans/review-queue?tier=low&start_date=2026-03-24&end_date=2026-03-24

→ Query GSI on type='scanCALCULATED', filter keypoint_confidence.confidence_tier='low'
```

For efficient querying, add a new GSI:

| GSI | PK | SK | Projected |
|---|---|---|---|
| `confidence-tier-index` | `keypoint_confidence.confidence_tier` | `when_scan_completed` | All |

This lets the dashboard query "all low-confidence scans from today" without a table scan.

**Review submission:**

```json
POST /api/v1/scans/{scan_id}/review
{
  "action": "approve" | "reject" | "manual_override",
  "reviewer": "operator@podimetrics.com",
  "corrected_keypoints": {  // only for manual_override
    "Hallux": {"left_normalized_coordinate": {"x": 0.4, "y": 0.1}, ...},
    ...
  }
}
```

On `manual_override`:
1. Update the patient's current template keypoints (same as `patient_keypoints_updated` event)
2. Trigger `process_new_template_patient_scans` to reprocess recent scans with corrected keypoints
3. Mark scan as reviewed in a new `review_status` field on scanCALCULATED

### Phase 3: Replace templates with scan-direct keypoints

This is the long-term vision: **eliminate the template entirely**. Instead of building a template once and matching every scan against it, detect keypoints directly on each incoming scan.

**Pipeline change:**

```
Current:   thermogram → match against template → extract temps at template keypoints
Future:    thermogram → detect feet → predict keypoints per scan → extract temps at predicted keypoints
```

The auto-keypoint models (geometric + Claude ensemble) replace the template matching step. The `template_mismatch` status goes away because there's no template to mismatch against.

**What this means for the shoebox pipeline:**
- Remove the template retrieval and matching steps
- Add keypoint prediction step (geometric model is ~10ms, runs inline)
- Claude model is called only for low-confidence scans (async, via SQS)
- High-confidence scans proceed immediately; low-confidence ones enter the review queue

**Migration path:**
1. Phase 1 runs alongside existing templates (additive — no behavior change)
2. Phase 2 adds the review UI (operators start seeing confidence data)
3. Phase 3 runs both old and new in parallel, comparing results
4. Phase 4 switches to scan-direct keypoints as primary, templates as fallback
5. Phase 5 removes templates entirely

---

## What changes in each codebase

### PADS-core changes

| Area | File | Change |
|---|---|---|
| Scan pipeline | `shoebox/processing/__init__.py` | Add keypoint confidence computation after template matching |
| Keypoint models | `shoebox/keypoint_automation/` | Copy geometric_keypoints.py into shoebox as a new module |
| DynamoDB | `lambdas/layers/podi_dynamo_connector/scan_service.py` | Store `keypoint_confidence` fields |
| API handler | `lambdas/functions/api_handler/lambda_function.py` | Add `/scans/review-queue` route |
| New handler | `lambdas/functions/review_handler/lambda_function.py` | Review queue queries and review submission |
| Terraform | `terraform/` | New Lambda, DynamoDB GSI, IAM permissions |
| Patient API | `lambdas/functions/patients_handler/` | Expose `keypoint_confidence` in scan list responses |

### template-automation (frontend) changes

| Area | File | Change |
|---|---|---|
| Dashboard | `src/routes/dashboard.tsx` | Replace mock data with real API calls to `/scans/review-queue` |
| Review detail | `src/routes/review.$reviewId.tsx` | Fetch real scan data + thermogram, render actual keypoint overlay |
| Review actions | Review detail page | POST to `/scans/{scan_id}/review` on approve/reject/override |
| Services | `src/services/review.ts` | New service file for review queue API calls |

### No changes needed

- The auto-keypoints demo page stays as-is (it's a research/demo tool)
- The manual template build page stays as-is (it's the fallback workflow)
- The Python keypoint server (`keypoint_automation/server.py`) remains a development tool — it doesn't deploy to production

---

## Deployment sequence

1. **PADS feature branch:** Add `keypoint_confidence` fields to scan pipeline (Phase 1). Deploy to `tmplt` feature env. Verify scans get confidence scores without breaking existing behavior.

2. **Frontend update:** Point dashboard at real review-queue API. Deploy to same feature env.

3. **Validation:** Run against TT-0002 and other test patients. Compare model keypoints vs template keypoints. Measure agreement rates.

4. **Dev merge:** After validation, merge to `dev`. The review queue becomes available to the ops team on `app.dev.podimetrics.com`.

5. **UAT/Prod:** Standard promotion path. The review queue is read-only in Phase 1 — it shows data but doesn't change any behavior. Low risk.

---

## Scale considerations

**Production volume: 20,000–30,000 scans/day.**

This is the critical constraint that shapes every decision:

### Geometric model (inline in pipeline): viable

The geometric model (`estimate_keypoints`) is pure numpy/scipy — ~10ms per foot, no I/O. At 30k scans/day that's ~5 minutes of aggregate CPU time, spread across the ECS fleet. This adds negligible latency to the existing 2-5 second pipeline and can safely run inline on every scan.

### Claude Vision API (on every scan): not viable

At 30k scans/day × 2 feet × ~$0.01-0.03 per API call = **$600–$1,800/day** in Anthropic API costs. Plus 5-15 seconds latency per call would more than double pipeline time. Even parallelized, the throughput bottleneck is significant.

**Claude must be reserved for the review queue only.** The operator triggers it on-demand for specific scans they're reviewing. At the expected review rate (~1-5% of scans flagged, operator reviews a subset), that's maybe 50-200 Claude calls/day — manageable at ~$2-6/day.

### DynamoDB GSI at scale

A new GSI on `confidence_tier` + `when_scan_completed` means 30k additional index writes/day. At ~$1.25 per million WCU, this is ~$0.04/day. Negligible. However, the GSI must be provisioned for burst capacity during peak scan hours (6-10am when patients step on mats).

### Review queue query patterns

At 30k scans/day, even a 5% low/medium flag rate = 1,500 items in the review queue daily. The dashboard query must be efficient:
- GSI query by `confidence_tier` + date range is O(result set), not O(table) — this scales fine
- Pagination is essential (already implemented in the frontend mock)
- Consider a TTL on the review status: auto-expire approved items after 30 days to keep the index lean

---

## Open questions

1. **Flag rate tuning:** At 30k scans/day, even a 1% false-positive rate on the geometric model means 300 scans flagged for review daily. The confidence thresholds need to be tuned against production data before launch. Too sensitive = ops drowns in reviews; too lenient = missed issues.

2. **Async Claude tier:** For scans where the geometric model is uncertain (medium tier), should PADS automatically queue a Claude call via SQS, then update the scan record when the result arrives? This would enrich the review queue with Claude's assessment before the operator opens it, without blocking the main pipeline. Cost: proportional to medium-tier volume only.

3. **Backfill:** Retroactively running the geometric model on historical scans would require reading thermograms from S3. At 30k/day × 14 days = 420k scans. This is a batch job, not inline — probably a Step Function that processes scans in parallel batches.

4. **Template elimination timeline:** With 30k scans/day, even a brief period of degraded keypoint quality affects thousands of patients. The parallel-run phase (old templates + new models side-by-side) needs to be measured in weeks, not days. Suggest: 2 weeks parallel on dev, 2 weeks on UAT, 4 weeks on prod with kill switch.

5. **Monitoring at scale:** The existing Slack alert fires at `mismatch_count >= 10`. A similar alert is needed for confidence: if the percentage of low-confidence scans spikes above baseline, it may indicate a model issue or a batch of unusual patient anatomy. Add a CloudWatch metric for `confidence_tier` distribution and alarm on low-tier percentage exceeding 10%.
