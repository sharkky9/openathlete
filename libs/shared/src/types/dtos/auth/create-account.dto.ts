import { z } from 'zod';

import { MIN_PASSWORD_LENGTH } from './password-policy';

export const createAccountDtoSchema = z.object({
  email: z.string().email(),
  password: z.string().min(MIN_PASSWORD_LENGTH),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  invitationToken: z.string().optional(),
  coachInvitationToken: z.string().optional(),
});

export type CreateAccountDto = z.infer<typeof createAccountDtoSchema>;
