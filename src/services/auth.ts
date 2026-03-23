import { podiAxios } from '@/utils/api';
import { ENV, STORAGE_KEYS } from '@/utils/constants';
import type { ParsedLocation, RedirectOptions } from '@tanstack/react-router';

export interface LoginCreds {
  email: string;
  password: string;
}

export const login = ({ email, password }: LoginCreds) => {
  if (ENV.ENV === 'LOCAL') {
    return Promise.resolve({ message: 'ok', session_id: 'mock-session-token', where_to: '/brannock' });
  }

  return podiAxios<{
    message: string;
    session_id: string;
    where_to: string;
  }>(`${ENV.API_BASE_URL}/sessions/`, {
    method: 'POST',
    data: JSON.stringify({ user_id: email, password }),
    headers: {
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8'
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
