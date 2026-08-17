import { z } from 'zod';
import { ClearableEmailAddressSchema } from '../../core/validation/email';
import { ClearablePhoneNumberSchema } from '../../core/validation/phone';

/**
 * Request shapes for `/api/internal/admin/users` — the surface the wi-admin backend calls.
 *
 * ── Why these are validated here as well as there ─────────────────────────────
 * wi-admin validates its own inbound request, and this schema runs again on ours. That
 * is not redundancy: this service is where the login identifiers actually live, so it is
 * where their canonical form is decided. `ClearableEmailAddressSchema` and
 * `ClearablePhoneNumberSchema` are the SAME schemas the customer-facing registration and
 * profile paths use, which is what stops an administrator writing a value that the
 * platform's own validators would have refused — an address only the admin door could
 * create is a row that fails every later edit its owner attempts.
 *
 * They are also normalising transforms (lowercase / E.164), so this is where a
 * `+237 670 00 00 00` typed into the dashboard becomes the `+237670000000` that
 * `findByPhone` will actually match.
 */

/**
 * A contact edit. Both fields are clearable: `''`/`null` removes the identifier.
 *
 * `.strict()` so a client sending `roles` or `status` here gets a 400 rather than a
 * silent no-op — those are separate operations with separate permissions, and a request
 * that looks like it changed a role must never come back 200 having changed nothing.
 */
export const AdminUpdateUserContactSchema = z
  .object({
    email: ClearableEmailAddressSchema,
    phone: ClearablePhoneNumberSchema,
  })
  .strict()
  .refine(
    (body) => body.email !== undefined || body.phone !== undefined,
    { message: 'Nothing to update — send `email`, `phone`, or both' }
  );

export const AdminSuspendUserSchema = z
  .object({
    /**
     * Required, and the reason it is required is the person on the other end: a
     * suspension they cannot be given a reason for is one no support agent can explain
     * and no administrator can review. The same rule the agent suspension path applies.
     */
    reason: z.string().trim().min(3, 'A reason is required to suspend an account').max(500),
  })
  .strict();

/**
 * Which channel to send an account-recovery credential over.
 *
 * A pinned enum, so an unrecognised value is a 400 rather than a silent fallback to
 * email. A fallback here would mail a credential to an address the operator did not
 * choose, which is precisely the confusion this endpoint is shaped to avoid.
 *
 * ⚠ There is deliberately **no destination field**. The address is read from the party's
 * own record. An operator who could type one could mail a working credential for
 * somebody else's account to themselves.
 */
export const AdminSendCredentialSchema = z
  .object({
    channel: z.enum(['email', 'whatsapp', 'telegram']),
  })
  .strict();

export type AdminUpdateUserContactInput = z.infer<typeof AdminUpdateUserContactSchema>;
export type AdminSuspendUserInput = z.infer<typeof AdminSuspendUserSchema>;
export type AdminSendCredentialInput = z.infer<typeof AdminSendCredentialSchema>;
