import { KeypointLegend } from '@/components/brannock/KeypointOverlayCanvas';
import { type ConfidenceTier, type ReviewScanItem, mockReviewQueue } from '@/mocks/review-queue';
import { getLogoutRedirectOptions } from '@/services/auth';
import { cn } from '@/utils/classes';
import { ENV, STORAGE_KEYS } from '@/utils/constants';
import { Link, createFileRoute, redirect } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';

export const Route = createFileRoute('/review/$reviewId')({
  beforeLoad: async ({ location }) => {
    const authToken = localStorage.getItem(STORAGE_KEYS.PODI_TOKEN);
    if (!authToken && ENV.ENV !== 'LOCAL') {
      throw redirect(getLogoutRedirectOptions(location));
    }
  },
  component: ReviewDetailPage
});

// ── Tier badge ───────────────────────────────────────────────
const TIER_STYLES: Record<ConfidenceTier, { bg: string; text: string; label: string }> = {
  low: { bg: 'bg-red-100', text: 'text-red-700', label: 'Low Confidence' },
  medium: { bg: 'bg-amber-100', text: 'text-amber-700', label: 'Medium Confidence' },
  high: { bg: 'bg-green-100', text: 'text-green-700', label: 'High Confidence' }
};

// ── Keypoint colors (matches KeypointOverlayCanvas) ──
const KP_COLORS: Record<string, string> = {
  Hallux: '#ef4444',
  '1st Metatarsal Head': '#f97316',
  '3rd Metatarsal Head': '#eab308',
  '5th Metatarsal Head': '#22c55e',
  Arch: '#3b82f6',
  Heel: '#a855f7'
};

// ── Simulated foot template canvas ───────────────────────────
// Since we don't have the actual thermogram, render a schematic
// foot outline with the model's keypoint placements.
const KeypointSchematic = ({ item }: { item: ReviewScanItem }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const w = 300;
    const h = 450;
    canvas.width = w;
    canvas.height = h;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Background
    ctx.fillStyle = '#111827';
    ctx.fillRect(0, 0, w, h);

    // Draw a schematic foot outline
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    const cx = w / 2;
    // Simplified foot shape
    const isLeft = item.side === 'left';
    const toeOffsetX = isLeft ? -30 : 30;
    ctx.moveTo(cx + toeOffsetX, 40);
    ctx.quadraticCurveTo(cx + (isLeft ? -80 : 80), 100, cx + (isLeft ? -70 : 70), 180);
    ctx.quadraticCurveTo(cx + (isLeft ? -50 : 50), 300, cx + (isLeft ? -30 : 30), 380);
    ctx.quadraticCurveTo(cx, 430, cx + (isLeft ? 30 : -30), 380);
    ctx.quadraticCurveTo(cx + (isLeft ? 60 : -60), 300, cx + (isLeft ? 50 : -50), 180);
    ctx.quadraticCurveTo(cx + (isLeft ? 40 : -40), 100, cx + toeOffsetX, 40);
    ctx.closePath();
    ctx.stroke();

    // Fill with subtle gradient
    const grad = ctx.createRadialGradient(cx, h * 0.4, 20, cx, h * 0.4, 200);
    grad.addColorStop(0, 'rgba(139, 92, 46, 0.3)');
    grad.addColorStop(1, 'rgba(139, 92, 46, 0.05)');
    ctx.fillStyle = grad;
    ctx.fill();

    // Draw keypoints
    for (const kp of item.model_keypoints) {
      if (kp.x === null || kp.y === null) continue;

      const px = kp.x * w;
      const py = kp.y * h;
      const color = KP_COLORS[kp.name] || '#ffffff';
      const conf = kp.confidence ?? 1;
      const alpha = 0.5 + conf * 0.5;

      // Outer ring
      ctx.beginPath();
      ctx.arc(px, py, 8, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255, 255, 255, ${alpha})`;
      ctx.lineWidth = 2;
      ctx.stroke();

      // Filled circle
      ctx.beginPath();
      ctx.arc(px, py, 6, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.globalAlpha = alpha;
      ctx.fill();
      ctx.globalAlpha = 1;

      // Label
      ctx.font = '10px sans-serif';
      ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
      ctx.textAlign = 'left';
      ctx.fillText(kp.name.split(' ')[0], px + 12, py + 4);

      // Confidence
      if (kp.confidence !== null) {
        ctx.font = '9px sans-serif';
        ctx.fillStyle = conf >= 0.7 ? '#4ade80' : conf >= 0.4 ? '#fbbf24' : '#f87171';
        ctx.fillText(`${Math.round(conf * 100)}%`, px + 12, py + 16);
      }
    }

    // Side label
    ctx.font = 'bold 12px sans-serif';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.textAlign = 'center';
    ctx.fillText(`${item.side.toUpperCase()} FOOT`, cx, h - 10);
  }, [item]);

  return <canvas ref={canvasRef} className="h-auto w-full rounded" />;
};

// ── Main page ────────────────────────────────────────────────
function ReviewDetailPage() {
  const { reviewId } = Route.useParams();
  const item = mockReviewQueue.find((i) => i.id === reviewId);

  if (!item) {
    return (
      <div className="p-6">
        <div className="rounded-lg bg-white p-8 text-center shadow-sm">
          <p className="text-gray-500">Review item not found: {reviewId}</p>
          <Link to="/dashboard" className="mt-2 inline-block text-sm text-blue-600 hover:underline">
            Back to dashboard
          </Link>
        </div>
      </div>
    );
  }

  const tier = TIER_STYLES[item.confidence_tier];

  // Find neighboring items for next/prev navigation
  const allItems = mockReviewQueue.filter((i) => i.confidence_tier === item.confidence_tier);
  const currentIdx = allItems.findIndex((i) => i.id === item.id);
  const prevItem = currentIdx > 0 ? allItems[currentIdx - 1] : null;
  const nextItem = currentIdx < allItems.length - 1 ? allItems[currentIdx + 1] : null;

  return (
    <div className="flex flex-col gap-4 p-4 lg:p-6">
      {/* Header with navigation */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link to="/dashboard" className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50">
            &larr; Queue
          </Link>
          <h1 className="text-xl font-semibold text-black">{item.patient_designation}</h1>
          <span className={cn('rounded-full px-2.5 py-1 text-xs font-medium', tier.bg, tier.text)}>{tier.label}</span>
        </div>
        <div className="flex gap-2">
          {prevItem && (
            <Link to="/review/$reviewId" params={{ reviewId: prevItem.id }} className="rounded-md border border-gray-300 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50">
              &larr; Prev
            </Link>
          )}
          {nextItem && (
            <Link to="/review/$reviewId" params={{ reviewId: nextItem.id }} className="rounded-md border border-gray-300 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50">
              Next &rarr;
            </Link>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-4 lg:flex-row">
        {/* Left: keypoint visualization */}
        <div className="w-full lg:w-[360px]">
          <div className="rounded-lg bg-white p-4 shadow-sm">
            <h3 className="text-lg font-semibold text-black">Model Keypoint Placement</h3>
            <p className="mt-1 text-xs text-gray-400">Keypoints placed by the auto-detection model on the {item.side} foot</p>
            <div className="mt-3 rounded bg-gray-900 p-2">
              <KeypointSchematic item={item} />
            </div>
            <div className="mt-3">
              <KeypointLegend />
            </div>
          </div>
        </div>

        {/* Right: details + actions */}
        <div className="flex flex-1 flex-col gap-4">
          {/* Scan info */}
          <div className="rounded-lg bg-white p-4 shadow-sm">
            <h3 className="text-sm font-semibold text-black">Scan Details</h3>
            <div className="mt-2 grid grid-cols-2 gap-x-8 gap-y-2 text-sm">
              <div>
                <span className="text-gray-500">Patient ID</span>
                <p className="font-mono text-xs text-black">{item.patient_id}</p>
              </div>
              <div>
                <span className="text-gray-500">Scan ID</span>
                <p className="font-mono text-xs text-black">{item.scan_id.slice(0, 30)}...</p>
              </div>
              <div>
                <span className="text-gray-500">Foot Side</span>
                <p className="text-black">{item.side}</p>
              </div>
              <div>
                <span className="text-gray-500">Scan Date</span>
                <p className="text-black">{new Date(item.scan_date).toLocaleString()}</p>
              </div>
              <div>
                <span className="text-gray-500">Keypoints Detected</span>
                <p className="text-black">{item.keypoints_detected}/6{item.null_keypoints > 0 && <span className="ml-1 text-red-400">({item.null_keypoints} absent)</span>}</p>
              </div>
            </div>
            {item.anomalies && (
              <div className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-700">{item.anomalies}</div>
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
                    <th className="pb-2 pr-4">Y</th>
                    <th className="pb-2">Confidence</th>
                  </tr>
                </thead>
                <tbody>
                  {item.model_keypoints.map((kp) => (
                    <tr key={kp.name} className="border-b border-gray-50">
                      <td className="py-2 pr-4">
                        <div className="flex items-center gap-2">
                          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: KP_COLORS[kp.name] }} />
                          <span className="font-medium text-gray-700">{kp.name}</span>
                        </div>
                      </td>
                      <td className="py-2 pr-4 font-mono text-gray-600">{kp.x != null ? kp.x.toFixed(3) : <span className="text-red-400">null</span>}</td>
                      <td className="py-2 pr-4 font-mono text-gray-600">{kp.y != null ? kp.y.toFixed(3) : <span className="text-red-400">null</span>}</td>
                      <td className="py-2">
                        {kp.confidence != null ? (
                          <span
                            className={cn(
                              'font-mono',
                              kp.confidence >= 0.7 ? 'text-green-600' : kp.confidence >= 0.4 ? 'text-amber-600' : 'text-red-600'
                            )}
                          >
                            {Math.round(kp.confidence * 100)}%
                          </span>
                        ) : (
                          <span className="text-gray-300">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-3 flex items-center gap-4 text-xs text-gray-500">
              <span>
                Mean: <span className="font-mono font-medium">{(item.mean_confidence * 100).toFixed(0)}%</span>
              </span>
              <span>
                Min: <span className="font-mono font-medium">{(item.min_confidence * 100).toFixed(0)}%</span>
              </span>
              <span>
                Detected: {item.keypoints_detected}/6
              </span>
            </div>
          </div>

          {/* Action buttons */}
          <div className="rounded-lg bg-white p-4 shadow-sm">
            <h3 className="text-sm font-semibold text-black">Review Actions</h3>
            <p className="mt-1 text-xs text-gray-400">Accept the model's keypoints, reject and flag for manual placement, or open in the manual builder.</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button className="cursor-pointer rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700">
                Approve Keypoints
              </button>
              <button className="cursor-pointer rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700">
                Reject — Flag for Manual
              </button>
              <Link
                to="/manual-build"
                search={{ patientId: item.patient_id }}
                className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Open in Manual Builder
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
