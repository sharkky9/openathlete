import { z } from 'zod';

import { MIN_PASSWORD_LENGTH } from './password-policy';

export const passwordResetRequestSchema = z.object({
  email: z.string().email(),
});

export type PasswordResetRequestDto = z.infer<
  typeof passwordResetRequestSchema
>;

export const passwordResetSchema = z.object({
  token: z.string(),
  password: z.string().min(MIN_PASSWORD_LENGTH),
});

export type PasswordResetDto = z.infer<typeof passwordResetSchema>;
