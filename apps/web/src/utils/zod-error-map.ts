import { m } from '@/paraglide/messages';
import { z } from 'zod';

const localizedErrorMap: z.ZodErrorMap = (issue, ctx) => {
  switch (issue.code) {
    case z.ZodIssueCode.invalid_type:
      if (issue.received === 'undefined' || issue.received === 'null') {
        return { message: m.required() };
      }
      return { message: ctx.defaultError };
    case z.ZodIssueCode.invalid_string:
      if (issue.validation === 'email') {
        return { message: m.invalid_email_address() };
      }
      return { message: ctx.defaultError };
    case z.ZodIssueCode.too_small:
      if (issue.type === 'string') {
        return Number(issue.minimum) <= 1
          ? { message: m.required() }
          : {
              message: m.min_characters({ count: String(issue.minimum) }),
            };
      }
      return { message: ctx.defaultError };
    default:
      return { message: ctx.defaultError };
  }
};

/**
 * Routes Zod's default validation messages through Paraglide so form errors are
 * shown in the user's language.
 */
export const initZodErrorMap = () => {
  z.setErrorMap(localizedErrorMap);
};
