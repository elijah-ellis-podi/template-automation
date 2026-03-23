# API Discovery — tmplt.dev.podimetrics.com

Date: 2026-03-23

## Authentication

- **Endpoint**: `POST /api/v1/sessions` (no trailing slash)
- **Content-Type**: `application/json` (NOT `x-www-form-urlencoded`)
- **Body**: `{ "user_id": "...", "password": "..." }`
- **Response**: `{ "message": "...", "session_id": "<jwt>", "where_to": "..." }`
- **Token**: JWT stored as `session_id`. Used in `Authorization: Bearer <token>` header.
- **Important**: trailing slash on `/sessions/` returns 502. Must be `/sessions`.

## Patient list

- **Endpoint**: `GET /api/v1/patients`
- **Response**: `{ "patients": "<s3-presigned-url>", "data_source": "s3", "data_source_format": "url" }`
- Then fetch the S3 URL (no auth needed): `{ "patients": [...] }`
- **Patient count in env**: 61
- **Patient shape** (relevant fields):
  - `patient_id`, `first_name` (often empty), `last_name` (often equals designation)
  - `patient_designation` — the canonical display name (e.g., "TT-0001")
  - `affiliations` — array, often `[null]` in dev
  - `scans_url` — full URL for this patient's scans endpoint
  - `template_id` — string if template exists, else null
  - `template_type` — "bilateral" | null
  - `customer`, `site` — optional metadata

## Patient scans

- **Endpoint**: `GET /api/v1/patients/{patient_id}/scans`
- **Query params**: `scan_type=user`, `start_date=...`, `end_date=...` (all optional)
- **Response**: `{ "scans": [...] }`
- **Scan shape** (relevant fields):
  - `scan_id`, `when_scan_completed`, `mat_thermogram_url` (null if no thermogram)
  - `schema_id` — **comes as float** (e.g., `4104.0`) not int. Some scans have `null`.
  - `scan_type` — some scans have `null` (especially TT-0001's synthetic scans)
  - `scan_status` — may be null
  - `foot_present`, `left_footness`, `right_footness`, `battery_voltage`, `is_elevated_scan`
- **Filtering note**: `scan_type=user` filter returns 0 results for patients whose scans don't have the field set

## Thermograms

- **Endpoint**: `GET /api/v1/thermograms/{scan_id}/mat?decimals=2`
- **Response**: `{ "thermogram": [[number, ...], ...] }`
- **Typical size**: 140 rows x 205 cols
- **Temperature range**: ~17-31°C

## Patient data availability

| Designation | Patient ID | Total scans | With mat_thermogram | Notes |
|---|---|---|---|---|
| TT-0001 | 64baf22a... | 31 | 0 | schema_id/scan_type all null — synthetic test scans |
| TT-0002 | fa4a5652... | 29 | 15 | Best data — 15 user scans with thermograms |
| TT-0906 | 0df791d8... | 1 | 1 | Single scan |
| TT-1108 | 3e0ae387... | 1 | 1 | Single scan |
| RM-3226 | f2105822... | 1 | 1 | Older scan (2023-11) |
| JD-022952 | 3c0cb0a1... | 20 | 6 | Good data — 6 scans with thermograms |
| RA-042239 | f20af594... | 1 | 1 | Single scan |
| SL-3865 | d0a4e85a... | 0 | 0 | No scans endpoint returned empty/error |

**Best test patients**: TT-0002 (15 scans) and JD-022952 (6 scans).

## Open questions

1. **Metadata endpoint** (`GET /templates/metadata`) doesn't exist yet. The app falls back to empty metadata so filtering checkboxes won't narrow results until this is built.
2. **Build endpoint** (`POST /templates/build`) doesn't exist yet. Auto/Manual build will fail in DEV. Only LOCAL mode (mock) works for the build workflow.
3. **Save endpoint** (`POST /templates`) doesn't exist yet. Same situation.
4. **TT-0001 scans** have null for all metadata fields — these appear to be synthetic scans that didn't go through the normal pipeline. The `scan_type=user` filter correctly excludes them.
5. **SL-3865** returned an error on the scans endpoint — may not be fully set up.

## Changes made to the codebase

1. **`constants.ts`**: DEV API base URL now uses `location.hostname` (the app and API share the same CloudFront domain)
2. **`auth.ts`**: Login uses `Content-Type: application/json`, no trailing slash on `/sessions`, body is JSON object (not stringified form data)
3. **`brannock.ts`**: Removed trailing slashes on `/patients`. `schema_id` filter uses `Math.round(Number(...))` to handle float values. `getPatientMetadata` catches errors and returns empty metadata for environments where the endpoint doesn't exist yet.
4. **`brannock.ts` schema**: Added `patient_designation`, `template_id`, `template_type` to `BrannockPatientSchema`
5. **`PatientSelector.tsx`**: Uses `patient_designation` as primary display name. Shows template status badge (green "has template" / amber scan count / gray "no template"). Fuzzy search includes designation.
