import { KeypointLegend, KeypointOverlayCanvas, type KeypointResult } from '@/components/brannock/KeypointOverlayCanvas';
import { KEYPOINT_NAMES } from '@/schemas/brannock';
import { getLogoutRedirectOptions } from '@/services/auth';
import { cn } from '@/utils/classes';
import { ENV, STORAGE_KEYS } from '@/utils/constants';
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router';
import { useCallback, useState } from 'react';
import toast from 'react-hot-toast';
import axios from 'axios';
import { z } from 'zod';

// All data comes from the handoff server — no PADS API needed
const SERVER = 'http://localhost:8788';

const BrannockSearchSchema = z.object({
  patientId: z.string().optional()
});

export const Route = createFileRoute('/manual-build')({
  validateSearch: BrannockSearchSchema.parse,
  beforeLoad: async ({ location }) => {
    const authToken = localStorage.getItem(STORAGE_KEYS.PODI_TOKEN);
    if (!authToken && ENV.ENV !== 'LOCAL') {
      throw redirect(getLogoutRedirectOptions(location));
    }
  },
  component: ManualBuildPage
});

// ── Server response types ────────────────────────────────────
interface PatientInfo {
  patient_id: string;
  patient_designation: string;
  n_scans: number;
  has_template: boolean;
}

interface ScanWithThermogram {
  scan_id: string;
  when_scan_completed: string;
  thermogram: Array<Array<number>>;
}

interface BuildKeypoint {
  name: string;
  x: number | null;
  y: number | null;
  confidence: number | null;
}

interface ValidationInfo {
  overall_score: number;
  violations: Array<string>;
}

interface BuildResponse {
  left_template: Array<Array<number>> | null;
  right_template: Array<Array<number>> | null;
  left_keypoints: Array<BuildKeypoint> | null;
  right_keypoints: Array<BuildKeypoint> | null;
  left_validation: ValidationInfo | null;
  right_validation: ValidationInfo | null;
  foot_count: 'single' | 'pair';
  detected_feet: Array<'left' | 'right'>;
  quality_score: number;
  earliest_scan_id: string | null;
  n_scans_used: number;
  model_used: string;
  error: string | null;
}

function buildKeypointsToOverlay(response: BuildResponse): Array<KeypointResult> {
  return KEYPOINT_NAMES.map((name) => {
    const left = response.left_keypoints?.find((k) => k.name === name);
    const right = response.right_keypoints?.find((k) => k.name === name);
    return {
      name,
      left: left?.x != null && left?.y != null ? { x: left.x, y: left.y } : undefined,
      right: right?.x != null && right?.y != null ? { x: right.x, y: right.y } : undefined,
      leftConfidence: left?.confidence ?? null,
      rightConfidence: right?.confidence ?? null
    };
  });
}

// ── Main page ────────────────────────────────────────────────
function ManualBuildPage() {
  const { patientId: urlPatientId } = Route.useSearch();
  const navigate = useNavigate();

  const [inputValue, setInputValue] = useState(urlPatientId ?? '');
  const [patientList, setPatientList] = useState<Array<PatientInfo> | null>(null);
  const [buildResponse, setBuildResponse] = useState<BuildResponse | null>(null);
  const [buildKeypoints, setBuildKeypoints] = useState<Array<KeypointResult>>([]);
  const [isBuilding, setIsBuilding] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [buildStatus, setBuildStatus] = useState<string | null>(null);

  // Load patient list on first interaction
  const loadPatientList = useCallback(async () => {
    if (patientList) return;
    try {
      const res = await axios.get<{ patients: Array<PatientInfo> }>(`${SERVER}/patients`);
      setPatientList(res.data.patients);
    } catch {
      // non-blocking
    }
  }, [patientList]);

  const handleBuild = useCallback(async () => {
    const patientId = inputValue.trim();
    if (!patientId) return;

    setIsBuilding(true);
    setBuildError(null);
    setBuildResponse(null);
    setBuildKeypoints([]);
    setBuildStatus('Loading patient...');
    navigate({ search: { patientId } });

    try {
      // 1. Fetch patient info
      const patientRes = await axios.get<PatientInfo>(`${SERVER}/patients/${patientId}`);
      const patient = patientRes.data;
      setBuildStatus(`${patient.patient_designation} — loading ${patient.n_scans} scans...`);

      // 2. Fetch scans with thermograms inline (one request replaces N+1 PADS calls)
      const scansRes = await axios.get<{ scans: Array<ScanWithThermogram> }>(`${SERVER}/patients/${patientId}/scans`);
      const scans = scansRes.data.scans;

      if (scans.length === 0) {
        setBuildError('No scans with thermograms found for this patient.');
        setIsBuilding(false);
        setBuildStatus(null);
        return;
      }
      setBuildStatus(`Building template from ${scans.length} scans...`);

      // 3. POST to build endpoint — thermograms already loaded
      const res = await axios.post<BuildResponse>(`${SERVER}/build-template`, {
        patient_id: patientId,
        scan_ids: scans.map((s) => s.scan_id),
        thermograms: scans.map((s) => ({ scan_id: s.scan_id, thermogram: s.thermogram }))
      });

      setBuildResponse(res.data);
      setBuildKeypoints(buildKeypointsToOverlay(res.data));
      if (res.data.error) {
        setBuildError(res.data.error);
      } else {
        toast.success(`Template built from ${res.data.n_scans_used} scans`);
      }
    } catch (e: any) {
      const msg = e?.response?.data?.detail || e?.message || 'Build failed';
      setBuildError(msg);
      toast.error('Build failed');
    } finally {
      setIsBuilding(false);
      setBuildStatus(null);
    }
  }, [inputValue, navigate]);

  const hasBuild = buildResponse !== null && (buildResponse.left_template !== null || buildResponse.right_template !== null);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 p-4 lg:p-6">
      {/* Header + input */}
      <div className="rounded-lg bg-white p-4 shadow-sm">
        <h1 className="text-xl font-semibold text-black">Template Builder</h1>
        <p className="mt-1 text-sm text-gray-500">Enter a patient ID and build a template with auto-placed keypoints from their most recent scans.</p>

        <div className="mt-4 flex gap-2">
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !isBuilding && handleBuild()}
            onFocus={loadPatientList}
            placeholder="Patient ID"
            disabled={isBuilding}
            list="patient-list"
            className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm text-black placeholder-gray-400 focus:border-gray-500 focus:outline-none disabled:opacity-50"
          />
          {patientList && (
            <datalist id="patient-list">
              {patientList.map((p) => (
                <option key={p.patient_id} value={p.patient_id}>
                  {p.patient_designation} ({p.n_scans} scans)
                </option>
              ))}
            </datalist>
          )}
          <button
            onClick={handleBuild}
            disabled={!inputValue.trim() || isBuilding}
            className="cursor-pointer rounded-md bg-gray-900 px-6 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isBuilding ? 'Building...' : 'Build Template'}
          </button>
        </div>

        {/* Available patients hint */}
        {patientList && !isBuilding && !hasBuild && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {patientList.slice(0, 8).map((p) => (
              <button
                key={p.patient_id}
                onClick={() => {
                  setInputValue(p.patient_id);
                }}
                className="cursor-pointer rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-200"
              >
                {p.patient_designation} ({p.n_scans})
              </button>
            ))}
            {patientList.length > 8 && <span className="px-1 text-xs text-gray-400">+{patientList.length - 8} more</span>}
          </div>
        )}

        {isBuilding && buildStatus && (
          <div className="mt-3 flex items-center gap-2 text-sm text-gray-500">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-gray-400 border-t-transparent" />
            {buildStatus}
          </div>
        )}
        {buildError && !hasBuild && <p className="mt-3 text-sm text-red-500">{buildError}</p>}
      </div>

      {/* Results */}
      {hasBuild && buildResponse && (
        <>
          <div className="rounded-lg bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold text-black">Built Template</h3>
              <div className="flex items-center gap-2 text-xs">
                <span className="rounded bg-gray-100 px-2 py-0.5 text-gray-600">{buildResponse.model_used}</span>
                <span className="text-gray-500">{buildResponse.foot_count === 'pair' ? 'Bilateral' : 'Single foot'}</span>
                <span className="text-gray-400">|</span>
                <span className="text-gray-500">{buildResponse.n_scans_used} scans</span>
                <span className="text-gray-400">|</span>
                <span className={buildResponse.quality_score >= 0.9 ? 'text-green-600' : buildResponse.quality_score >= 0.7 ? 'text-amber-600' : 'text-red-500'}>
                  Quality: {(buildResponse.quality_score * 100).toFixed(0)}%
                </span>
              </div>
            </div>

            {(buildResponse.left_validation?.violations?.length || buildResponse.right_validation?.violations?.length) ? (
              <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2">
                <p className="text-xs font-medium text-amber-700">Anatomical validation warnings:</p>
                <ul className="mt-1 list-inside list-disc text-xs text-amber-600">
                  {buildResponse.left_validation?.violations?.map((v, i) => <li key={`l-${i}`}>Left: {v}</li>)}
                  {buildResponse.right_validation?.violations?.map((v, i) => <li key={`r-${i}`}>Right: {v}</li>)}
                </ul>
              </div>
            ) : buildResponse.quality_score >= 0.9 ? (
              <div className="mt-2 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-700">
                All anatomical validation rules passed
              </div>
            ) : null}

            {buildResponse.error && (
              <div className="mt-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">{buildResponse.error}</div>
            )}

            <div className="mt-3 flex gap-4">
              {buildResponse.right_template && (
                <div className="flex-1">
                  <p className="mb-1 text-center text-xs font-medium text-gray-500">Right Foot</p>
                  <div className="rounded bg-gray-900 p-2">
                    <KeypointOverlayCanvas
                      thermogramData={buildResponse.right_template}
                      keypoints={buildKeypoints.map((kp) => ({ ...kp, left: undefined, leftConfidence: null }))}
                      renderMode="template"
                      coordMode="single"
                    />
                  </div>
                </div>
              )}
              {buildResponse.left_template && (
                <div className="flex-1">
                  <p className="mb-1 text-center text-xs font-medium text-gray-500">Left Foot</p>
                  <div className="rounded bg-gray-900 p-2">
                    <KeypointOverlayCanvas
                      thermogramData={buildResponse.left_template}
                      keypoints={buildKeypoints.map((kp) => ({ ...kp, right: undefined, rightConfidence: null }))}
                      renderMode="template"
                      coordMode="single"
                    />
                  </div>
                </div>
              )}
            </div>
            <div className="mt-3">
              <KeypointLegend />
            </div>
          </div>

          {/* Keypoint table */}
          <div className="rounded-lg bg-white p-4 shadow-sm">
            <h3 className="text-sm font-semibold text-black">Auto-Placed Keypoints</h3>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b text-gray-500">
                    <th className="pb-2 pr-4">Keypoint</th>
                    {buildResponse.left_template && <th className="pb-2 pr-4">Left (x, y)</th>}
                    {buildResponse.right_template && <th className="pb-2">Right (x, y)</th>}
                  </tr>
                </thead>
                <tbody>
                  {buildKeypoints.map((kp) => (
                    <tr key={kp.name} className="border-b border-gray-50">
                      <td className="py-1.5 pr-4 font-medium text-gray-700">{kp.name}</td>
                      {buildResponse.left_template && (
                        <td className="py-1.5 pr-4 font-mono text-gray-600">
                          {kp.left ? `(${kp.left.x.toFixed(3)}, ${kp.left.y.toFixed(3)})` : <span className="text-gray-300">null</span>}
                        </td>
                      )}
                      {buildResponse.right_template && (
                        <td className="py-1.5 font-mono text-gray-600">
                          {kp.right ? `(${kp.right.x.toFixed(3)}, ${kp.right.y.toFixed(3)})` : <span className="text-gray-300">null</span>}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Actions */}
          <div className="rounded-lg bg-white p-4 shadow-sm">
            <h3 className="text-sm font-semibold text-black">Actions</h3>
            <p className="mt-1 text-xs text-gray-400">Review the auto-placed keypoints above. Approve to save, or adjust manually.</p>
            <div className="mt-3 flex gap-2">
              <button disabled className="cursor-not-allowed rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white opacity-50">
                Approve &amp; Save Template
              </button>
              <button disabled className="cursor-not-allowed rounded-md border border-gray-300 px-4 py-2 text-sm text-gray-600 opacity-50">
                Adjust Keypoints Manually
              </button>
            </div>
          </div>
        </>
      )}

      {/* Empty state */}
      {!hasBuild && !isBuilding && !buildError && (
        <div className="rounded-lg bg-white p-8 text-center shadow-sm">
          <p className="text-gray-400">Enter a patient ID and click Build Template to get started.</p>
          <p className="mt-1 text-xs text-gray-300">Uses the 15 most recent scans from local patient data.</p>
        </div>
      )}
    </div>
  );
}
