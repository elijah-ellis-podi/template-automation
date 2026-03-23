import { generateMockThermogram, mockPatientMetadata, mockPatients, mockScans, mockTemplateBuildResponse } from '@/mocks/brannock';
import type { BrannockPatient, BrannockScan, PatientMetadata, TemplateBuildRequest, TemplateBuildResponse, TemplateSavePayload } from '@/schemas/brannock';
import { podiAxios } from '@/utils/api';
import { ENV } from '@/utils/constants';
import { getAuthHeader } from './auth';

// ── Patient list ──────────────────────────────────────────────
// Legacy flow: GET /patients/ returns an S3 pre-signed URL, then
// fetch that URL to get the actual patient JSON array.
export const getBrannockPatients = async (): Promise<Array<BrannockPatient>> => {
  if (ENV.ENV === 'LOCAL') return Promise.resolve(mockPatients);

  const urlResponse = await podiAxios<{ patients: string }>(`${ENV.API_BASE_URL}/patients/`, {
    headers: getAuthHeader()
  });
  // urlResponse.patients is an S3 pre-signed URL
  const patientsResponse = await podiAxios<{ patients: Array<BrannockPatient> }>(
    urlResponse.patients,
    {} // no auth header needed for pre-signed S3 URL
  );
  return patientsResponse.patients.sort((a, b) => a.last_name.localeCompare(b.last_name));
};

// ── Patient metadata (scan counts for filtering) ──────────────
// Legacy: bucket.get_blob_metadata() reads 3 JSON files from cloud storage.
// TODO: Replace with actual endpoint once backend creates it.
// Expected endpoint: GET /api/v1/templates/metadata
export const getPatientMetadata = async (): Promise<PatientMetadata> => {
  if (ENV.ENV === 'LOCAL') return Promise.resolve(mockPatientMetadata);

  return podiAxios<PatientMetadata>(`${ENV.API_BASE_URL}/templates/metadata`, {
    headers: getAuthHeader()
  });
};

// ── Patient scans ─────────────────────────────────────────────
// Legacy: GET {patient.scans_url}?scan_type=user&start_date=2024-10-01&end_date={today}
// Filters out scans without mat_thermogram_url and schema_id === 9 (SM+ scans).
export const getBrannockScans = async (scansUrl: string): Promise<Array<BrannockScan>> => {
  if (ENV.ENV === 'LOCAL') return Promise.resolve(mockScans);

  const today = new Date().toISOString().split('T')[0];
  const url = `${scansUrl}?scan_type=user&start_date=2024-10-01&end_date=${today}`;
  const res = await podiAxios<{ scans: Array<BrannockScan> }>(url, {
    headers: getAuthHeader()
  });
  return res.scans.filter((scan) => scan.mat_thermogram_url && scan.schema_id !== 9);
};

// ── Thermogram fetch ──────────────────────────────────────────
// Legacy: GET {scan.mat_thermogram_url}?decimals=2
// Returns { thermogram: number[][] } — a 2D array of temperature values.
export const getMatThermogram = async (matThermogramUrl: string): Promise<Array<Array<number>>> => {
  if (ENV.ENV === 'LOCAL') return Promise.resolve(generateMockThermogram());

  const res = await podiAxios<{ thermogram: Array<Array<number>> }>(`${matThermogramUrl}?decimals=2`, {
    headers: getAuthHeader()
  });
  return res.thermogram;
};

// ── Template build ────────────────────────────────────────────
// Legacy: All computation was client-side (numpy/scipy). Now server-side.
// TODO: New endpoint needed — POST /api/v1/templates/build
//
// The server runs template.build_templates() for auto mode or
// cleats.templates.stack_thermograms() for manual mode.
//
// This may be a long-running operation (5-30s). The initial
// implementation uses a blocking POST. If build times exceed 30s,
// upgrade to an async job pattern:
//   POST /api/v1/templates/build → 202 { job_id }
//   GET  /api/v1/templates/build/{job_id} → { status, result? }
export const buildTemplate = async (request: TemplateBuildRequest): Promise<TemplateBuildResponse> => {
  if (ENV.ENV === 'LOCAL') {
    // Simulate server-side build time
    await new Promise((resolve) => setTimeout(resolve, 2000));
    return Promise.resolve(mockTemplateBuildResponse);
  }

  return podiAxios<TemplateBuildResponse>(`${ENV.API_BASE_URL}/templates/build`, {
    method: 'POST',
    headers: { ...getAuthHeader(), 'Content-Type': 'application/json' },
    data: request,
    timeout: 60000 // 60s timeout for long-running builds
  });
};

// ── Template save ─────────────────────────────────────────────
// Legacy: Uploads 2 events to cloud storage pending/ folder:
//   1. { which: "patient_template_defined", what: { template data } }
//   2. { which: "process_new_template_patient_scans", what: { patient_id, earliest_scan_id } }
//
// TODO: New endpoint needed — POST /api/v1/templates
// The server handles event creation and cloud storage upload internally.
// The payload matches the legacy event shape: { which, what }.
export const saveTemplate = async (payload: TemplateSavePayload): Promise<void> => {
  if (ENV.ENV === 'LOCAL') {
    console.log('[MOCK] saveTemplate event:', JSON.stringify(payload, null, 2).slice(0, 500) + '...');
    console.log('[MOCK] full payload keys:', Object.keys(payload));
    console.log('[MOCK] what keys:', Object.keys(payload.what));
    console.log('[MOCK] keypoints:', JSON.stringify(payload.what.keypoints, null, 2));
    return Promise.resolve();
  }

  return podiAxios<void>(`${ENV.API_BASE_URL}/templates`, {
    method: 'POST',
    headers: { ...getAuthHeader(), 'Content-Type': 'application/json' },
    data: payload
  });
};
