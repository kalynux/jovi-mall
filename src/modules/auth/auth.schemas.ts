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
 * The roles a person may authenticate AS on this service.
 *
 * Deliberately NOT `UserRole` from the user model: that union still carries
 * `'admin'`, because the Mongoose enum describes what a legacy row may hold, not
 * what may be signed in as. Administrator identity lives in the separate
 * `wi-admin` database — an administrator holds no `users` row here at all, and
 * reaches this service through `requireAdminCaller`, never through a token.
 *
 * One list, four schemas. It used to be written out at each of them, and that is
 * exactly how `'admin'` came to be closed on register/add-role while staying open
 * on login/auth-me — a second, weaker administrator identity surviving in parallel
 * with the designed one. Derive from here; do not re-type the members.
 */
export const AUTHENTICATABLE_ROLES = ['customer', 'vendor', 'agency', 'agent'] as const;

export type AuthenticatableRole = (typeof AUTHENTICATABLE_ROLES)[number];

/**
 * Runtime counterpart to the list above, for the paths where a role arrives from a
 * stored `users.roles` array rather than from a parsed request body. Those are not
 * covered by the Zod enums and are the reason this guard exists rather than a cast:
 * a `roles: ['admin']` row auto-resolving to its single role would mint an admin
 * token without any request ever having named the role.
 */
export function isAuthenticatableRole(role: string): role is AuthenticatableRole {
  return (AUTHENTICATABLE_ROLES as readonly string[]).includes(role);
}

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
  role: z.enum(AUTHENTICATABLE_ROLES).default('vendor'),
  business_name: z.string().optional(), // For vendors
  agency_name: z.string().optional(), // For agencies
});

// 'admin' is NOT loggable-in-as, for the same reason it is not registerable. Both of
// these mint a token pair, so leaving it here kept a second administrator identity
// alive in parallel with the designed one — one with no MFA, no session revocation,
// no permission tier and no audit trail, and honoured by 26 route guards.
export const LoginSchema = z.object({
  identifier: LoginIdentifierSchema,
  password: z.string().min(1, "Password required"),
  role: z.enum(AUTHENTICATABLE_ROLES).optional(),
});

// Same rule, and this one is the role SWITCHER — it re-issues the pair for another of
// the caller's roles, so accepting 'admin' let any signed-in user ask to be handed an
// admin token and be refused only by whether they happened to hold the role.
export const AuthMeSchema = z.object({
  userId: z.string().min(1, "User ID required"),
  role: z.enum(AUTHENTICATABLE_ROLES),
});

export const AddRoleSchema = z.object({
  // 'admin' is NOT addable — this route only requires `requireAuth`, so accepting it
  // let any signed-in customer promote themselves. An admin holds no other role at
  // all: admin identity lives in `wi-admin` and is not a role on a platform User.
  role: z.enum(AUTHENTICATABLE_ROLES),
  name: z.string().min(2, 'Name required').optional(),          // customer / agent
  business_name: z.string().optional(),                          // vendor
  agency_name: z.string().optional(),                            // agency
});

export type RegisterInput = z.infer<typeof RegisterSchema>;
export type LoginInput = z.infer<typeof LoginSchema>;
export type AuthMeInput = z.infer<typeof AuthMeSchema>;
export type AddRoleInput = z.infer<typeof AddRoleSchema>;
