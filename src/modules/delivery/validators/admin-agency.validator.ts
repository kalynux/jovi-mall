import { z } from 'zod';

/**
 * Request shapes for the delivery-agency admin surface — the routes the wi-admin
 * backend calls at `/api/internal/admin/agencies`.
 *
 * Validated here as well as there for the reason `admin-vendor.validator.ts` gives:
 * this service is where the values live, so it is where their canonical bounds are
 * decided. A bound only one side enforces is one the other side can violate.
 */

/**
 * Refusing an agency's business verification.
 *
 * The reason is required, and the bound is copied from `AdminRejectVendorKycSchema`
 * rather than chosen again — the two verdicts are the same kind of decision about
 * two kinds of business, and a rejection reason that fits on a vendor's screen and
 * not on an agency's would be an arbitrary difference.
 *
 * It is required for the same cause: **the agency is shown it.** A refusal whose
 * cause they cannot see is one they cannot act on, and re-submitting blind is the
 * worst outcome for both sides — it costs an administrator a second review of the
 * same unchanged application.
 */
export const AdminRejectAgencyKycSchema = z
  .object({
    reason: z
      .string()
      .trim()
      .min(3, 'A reason is required to reject an agency’s verification')
      .max(500),
  })
  .strict();

export type AdminRejectAgencyKycInput = z.infer<typeof AdminRejectAgencyKycSchema>;
