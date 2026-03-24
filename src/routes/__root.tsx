import { createRootRoute, Link, Outlet, useRouterState } from '@tanstack/react-router';
import { lazy } from 'react';
import { Toaster } from 'react-hot-toast';
import { useAuth } from '../hooks/useAuth';

const TanStackRouterDevtools =
  import.meta.env.MODE === 'development'
    ? lazy(() =>
        import('@tanstack/react-router-devtools').then((res) => ({
          default: res.TanStackRouterDevtools
        }))
      )
    : () => null;

const NAV_ITEMS = [
  { label: 'Review Queue', to: '/dashboard' },
  { label: 'Template Builder', to: '/manual-build' },
  { label: 'Approval Log', to: '/approval-log' }
] as const;

const SiteNavigation = () => {
  const { logout, user } = useAuth();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <nav className="flex flex-row items-center justify-between bg-gray-900 px-4 py-3">
      <div className="flex items-center gap-8">
        <Link to="/dashboard" className="text-sm font-semibold text-white">
          Template Automation
        </Link>
        {user && (
          <div className="flex items-center gap-1">
            {NAV_ITEMS.map((item) => {
              const isActive = pathname === item.to || pathname.startsWith(item.to + '/');
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  className={
                    isActive
                      ? 'rounded-md bg-gray-700 px-3 py-1.5 text-sm font-medium text-white'
                      : 'rounded-md px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-800 hover:text-white'
                  }
                >
                  {item.label}
                </Link>
              );
            })}
          </div>
        )}
      </div>
      {user && (
        <button onClick={logout} className="cursor-pointer text-sm text-gray-300 hover:text-white">
          Logout
        </button>
      )}
    </nav>
  );
};

export const Route = createRootRoute({
  component: () => (
    <main className="min-h-screen bg-gray-100 pb-10">
      <Toaster />
      <SiteNavigation />
      <Outlet />
      <TanStackRouterDevtools />
    </main>
  )
});
