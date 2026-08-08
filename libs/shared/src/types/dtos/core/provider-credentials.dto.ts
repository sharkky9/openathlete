import { z } from 'zod';

/**
 * Credentials for providers that authenticate with a static API key rather than
 * an OAuth redirect (currently Intervals.icu).
 *
 * `athleteId` is optional: Intervals.icu exposes `GET /athlete/0` as a "me"
 * alias, so the server can discover the athlete ID from the key alone.
 */
export const providerCredentialsSchema = z.object({
  apiKey: z.string().min(1, 'An API key is required'),
  athleteId: z.string().trim().optional(),
});

export type ProviderCredentialsDto = z.infer<typeof providerCredentialsSchema>;
