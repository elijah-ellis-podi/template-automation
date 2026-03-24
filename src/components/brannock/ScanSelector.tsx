import type { BrannockPatient, BrannockScan } from '@/schemas/brannock';
import { getBrannockScans } from '@/services/brannock';
import { cn } from '@/utils/classes';
import { useQuery } from '@tanstack/react-query';
import { type FC, type KeyboardEvent, useCallback } from 'react';

function formatScanDate(whenScanCompleted: string): string {
  return whenScanCompleted.slice(0, 16).replace('T', ' ');
}

function ScanListSkeleton() {
  return (
    <div className="flex flex-col">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-center gap-2 border-b border-gray-100 px-2 py-2 last:border-b-0">
          <div className="h-4 w-4 animate-pulse rounded bg-gray-200" />
          <div className="h-3.5 w-32 animate-pulse rounded bg-gray-200" />
        </div>
      ))}
    </div>
  );
}

interface ScanSelectorProps {
  patient: BrannockPatient | null;
  selectedScanIds: Set<string>;
  onSelectedScanIdsChange: (ids: Set<string>) => void;
  previewScanId: string | null;
  onPreviewScanChange: (scan: BrannockScan | null) => void;
  /** Override the default scan fetch function (e.g. to bypass LOCAL mock guard). */
  fetchScansFn?: (scansUrl: string) => Promise<Array<BrannockScan>>;
}

export const ScanSelector: FC<ScanSelectorProps> = ({ patient, selectedScanIds, onSelectedScanIdsChange, previewScanId, onPreviewScanChange, fetchScansFn }) => {
  const fetcher = fetchScansFn ?? getBrannockScans;
  const {
    data: scans = [],
    isLoading,
    isError
  } = useQuery({
    queryKey: ['brannock-scans', patient?.patient_id],
    queryFn: () => fetcher(patient!.scans_url),
    enabled: !!patient
  });

  const toggleCheckbox = useCallback(
    (scanId: string) => {
      const next = new Set(selectedScanIds);
      if (next.has(scanId)) {
        next.delete(scanId);
      } else {
        next.add(scanId);
      }
      onSelectedScanIdsChange(next);
    },
    [selectedScanIds, onSelectedScanIdsChange]
  );

  const handleRowClick = useCallback(
    (scan: BrannockScan) => {
      onPreviewScanChange(previewScanId === scan.scan_id ? null : scan);
    },
    [previewScanId, onPreviewScanChange]
  );

  const handleRowKeyDown = useCallback(
    (e: KeyboardEvent, scan: BrannockScan) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleRowClick(scan);
      }
    },
    [handleRowClick]
  );

  const checkedCount = selectedScanIds.size;

  return (
    <div className="rounded-lg bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-black">Select Scans</h3>
        {checkedCount > 0 && <span className="text-xs text-gray-500">{checkedCount} checked</span>}
      </div>

      {!patient ? (
        <p className="mt-2 text-sm text-gray-400">Select a patient to view scans</p>
      ) : isLoading ? (
        <div className="mt-2 rounded-md border border-gray-200">
          <ScanListSkeleton />
        </div>
      ) : isError ? (
        <div className="mt-2 rounded-md border border-red-200 bg-red-50 px-3 py-3 text-sm text-red-600">Failed to load scans. The patient may not have any scan data, or the server may be unreachable.</div>
      ) : scans.length === 0 ? (
        <p className="mt-2 text-sm text-gray-400">No scans available for this patient</p>
      ) : (
        <div className="mt-2 max-h-[300px] overflow-y-auto rounded-md border border-gray-200" role="list" aria-label="Scan list">
          {scans.map((scan) => {
            const isChecked = selectedScanIds.has(scan.scan_id);
            const isPreviewed = previewScanId === scan.scan_id;

            return (
              <div
                key={scan.scan_id}
                role="listitem"
                className={cn(
                  'flex items-center gap-2 border-b border-gray-100 px-2 py-1.5 text-sm last:border-b-0',
                  isPreviewed ? 'bg-blue-50' : 'hover:bg-gray-50'
                )}
              >
                <input
                  type="checkbox"
                  checked={isChecked}
                  onChange={() => toggleCheckbox(scan.scan_id)}
                  aria-label={`Check scan from ${formatScanDate(scan.when_scan_completed)}`}
                  className="shrink-0 accent-gray-900"
                />
                <div
                  className="flex-1 cursor-pointer focus:outline-none focus:ring-2 focus:ring-inset focus:ring-blue-400"
                  tabIndex={0}
                  role="button"
                  aria-pressed={isPreviewed}
                  onClick={() => handleRowClick(scan)}
                  onKeyDown={(e) => handleRowKeyDown(e, scan)}
                >
                  <span className={cn('font-mono text-xs', isPreviewed ? 'font-semibold text-blue-700' : 'text-gray-700')}>
                    {formatScanDate(scan.when_scan_completed)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
