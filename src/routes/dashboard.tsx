import { getLogoutRedirectOptions } from '@/services/auth';
import { ENV, STORAGE_KEYS } from '@/utils/constants';
import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/dashboard')({
  beforeLoad: async ({ location }) => {
    const authToken = localStorage.getItem(STORAGE_KEYS.PODI_TOKEN);
    if (!authToken && ENV.ENV !== 'LOCAL') {
      throw redirect(getLogoutRedirectOptions(location));
    }
  },
  component: DashboardPage
});

function DashboardPage() {
  return (
    <div className="p-4 lg:p-6">
      <div className="rounded-lg bg-white p-6 shadow-sm">
        <h1 className="text-xl font-semibold text-black">Template Automation Dashboard</h1>
        <p className="mt-2 text-sm text-gray-500">Overview of template status, patient queue, and build activity will go here.</p>

        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div className="rounded-lg border border-gray-200 p-4">
            <h3 className="text-sm font-medium text-gray-500">Patients Without Templates</h3>
            <p className="mt-1 text-2xl font-semibold text-black">—</p>
          </div>
          <div className="rounded-lg border border-gray-200 p-4">
            <h3 className="text-sm font-medium text-gray-500">Templates Built Today</h3>
            <p className="mt-1 text-2xl font-semibold text-black">—</p>
          </div>
          <div className="rounded-lg border border-gray-200 p-4">
            <h3 className="text-sm font-medium text-gray-500">Pending Reprocessing</h3>
            <p className="mt-1 text-2xl font-semibold text-black">—</p>
          </div>
        </div>
      </div>
    </div>
  );
}
