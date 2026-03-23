'use client';

import { type LoginCreds, login as loginApiCall } from '@/services/auth';
import { STORAGE_KEYS } from '@/utils/constants';
import axios from 'axios';
import { type JSX, type ReactNode, createContext, useContext, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { router } from '../main';

export const AuthContext = createContext<AuthContextProps>(null as unknown as AuthContextProps);

interface AuthContextProps {
  user: { email: string } | undefined;
  login: (credentials: LoginCreds) => void;
  logout: () => void;
}

export const AuthProvider = (props: { children: ReactNode }): JSX.Element => {
  const [user, setUser] = useState<{ email: string }>();

  useEffect(() => {
    const token = localStorage.getItem(STORAGE_KEYS.PODI_TOKEN);
    if (token) {
      setUser({ email: '[placeholder_email]@podimetrics.com' });
    }
  }, []);

  const login = async ({ email, password }: LoginCreds) => {
    try {
      const response = await loginApiCall({ email, password });
      const _authToken = (response as any)?.session_id as string | undefined;

      if (_authToken) {
        localStorage.setItem(STORAGE_KEYS.PODI_TOKEN, _authToken);
      }

      setUser({ email });

      const queryString = window.location.search;
      const urlParams = new URLSearchParams(queryString);
      const redirect = urlParams.get('redirect');

      toast.success('Successfully logged in');
      router.navigate({ to: redirect || '/brannock' });
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 401) {
        toast.error('Incorrect password, try again.');
      }
    }
  };

  const logout = () => {
    localStorage.removeItem(STORAGE_KEYS.PODI_TOKEN);
    setUser(undefined);
    router.navigate({ to: '/login' });
  };

  const value: AuthContextProps = {
    login,
    logout,
    user
  };

  return <AuthContext.Provider value={value}>{props.children}</AuthContext.Provider>;
};

export const useAuth = (): AuthContextProps => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
