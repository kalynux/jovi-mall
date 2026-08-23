import { z } from 'zod';
import { EmailAddressSchema } from '../../core/validation/email';
import { PhoneNumberSchema } from '../../core/validation/phone';

/**
 * Password strength policy — the single source of truth for every role.
 *
 * The password lives on the User model, not on any role entity, so the policy
 * is account-level. Role-specific validators re-export from here rather than
 * redefining it.
 */
export const PasswordStrengthSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
  .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
  .regex(/[0-9]/, 'Password must contain at least one number')
  .regex(/[^A-Za-z0-9]/, 'Password must contain at least one special character');

/**
 * Update Password Schema
 *
 * Validates password change requests (all roles).
 */
export const UpdatePasswordSchema = z.object({
  oldPassword: z.string().min(1, 'Current password is required'),
  newPassword: PasswordStrengthSchema,
});

export type UpdatePasswordInput = z.infer<typeof UpdatePasswordSchema>;

// ─── Self-service contact change (Phase 6 · 6.D.1) ───────────────────────────
//
// Both request schemas are `.strict()` and both reuse the shared identifier schemas from
// `core/validation/` rather than spelling a regex out here. That is the convention already
// in force everywhere else, and it is what makes strict E.164 and RFC-shaped email one
// decision for the whole service instead of one per endpoint — the alternative is an
// address this endpoint accepts and `login` cannot resolve.
//
// Neither is `clearable()`. Clearing a login identifier is a real operation and it is the
// administrator's (`AdminUserService.updateContact`, which refuses to leave an account with
// neither): a self-service path that could clear the last one would let a person lock
// themselves out with no way back, which is exactly what this whole flow exists to prevent.

/** `PATCH /api/me/email` — open a change of login email. */
export const RequestEmailChangeSchema = z
  .object({ email: EmailAddressSchema })
  .strict();

/** `PATCH /api/me/phone` — open a change of login phone. */
export const RequestPhoneChangeSchema = z
  .object({ phone: PhoneNumberSchema })
  .strict();

/**
 * `POST /api/auth/email-change/confirm` — spend a confirmation token.
 *
 * Bounded at 512 characters so a pathological body is refused by the schema rather than
 * being hashed and looked up. The token this service mints is 64 hex characters; the bound
 * is generous on purpose, because a mail client that wraps a URL is a real thing and a
 * near-miss should be told the token is invalid, not that it is malformed.
 */
export const ConfirmEmailChangeSchema = z
  .object({ token: z.string().trim().min(1, 'A confirmation token is required').max(512) })
  .strict();

export type RequestEmailChangeInput = z.infer<typeof RequestEmailChangeSchema>;
export type RequestPhoneChangeInput = z.infer<typeof RequestPhoneChangeSchema>;
export type ConfirmEmailChangeInput = z.infer<typeof ConfirmEmailChangeSchema>;

/**
 * The literal a caller must type to close their account (ADR-A02).
 *
 * Exported so the api-doc, the test and the schema quote the same string rather than three
 * copies of it.
 */
export const ACCOUNT_CLOSURE_CONFIRMATION = 'CLOSE MY ACCOUNT';

/**
 * Close Account Schema.
 *
 * ── Why a typed phrase and NOT the password ──────────────────────────────────
 * The obvious guard for an irreversible self-service action is `UserService.verifyPassword`,
 * which exists for exactly this. It is the wrong one HERE: customers are passwordless by
 * default on this platform — `RegisterSchema` strips a supplied password for
 * `role: 'customer'` and mints a random one, and they sign in through the messaging bot — so
 * requiring a password would make closure impossible for most of the people entitled to it,
 * and possible only for the minority who had once used the reset flow.
 *
 * The phrase does the one job a confirmation can do: it makes the request impossible to send
 * by accident. It is not a credential and is not treated as one — the caller's access token
 * is what proves who they are.
 *
 * `.strict()` for the same reason every other schema here is: a body carrying `userId` should
 * be refused loudly, not silently ignored, because the account closed is always `req.auth`'s.
 */
export const CloseAccountSchema = z
  .object({
    confirm: z.literal(ACCOUNT_CLOSURE_CONFIRMATION, {
      errorMap: () => ({ message: `Type "${ACCOUNT_CLOSURE_CONFIRMATION}" to confirm` }),
    }),
  })
  .strict();

export type CloseAccountInput = z.infer<typeof CloseAccountSchema>;
