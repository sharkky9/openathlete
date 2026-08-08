import { ConnectorProvider } from '@openathlete/shared';

/**
 * Providers that connect with a static API key pasted by the user instead of an
 * OAuth redirect. Keep in sync with the API's `:provider/credentials` route.
 */
export const API_KEY_PROVIDERS: ConnectorProvider[] = ['INTERVALS_ICU'];

export function isApiKeyProvider(provider: ConnectorProvider): boolean {
  return API_KEY_PROVIDERS.includes(provider);
}

/** Where the user finds the key for each API-key provider. */
export const API_KEY_HELP_URL: Partial<Record<ConnectorProvider, string>> = {
  INTERVALS_ICU: 'https://intervals.icu/settings',
};
