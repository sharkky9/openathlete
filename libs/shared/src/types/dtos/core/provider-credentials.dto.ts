import { z } from 'zod';

/**
 * Credentials for providers that authenticate with a static API key rather than
 * an OAuth redirect (currently Intervals.icu).
 *
 * `apiKey` is omissible so a single-user deployment can configure the key on the
 * server (`INTERVALS_ICU_API_KEY`) and connect without it ever passing through a
 * form. Omitted means "use the server's key"; present must still be non-empty,
 * so a blank form field is a validation error rather than a silent fallback.
 *
 * `athleteId` is optional: Intervals.icu exposes `GET /athlete/0` as a "me"
 * alias, so the server can discover the athlete ID from the key alone.
 */
export const providerCredentialsSchema = z.object({
  apiKey: z.string().min(1, 'An API key is required').optional(),
  athleteId: z.string().trim().optional(),
});

export type ProviderCredentialsDto = z.infer<typeof providerCredentialsSchema>;
