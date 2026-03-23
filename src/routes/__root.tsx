import { createRootRoute, Link, Outlet } from '@tanstack/react-router';
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

const SiteNavigation = () => {
  const { logout, user } = useAuth();

  return (
    <nav className="flex flex-row items-center justify-between bg-gray-900 p-4">
      <Link to="/brannock" className="text-sm font-semibold text-white">
        Brannock — Template Automation
      </Link>
      {user && (
        <div className="flex flex-row items-center gap-8">
          <button onClick={logout} className="cursor-pointer text-sm text-white hover:text-gray-300">
            Logout
          </button>
        </div>
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
