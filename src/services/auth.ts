import { podiAxios } from '@/utils/api';
import { ENV, STORAGE_KEYS } from '@/utils/constants';
import type { ParsedLocation, RedirectOptions } from '@tanstack/react-router';

export interface LoginCreds {
  email: string;
  password: string;
}

export const login = ({ email, password }: LoginCreds) => {
  if (ENV.ENV === 'LOCAL') {
    return Promise.resolve({ message: 'ok', session_id: 'mock-session-token', where_to: '/dashboard' });
  }

  // API expects JSON body with { user_id, password } at /sessions (no trailing slash).
  return podiAxios<{
    message: string;
    session_id: string;
    where_to: string;
  }>(`${ENV.API_BASE_URL}/sessions`, {
    method: 'POST',
    data: { user_id: email, password },
    headers: {
      'Content-Type': 'application/json'
    }
  });
};

export const getAuthHeader = () => {
  const authToken = localStorage.getItem(STORAGE_KEYS.PODI_TOKEN);
  return authToken ? { Authorization: `Bearer ${authToken}` } : {};
};

export const getLogoutRedirectOptions = (location: ParsedLocation<object>): RedirectOptions => {
  return location.pathname === '/' ? { to: '/login' } : { to: '/login', search: { redirect: location.pathname + location.searchStr } as any };
};
