import { STORAGE_KEYS } from '@/utils/constants';
import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/')({
  beforeLoad: async () => {
    const authToken = localStorage.getItem(STORAGE_KEYS.PODI_TOKEN);
    if (authToken) {
      throw redirect({ to: '/dashboard' });
    }
    throw redirect({ to: '/login' });
  }
});
