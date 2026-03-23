import axios, { type AxiosError, type AxiosRequestConfig } from 'axios';
import { getLogoutRedirectOptions } from '../services/auth';
import { STORAGE_KEYS } from './constants';

export type PodiAxiosRequestConfig = Omit<AxiosRequestConfig, 'url'>;
export type PodiAxiosResponseConfig<T = any> = {
  dataOnly?: boolean;
  onError?: (error: AxiosError) => T | Promise<T>;
};

/**
 * A wrapper around axios to handle common request/response patterns.
 *
 * @param url - The URL to send the request to.
 * @param requestConfig - Optional axios request configuration (excluding 'url').
 * @param responseConfig - Optional configuration for response handling.
 * @returns A promise resolving to the requested data.
 */
export const podiAxios = <T>(url: string, requestConfig?: PodiAxiosRequestConfig, responseConfig?: PodiAxiosResponseConfig<T>): Promise<T> => {
  const { dataOnly = true, onError } = responseConfig ?? {};

  const _config: AxiosRequestConfig<T> = {
    url,
    responseType: 'json',
    ...requestConfig
  };

  return axios<T>(_config)
    .then((res) => (dataOnly ? res.data : (res as T)))
    .catch(async (error: Error | AxiosError) => {
      console.error((error as AxiosError).config?.url, '\n', (error as AxiosError).message);

      if (typeof onError === 'function') {
        return onError(error as AxiosError);
      }

      // 403 signals session expired — redirect to login
      if (axios.isAxiosError(error) && error.response?.status === 403) {
        localStorage.removeItem(STORAGE_KEYS.PODI_TOKEN);
        window.location.assign(getLogoutRedirectOptions({ pathname: location.pathname, searchStr: location.search } as any).to);
      }

      throw error as AxiosError<{ message: string }>;
    }) as Promise<T>;
};
