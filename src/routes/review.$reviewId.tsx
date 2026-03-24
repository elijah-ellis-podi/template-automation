import { KeypointLegend, KeypointOverlayCanvas, type KeypointResult } from '@/components/brannock/KeypointOverlayCanvas';
import { ThermogramHeatmap } from '@/components/brannock/ThermogramHeatmap';
import { KEYPOINT_NAMES } from '@/schemas/brannock';
import { getLogoutRedirectOptions } from '@/services/auth';
import { cn } from '@/utils/classes';
import { ENV, STORAGE_KEYS } from '@/utils/constants';
import { Link, createFileRoute, redirect } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import axios from 'axios';

const SERVER = 'http://localhost:8788';

export const Route = createFileRoute('/review/$reviewId')({
  beforeLoad: async ({ location }) => {
    const authToken = localStorage.getItem(STORAGE_KEYS.PODI_TOKEN);
    if (!authToken && ENV.ENV !== 'LOCAL') {
      throw redirect(getLogoutRedirectOptions(location));
    }
  },
  component: ReviewDetailPage
});

// ── Types ────────────────────────────────────────────────────
type ConfidenceTier = 'low' | 'medium' | 'high';

interface KeypointCoord {
  name: string;
  x: number | null;
  y: number | null;
  confidence: number | null;
}

interface ReviewItemDetail {
  id: string;
  patient_id: string;
  patient_designation: string;
  side: string;
  confidence_tier: ConfidenceTier;
  overall_score: number;
  violations: Array<string>;
  n_scans_used: number;
  keypoints: Array<KeypointCoord>;
  template: Array<Array<number>>;
  latest_thermogram: Array<Array<number>> | null;
  review_status: string;
}

// ── Keypoint colors (matches overlay canvas) ──
const KP_COLORS: Record<string, string> = {
  Hallux: '#ef4444',
  '1st Metatarsal Head': '#f97316',
  '3rd Metatarsal Head': '#eab308',
  '5th Metatarsal Head': '#22c55e',
  Arch: '#3b82f6',
  Heel: '#a855f7'
};

const TIER_STYLES: Record<ConfidenceTier, { bg: string; text: string; label: string }> = {
  low: { bg: 'bg-red-100', text: 'text-red-700', label: 'Needs Review' },
  medium: { bg: 'bg-red-100', text: 'text-red-700', label: 'Needs Review' },
  high: { bg: 'bg-green-100', text: 'text-green-700', label: 'Auto-Accepted' }
};

function toOverlayKeypoints(kps: Array<KeypointCoord>, side: string): Array<KeypointResult> {
  return kps.map((kp) => ({
    name: kp.name,
    left: side === 'left' && kp.x != null && kp.y != null ? { x: kp.x, y: kp.y } : undefined,
    right: side === 'right' && kp.x != null && kp.y != null ? { x: kp.x, y: kp.y } : undefined
  }));
}

// ── Main page ────────────────────────────────────────────────
function ReviewDetailPage() {
  const { reviewId } = Route.useParams();

  const { data: item, isLoading, isError } = useQuery({
    queryKey: ['review-item', reviewId],
    queryFn: async () => {
      const res = await axios.get<ReviewItemDetail>(`${SERVER}/review-queue/${reviewId}`);
      return res.data;
    }
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 p-6">
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-gray-400 border-t-transparent" />
        <span className="text-sm text-gray-500">Loading review...</span>
      </div>
    );
  }

  if (isError || !item) {
    return (
      <div className="p-6">
        <div className="rounded-lg bg-white p-8 text-center shadow-sm">
          <p className="text-gray-500">Review item not found: {reviewId}</p>
          <Link to="/dashboard" className="mt-2 inline-block text-sm text-blue-600 hover:underline">
            Back to queue
          </Link>
        </div>
      </div>
    );
  }

  const tier = TIER_STYLES[item.confidence_tier];
  const overlayKps = toOverlayKeypoints(item.keypoints, item.side);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 p-4 lg:p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link to="/dashboard" className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50">
            &larr; Queue
          </Link>
          <h1 className="text-xl font-semibold text-black">{item.patient_designation}</h1>
          <span className="text-sm text-gray-500">{item.side} foot</span>
          <span className={cn('rounded-full px-2.5 py-1 text-xs font-medium', tier.bg, tier.text)}>{tier.label}</span>
        </div>
      </div>

      <div className="flex flex-col gap-4 lg:flex-row">
        {/* Left: template with keypoints */}
        <div className="w-full lg:w-1/2">
          <div className="rounded-lg bg-white p-4 shadow-sm">
            <h3 className="text-sm font-semibold text-black">Built Template — {item.side} foot</h3>
            <p className="mt-1 text-xs text-gray-400">Auto-placed keypoints from {item.n_scans_used} scans</p>
            <div className="mt-3 rounded bg-gray-900 p-2">
              <KeypointOverlayCanvas
                thermogramData={item.template}
                keypoints={overlayKps}
                renderMode="template"
                coordMode="single"
              />
            </div>
            <div className="mt-2">
              <KeypointLegend />
            </div>
          </div>
        </div>

        {/* Right: latest thermogram + details */}
        <div className="flex w-full flex-col gap-4 lg:w-1/2">
          {/* Latest thermogram */}
          {item.latest_thermogram && (
            <div className="rounded-lg bg-white p-4 shadow-sm">
              <h3 className="text-sm font-semibold text-black">Latest Mat Thermogram</h3>
              <p className="mt-1 text-xs text-gray-400">Most recent scan from this patient</p>
              <div className="mt-3 rounded bg-gray-900 p-2">
                <ThermogramHeatmap data={item.latest_thermogram} className="h-auto w-full rounded" />
              </div>
            </div>
          )}

          {/* Validation */}
          <div className="rounded-lg bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-black">Anatomical Validation</h3>
              <span className={cn('font-mono text-sm', item.overall_score >= 0.9 ? 'text-green-600' : item.overall_score >= 0.7 ? 'text-amber-600' : 'text-red-600')}>
                {(item.overall_score * 100).toFixed(0)}%
              </span>
            </div>
            {item.violations.length > 0 ? (
              <ul className="mt-2 list-inside list-disc text-xs text-amber-600">
                {item.violations.map((v, i) => (
                  <li key={i}>{v}</li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-xs text-green-600">All anatomical rules passed</p>
            )}
          </div>

          {/* Keypoint table */}
          <div className="rounded-lg bg-white p-4 shadow-sm">
            <h3 className="text-sm font-semibold text-black">Keypoint Coordinates</h3>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b text-gray-500">
                    <th className="pb-2 pr-4">Keypoint</th>
                    <th className="pb-2 pr-4">X</th>
                    <th className="pb-2">Y</th>
                  </tr>
                </thead>
                <tbody>
                  {item.keypoints.map((kp) => (
                    <tr key={kp.name} className="border-b border-gray-50">
                      <td className="py-1.5 pr-4">
                        <div className="flex items-center gap-2">
                          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: KP_COLORS[kp.name] }} />
                          <span className="font-medium text-gray-700">{kp.name}</span>
                        </div>
                      </td>
                      <td className="py-1.5 pr-4 font-mono text-gray-600">
                        {kp.x != null ? kp.x.toFixed(3) : <span className="text-red-400">null</span>}
                      </td>
                      <td className="py-1.5 font-mono text-gray-600">
                        {kp.y != null ? kp.y.toFixed(3) : <span className="text-red-400">null</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Actions */}
          <div className="rounded-lg bg-white p-4 shadow-sm">
            <div className="flex gap-2">
              <button disabled className="cursor-not-allowed rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white opacity-50">
                Approve Keypoints
              </button>
              <button disabled className="cursor-not-allowed rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white opacity-50">
                Flag for Manual Review
              </button>
              <Link
                to="/manual-build"
                search={{ patientId: item.patient_id }}
                className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Open in Template Builder
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
