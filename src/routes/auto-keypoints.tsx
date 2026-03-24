import { ThermogramHeatmap } from '@/components/brannock/ThermogramHeatmap';
import { KeypointLegend, KeypointOverlayCanvas, type KeypointResult } from '@/components/brannock/KeypointOverlayCanvas';
import type { BrannockScan } from '@/schemas/brannock';
import { getLogoutRedirectOptions } from '@/services/auth';
import { cn } from '@/utils/classes';
import { ENV, STORAGE_KEYS } from '@/utils/constants';
import { podiAxios } from '@/utils/api';
import { getAuthHeader } from '@/services/auth';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { type FC, useState, useCallback } from 'react';
import toast from 'react-hot-toast';
import { z } from 'zod';
import axios from 'axios';

// This page always hits the real PADS API for patient/scan data.
const PADS_API = ENV.DEV_API_BASE_URL;

// Python keypoint detection server (keypoint_automation/server.py)
const KP_SERVER = 'http://localhost:8787';

const SearchSchema = z.object({
  patientId: z.string().optional()
});

export const Route = createFileRoute('/auto-keypoints')({
  validateSearch: SearchSchema.parse,
  beforeLoad: async ({ location }) => {
    const authToken = localStorage.getItem(STORAGE_KEYS.PODI_TOKEN);
    if (!authToken && ENV.ENV !== 'LOCAL') {
      throw redirect(getLogoutRedirectOptions(location));
    }
  },
  component: AutoKeypointsPage
});

// ── PADS API calls ───────────────────────────────────────────
async function fetchPatient(patientId: string) {
  const res = await podiAxios<{ patient: { patient_id: string; patient_designation?: string; scans_url: string; template_id?: string } }>(
    `${PADS_API}/patients/${patientId}`,
    { headers: getAuthHeader() }
  );
  return res.patient;
}

async function fetchScans(scansUrl: string): Promise<Array<BrannockScan>> {
  const today = new Date().toISOString().split('T')[0];
  const url = `${scansUrl}?scan_type=user&start_date=2024-10-01&end_date=${today}`;
  const res = await podiAxios<{ scans: Array<BrannockScan> }>(url, { headers: getAuthHeader() });
  return res.scans.filter((s) => {
    if (!s.mat_thermogram_url) return false;
    const schemaId = s.schema_id != null ? Math.round(Number(s.schema_id)) : null;
    return schemaId !== 9;
  });
}

async function fetchThermogram(matThermogramUrl: string): Promise<Array<Array<number>>> {
  const res = await podiAxios<{ thermogram: Array<Array<number>> }>(`${matThermogramUrl}?decimals=2`, { headers: getAuthHeader() });
  return res.thermogram;
}

// ── Scan metadata from PADS (old algorithm scores) ───────────
interface ScanMetadata {
  template_mismatch: boolean | null;
  left_footness: number | null;
  right_footness: number | null;
  scan_status: string | null;
  is_elevated_scan: boolean | null;
}

async function fetchScanMetadata(scanId: string): Promise<ScanMetadata> {
  const res = await podiAxios<{ scan: Record<string, any> }>(`${PADS_API}/scans/${scanId}`, { headers: getAuthHeader() });
  const s = res.scan;
  return {
    template_mismatch: s.template_mismatch ?? null,
    left_footness: s.left_footness != null ? Number(s.left_footness) : null,
    right_footness: s.right_footness != null ? Number(s.right_footness) : null,
    scan_status: s.scan_status ?? null,
    is_elevated_scan: s.is_elevated_scan ?? null
  };
}

// ── Keypoint server types ────────────────────────────────────
interface KpCoord {
  name: string;
  x: number | null;
  y: number | null;
  confidence?: number | null;
}

interface ImageClassificationRaw {
  foot_count?: string | null;
  detected_feet?: Array<string> | null;
  anomalies?: string | null;
}

interface ModelResultRaw {
  model: string;
  side: string;
  keypoints: Array<KpCoord>;
  error?: string | null;
  image_classification?: ImageClassificationRaw | null;
}

interface PredictResponseRaw {
  results: Array<ModelResultRaw>;
}

interface ParsedResults {
  byModel: Map<string, Array<KeypointResult>>;
  imageClassification: ImageClassificationRaw | null;
}

// Convert server response into display-ready format
function serverResultToParsed(results: Array<ModelResultRaw>): ParsedResults {
  const byModel = new Map<string, Array<KeypointResult>>();
  let imageClassification: ImageClassificationRaw | null = null;

  for (const r of results) {
    // Capture image_classification from Claude result
    if (r.image_classification && !imageClassification) {
      imageClassification = r.image_classification;
    }

    if (r.error || r.keypoints.length === 0) continue;

    if (!byModel.has(r.model)) {
      byModel.set(r.model, r.keypoints.map((kp) => ({ name: kp.name })));
    }

    const arr = byModel.get(r.model)!;
    for (const kp of r.keypoints) {
      const entry = arr.find((e) => e.name === kp.name);
      if (!entry) continue;
      // A null keypoint means anatomy is absent — keep the entry without coords
      if (kp.x == null || kp.y == null) continue;
      if (r.side === 'left') {
        entry.left = { x: kp.x, y: kp.y };
        entry.leftConfidence = kp.confidence ?? null;
      } else {
        entry.right = { x: kp.x, y: kp.y };
        entry.rightConfidence = kp.confidence ?? null;
      }
    }
  }

  return { byModel, imageClassification };
}

// ── Components ───────────────────────────────────────────────
const ScanThumbnail: FC<{
  scan: BrannockScan;
  isSelected: boolean;
  onSelect: () => void;
}> = ({ scan, isSelected, onSelect }) => {
  const { data: thermogram, isLoading } = useQuery({
    queryKey: ['brannock-thermogram', scan.mat_thermogram_url],
    queryFn: () => fetchThermogram(scan.mat_thermogram_url!),
    staleTime: Infinity,
    enabled: !!scan.mat_thermogram_url
  });
  const dateLabel = scan.when_scan_completed.slice(0, 16).replace('T', ' ');
  return (
    <div
      onClick={onSelect}
      className={cn(
        'cursor-pointer rounded-lg border-2 p-2 transition-colors',
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
      <p className="mt-1 text-center font-mono text-xs text-gray-600">{dateLabel}</p>
    </div>
  );
};

// ── Model result card ────────────────────────────────────────
const MODEL_LABELS: Record<string, { label: string; description: string }> = {
  geometric: { label: 'Geometric', description: 'Anatomy-based heuristics using mask spatial statistics' },
  claude: { label: 'Claude Vision', description: 'Few-shot prompting with Claude Opus 4.6 vision API' },
  ensemble: { label: 'Ensemble', description: 'NaN-safe average of geometric + Claude predictions' }
};

const ModelCard: FC<{
  modelName: string;
  keypoints: Array<KeypointResult>;
  thermogramData: Array<Array<number>>;
  isHighlighted?: boolean;
}> = ({ modelName, keypoints, thermogramData, isHighlighted }) => {
  const meta = MODEL_LABELS[modelName] ?? { label: modelName, description: '' };
  const validCount = keypoints.filter((kp) => kp.left || kp.right).length;

  return (
    <div className={cn('rounded-lg border bg-white shadow-sm', isHighlighted ? 'border-blue-400 ring-2 ring-blue-100' : 'border-gray-200')}>
      <div className="border-b border-gray-100 px-4 py-3">
        <div className="flex items-center justify-between">
          <div>
            <h4 className="text-sm font-semibold text-black">
              {meta.label}
              {isHighlighted && <span className="ml-2 rounded bg-blue-100 px-1.5 py-0.5 text-xs text-blue-700">primary</span>}
            </h4>
            <p className="text-xs text-gray-400">{meta.description}</p>
          </div>
          <span className="text-xs text-gray-500">{validCount}/6 keypoints</span>
        </div>
      </div>
      <div className="p-2">
        <div className="rounded bg-gray-900 p-1">
          <KeypointOverlayCanvas thermogramData={thermogramData} keypoints={keypoints} />
        </div>
      </div>
    </div>
  );
};

// ── Main page ────────────────────────────────────────────────
function AutoKeypointsPage() {
  const { patientId: urlPatientId } = Route.useSearch();
  const [inputValue, setInputValue] = useState(urlPatientId ?? '');
  const [activePatientId, setActivePatientId] = useState<string | null>(urlPatientId ?? null);
  const [selectedScanId, setSelectedScanId] = useState<string | null>(null);

  // Model results keyed by model name
  const [modelResults, setModelResults] = useState<Map<string, Array<KeypointResult>>>(new Map());
  const [imageClassification, setImageClassification] = useState<ImageClassificationRaw | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [serverErrors, setServerErrors] = useState<Array<{ model: string; error: string }>>([]);

  const { data: patient, isLoading: patientLoading, isError: patientError } = useQuery({
    queryKey: ['auto-kp-patient', activePatientId],
    queryFn: () => fetchPatient(activePatientId!),
    enabled: !!activePatientId
  });

  const { data: scans = [], isLoading: scansLoading } = useQuery({
    queryKey: ['brannock-scans', activePatientId],
    queryFn: () => fetchScans(patient!.scans_url),
    enabled: !!patient?.scans_url
  });

  const selectedScan = scans.find((s) => s.scan_id === selectedScanId) ?? scans[0] ?? null;
  const { data: selectedThermogram } = useQuery({
    queryKey: ['brannock-thermogram', selectedScan?.mat_thermogram_url],
    queryFn: () => fetchThermogram(selectedScan!.mat_thermogram_url!),
    staleTime: Infinity,
    enabled: !!selectedScan?.mat_thermogram_url
  });

  // ── Scan metadata (old algorithm scores) ──
  const { data: scanMeta } = useQuery({
    queryKey: ['scan-metadata', selectedScan?.scan_id],
    queryFn: () => fetchScanMetadata(selectedScan!.scan_id),
    staleTime: Infinity,
    enabled: !!selectedScan?.scan_id
  });

  const handleLoadPatient = useCallback(() => {
    const trimmed = inputValue.trim();
    if (trimmed) {
      setActivePatientId(trimmed);
      setSelectedScanId(null);
      setModelResults(new Map());
      setImageClassification(null);
      setRunError(null);
      setServerErrors([]);
    }
  }, [inputValue]);

  const handleSelectScan = useCallback((scanId: string) => {
    setSelectedScanId(scanId);
    setModelResults(new Map());
    setImageClassification(null);
    setRunError(null);
    setServerErrors([]);
  }, []);

  const handleRunModels = useCallback(
    async (models: Array<string>) => {
      if (!selectedThermogram) return;
      setIsRunning(true);
      setRunError(null);
      setServerErrors([]);

      try {
        const res = await axios.post<PredictResponseRaw>(`${KP_SERVER}/predict`, {
          thermogram: selectedThermogram,
          side: 'both',
          models
        });

        const parsed = serverResultToParsed(res.data.results);
        setModelResults(parsed.byModel);
        setImageClassification(parsed.imageClassification);

        // Collect errors from individual models
        const errors = res.data.results.filter((r) => r.error).map((r) => ({ model: r.model, error: r.error! }));
        // Dedupe by model name
        const seen = new Set<string>();
        const uniqueErrors = errors.filter((e) => {
          if (seen.has(e.model)) return false;
          seen.add(e.model);
          return true;
        });
        setServerErrors(uniqueErrors);

        if (parsed.byModel.size > 0) {
          toast.success(`${parsed.byModel.size} model(s) returned results`);
        }
      } catch (e: any) {
        const msg = e?.response?.data?.detail || e?.message || 'Failed to reach keypoint server';
        setRunError(msg);
        toast.error('Keypoint server error');
      } finally {
        setIsRunning(false);
      }
    },
    [selectedThermogram]
  );

  const claudeResults = modelResults.get('claude');
  const hasResults = modelResults.size > 0;

  return (
    <div className="flex flex-col gap-6 p-4 lg:p-6">
      {/* Header + Patient ID input */}
      <div className="rounded-lg bg-white p-4 shadow-sm">
        <h1 className="text-xl font-semibold text-black">Automatic Keypoint Selection Demo</h1>
        <p className="mt-1 text-sm text-gray-500">
          Load a patient, select a scan, then run keypoint detection models. The Python server at <code className="text-xs">localhost:8787</code> must be
          running.
        </p>

        <div className="mt-4 flex gap-2">
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleLoadPatient()}
            placeholder="Patient ID (e.g. fa4a56521d93238218b29d027b4d32c6)"
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
        {patientError && <p className="mt-2 text-sm text-red-500">Patient not found or API error.</p>}
        {patient && (
          <div className="mt-2 flex items-center gap-3 text-sm text-gray-600">
            <span className="font-medium text-black">{patient.patient_designation || activePatientId?.slice(0, 12)}</span>
            {patient.template_id && <span className="rounded bg-green-100 px-2 py-0.5 text-xs text-green-700">has template</span>}
            <span className="text-gray-400">{scans.length} scans with thermograms</span>
          </div>
        )}
      </div>

      {scans.length > 0 && (
        <div className="flex flex-col gap-6 lg:flex-row">
          {/* Left: scan thumbnails */}
          <div className="w-full shrink-0 lg:w-[340px]">
            <div className="rounded-lg bg-white p-4 shadow-sm">
              <h3 className="text-lg font-semibold text-black">Scans</h3>
              <p className="mt-1 text-xs text-gray-400">Select a scan for keypoint detection</p>
              {scansLoading ? (
                <div className="mt-3 grid grid-cols-2 gap-2">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="aspect-[205/140] animate-pulse rounded-lg bg-gray-200" />
                  ))}
                </div>
              ) : (
                <div className="mt-3 grid grid-cols-2 gap-2">
                  {scans.map((scan) => (
                    <ScanThumbnail
                      key={scan.scan_id}
                      scan={scan}
                      isSelected={(selectedScan?.scan_id ?? scans[0]?.scan_id) === scan.scan_id}
                      onSelect={() => handleSelectScan(scan.scan_id)}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Right: detection controls + results */}
          <div className="flex flex-1 flex-col gap-4">
            {/* Run controls */}
            {selectedThermogram && (
              <div className="rounded-lg bg-white p-4 shadow-sm">
                <h3 className="text-lg font-semibold text-black">Run Models</h3>
                <p className="mt-1 text-xs text-gray-400">
                  Thermogram: {selectedThermogram.length} x {selectedThermogram[0]?.length} px | Scan: {selectedScan?.scan_id?.slice(0, 20)}...
                </p>
                {/* Existing algorithm scores from PADS */}
              {scanMeta && (
                <div className="mt-2 flex flex-wrap items-center gap-3 rounded-md bg-gray-50 px-3 py-2 text-xs">
                  <span className="font-medium text-gray-500">Production PADS footness</span>
                  <span className={scanMeta.template_mismatch ? 'text-red-600' : 'text-green-600'}>
                    Template match: {scanMeta.template_mismatch ? 'MISMATCH' : 'OK'}
                  </span>
                  <span className="text-gray-400">|</span>
                  <span className="text-gray-700">
                    L footness: <span className="font-mono">{scanMeta.left_footness != null ? scanMeta.left_footness.toFixed(3) : '—'}</span>
                  </span>
                  <span className="text-gray-700">
                    R footness: <span className="font-mono">{scanMeta.right_footness != null ? scanMeta.right_footness.toFixed(3) : '—'}</span>
                  </span>
                  {scanMeta.scan_status && (
                    <>
                      <span className="text-gray-400">|</span>
                      <span className="text-gray-600">Status: {scanMeta.scan_status}</span>
                    </>
                  )}
                </div>
              )}

              <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    onClick={() => handleRunModels(['geometric'])}
                    disabled={isRunning}
                    className="cursor-pointer rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                  >
                    Geometric Only
                  </button>
                  <button
                    onClick={() => handleRunModels(['claude'])}
                    disabled={isRunning}
                    className="cursor-pointer rounded-md border border-blue-300 bg-blue-50 px-3 py-1.5 text-sm font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-50"
                  >
                    Claude Vision Only
                  </button>
                  <button
                    onClick={() => handleRunModels(['geometric', 'claude', 'ensemble'])}
                    disabled={isRunning}
                    className="cursor-pointer rounded-md bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
                  >
                    Run All Models
                  </button>
                  {hasResults && (
                    <button
                      onClick={() => {
                        setModelResults(new Map());
                        setImageClassification(null);
                        setServerErrors([]);
                      }}
                      className="cursor-pointer rounded-md border border-gray-300 px-3 py-1.5 text-xs text-gray-500 hover:bg-gray-50"
                    >
                      Clear
                    </button>
                  )}
                </div>

                {isRunning && (
                  <div className="mt-3 flex items-center gap-2 text-sm text-gray-500">
                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-gray-400 border-t-transparent" />
                    Running models... Claude Vision may take 5-15 seconds.
                  </div>
                )}
                {runError && <p className="mt-2 text-sm text-red-500">{runError}</p>}
                {serverErrors.map((e) => (
                  <p key={e.model} className="mt-1 text-xs text-amber-600">
                    {e.model}: {e.error}
                  </p>
                ))}
              </div>
            )}

            {/* Claude Vision — featured large */}
            {claudeResults && selectedThermogram && (
              <div className="rounded-lg border-2 border-blue-400 bg-white p-4 shadow-sm ring-2 ring-blue-100">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-lg font-semibold text-black">
                      Claude Vision Results <span className="ml-2 rounded bg-blue-100 px-1.5 py-0.5 text-xs text-blue-700">primary</span>
                    </h3>
                    <p className="text-xs text-gray-400">Few-shot prompting with Claude Opus 4.6 — keypoints predicted directly from the thermogram image</p>
                  </div>
                  <span className="text-sm text-gray-500">
                    {claudeResults.filter((kp) => kp.left || kp.right).length}/6 keypoints
                  </span>
                </div>

                {/* Image classification badge */}
                {imageClassification && (
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                    {imageClassification.foot_count && (
                      <span className="rounded bg-gray-100 px-2 py-0.5 text-gray-600">
                        {imageClassification.foot_count === 'pair' ? 'Bilateral (pair)' : 'Single foot'}
                      </span>
                    )}
                    {imageClassification.detected_feet && (
                      <span className="rounded bg-blue-50 px-2 py-0.5 text-blue-600">
                        Detected: {imageClassification.detected_feet.join(', ')}
                      </span>
                    )}
                    {imageClassification.anomalies && imageClassification.anomalies !== 'none' && (
                      <span className="rounded bg-amber-50 px-2 py-0.5 text-amber-700">{imageClassification.anomalies}</span>
                    )}
                    {imageClassification.anomalies === 'none' && (
                      <span className="rounded bg-green-50 px-2 py-0.5 text-green-600">No anomalies</span>
                    )}
                  </div>
                )}

                <div className="mt-3 rounded bg-gray-900 p-2">
                  <KeypointOverlayCanvas thermogramData={selectedThermogram} keypoints={claudeResults} />
                </div>
                <div className="mt-3">
                  <KeypointLegend />
                </div>
                {/* Coordinate + confidence table */}
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b text-gray-500">
                        <th className="pb-1 pr-4">Keypoint</th>
                        <th className="pb-1 pr-4">Left (x, y)</th>
                        <th className="pb-1 pr-4">L Conf</th>
                        <th className="pb-1 pr-4">Right (x, y)</th>
                        <th className="pb-1">R Conf</th>
                      </tr>
                    </thead>
                    <tbody>
                      {claudeResults.map((kp) => {
                        const fmtConf = (c: number | null | undefined) => {
                          if (c == null) return <span className="text-gray-300">—</span>;
                          const pct = Math.round(c * 100);
                          const color = c >= 0.7 ? 'text-green-600' : c >= 0.4 ? 'text-amber-600' : 'text-red-500';
                          return <span className={color}>{pct}%</span>;
                        };
                        return (
                          <tr key={kp.name} className="border-b border-gray-50">
                            <td className="py-1 pr-4 font-medium text-gray-700">{kp.name}</td>
                            <td className="py-1 pr-4 font-mono text-gray-600">
                              {kp.left ? `(${kp.left.x.toFixed(3)}, ${kp.left.y.toFixed(3)})` : <span className="text-gray-300">null</span>}
                            </td>
                            <td className="py-1 pr-4">{kp.left ? fmtConf(kp.leftConfidence) : '—'}</td>
                            <td className="py-1 pr-4 font-mono text-gray-600">
                              {kp.right ? `(${kp.right.x.toFixed(3)}, ${kp.right.y.toFixed(3)})` : <span className="text-gray-300">null</span>}
                            </td>
                            <td className="py-1">{kp.right ? fmtConf(kp.rightConfidence) : '—'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Other models — smaller cards in a grid */}
            {hasResults && selectedThermogram && (
              <div className="grid gap-4 md:grid-cols-2">
                {Array.from(modelResults.entries())
                  .filter(([name]) => name !== 'claude')
                  .map(([name, keypoints]) => (
                    <ModelCard key={name} modelName={name} keypoints={keypoints} thermogramData={selectedThermogram} />
                  ))}
              </div>
            )}

            {/* Empty state */}
            {!hasResults && selectedThermogram && !isRunning && (
              <div className="rounded-lg bg-white p-4 shadow-sm">
                <div className="rounded bg-gray-900 p-2">
                  <ThermogramHeatmap data={selectedThermogram} className="h-auto w-full rounded" />
                </div>
                <p className="mt-3 text-center text-sm text-gray-400">Select a model above to run keypoint detection on this thermogram.</p>
              </div>
            )}

            {!selectedThermogram && (
              <div className="flex h-[400px] items-center justify-center rounded-lg bg-white shadow-sm">
                <p className="text-sm text-gray-400">Select a scan to view its thermogram</p>
              </div>
            )}
          </div>
        </div>
      )}

      {!activePatientId && (
        <div className="rounded-lg bg-white p-8 text-center shadow-sm">
          <p className="text-gray-400">Enter a patient ID above to get started.</p>
          <p className="mt-1 text-xs text-gray-300">Try: fa4a56521d93238218b29d027b4d32c6 (TT-0002, 15 scans)</p>
        </div>
      )}
    </div>
  );
}
