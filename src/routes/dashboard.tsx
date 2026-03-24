import { getLogoutRedirectOptions } from '@/services/auth';
import { cn } from '@/utils/classes';
import { ENV, STORAGE_KEYS } from '@/utils/constants';
import { Link, createFileRoute, redirect } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import axios from 'axios';

const SERVER = 'http://localhost:8788';

export const Route = createFileRoute('/dashboard')({
  beforeLoad: async ({ location }) => {
    const authToken = localStorage.getItem(STORAGE_KEYS.PODI_TOKEN);
    if (!authToken && ENV.ENV !== 'LOCAL') {
      throw redirect(getLogoutRedirectOptions(location));
    }
  },
  component: DashboardPage
});

// ── Types ────────────────────────────────────────────────────
type ConfidenceTier = 'low' | 'medium' | 'high';

interface ReviewItem {
  id: string;
  patient_id: string;
  patient_designation: string;
  side: string;
  confidence_tier: ConfidenceTier;
  overall_score: number;
  violations: Array<string>;
  n_scans_used: number;
  keypoints: Array<{ name: string; x: number | null; y: number | null; confidence: number | null }>;
  review_status: string;
}

interface ReviewQueueResponse {
  items: Array<ReviewItem>;
  summary: { total: number; low: number; medium: number; high: number };
}

// "Needs Review" = low + medium combined
function needsReview(tier: ConfidenceTier): boolean {
  return tier === 'low' || tier === 'medium';
}

// ── Main page ────────────────────────────────────────────────
function DashboardPage() {
  const [filter, setFilter] = useState<'review' | 'accepted' | 'all'>('all');
  const [searchText, setSearchText] = useState('');

  const { data, isLoading, isError } = useQuery({
    queryKey: ['review-queue'],
    queryFn: async () => {
      const res = await axios.get<ReviewQueueResponse>(`${SERVER}/review-queue`);
      return res.data;
    },
    staleTime: 5 * 60 * 1000
  });

  const items = data?.items ?? [];
  const summary = data?.summary ?? { total: 0, low: 0, medium: 0, high: 0 };
  const reviewCount = summary.low + summary.medium;

  const filteredItems = useMemo(() => {
    let filtered = items;
    if (filter === 'review') {
      filtered = filtered.filter((i) => needsReview(i.confidence_tier));
    } else if (filter === 'accepted') {
      filtered = filtered.filter((i) => i.confidence_tier === 'high');
    }
    if (searchText.trim()) {
      const q = searchText.toLowerCase();
      filtered = filtered.filter(
        (i) => i.patient_designation.toLowerCase().includes(q) || i.patient_id.toLowerCase().includes(q)
      );
    }
    return filtered;
  }, [items, filter, searchText]);

  return (
    <div className="flex flex-col gap-4 p-4 lg:p-6">
      <div>
        <h1 className="text-xl font-semibold text-black">Keypoint Review Queue</h1>
        <p className="mt-1 text-sm text-gray-500">Templates auto-built for {Math.round(summary.total / 2)} patients. Each foot validated against anatomical rules.</p>
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 rounded-lg bg-white p-6 shadow-sm">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-gray-400 border-t-transparent" />
          <span className="text-sm text-gray-500">Building templates for all patients... this may take a moment on first load.</span>
        </div>
      )}

      {isError && (
        <div className="rounded-lg bg-red-50 p-4 text-sm text-red-600">
          Failed to load review queue. Make sure the server is running at {SERVER}.
        </div>
      )}

      {data && (
        <>
          {/* Summary cards — two: needs review vs auto-accepted */}
          <div className="grid gap-3 sm:grid-cols-3">
            <button
              onClick={() => setFilter('review')}
              className={cn(
                'cursor-pointer rounded-lg border-2 p-4 text-left transition-colors',
                filter === 'review' ? 'border-red-400 bg-red-50' : 'border-gray-200 bg-white hover:border-red-200'
              )}
            >
              <h3 className="text-sm font-medium text-red-600">Needs Review</h3>
              <p className="mt-1 text-2xl font-semibold text-red-700">{reviewCount}</p>
              <p className="text-xs text-red-400">Flagged by anatomical validation — manual check required</p>
            </button>

            <button
              onClick={() => setFilter('accepted')}
              className={cn(
                'cursor-pointer rounded-lg border-2 p-4 text-left transition-colors',
                filter === 'accepted' ? 'border-green-400 bg-green-50' : 'border-gray-200 bg-white hover:border-green-200'
              )}
            >
              <h3 className="text-sm font-medium text-green-600">Auto-Accepted</h3>
              <p className="mt-1 text-2xl font-semibold text-green-700">{summary.high}</p>
              <p className="text-xs text-green-400">All anatomical rules passed — no action needed</p>
            </button>

            <button
              onClick={() => setFilter('all')}
              className={cn(
                'cursor-pointer rounded-lg border-2 p-4 text-left transition-colors',
                filter === 'all' ? 'border-gray-400 bg-gray-50' : 'border-gray-200 bg-white hover:border-gray-300'
              )}
            >
              <h3 className="text-sm font-medium text-gray-600">Total</h3>
              <p className="mt-1 text-2xl font-semibold text-black">{summary.total}</p>
              <p className="text-xs text-gray-400">All feet processed</p>
            </button>
          </div>

          {/* Search */}
          <div className="flex items-center gap-3 rounded-lg bg-white p-3 shadow-sm">
            <input
              type="text"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder="Search by patient..."
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
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Score</th>
                    <th className="px-4 py-3">Scans</th>
                    <th className="px-4 py-3">Issues</th>
                    <th className="px-4 py-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredItems.map((item) => {
                    const isReview = needsReview(item.confidence_tier);
                    return (
                      <tr key={item.id} className={cn('border-b border-gray-50', isReview ? 'bg-red-50/30' : 'hover:bg-gray-50')}>
                        <td className="px-4 py-2.5">
                          <div className="font-medium text-black">{item.patient_designation}</div>
                          <div className="font-mono text-xs text-gray-400">{item.patient_id.slice(0, 12)}...</div>
                        </td>
                        <td className="px-4 py-2.5 text-xs text-gray-600">{item.side}</td>
                        <td className="px-4 py-2.5">
                          {isReview ? (
                            <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">Needs Review</span>
                          ) : (
                            <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">Accepted</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5">
                          <span className={cn('font-mono text-xs', item.overall_score >= 0.9 ? 'text-green-600' : 'text-red-600')}>
                            {(item.overall_score * 100).toFixed(0)}%
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-xs text-gray-600">{item.n_scans_used}</td>
                        <td className="px-4 py-2.5 text-xs">
                          {item.violations.length > 0 ? (
                            <span className="text-red-600">{item.violations.length} warning{item.violations.length !== 1 ? 's' : ''}</span>
                          ) : (
                            <span className="text-green-600">None</span>
                          )}
                        </td>
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
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
