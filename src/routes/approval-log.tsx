import { getLogoutRedirectOptions } from '@/services/auth';
import { cn } from '@/utils/classes';
import { ENV, STORAGE_KEYS } from '@/utils/constants';
import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/approval-log')({
  beforeLoad: async ({ location }) => {
    const authToken = localStorage.getItem(STORAGE_KEYS.PODI_TOKEN);
    if (!authToken && ENV.ENV !== 'LOCAL') {
      throw redirect(getLogoutRedirectOptions(location));
    }
  },
  component: ApprovalLogPage
});

// ── Mock audit log entries ───────────────────────────────────
const MOCK_LOG = [
  { id: 1, date: '2026-03-24 09:12', patient: 'RB-2093', side: 'left', action: 'approved', reviewer: 'jsmith@podimetrics.com', score: 0.94, note: null },
  { id: 2, date: '2026-03-24 09:14', patient: 'RB-2093', side: 'right', action: 'approved', reviewer: 'jsmith@podimetrics.com', score: 0.92, note: null },
  { id: 3, date: '2026-03-24 09:21', patient: 'KL-4417', side: 'left', action: 'flagged', reviewer: 'jsmith@podimetrics.com', score: 0.61, note: 'Hallux placement looks off — possible partial amputation' },
  { id: 4, date: '2026-03-24 09:23', patient: 'KL-4417', side: 'right', action: 'approved', reviewer: 'jsmith@podimetrics.com', score: 0.88, note: null },
  { id: 5, date: '2026-03-24 09:30', patient: 'MV-1155', side: 'left', action: 'approved', reviewer: 'agarcia@podimetrics.com', score: 0.97, note: null },
  { id: 6, date: '2026-03-24 09:30', patient: 'MV-1155', side: 'right', action: 'approved', reviewer: 'agarcia@podimetrics.com', score: 0.95, note: null },
  { id: 7, date: '2026-03-24 09:45', patient: 'DH-1838', side: 'left', action: 'override', reviewer: 'agarcia@podimetrics.com', score: 0.52, note: 'Manually corrected arch and heel keypoints' },
  { id: 8, date: '2026-03-24 09:47', patient: 'DH-1838', side: 'right', action: 'override', reviewer: 'agarcia@podimetrics.com', score: 0.48, note: 'Manually corrected all metatarsal heads' },
  { id: 9, date: '2026-03-24 10:05', patient: 'TT-0002', side: 'left', action: 'approved', reviewer: 'jsmith@podimetrics.com', score: 0.91, note: null },
  { id: 10, date: '2026-03-24 10:05', patient: 'TT-0002', side: 'right', action: 'approved', reviewer: 'jsmith@podimetrics.com', score: 0.93, note: null },
  { id: 11, date: '2026-03-24 10:15', patient: 'BX-0773', side: 'left', action: 'flagged', reviewer: 'agarcia@podimetrics.com', score: 0.55, note: 'Forefoot taper check failed — possible toe amputation' },
  { id: 12, date: '2026-03-24 10:18', patient: 'BX-0773', side: 'right', action: 'approved', reviewer: 'agarcia@podimetrics.com', score: 0.90, note: null },
];

const ACTION_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  approved: { bg: 'bg-green-100', text: 'text-green-700', label: 'Approved' },
  flagged: { bg: 'bg-red-100', text: 'text-red-700', label: 'Flagged' },
  override: { bg: 'bg-blue-100', text: 'text-blue-700', label: 'Manual Override' },
};

function ApprovalLogPage() {
  const counts = {
    approved: MOCK_LOG.filter((e) => e.action === 'approved').length,
    flagged: MOCK_LOG.filter((e) => e.action === 'flagged').length,
    override: MOCK_LOG.filter((e) => e.action === 'override').length,
  };

  return (
    <div className="flex flex-col gap-4 p-4 lg:p-6">
      <div>
        <h1 className="text-xl font-semibold text-black">Approval Log</h1>
        <p className="mt-1 text-sm text-gray-500">Audit trail of template review decisions. All approvals, flags, and manual overrides are recorded here.</p>
      </div>

      {/* Summary */}
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-green-200 bg-green-50 p-3">
          <span className="text-xs text-green-600">Approved</span>
          <p className="text-xl font-semibold text-green-700">{counts.approved}</p>
        </div>
        <div className="rounded-lg border border-red-200 bg-red-50 p-3">
          <span className="text-xs text-red-600">Flagged for Review</span>
          <p className="text-xl font-semibold text-red-700">{counts.flagged}</p>
        </div>
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-3">
          <span className="text-xs text-blue-600">Manual Overrides</span>
          <p className="text-xl font-semibold text-blue-700">{counts.override}</p>
        </div>
      </div>

      {/* Log table */}
      <div className="overflow-hidden rounded-lg bg-white shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b bg-gray-50 text-xs font-medium text-gray-500">
                <th className="px-4 py-3">Time</th>
                <th className="px-4 py-3">Patient</th>
                <th className="px-4 py-3">Side</th>
                <th className="px-4 py-3">Action</th>
                <th className="px-4 py-3">Score</th>
                <th className="px-4 py-3">Reviewer</th>
                <th className="px-4 py-3">Note</th>
              </tr>
            </thead>
            <tbody>
              {MOCK_LOG.map((entry) => {
                const style = ACTION_STYLES[entry.action] ?? ACTION_STYLES.approved;
                return (
                  <tr key={entry.id} className="border-b border-gray-50 hover:bg-gray-50">
                    <td className="px-4 py-2.5 font-mono text-xs text-gray-500">{entry.date}</td>
                    <td className="px-4 py-2.5 font-medium text-black">{entry.patient}</td>
                    <td className="px-4 py-2.5 text-xs text-gray-600">{entry.side}</td>
                    <td className="px-4 py-2.5">
                      <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', style.bg, style.text)}>{style.label}</span>
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={cn('font-mono text-xs', entry.score >= 0.9 ? 'text-green-600' : entry.score >= 0.7 ? 'text-amber-600' : 'text-red-600')}>
                        {(entry.score * 100).toFixed(0)}%
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-gray-500">{entry.reviewer}</td>
                    <td className="px-4 py-2.5 text-xs text-gray-500">{entry.note || <span className="text-gray-300">—</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
