import { z } from 'zod';

/**
 * Request shapes for `/api/internal/admin/vendors` — the surface the wi-admin backend calls.
 *
 * ── Why these are validated here as well as there ─────────────────────────────
 * wi-admin validates its own inbound request, and these run again on ours. That is not
 * redundancy: this service is where the values actually live, so it is where their
 * canonical bounds are decided. The numeric bounds below are copied from the vendor's own
 * settings schema, which is what stops an administrator writing a value the vendor's own
 * screen would refuse — a setting only the admin door could create is one that fails
 * every later edit its owner attempts.
 */

/** A reason string. Required wherever somebody has to be told why, later. */
const reason = (message: string) => z.string().trim().min(3, message).max(500);

/**
 * Suspending a vendor.
 *
 * The reason is required for the same cause as `AdminSuspendUserSchema`'s: a suspension
 * nobody can be given a reason for is one no support agent can explain and no
 * administrator can review. It is stored on the vendor row rather than only in wi-admin's
 * audit trail, because this service cannot read that database and the vendor has to be
 * able to be told.
 */
export const AdminSuspendVendorSchema = z
  .object({
    reason: reason('A reason is required to suspend a vendor'),
  })
  .strict();

/** Approving a verification. The note is optional — an approval explains itself. */
export const AdminApproveVendorKycSchema = z
  .object({
    note: z.string().trim().max(500).optional(),
  })
  .strict();

/**
 * Rejecting a verification. The reason is required and is REACHABLE BY THE VENDOR —
 * a rejection they cannot see the cause of is one they cannot act on, and re-submitting
 * blind is the worst outcome for both sides.
 */
export const AdminRejectVendorKycSchema = z
  .object({
    reason: reason('A reason is required to reject a vendor’s verification'),
  })
  .strict();

/** Taking one listing off sale. The note is what the vendor is shown. */
export const AdminSuspendVendorProductSchema = z
  .object({
    note: reason('A reason is required to take a product off sale'),
  })
  .strict();

/**
 * The platform-governed slice of a vendor's settings.
 *
 * ── The rule that decides what is in here ─────────────────────────────────────
 * A setting is the administrator's to change when its effect lands on somebody OTHER
 * than the vendor — the platform's sweep worker, the agency receiving the shipment, or
 * the customer waiting on the order. A setting whose only effect is on the vendor's own
 * screen or inbox is theirs.
 *
 * So `notify_days_before_expiry` (a notification to the vendor about the vendor) and
 * `customer_flags` (their private CRM vocabulary, referenced by `VendorCustomer.flag_ids`)
 * are deliberately ABSENT, and `.strict()` makes naming either one a 400 rather than a
 * silent no-op. Per-vendor commission is absent too, and is not an oversight: commission
 * lives on `PricingPlan` and is set by assigning a plan through
 * `POST /api/admin/vendors/:vendorId/plan`.
 */
export const AdminUpdateVendorSettingsSchema = z
  .object({
    /** Bounds from `VendorSettingsSchema.auto_cancel_unpaid_days` — min 1, max 90. */
    autoCancelUnpaidDays: z.number().int().min(1).max(90).optional(),
    autoRedirectOrdersToAgency: z.boolean().optional(),
    /** `null` clears the cap, meaning every order is auto-dispatched when the flag is on. */
    autoRedirectThresholdAmount: z.number().min(0).nullable().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: 'Nothing to update',
  });

export type AdminSuspendVendorInput = z.infer<typeof AdminSuspendVendorSchema>;
export type AdminApproveVendorKycInput = z.infer<typeof AdminApproveVendorKycSchema>;
export type AdminRejectVendorKycInput = z.infer<typeof AdminRejectVendorKycSchema>;
export type AdminSuspendVendorProductInput = z.infer<typeof AdminSuspendVendorProductSchema>;
export type AdminUpdateVendorSettingsInput = z.infer<typeof AdminUpdateVendorSettingsSchema>;
