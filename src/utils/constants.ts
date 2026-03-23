export type Env = 'LOCAL' | 'DEV' | 'UAT' | 'PROD';

export const getEnv = (): Env => {
  if (location.hostname.endsWith('dev.podimetrics.com')) {
    return 'DEV';
  }

  switch (location.hostname) {
    case 'template-automation.podimetrics.com':
      return 'PROD';
    case 'template-automation.uat.podimetrics.com':
      return 'UAT';
    case 'localhost':
    default:
      return 'LOCAL';
  }
};

// DEV API base URL uses the same hostname the app is served from.
// The API is co-located behind the same CloudFront distribution.
const getApiBaseUrl = (): string => {
  const env = getEnv();
  switch (env) {
    case 'LOCAL':
      return 'http://localhost:3000/api/v1';
    case 'DEV':
      return `https://${location.hostname}/api/v1`;
    case 'UAT':
      return 'https://app.uat.podimetrics.com/api/v1';
    case 'PROD':
      return 'https://app.podimetrics.com/api/v1';
  }
};

export const ENV = {
  ENV: getEnv(),
  API_BASE_URL: getApiBaseUrl(),
  // Always-live API URL for pages that need real data even on localhost (e.g. auto-keypoint demo).
  // Falls back to the normal API base URL in deployed environments.
  DEV_API_BASE_URL: getEnv() === 'LOCAL' ? 'https://tmplt.dev.podimetrics.com/api/v1' : getApiBaseUrl()
};

export enum STORAGE_KEYS {
  PODI_TOKEN = '__podi'
}
