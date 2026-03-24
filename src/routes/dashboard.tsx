import { type ConfidenceTier, type ReviewScanItem, type ReviewStatus, mockQueueSummary, mockReviewQueue } from '@/mocks/review-queue';
import { getLogoutRedirectOptions } from '@/services/auth';
import { cn } from '@/utils/classes';
import { ENV, STORAGE_KEYS } from '@/utils/constants';
import { Link, createFileRoute, redirect } from '@tanstack/react-router';
import { useMemo, useState } from 'react';

export const Route = createFileRoute('/dashboard')({
  beforeLoad: async ({ location }) => {
    const authToken = localStorage.getItem(STORAGE_KEYS.PODI_TOKEN);
    if (!authToken && ENV.ENV !== 'LOCAL') {
      throw redirect(getLogoutRedirectOptions(location));
    }
  },
  component: DashboardPage
});

// ── Tier badge ───────────────────────────────────────────────
const TIER_STYLES: Record<ConfidenceTier, { bg: string; text: string; label: string }> = {
  low: { bg: 'bg-red-100', text: 'text-red-700', label: 'Low' },
  medium: { bg: 'bg-amber-100', text: 'text-amber-700', label: 'Review' },
  high: { bg: 'bg-green-100', text: 'text-green-700', label: 'High' }
};

const TierBadge = ({ tier }: { tier: ConfidenceTier }) => {
  const s = TIER_STYLES[tier];
  return <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', s.bg, s.text)}>{s.label}</span>;
};

const STATUS_STYLES: Record<ReviewStatus, { bg: string; text: string; label: string }> = {
  pending: { bg: 'bg-gray-100', text: 'text-gray-600', label: 'Pending' },
  approved: { bg: 'bg-green-100', text: 'text-green-700', label: 'Approved' },
  rejected: { bg: 'bg-red-100', text: 'text-red-700', label: 'Rejected' },
  manual_override: { bg: 'bg-blue-100', text: 'text-blue-700', label: 'Manual Override' }
};

const StatusBadge = ({ status }: { status: ReviewStatus }) => {
  const s = STATUS_STYLES[status];
  return <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', s.bg, s.text)}>{s.label}</span>;
};

// ── Main page ────────────────────────────────────────────────
function DashboardPage() {
  const [tierFilter, setTierFilter] = useState<ConfidenceTier | 'all'>('all');
  const [searchText, setSearchText] = useState('');
  const [page, setPage] = useState(0);
  const pageSize = 25;

  const filteredItems = useMemo(() => {
    let items = mockReviewQueue;
    if (tierFilter !== 'all') {
      items = items.filter((i) => i.confidence_tier === tierFilter);
    }
    if (searchText.trim()) {
      const q = searchText.toLowerCase();
      items = items.filter(
        (i) => i.patient_designation.toLowerCase().includes(q) || i.patient_id.toLowerCase().includes(q) || i.scan_id.toLowerCase().includes(q)
      );
    }
    return items;
  }, [tierFilter, searchText]);

  const totalPages = Math.ceil(filteredItems.length / pageSize);
  const pageItems = filteredItems.slice(page * pageSize, (page + 1) * pageSize);

  const s = mockQueueSummary;

  return (
    <div className="flex flex-col gap-4 p-4 lg:p-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-semibold text-black">Keypoint Review Queue</h1>
        <p className="mt-1 text-sm text-gray-500">Scans processed by the auto-keypoint pipeline today. Low confidence scans require manual intervention.</p>
      </div>

      {/* Summary cards */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <button
          onClick={() => {
            setTierFilter('low');
            setPage(0);
          }}
          className={cn(
            'cursor-pointer rounded-lg border-2 p-4 text-left transition-colors',
            tierFilter === 'low' ? 'border-red-400 bg-red-50' : 'border-gray-200 bg-white hover:border-red-200'
          )}
        >
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-red-600">Manual Required</h3>
            <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-bold text-red-700">{s.low}</span>
          </div>
          <p className="mt-1 text-2xl font-semibold text-red-700">{s.low}</p>
          <p className="text-xs text-red-400">Low confidence — needs manual keypoints</p>
        </button>

        <button
          onClick={() => {
            setTierFilter('medium');
            setPage(0);
          }}
          className={cn(
            'cursor-pointer rounded-lg border-2 p-4 text-left transition-colors',
            tierFilter === 'medium' ? 'border-amber-400 bg-amber-50' : 'border-gray-200 bg-white hover:border-amber-200'
          )}
        >
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-amber-600">Needs Review</h3>
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-700">{s.medium}</span>
          </div>
          <p className="mt-1 text-2xl font-semibold text-amber-700">{s.medium}</p>
          <p className="text-xs text-amber-400">Medium confidence — review recommended</p>
        </button>

        <button
          onClick={() => {
            setTierFilter('high');
            setPage(0);
          }}
          className={cn(
            'cursor-pointer rounded-lg border-2 p-4 text-left transition-colors',
            tierFilter === 'high' ? 'border-green-400 bg-green-50' : 'border-gray-200 bg-white hover:border-green-200'
          )}
        >
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-green-600">Auto-Accepted</h3>
            <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-bold text-green-700">{s.high}</span>
          </div>
          <p className="mt-1 text-2xl font-semibold text-green-700">{s.high}</p>
          <p className="text-xs text-green-400">High confidence — no action needed</p>
        </button>

        <button
          onClick={() => {
            setTierFilter('all');
            setPage(0);
          }}
          className={cn(
            'cursor-pointer rounded-lg border-2 p-4 text-left transition-colors',
            tierFilter === 'all' ? 'border-gray-400 bg-gray-50' : 'border-gray-200 bg-white hover:border-gray-300'
          )}
        >
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-gray-600">Total Processed</h3>
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-bold text-gray-700">{s.total}</span>
          </div>
          <p className="mt-1 text-2xl font-semibold text-black">{s.total}</p>
          <p className="text-xs text-gray-400">All scans processed today</p>
        </button>
      </div>

      {/* Search + filter bar */}
      <div className="flex items-center gap-3 rounded-lg bg-white p-3 shadow-sm">
        <input
          type="text"
          value={searchText}
          onChange={(e) => {
            setSearchText(e.target.value);
            setPage(0);
          }}
          placeholder="Search by patient, scan ID..."
          className="flex-1 rounded-md border border-gray-300 px-3 py-1.5 text-sm text-black placeholder-gray-400 focus:border-gray-500 focus:outline-none"
        />
        <span className="text-xs text-gray-400">{filteredItems.length} results</span>
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-lg bg-white shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b bg-gray-50 text-xs font-medium text-gray-500">
                <th className="px-4 py-3">Patient</th>
                <th className="px-4 py-3">Side</th>
                <th className="px-4 py-3">Confidence</th>
                <th className="px-4 py-3">Mean Conf</th>
                <th className="px-4 py-3">Min Conf</th>
                <th className="px-4 py-3">KPs</th>
                <th className="px-4 py-3">Anomalies</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Scan Date</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {pageItems.map((item) => (
                <tr key={item.id} className="border-b border-gray-50 hover:bg-gray-50">
                  <td className="px-4 py-2.5">
                    <div className="font-medium text-black">{item.patient_designation}</div>
                    <div className="font-mono text-xs text-gray-400">{item.patient_id.slice(0, 12)}...</div>
                  </td>
                  <td className="px-4 py-2.5 text-xs text-gray-600">{item.side}</td>
                  <td className="px-4 py-2.5">
                    <TierBadge tier={item.confidence_tier} />
                  </td>
                  <td className="px-4 py-2.5">
                    <span
                      className={cn(
                        'font-mono text-xs',
                        item.mean_confidence >= 0.7 ? 'text-green-600' : item.mean_confidence >= 0.4 ? 'text-amber-600' : 'text-red-600'
                      )}
                    >
                      {(item.mean_confidence * 100).toFixed(0)}%
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    <span
                      className={cn(
                        'font-mono text-xs',
                        item.min_confidence >= 0.7 ? 'text-green-600' : item.min_confidence >= 0.4 ? 'text-amber-600' : 'text-red-600'
                      )}
                    >
                      {(item.min_confidence * 100).toFixed(0)}%
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-xs text-gray-600">
                    {item.keypoints_detected}/6
                    {item.null_keypoints > 0 && <span className="ml-1 text-red-400">({item.null_keypoints} null)</span>}
                  </td>
                  <td className="px-4 py-2.5 text-xs">{item.anomalies ? <span className="text-amber-600">{item.anomalies}</span> : <span className="text-gray-300">none</span>}</td>
                  <td className="px-4 py-2.5">
                    <StatusBadge status={item.review_status} />
                  </td>
                  <td className="px-4 py-2.5 text-xs text-gray-500">{new Date(item.scan_date).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
                  <td className="px-4 py-2.5">
                    <Link
                      to="/review/$reviewId"
                      params={{ reviewId: item.id }}
                      className="rounded-md bg-gray-900 px-3 py-1 text-xs font-medium text-white hover:bg-gray-800"
                    >
                      Review
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between border-t px-4 py-3">
            <span className="text-xs text-gray-500">
              Showing {page * pageSize + 1}–{Math.min((page + 1) * pageSize, filteredItems.length)} of {filteredItems.length}
            </span>
            <div className="flex gap-1">
              <button
                onClick={() => setPage(Math.max(0, page - 1))}
                disabled={page === 0}
                className="cursor-pointer rounded border px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-30"
              >
                Prev
              </button>
              {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                const p = page < 3 ? i : page - 2 + i;
                if (p >= totalPages) return null;
                return (
                  <button
                    key={p}
                    onClick={() => setPage(p)}
                    className={cn('cursor-pointer rounded border px-2 py-1 text-xs', p === page ? 'bg-gray-900 text-white' : 'hover:bg-gray-50')}
                  >
                    {p + 1}
                  </button>
                );
              })}
              <button
                onClick={() => setPage(Math.min(totalPages - 1, page + 1))}
                disabled={page >= totalPages - 1}
                className="cursor-pointer rounded border px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-30"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
