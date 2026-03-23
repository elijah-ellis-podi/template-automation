import { z } from 'zod';

// ── Patient (from API) ────────────────────────────────────────
// In the real API, first_name is often empty and last_name holds the
// patient_designation (e.g. "DH-1838"). patient_designation is the
// canonical display name.
export const BrannockPatientSchema = z.object({
  patient_id: z.string(),
  first_name: z.string(),
  last_name: z.string(),
  affiliations: z.array(z.string().nullable()),
  scans_url: z.string(),
  patient_designation: z.string().nullish(),
  template_id: z.string().nullish(),
  template_type: z.string().nullish()
});
export type BrannockPatient = z.infer<typeof BrannockPatientSchema>;

// ── Scan (only the fields brannock uses) ──────────────────────
export const BrannockScanSchema = z.object({
  scan_id: z.string(),
  when_scan_completed: z.string(),
  mat_thermogram_url: z.string().nullable(),
  schema_id: z.number().nullable()
});
export type BrannockScan = z.infer<typeof BrannockScanSchema>;

// ── Metadata from cloud storage (scan counts for filtering) ───
export const PatientMetadataSchema = z.object({
  number_of_scans_for_patients_without_templates: z.record(z.string(), z.number()),
  number_of_single_foot_scans_for_single_foot_patients: z.record(z.string(), z.number()),
  number_of_single_foot_scans_for_two_feet_patients: z.record(z.string(), z.number())
});
export type PatientMetadata = z.infer<typeof PatientMetadataSchema>;

// ── Keypoint coordinate ───────────────────────────────────────
export const NormalizedCoordinateSchema = z
  .object({
    x: z.number(),
    y: z.number()
  })
  .nullable();
export type NormalizedCoordinate = z.infer<typeof NormalizedCoordinateSchema>;

// ── Single keypoint (left + right) ───────────────────────────
export const KeypointLocationSchema = z.object({
  left_normalized_coordinate: NormalizedCoordinateSchema,
  right_normalized_coordinate: NormalizedCoordinateSchema
});
export type KeypointLocation = z.infer<typeof KeypointLocationSchema>;

// ── All 6 keypoints ──────────────────────────────────────────
export const KEYPOINT_NAMES = ['Hallux', '1st Metatarsal Head', '3rd Metatarsal Head', '5th Metatarsal Head', 'Arch', 'Heel'] as const;
export type KeypointName = (typeof KEYPOINT_NAMES)[number];

export type Keypoints = Record<KeypointName, KeypointLocation>;

// ── Template build modes ─────────────────────────────────────
export const TEMPLATE_MODES = ['auto', 'manual'] as const;
export type TemplateMode = (typeof TEMPLATE_MODES)[number];

// ── Template build request (sent to server) ──────────────────
export const TemplateBuildRequestSchema = z.object({
  patient_id: z.string(),
  scan_ids: z.array(z.string()),
  mode: z.enum(TEMPLATE_MODES)
});
export type TemplateBuildRequest = z.infer<typeof TemplateBuildRequestSchema>;

// ── Template build response (from server) ────────────────────
export const TemplateBuildResponseSchema = z.object({
  left_foot: z.array(z.array(z.number())).nullable(),
  right_foot: z.array(z.array(z.number())).nullable(),
  left_threshold: z.number(),
  right_threshold: z.number(),
  earliest_scan_id: z.string(),
  date_created: z.string(),
  foot_side: z.number().nullable(), // 1 = left, 0 = right, null = bilateral
  // Optional: pre-rendered contour images as base64 or URLs
  left_contour_image_url: z.string().nullable().optional(),
  right_contour_image_url: z.string().nullable().optional()
});
export type TemplateBuildResponse = z.infer<typeof TemplateBuildResponseSchema>;

// ── Template save: inner "what" content ──────────────────────
export const TemplateSaveWhatSchema = z.object({
  patient_id: z.string(),
  left_foot: z.array(z.array(z.number())).nullable(),
  right_foot: z.array(z.array(z.number())).nullable(),
  left_threshold: z.number(),
  right_threshold: z.number(),
  keypoints: z.record(z.string(), KeypointLocationSchema),
  earliest_scan_id: z.string().optional(),
  date_created: z.string().optional()
});
export type TemplateSaveWhat = z.infer<typeof TemplateSaveWhatSchema>;

// ── Template save event payload (matches legacy bucket event shape) ──
// Legacy uploads two events:
//   1. { which: "patient_template_defined", what: { ...template data } }
//   2. { which: "process_new_template_patient_scans", what: { patient_id, earliest_scan_id } }
export const TemplateSavePayloadSchema = z.object({
  which: z.string(),
  what: TemplateSaveWhatSchema
});
export type TemplateSavePayload = z.infer<typeof TemplateSavePayloadSchema>;

// ── Patient filter options ───────────────────────────────────
export const PATIENT_FILTERS = ['showDemo', 'requiresTemplate', 'singleFoot', 'hasSingleFootScan'] as const;
export type PatientFilter = (typeof PATIENT_FILTERS)[number];
