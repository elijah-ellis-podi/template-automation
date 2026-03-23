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
import { z } from 'zod';

// This page always hits the real API (DEV_API_BASE_URL), even on localhost.
const API = ENV.DEV_API_BASE_URL;

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

// ── Live API calls (bypass LOCAL mock guard) ─────────────────
async function fetchPatient(patientId: string) {
  const res = await podiAxios<{ patient: { patient_id: string; patient_designation?: string; scans_url: string; template_id?: string } }>(
    `${API}/patients/${patientId}`,
    { headers: getAuthHeader() }
  );
  return res.patient;
}

async function fetchScans(scansUrl: string): Promise<Array<BrannockScan>> {
  const today = new Date().toISOString().split('T')[0];
  const url = `${scansUrl}?scan_type=user&start_date=2024-10-01&end_date=${today}`;
  const res = await podiAxios<{ scans: Array<BrannockScan> }>(url, {
    headers: getAuthHeader()
  });
  return res.scans.filter((scan) => {
    if (!scan.mat_thermogram_url) return false;
    const schemaId = scan.schema_id != null ? Math.round(Number(scan.schema_id)) : null;
    return schemaId !== 9;
  });
}

async function fetchThermogram(matThermogramUrl: string): Promise<Array<Array<number>>> {
  const res = await podiAxios<{ thermogram: Array<Array<number>> }>(`${matThermogramUrl}?decimals=2`, {
    headers: getAuthHeader()
  });
  return res.thermogram;
}

// ── Scan thumbnail: loads thermogram and renders it ──
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

function AutoKeypointsPage() {
  const { patientId: urlPatientId } = Route.useSearch();
  const [inputValue, setInputValue] = useState(urlPatientId ?? '');
  const [activePatientId, setActivePatientId] = useState<string | null>(urlPatientId ?? null);
  const [selectedScanId, setSelectedScanId] = useState<string | null>(null);
  const [demoKeypoints, setDemoKeypoints] = useState<Array<KeypointResult>>([]);

  // ── Patient query ──
  const {
    data: patient,
    isLoading: patientLoading,
    isError: patientError
  } = useQuery({
    queryKey: ['auto-kp-patient', activePatientId],
    queryFn: () => fetchPatient(activePatientId!),
    enabled: !!activePatientId
  });

  // ── Scans query ──
  const { data: scans = [], isLoading: scansLoading } = useQuery({
    queryKey: ['brannock-scans', activePatientId],
    queryFn: () => fetchScans(patient!.scans_url),
    enabled: !!patient?.scans_url
  });

  // ── Selected scan thermogram ──
  const selectedScan = scans.find((s) => s.scan_id === selectedScanId) ?? scans[0] ?? null;
  const { data: selectedThermogram } = useQuery({
    queryKey: ['brannock-thermogram', selectedScan?.mat_thermogram_url],
    queryFn: () => fetchThermogram(selectedScan!.mat_thermogram_url!),
    staleTime: Infinity,
    enabled: !!selectedScan?.mat_thermogram_url
  });

  const handleLoadPatient = useCallback(() => {
    const trimmed = inputValue.trim();
    if (trimmed) {
      setActivePatientId(trimmed);
      setSelectedScanId(null);
      setDemoKeypoints([]);
    }
  }, [inputValue]);

  const handleSelectScan = useCallback((scanId: string) => {
    setSelectedScanId(scanId);
    setDemoKeypoints([]);
  }, []);

  return (
    <div className="flex flex-col gap-6 p-4 lg:p-6">
      {/* Header + Patient ID input */}
      <div className="rounded-lg bg-white p-4 shadow-sm">
        <h1 className="text-xl font-semibold text-black">Automatic Keypoint Selection Demo</h1>
        <p className="mt-1 text-sm text-gray-500">Enter a patient ID to load their scans, select a scan, then run automatic keypoint detection.</p>

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
        {patientError && <p className="mt-2 text-sm text-red-500">Patient not found or API error. Check the ID and try again.</p>}
        {patient && (
          <div className="mt-2 flex items-center gap-3 text-sm text-gray-600">
            <span className="font-medium text-black">{patient.patient_designation || activePatientId?.slice(0, 12)}</span>
            {patient.template_id && <span className="rounded bg-green-100 px-2 py-0.5 text-xs text-green-700">has template</span>}
            <span className="text-gray-400">{scans.length} scans with thermograms</span>
          </div>
        )}
      </div>

      {/* Main content: scan grid + keypoint frame */}
      {scans.length > 0 && (
        <div className="flex flex-col gap-6 lg:flex-row">
          {/* Left: scan thumbnails */}
          <div className="w-full shrink-0 lg:w-[340px]">
            <div className="rounded-lg bg-white p-4 shadow-sm">
              <h3 className="text-lg font-semibold text-black">Scans</h3>
              <p className="mt-1 text-xs text-gray-400">Click a scan to select it for keypoint detection</p>

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

          {/* Right: keypoint detection frame */}
          <div className="flex-1">
            <div className="rounded-lg bg-white p-4 shadow-sm">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-semibold text-black">Keypoint Detection</h3>
                {demoKeypoints.length > 0 && (
                  <button
                    onClick={() => setDemoKeypoints([])}
                    className="cursor-pointer rounded-md border border-gray-300 px-3 py-1 text-xs text-gray-600 hover:bg-gray-50"
                  >
                    Clear
                  </button>
                )}
              </div>

              {selectedThermogram ? (
                <>
                  {/* Thermogram with keypoint overlay */}
                  <div className="mt-3 rounded bg-gray-900 p-2">
                    {demoKeypoints.length > 0 ? (
                      <KeypointOverlayCanvas thermogramData={selectedThermogram} keypoints={demoKeypoints} className="rounded" />
                    ) : (
                      <ThermogramHeatmap data={selectedThermogram} className="h-auto w-full rounded" />
                    )}
                  </div>

                  {/* Legend */}
                  {demoKeypoints.length > 0 && (
                    <div className="mt-3">
                      <KeypointLegend />
                    </div>
                  )}

                  {/* Action area */}
                  <div className="mt-4 rounded-md border border-dashed border-gray-300 bg-gray-50 p-4">
                    <p className="text-center text-sm text-gray-500">
                      {demoKeypoints.length > 0
                        ? `${demoKeypoints.length} keypoints detected`
                        : 'Automatic keypoint detection algorithm output will be displayed here.'}
                    </p>
                    <p className="mt-1 text-center text-xs text-gray-400">
                      {demoKeypoints.length > 0
                        ? 'Results shown as colored markers on the thermogram above.'
                        : 'Connect your detection algorithm to populate this view.'}
                    </p>

                    {/* Placeholder button to simulate algorithm output */}
                    {demoKeypoints.length === 0 && (
                      <div className="mt-3 flex justify-center">
                        <button
                          onClick={() => {
                            // Simulate algorithm output with plausible normalized coordinates
                            setDemoKeypoints([
                              { name: 'Hallux', left: { x: 0.45, y: 0.08 }, right: { x: 0.55, y: 0.09 } },
                              { name: '1st Metatarsal Head', left: { x: 0.38, y: 0.22 }, right: { x: 0.62, y: 0.23 } },
                              { name: '3rd Metatarsal Head', left: { x: 0.5, y: 0.25 }, right: { x: 0.5, y: 0.26 } },
                              { name: '5th Metatarsal Head', left: { x: 0.62, y: 0.3 }, right: { x: 0.38, y: 0.31 } },
                              { name: 'Arch', left: { x: 0.52, y: 0.52 }, right: { x: 0.48, y: 0.53 } },
                              { name: 'Heel', left: { x: 0.5, y: 0.82 }, right: { x: 0.5, y: 0.83 } }
                            ]);
                          }}
                          className="cursor-pointer rounded-md border border-gray-300 bg-white px-4 py-2 text-sm text-gray-600 hover:bg-gray-50"
                        >
                          Run Demo (simulated keypoints)
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Scan metadata */}
                  <div className="mt-3 text-xs text-gray-400">
                    Scan: {selectedScan?.scan_id} | {selectedThermogram.length} x {selectedThermogram[0]?.length} px
                  </div>
                </>
              ) : (
                <div className="mt-3 flex h-[400px] items-center justify-center rounded bg-gray-50">
                  <p className="text-sm text-gray-400">Select a scan to view its thermogram</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Empty state when no patient loaded */}
      {!activePatientId && (
        <div className="rounded-lg bg-white p-8 text-center shadow-sm">
          <p className="text-gray-400">Enter a patient ID above to get started.</p>
          <p className="mt-1 text-xs text-gray-300">Try: fa4a56521d93238218b29d027b4d32c6 (TT-0002, 15 scans)</p>
        </div>
      )}
    </div>
  );
}
