import { KeypointLegend, KeypointOverlayCanvas, type KeypointResult } from '@/components/brannock/KeypointOverlayCanvas';
import type { BrannockScan } from '@/schemas/brannock';
import { KEYPOINT_NAMES } from '@/schemas/brannock';
import { getAuthHeader, getLogoutRedirectOptions } from '@/services/auth';
import { cn } from '@/utils/classes';
import { podiAxios } from '@/utils/api';
import { ENV, STORAGE_KEYS } from '@/utils/constants';
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router';
import { useCallback, useState } from 'react';
import toast from 'react-hot-toast';
import axios from 'axios';
import { z } from 'zod';

const PADS_API = ENV.DEV_API_BASE_URL;
const BUILD_SERVER = 'http://localhost:8788';
const MAX_SCANS = 15;

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

// ── PADS API calls ───────────────────────────────────────────
interface PatientInfo {
  patient_id: string;
  patient_designation?: string;
  scans_url: string;
  template_id?: string | null;
}

async function fetchPatient(patientId: string): Promise<PatientInfo> {
  const res = await podiAxios<{ patient: PatientInfo }>(`${PADS_API}/patients/${patientId}`, { headers: getAuthHeader() });
  return res.patient;
}

// Ground truth keypoints from the existing PADS template
interface GroundTruthKeypoints {
  keypoints: Record<string, {
    left_normalized_coordinate?: { x: number; y: number };
    right_normalized_coordinate?: { x: number; y: number };
  }>;
}

async function fetchGroundTruthKeypoints(templateId: string): Promise<GroundTruthKeypoints> {
  return podiAxios<GroundTruthKeypoints>(`${PADS_API}/templates/keypoints/${templateId}`, { headers: getAuthHeader() });
}

function groundTruthToOverlay(gt: GroundTruthKeypoints): Array<KeypointResult> {
  return KEYPOINT_NAMES.map((name) => {
    const entry = gt.keypoints[name];
    return {
      name,
      left: entry?.left_normalized_coordinate ? { x: entry.left_normalized_coordinate.x, y: entry.left_normalized_coordinate.y } : undefined,
      right: entry?.right_normalized_coordinate ? { x: entry.right_normalized_coordinate.x, y: entry.right_normalized_coordinate.y } : undefined
    };
  });
}

async function fetchScans(scansUrl: string): Promise<Array<BrannockScan>> {
  const today = new Date().toISOString().split('T')[0];
  const url = `${scansUrl}?scan_type=user&start_date=2024-10-01&end_date=${today}`;
  const res = await podiAxios<{ scans: Array<BrannockScan> }>(url, { headers: getAuthHeader() });
  return res.scans.filter((s) => !!s.mat_thermogram_url).slice(0, MAX_SCANS);
}

async function fetchThermogram(matThermogramUrl: string): Promise<Array<Array<number>>> {
  const res = await podiAxios<{ thermogram: Array<Array<number>> }>(`${matThermogramUrl}?decimals=2`, { headers: getAuthHeader() });
  return res.thermogram;
}

// ── Build backend types ──────────────────────────────────────
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
  const [buildResponse, setBuildResponse] = useState<BuildResponse | null>(null);
  const [buildKeypoints, setBuildKeypoints] = useState<Array<KeypointResult>>([]);
  const [groundTruth, setGroundTruth] = useState<Array<KeypointResult> | null>(null);
  const [isBuilding, setIsBuilding] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [buildStatus, setBuildStatus] = useState<string | null>(null);

  const handleBuild = useCallback(async () => {
    const patientId = inputValue.trim();
    if (!patientId) return;

    setIsBuilding(true);
    setBuildError(null);
    setBuildResponse(null);
    setBuildKeypoints([]);
    setGroundTruth(null);
    setBuildStatus('Loading patient...');
    navigate({ search: { patientId } });

    try {
      // 1. Fetch patient
      const patient = await fetchPatient(patientId);
      setBuildStatus(`Patient ${patient.patient_designation || patientId.slice(0, 12)} — loading scans...`);

      // Ground truth fetch disabled for demo
      // if (patient.template_id) {
      //   fetchGroundTruthKeypoints(patient.template_id)
      //     .then((gt) => setGroundTruth(groundTruthToOverlay(gt)))
      //     .catch(() => {});
      // }

      // 2. Fetch scans (up to 15 most recent with thermograms)
      const scans = await fetchScans(patient.scans_url);
      if (scans.length === 0) {
        setBuildError('No scans with thermograms found for this patient.');
        setIsBuilding(false);
        setBuildStatus(null);
        return;
      }
      setBuildStatus(`Fetching ${scans.length} thermogram${scans.length !== 1 ? 's' : ''}...`);

      // 3. Fetch all thermograms in parallel
      const thermogramPromises = scans.map(async (scan) => {
        const thermogram = await fetchThermogram(scan.mat_thermogram_url!);
        return { scan_id: scan.scan_id, thermogram };
      });
      const thermograms = await Promise.all(thermogramPromises);
      setBuildStatus(`Building template from ${thermograms.length} scans...`);

      // 4. POST to build backend
      const res = await axios.post<BuildResponse>(`${BUILD_SERVER}/build-template`, {
        patient_id: patientId,
        scan_ids: scans.map((s) => s.scan_id),
        thermograms
      });

      setBuildResponse(res.data);
      setBuildKeypoints(buildKeypointsToOverlay(res.data));
      if (res.data.error) {
        setBuildError(res.data.error);
      } else {
        toast.success('Template built with auto-placed keypoints');
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
            placeholder="Patient ID"
            disabled={isBuilding}
            className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm text-black placeholder-gray-400 focus:border-gray-500 focus:outline-none disabled:opacity-50"
          />
          <button
            onClick={handleBuild}
            disabled={!inputValue.trim() || isBuilding}
            className="cursor-pointer rounded-md bg-gray-900 px-6 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isBuilding ? 'Building...' : 'Build Template'}
          </button>
        </div>

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
          {/* Template visualization with keypoints */}
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
                All anatomical validation rules passed — auto-accept eligible
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
                      groundTruth={groundTruth?.map((kp) => ({ ...kp, left: undefined })) ?? undefined}
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
                      groundTruth={groundTruth?.map((kp) => ({ ...kp, right: undefined })) ?? undefined}
                      renderMode="template"
                      coordMode="single"
                    />
                  </div>
                </div>
              )}
            </div>
            <div className="mt-3">
              <KeypointLegend showGroundTruth={!!groundTruth} />
            </div>
          </div>

          {/* Keypoint comparison table: model vs ground truth */}
          <div className="rounded-lg bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-black">Keypoint Comparison</h3>
              {groundTruth && <span className="rounded bg-blue-100 px-2 py-0.5 text-xs text-blue-700">Ground truth from existing template</span>}
            </div>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b text-gray-500">
                    <th className="pb-2 pr-3">Keypoint</th>
                    {buildResponse.left_template && <th className="pb-2 pr-3">Model L (x, y)</th>}
                    {buildResponse.left_template && groundTruth && <th className="pb-2 pr-3">GT L (x, y)</th>}
                    {buildResponse.left_template && groundTruth && <th className="pb-2 pr-3">L Err</th>}
                    {buildResponse.left_template && !groundTruth && <th className="pb-2 pr-3">L Conf</th>}
                    {buildResponse.right_template && <th className="pb-2 pr-3">Model R (x, y)</th>}
                    {buildResponse.right_template && groundTruth && <th className="pb-2 pr-3">GT R (x, y)</th>}
                    {buildResponse.right_template && groundTruth && <th className="pb-2">R Err</th>}
                    {buildResponse.right_template && !groundTruth && <th className="pb-2">R Conf</th>}
                  </tr>
                </thead>
                <tbody>
                  {buildKeypoints.map((kp) => {
                    const gt = groundTruth?.find((g) => g.name === kp.name);
                    const fmtCoord = (c: { x: number; y: number } | undefined | null) =>
                      c ? `(${c.x.toFixed(3)}, ${c.y.toFixed(3)})` : <span className="text-gray-300">—</span>;
                    const fmtConf = (c: number | null | undefined) => {
                      if (c == null) return <span className="text-gray-300">—</span>;
                      const color = c >= 0.7 ? 'text-green-600' : c >= 0.4 ? 'text-amber-600' : 'text-red-500';
                      return <span className={color}>{Math.round(c * 100)}%</span>;
                    };
                    const dist = (a: { x: number; y: number } | undefined | null, b: { x: number; y: number } | undefined | null) => {
                      if (!a || !b) return null;
                      return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
                    };
                    const fmtErr = (d: number | null) => {
                      if (d == null) return <span className="text-gray-300">—</span>;
                      const color = d < 0.05 ? 'text-green-600' : d < 0.1 ? 'text-amber-600' : 'text-red-500';
                      return <span className={cn('font-mono', color)}>{d.toFixed(4)}</span>;
                    };
                    const leftErr = dist(kp.left, gt?.left);
                    const rightErr = dist(kp.right, gt?.right);

                    return (
                      <tr key={kp.name} className="border-b border-gray-50">
                        <td className="py-1.5 pr-3 font-medium text-gray-700">{kp.name}</td>
                        {buildResponse.left_template && <td className="py-1.5 pr-3 font-mono text-gray-600">{fmtCoord(kp.left)}</td>}
                        {buildResponse.left_template && groundTruth && <td className="py-1.5 pr-3 font-mono text-blue-600">{fmtCoord(gt?.left)}</td>}
                        {buildResponse.left_template && groundTruth && <td className="py-1.5 pr-3">{fmtErr(leftErr)}</td>}
                        {buildResponse.left_template && !groundTruth && <td className="py-1.5 pr-3">{fmtConf(kp.leftConfidence)}</td>}
                        {buildResponse.right_template && <td className="py-1.5 pr-3 font-mono text-gray-600">{fmtCoord(kp.right)}</td>}
                        {buildResponse.right_template && groundTruth && <td className="py-1.5 pr-3 font-mono text-blue-600">{fmtCoord(gt?.right)}</td>}
                        {buildResponse.right_template && groundTruth && <td className="py-1.5">{fmtErr(rightErr)}</td>}
                        {buildResponse.right_template && !groundTruth && <td className="py-1.5">{fmtConf(kp.rightConfidence)}</td>}
                      </tr>
                    );
                  })}
                </tbody>
                {groundTruth && (
                  <tfoot>
                    <tr className="border-t">
                      <td className="pt-2 pr-3 font-medium text-gray-500">Mean Error</td>
                      {buildResponse.left_template && <td></td>}
                      {buildResponse.left_template && <td></td>}
                      {buildResponse.left_template && (
                        <td className="pt-2 pr-3">
                          {(() => {
                            const errs = buildKeypoints.map((kp) => {
                              const gt2 = groundTruth?.find((g) => g.name === kp.name);
                              if (!kp.left || !gt2?.left) return null;
                              return Math.sqrt((kp.left.x - gt2.left.x) ** 2 + (kp.left.y - gt2.left.y) ** 2);
                            }).filter((e): e is number => e !== null);
                            if (errs.length === 0) return <span className="text-gray-300">—</span>;
                            const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
                            const color = mean < 0.05 ? 'text-green-600' : mean < 0.1 ? 'text-amber-600' : 'text-red-500';
                            return <span className={cn('font-mono font-semibold', color)}>{mean.toFixed(4)}</span>;
                          })()}
                        </td>
                      )}
                      {buildResponse.right_template && <td></td>}
                      {buildResponse.right_template && <td></td>}
                      {buildResponse.right_template && (
                        <td className="pt-2">
                          {(() => {
                            const errs = buildKeypoints.map((kp) => {
                              const gt2 = groundTruth?.find((g) => g.name === kp.name);
                              if (!kp.right || !gt2?.right) return null;
                              return Math.sqrt((kp.right.x - gt2.right.x) ** 2 + (kp.right.y - gt2.right.y) ** 2);
                            }).filter((e): e is number => e !== null);
                            if (errs.length === 0) return <span className="text-gray-300">—</span>;
                            const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
                            const color = mean < 0.05 ? 'text-green-600' : mean < 0.1 ? 'text-amber-600' : 'text-red-500';
                            return <span className={cn('font-mono font-semibold', color)}>{mean.toFixed(4)}</span>;
                          })()}
                        </td>
                      )}
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
            {!groundTruth && <p className="mt-2 text-xs text-gray-300">No existing template found for this patient — ground truth comparison unavailable.</p>}
          </div>

          {/* Actions placeholder */}
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
            <p className="mt-2 text-xs text-gray-300">Save actions will be connected to the PADS events API.</p>
          </div>
        </>
      )}

      {/* Empty state */}
      {!hasBuild && !isBuilding && !buildError && (
        <div className="rounded-lg bg-white p-8 text-center shadow-sm">
          <p className="text-gray-400">Enter a patient ID and click Build Template to get started.</p>
          <p className="mt-1 text-xs text-gray-300">The {MAX_SCANS} most recent scans will be used automatically.</p>
        </div>
      )}
    </div>
  );
}
