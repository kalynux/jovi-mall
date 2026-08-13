import { z } from 'zod';
import {
  EMAIL_FORMAT_MESSAGE,
  isEmailAddress,
  normalizeEmailAddress,
  OptionalEmailAddressSchema,
} from '../../core/validation/email';
import {
  isE164,
  normalizePhoneNumber,
  PHONE_FORMAT_MESSAGE,
  PhoneNumberSchema,
} from '../../core/validation/phone';

/**
 * Login accepts a phone number OR an email address in one field, so the rule is
 * "whichever one this is, it must be valid" rather than a laxer rule of its own.
 *
 * The `@` test is the same discriminator `AuthService.login` uses to choose
 * which repository lookup to run - deliberately, so the value that is validated
 * is the value that is looked up. Normalising here is what makes the lookup
 * work at all: `login_email` is stored lowercased and `login_phone` in E.164,
 * so an identifier typed as `John@Example.COM` or `+237 670 00 00 00` would
 * otherwise miss a row that exists.
 */
const LoginIdentifierSchema = z
  .string({ required_error: 'Phone or Email required' })
  .min(1, 'Phone or Email required')
  .transform((value) =>
    value.includes('@') ? normalizeEmailAddress(value) : normalizePhoneNumber(value)
  )
  .refine((value) => (value.includes('@') ? isEmailAddress(value) : isE164(value)), {
    message: `Identifier must be a valid email address or phone number. ${EMAIL_FORMAT_MESSAGE}. ${PHONE_FORMAT_MESSAGE}`,
  });

export const RegisterSchema = z.object({
  // Required, and the account's unique key - so it is held to full E.164 here,
  // where the account is created, rather than being repaired later.
  phone: PhoneNumberSchema,
  email: OptionalEmailAddressSchema,
  name: z.string().min(2, "Name required"),
  password: z.string().min(6, "Password must be at least 6 characters"),
  // 'admin' is NOT registerable. This endpoint is public (no auth middleware), so
  // accepting it here let anyone POST themselves a platform administrator and get a
  // signed admin token back in the same response. Administrators are created only by
  // the admin service's bootstrap CLI, in the separate `wi-admin` database.
  role: z.enum(['customer', 'vendor', 'agency', 'agent']).default('vendor'),
  business_name: z.string().optional(), // For vendors
  agency_name: z.string().optional(), // For agencies
});

export const LoginSchema = z.object({
  identifier: LoginIdentifierSchema,
  password: z.string().min(1, "Password required"),
  role: z.enum(['customer', 'vendor', 'agency', 'agent', 'admin']).optional(),
});

export const AuthMeSchema = z.object({
  userId: z.string().min(1, "User ID required"),
  role: z.enum(['customer', 'vendor', 'agency', 'agent', 'admin']),
});

export const AddRoleSchema = z.object({
  // 'admin' is NOT addable — this route only requires `requireAuth`, so accepting it
  // let any signed-in customer promote themselves. An admin holds no other role at
  // all: admin identity lives in `wi-admin` and is not a role on a platform User.
  role: z.enum(['customer', 'vendor', 'agency', 'agent']),
  name: z.string().min(2, 'Name required').optional(),          // customer / agent
  business_name: z.string().optional(),                          // vendor
  agency_name: z.string().optional(),                            // agency
});

export type RegisterInput = z.infer<typeof RegisterSchema>;
export type LoginInput = z.infer<typeof LoginSchema>;
export type AuthMeInput = z.infer<typeof AuthMeSchema>;
export type AddRoleInput = z.infer<typeof AddRoleSchema>;
