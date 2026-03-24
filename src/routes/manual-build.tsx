import { KeypointLegend, KeypointOverlayCanvas, type KeypointResult } from '@/components/brannock/KeypointOverlayCanvas';
import { ThermogramHeatmap } from '@/components/brannock/ThermogramHeatmap';
import type { BrannockScan, KeypointLocation, KeypointName } from '@/schemas/brannock';
import { KEYPOINT_NAMES } from '@/schemas/brannock';
import { getAuthHeader, getLogoutRedirectOptions } from '@/services/auth';
import { cn } from '@/utils/classes';
import { podiAxios } from '@/utils/api';
import { ENV, STORAGE_KEYS } from '@/utils/constants';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router';
import { type FC, useCallback, useState } from 'react';
import toast from 'react-hot-toast';
import axios from 'axios';
import { z } from 'zod';

const PADS_API = ENV.DEV_API_BASE_URL;

// Template build backend — to be implemented.
// This service accepts scan thermograms and returns a built template + auto-placed keypoints.
// See BUILD_BACKEND_SPEC.md for the contract.
const BUILD_SERVER = 'http://localhost:8787';

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
  template_type?: string | null;
}

async function fetchPatient(patientId: string): Promise<PatientInfo> {
  const res = await podiAxios<{ patient: PatientInfo }>(`${PADS_API}/patients/${patientId}`, { headers: getAuthHeader() });
  return res.patient;
}

async function fetchScans(scansUrl: string): Promise<Array<BrannockScan>> {
  const today = new Date().toISOString().split('T')[0];
  const url = `${scansUrl}?scan_type=user&start_date=2024-10-01&end_date=${today}`;
  const res = await podiAxios<{ scans: Array<BrannockScan> }>(url, { headers: getAuthHeader() });
  return res.scans.filter((s) => !!s.mat_thermogram_url);
}

async function fetchThermogram(matThermogramUrl: string): Promise<Array<Array<number>>> {
  const res = await podiAxios<{ thermogram: Array<Array<number>> }>(`${matThermogramUrl}?decimals=2`, { headers: getAuthHeader() });
  return res.thermogram;
}

// ── Build backend types ──────────────────────────────────────
// This is the contract the build backend must fulfill.
// See BUILD_BACKEND_SPEC.md for full specification.

interface BuildRequest {
  patient_id: string;
  scan_ids: Array<string>;
  thermograms: Array<{ scan_id: string; thermogram: Array<Array<number>> }>;
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

// Convert build response keypoints to the overlay display format
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

// ── Scan thumbnail ───────────────────────────────────────────
const ScanThumbnail: FC<{
  scan: BrannockScan;
  isSelected: boolean;
  onToggle: () => void;
}> = ({ scan, isSelected, onToggle }) => {
  const { data: thermogram, isLoading } = useQuery({
    queryKey: ['brannock-thermogram', scan.mat_thermogram_url],
    queryFn: () => fetchThermogram(scan.mat_thermogram_url!),
    staleTime: Infinity,
    enabled: !!scan.mat_thermogram_url
  });
  const dateLabel = scan.when_scan_completed.slice(0, 16).replace('T', ' ');
  return (
    <div
      onClick={onToggle}
      className={cn(
        'cursor-pointer rounded-lg border-2 p-1.5 transition-colors',
        isSelected ? 'border-blue-500 bg-blue-50' : 'border-gray-200 bg-white hover:border-gray-300'
      )}
    >
      <div className="aspect-[205/140] w-full overflow-hidden rounded bg-gray-900">
        {isLoading ? (
          <div className="flex h-full items-center justify-center">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-gray-400 border-t-transparent" />
          </div>
        ) : thermogram ? (
          <ThermogramHeatmap data={thermogram} className="h-full w-full object-contain" />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-gray-500">No data</div>
        )}
      </div>
      <div className="mt-1 flex items-center justify-between px-0.5">
        <span className="font-mono text-xs text-gray-600">{dateLabel}</span>
        {isSelected && <span className="text-xs text-blue-600">selected</span>}
      </div>
    </div>
  );
};

// ── Main page ────────────────────────────────────────────────
function ManualBuildPage() {
  const { patientId: urlPatientId } = Route.useSearch();
  const navigate = useNavigate();

  // Patient input
  const [inputValue, setInputValue] = useState(urlPatientId ?? '');
  const [activePatientId, setActivePatientId] = useState<string | null>(urlPatientId ?? null);

  // Selected scans for build
  const [selectedScanIds, setSelectedScanIds] = useState<Set<string>>(new Set());

  // Build state
  const [buildResponse, setBuildResponse] = useState<BuildResponse | null>(null);
  const [buildKeypoints, setBuildKeypoints] = useState<Array<KeypointResult>>([]);
  const [isBuilding, setIsBuilding] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);

  // ── Queries ────────────────────────────────────────────────
  const { data: patient, isLoading: patientLoading, isError: patientError } = useQuery({
    queryKey: ['manual-build-patient', activePatientId],
    queryFn: () => fetchPatient(activePatientId!),
    enabled: !!activePatientId
  });

  const { data: scans = [], isLoading: scansLoading } = useQuery({
    queryKey: ['manual-build-scans', activePatientId],
    queryFn: () => fetchScans(patient!.scans_url),
    enabled: !!patient?.scans_url
  });

  // ── Handlers ───────────────────────────────────────────────
  const handleLoadPatient = useCallback(() => {
    const trimmed = inputValue.trim();
    if (trimmed) {
      setActivePatientId(trimmed);
      setSelectedScanIds(new Set());
      setBuildResponse(null);
      setBuildKeypoints([]);
      setBuildError(null);
      navigate({ search: { patientId: trimmed } });
    }
  }, [inputValue, navigate]);

  const toggleScan = useCallback((scanId: string) => {
    setSelectedScanIds((prev) => {
      const next = new Set(prev);
      if (next.has(scanId)) {
        next.delete(scanId);
      } else {
        next.add(scanId);
      }
      return next;
    });
  }, []);

  const selectAllScans = useCallback(() => {
    setSelectedScanIds(new Set(scans.map((s) => s.scan_id)));
  }, [scans]);

  const clearSelection = useCallback(() => {
    setSelectedScanIds(new Set());
  }, []);

  const handleBuild = useCallback(async () => {
    if (!patient || selectedScanIds.size === 0) return;

    setIsBuilding(true);
    setBuildError(null);
    setBuildResponse(null);
    setBuildKeypoints([]);

    try {
      // Fetch all selected thermograms
      const selectedScans = scans.filter((s) => selectedScanIds.has(s.scan_id));
      const thermogramPromises = selectedScans.map(async (scan) => {
        const thermogram = await fetchThermogram(scan.mat_thermogram_url!);
        return { scan_id: scan.scan_id, thermogram };
      });
      const thermograms = await Promise.all(thermogramPromises);

      toast.success(`Loaded ${thermograms.length} thermograms, sending to build server...`);

      // POST to build backend
      const res = await axios.post<BuildResponse>(`${BUILD_SERVER}/build-template`, {
        patient_id: patient.patient_id,
        scan_ids: Array.from(selectedScanIds),
        thermograms
      } as BuildRequest);

      setBuildResponse(res.data);
      setBuildKeypoints(buildKeypointsToOverlay(res.data));
      toast.success('Template built with auto-placed keypoints');
    } catch (e: any) {
      const msg = e?.response?.data?.detail || e?.message || 'Build server unreachable';
      setBuildError(msg);
      toast.error('Build failed');
    } finally {
      setIsBuilding(false);
    }
  }, [patient, selectedScanIds, scans]);

  const hasBuild = buildResponse !== null;
  const selectedCount = selectedScanIds.size;

  return (
    <div className="flex flex-col gap-6 p-4 lg:p-6">
      {/* Header */}
      <div className="rounded-lg bg-white p-4 shadow-sm">
        <h1 className="text-xl font-semibold text-black">Template Builder</h1>
        <p className="mt-1 text-sm text-gray-500">
          Enter a patient ID, select scans, then build a template with auto-placed keypoints.
        </p>

        <div className="mt-4 flex gap-2">
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleLoadPatient()}
            placeholder="Patient ID"
            className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm text-black placeholder-gray-400 focus:border-gray-500 focus:outline-none"
          />
          <button
            onClick={handleLoadPatient}
            disabled={!inputValue.trim()}
            className="cursor-pointer rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            Load Patient
          </button>
        </div>

        {patientLoading && <p className="mt-2 text-sm text-gray-400">Loading patient...</p>}
        {patientError && <p className="mt-2 text-sm text-red-500">Patient not found.</p>}
        {patient && (
          <div className="mt-2 flex items-center gap-3 text-sm">
            <span className="font-medium text-black">{patient.patient_designation || activePatientId?.slice(0, 12)}</span>
            <span className="text-gray-400">{scans.length} scans available</span>
          </div>
        )}
      </div>

      {/* Main content */}
      {scans.length > 0 && (
        <div className="flex flex-col gap-6 lg:flex-row">
          {/* Left: scan selection */}
          <div className="w-full shrink-0 lg:w-[400px]">
            <div className="rounded-lg bg-white p-4 shadow-sm">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-semibold text-black">Select Scans</h3>
                <div className="flex gap-2">
                  <button onClick={selectAllScans} className="cursor-pointer text-xs text-blue-600 hover:underline">
                    All
                  </button>
                  <button onClick={clearSelection} className="cursor-pointer text-xs text-gray-400 hover:underline">
                    Clear
                  </button>
                  {selectedCount > 0 && <span className="text-xs text-gray-500">{selectedCount} selected</span>}
                </div>
              </div>
              <p className="mt-1 text-xs text-gray-400">Select the scans to use for template building. More scans = better template.</p>

              {scansLoading ? (
                <div className="mt-3 grid grid-cols-2 gap-2">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="aspect-[205/140] animate-pulse rounded-lg bg-gray-200" />
                  ))}
                </div>
              ) : (
                <div className="mt-3 grid grid-cols-2 gap-2">
                  {scans.map((scan) => (
                    <ScanThumbnail key={scan.scan_id} scan={scan} isSelected={selectedScanIds.has(scan.scan_id)} onToggle={() => toggleScan(scan.scan_id)} />
                  ))}
                </div>
              )}

              {/* Build button */}
              <div className="mt-4">
                <button
                  onClick={handleBuild}
                  disabled={selectedCount === 0 || isBuilding}
                  className="w-full cursor-pointer rounded-md bg-gray-900 px-4 py-2.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isBuilding ? (
                    <span className="flex items-center justify-center gap-2">
                      <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                      Building template...
                    </span>
                  ) : (
                    `Build Template from ${selectedCount} scan${selectedCount !== 1 ? 's' : ''}`
                  )}
                </button>
                {selectedCount > 0 && selectedCount < 4 && (
                  <p className="mt-1 text-center text-xs text-amber-500">Recommend at least 4 scans for a reliable template</p>
                )}
                {buildError && <p className="mt-2 text-sm text-red-500">{buildError}</p>}
              </div>
            </div>
          </div>

          {/* Right: build results */}
          <div className="flex flex-1 flex-col gap-4">
            {hasBuild && buildResponse ? (
              <>
                {/* Template visualization with keypoints */}
                <div className="rounded-lg bg-white p-4 shadow-sm">
                  <div className="flex items-center justify-between">
                    <h3 className="text-lg font-semibold text-black">Built Template</h3>
                    <div className="flex items-center gap-2 text-xs">
                      <span className="rounded bg-gray-100 px-2 py-0.5 text-gray-600">{buildResponse.model_used}</span>
                      <span className="text-gray-500">{buildResponse.foot_count === 'pair' ? 'Bilateral' : 'Single foot'}</span>
                      <span className="text-gray-400">|</span>
                      <span className="text-gray-500">{buildResponse.n_scans_used} scans used</span>
                      <span className="text-gray-400">|</span>
                      <span className={buildResponse.quality_score >= 0.9 ? 'text-green-600' : buildResponse.quality_score >= 0.7 ? 'text-amber-600' : 'text-red-500'}>
                        Quality: {(buildResponse.quality_score * 100).toFixed(0)}%
                      </span>
                    </div>
                  </div>

                  {/* Validation violations */}
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
                    {/* Right foot (left side of screen — anatomical convention) */}
                    {buildResponse.right_template && (
                      <div className="flex-1">
                        <p className="mb-1 text-center text-xs font-medium text-gray-500">Right Foot</p>
                        <div className="rounded bg-gray-900 p-2">
                          <KeypointOverlayCanvas
                            thermogramData={buildResponse.right_template}
                            keypoints={buildKeypoints.map((kp) => ({
                              ...kp,
                              left: undefined,
                              leftConfidence: null
                            }))}
                          />
                        </div>
                        {buildResponse.right_validation && (
                          <p className={cn('mt-1 text-center text-xs', buildResponse.right_validation.overall_score >= 0.9 ? 'text-green-600' : 'text-amber-600')}>
                            Validation: {(buildResponse.right_validation.overall_score * 100).toFixed(0)}%
                          </p>
                        )}
                      </div>
                    )}
                    {buildResponse.left_template && (
                      <div className="flex-1">
                        <p className="mb-1 text-center text-xs font-medium text-gray-500">Left Foot</p>
                        <div className="rounded bg-gray-900 p-2">
                          <KeypointOverlayCanvas
                            thermogramData={buildResponse.left_template}
                            keypoints={buildKeypoints.map((kp) => ({
                              ...kp,
                              right: undefined,
                              rightConfidence: null
                            }))}
                          />
                        </div>
                        {buildResponse.left_validation && (
                          <p className={cn('mt-1 text-center text-xs', buildResponse.left_validation.overall_score >= 0.9 ? 'text-green-600' : 'text-amber-600')}>
                            Validation: {(buildResponse.left_validation.overall_score * 100).toFixed(0)}%
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="mt-3">
                    <KeypointLegend />
                  </div>
                </div>

                {/* Keypoint details table */}
                <div className="rounded-lg bg-white p-4 shadow-sm">
                  <h3 className="text-sm font-semibold text-black">Auto-Placed Keypoints</h3>
                  <div className="mt-2 overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead>
                        <tr className="border-b text-gray-500">
                          <th className="pb-2 pr-4">Keypoint</th>
                          {buildResponse.left_template && <th className="pb-2 pr-4">Left (x, y)</th>}
                          {buildResponse.left_template && <th className="pb-2 pr-4">L Conf</th>}
                          {buildResponse.right_template && <th className="pb-2 pr-4">Right (x, y)</th>}
                          {buildResponse.right_template && <th className="pb-2">R Conf</th>}
                        </tr>
                      </thead>
                      <tbody>
                        {buildKeypoints.map((kp) => {
                          const fmtConf = (c: number | null | undefined) => {
                            if (c == null) return <span className="text-gray-300">—</span>;
                            const color = c >= 0.7 ? 'text-green-600' : c >= 0.4 ? 'text-amber-600' : 'text-red-500';
                            return <span className={color}>{Math.round(c * 100)}%</span>;
                          };
                          return (
                            <tr key={kp.name} className="border-b border-gray-50">
                              <td className="py-1.5 pr-4 font-medium text-gray-700">{kp.name}</td>
                              {buildResponse.left_template && (
                                <td className="py-1.5 pr-4 font-mono text-gray-600">
                                  {kp.left ? `(${kp.left.x.toFixed(3)}, ${kp.left.y.toFixed(3)})` : <span className="text-gray-300">null</span>}
                                </td>
                              )}
                              {buildResponse.left_template && <td className="py-1.5 pr-4">{fmtConf(kp.leftConfidence)}</td>}
                              {buildResponse.right_template && (
                                <td className="py-1.5 pr-4 font-mono text-gray-600">
                                  {kp.right ? `(${kp.right.x.toFixed(3)}, ${kp.right.y.toFixed(3)})` : <span className="text-gray-300">null</span>}
                                </td>
                              )}
                              {buildResponse.right_template && <td className="py-1.5">{fmtConf(kp.rightConfidence)}</td>}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
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
            ) : (
              <div className="flex h-[500px] items-center justify-center rounded-lg bg-white shadow-sm">
                <div className="text-center">
                  <p className="text-sm text-gray-400">
                    {scans.length > 0 ? 'Select scans and click Build to generate a template' : 'Loading scans...'}
                  </p>
                  {scans.length > 0 && <p className="mt-1 text-xs text-gray-300">The build server will return a template with auto-placed keypoints</p>}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {!activePatientId && (
        <div className="rounded-lg bg-white p-8 text-center shadow-sm">
          <p className="text-gray-400">Enter a patient ID above to get started.</p>
          <p className="mt-1 text-xs text-gray-300">Try: fa4a56521d93238218b29d027b4d32c6 (TT-0002)</p>
        </div>
      )}
    </div>
  );
}
