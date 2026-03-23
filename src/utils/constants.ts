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

const SalusBaseUrlMap: Record<Env, string> = {
  LOCAL: 'http://localhost:3000/api/v1',
  DEV: 'https://app.dev.podimetrics.com/api/v1',
  UAT: 'https://app.uat.podimetrics.com/api/v1',
  PROD: 'https://app.podimetrics.com/api/v1'
};

export const ENV = {
  ENV: getEnv(),
  API_BASE_URL: SalusBaseUrlMap[getEnv()]
};

export enum STORAGE_KEYS {
  PODI_TOKEN = '__podi'
}
