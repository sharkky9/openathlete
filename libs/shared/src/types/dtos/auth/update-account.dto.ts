import { z } from 'zod';

export const updateAccountDtoSchema = z.object({
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  gender: z.enum(['MALE', 'FEMALE', 'OTHER']).optional(),
  /**
   * When present, the submitted array is authoritative: roles absent from it
   * are removed as well as added, matching `completeOnboarding`. It may not be
   * empty — the web shell (`SpaceProvider`, the sidebar space switcher) assumes
   * every account has at least one role. Omit the field entirely to leave roles
   * untouched.
   */
  roles: z
    .array(z.enum(['ATHLETE', 'COACH']))
    .min(1)
    .optional(),
});

export type UpdateAccountDto = z.infer<typeof updateAccountDtoSchema>;
