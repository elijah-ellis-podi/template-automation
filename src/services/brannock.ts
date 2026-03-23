import { mockPatientMetadata, mockPatients, mockScans, mockTemplateBuildResponse, mockThermogram } from '@/mocks/brannock';
import type { BrannockPatient, BrannockScan, PatientMetadata, TemplateBuildRequest, TemplateBuildResponse, TemplateSavePayload } from '@/schemas/brannock';
import { podiAxios } from '@/utils/api';
import { ENV } from '@/utils/constants';
import { getAuthHeader } from './auth';

// ── Patient list ──────────────────────────────────────────────
// GET /patients returns { patients: "<s3-presigned-url>" }.
// Then fetch that URL for the actual patient JSON array.
export const getBrannockPatients = async (): Promise<Array<BrannockPatient>> => {
  if (ENV.ENV === 'LOCAL') return Promise.resolve(mockPatients);

  const urlResponse = await podiAxios<{ patients: string }>(`${ENV.API_BASE_URL}/patients`, {
    headers: getAuthHeader()
  });
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

  // This endpoint doesn't exist yet — return empty metadata so the app
  // still works against real environments (filters just won't narrow).
  try {
    return await podiAxios<PatientMetadata>(`${ENV.API_BASE_URL}/templates/metadata`, {
      headers: getAuthHeader()
    });
  } catch {
    return {
      number_of_scans_for_patients_without_templates: {},
      number_of_single_foot_scans_for_single_foot_patients: {},
      number_of_single_foot_scans_for_two_feet_patients: {}
    };
  }
};

// ── Patient scans ─────────────────────────────────────────────
// GET {patient.scans_url}?scan_type=user&start_date=...&end_date=...
// Filters: must have mat_thermogram_url AND schema_id !== 9.
// Note: schema_id may come as float (4104.0) in some envs.
export const getBrannockScans = async (scansUrl: string): Promise<Array<BrannockScan>> => {
  if (ENV.ENV === 'LOCAL') return Promise.resolve(mockScans);

  const today = new Date().toISOString().split('T')[0];
  const url = `${scansUrl}?scan_type=user&start_date=2024-10-01&end_date=${today}`;
  const res = await podiAxios<{ scans: Array<BrannockScan> }>(url, {
    headers: getAuthHeader()
  });
  return res.scans.filter((scan) => {
    if (!scan.mat_thermogram_url) return false;
    // schema_id may be null, int, or float — coerce to number for comparison
    const schemaId = scan.schema_id != null ? Math.round(Number(scan.schema_id)) : null;
    if (schemaId === 9) return false;
    return true;
  });
};

// ── Thermogram fetch ──────────────────────────────────────────
// GET {scan.mat_thermogram_url}?decimals=2
// Returns { thermogram: number[][] } — a 2D array of temperature values.
export const getMatThermogram = async (matThermogramUrl: string): Promise<Array<Array<number>>> => {
  if (ENV.ENV === 'LOCAL') return Promise.resolve(mockThermogram);

  const res = await podiAxios<{ thermogram: Array<Array<number>> }>(`${matThermogramUrl}?decimals=2`, {
    headers: getAuthHeader()
  });
  return res.thermogram;
};

// ── Template build ────────────────────────────────────────────
// TODO: New endpoint needed — POST /api/v1/templates/build
// Uses mock in LOCAL. In real environments this endpoint doesn't exist yet,
// so the mutation will fail with a server error until the backend implements it.
export const buildTemplate = async (request: TemplateBuildRequest): Promise<TemplateBuildResponse> => {
  if (ENV.ENV === 'LOCAL') {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    return Promise.resolve(mockTemplateBuildResponse);
  }

  return podiAxios<TemplateBuildResponse>(`${ENV.API_BASE_URL}/templates/build`, {
    method: 'POST',
    headers: { ...getAuthHeader(), 'Content-Type': 'application/json' },
    data: request,
    timeout: 60000
  });
};

// ── Template save ─────────────────────────────────────────────
// TODO: New endpoint needed — POST /api/v1/templates
// Uses mock in LOCAL. Payload: { which: "patient_template_defined", what: {...} }
export const saveTemplate = async (payload: TemplateSavePayload): Promise<void> => {
  if (ENV.ENV === 'LOCAL') {
    console.log('[MOCK] saveTemplate event:', JSON.stringify(payload, null, 2).slice(0, 500) + '...');
    console.log('[MOCK] keypoints:', JSON.stringify(payload.what.keypoints, null, 2));
    return Promise.resolve();
  }

  return podiAxios<void>(`${ENV.API_BASE_URL}/templates`, {
    method: 'POST',
    headers: { ...getAuthHeader(), 'Content-Type': 'application/json' },
    data: payload
  });
};
