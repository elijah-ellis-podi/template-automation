import { STORAGE_KEYS } from '@/utils/constants';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { LoginForm } from '../components/forms/LoginForm';

export const Route = createFileRoute('/login')({
  beforeLoad: async () => {
    const podiToken = localStorage.getItem(STORAGE_KEYS.PODI_TOKEN);
    if (podiToken) throw redirect({ to: '/dashboard' });
  },
  component: LoginPage
});

function LoginPage() {
  return (
    <div className="flex h-[calc(100vh-56px)] flex-col items-center justify-center bg-gray-200">
      <div className="rounded-lg bg-white p-6 shadow-sm">
        <h2 className="mb-1 text-lg font-semibold text-black">Login</h2>
        <p className="mb-4 text-sm text-gray-600">Enter your PADS credentials to continue</p>
        <LoginForm className="w-[300px]" />
      </div>
    </div>
  );
}
