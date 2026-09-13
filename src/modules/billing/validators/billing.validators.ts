import { z } from 'zod';
import { PaymentChannelSchema } from '../../payments/validators/payment.validators';
import { BILLING_OWNER_TYPES } from '../billing.types';

// Derived from the module's own list, never retyped beside it — the same rule the
// notification catalogs follow, for the same reason: two hand-maintained copies of one
// vocabulary drift, and the drift is silent until a request is refused for no reason.
const PlanRoleSchema = z.enum([...BILLING_OWNER_TYPES]);

/**
 * Admin: create a pricing plan. Limit fields are role-specific and nullable —
 * vendor plans carry products/storage/commission; agency/agent plans carry
 * `max_unterminated_shipments`. `live_tracking_enabled` defaults true everywhere.
 */
export const CreatePlanSchema = z.object({
  role: PlanRoleSchema.default('vendor'),
  code: z.string().trim().min(2).max(40),
  name: z.string().trim().min(2).max(80),
  price: z.number().min(0),
  currency: z.string().trim().length(3).optional(),
  term_days: z.number().int().min(1).nullable(),
  credit_allowance: z.number().int().min(0),
  max_active_products: z.number().int().min(0).nullable().optional(),
  max_storage_bytes: z.number().int().min(0).nullable().optional(),
  commission_percent: z.number().min(0).max(100).nullable().optional(),
  max_unterminated_shipments: z.number().int().min(0).nullable().optional(),
  live_tracking_enabled: z.boolean().optional(),
  is_active: z.boolean().optional(),
  sort_order: z.number().int().optional(),
});

/** Admin: update a pricing plan (code/role are immutable, ignored if sent). */
export const UpdatePlanSchema = CreatePlanSchema.partial().omit({ role: true, code: true });

/** Admin: filter the plan catalog by role (optional). */
export const ListPlansQuerySchema = z.object({
  role: PlanRoleSchema.optional(),
});

/**
 * Public: filter the plan catalog by role, and opt in to the tiers that are
 * defined but not purchasable.
 *
 * `includeInactive` is opt-in rather than the default because `is_active: false`
 * is ambiguous on a public page — it means both "seeded ahead of launch" and
 * "withdrawn from sale", and only the caller knows which story it wants to tell.
 * Flag parsing follows the `trueFlag` convention in `connection.validator.ts`:
 * the literal string `'true'`, anything else (including absent) is false.
 */
export const PublicListPlansQuerySchema = z.object({
  role: PlanRoleSchema.optional(),
  includeInactive: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
});

/** Admin: assign a plan to a vendor. */
export const AssignPlanSchema = z.object({
  planId: z.string().trim().min(1),
  paymentRef: z.string().trim().min(1).optional(),
});

/**
 * Shared payment channel shape (mobile money / card).
 *
 * The shape itself now lives with the payment module (the gateways that consume
 * it), so a credit top-up, a plan purchase, a checkout and a booking payment all
 * validate the buyer's number and email identically. Only the "may be omitted"
 * part is billing's own: these two bodies have always defaulted it to `{}`.
 */
const BillingPaymentChannelSchema = PaymentChannelSchema.default({});

/** Vendor: start a credit top-up purchase. */
export const InitiateTopupSchema = z.object({
  packCode: z.string().trim().min(1),
  gateway: z.enum(['NOTCHPAY', 'MYCOOLPAY', 'STRIPE']),
  channel: BillingPaymentChannelSchema,
});

/** Vendor: start a self-serve plan purchase (planId comes from the URL). */
export const InitiatePlanPurchaseSchema = z.object({
  gateway: z.enum(['NOTCHPAY', 'MYCOOLPAY', 'STRIPE']),
  channel: BillingPaymentChannelSchema,
});

/**
 * Relay the mobile-money one-time code for a top-up or a plan purchase.
 *
 * The same shape as `AuthorizePaymentSchema` in the payments module, and
 * deliberately re-exported from it rather than retyped: the code being relayed
 * is the same gateway's code, and two copies of the accepted format would let
 * one path start refusing a digit length the other accepts.
 */
export { AuthorizePaymentSchema as AuthorizeBillingOtpSchema } from '../../payments/validators/payment.validators';

/** Pagination query for ledger / top-up history. */
export const PaginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/** Vendor: how many days before expiry to be notified. */
export const ExpiryNoticeSchema = z.object({
  notifyDaysBeforeExpiry: z.number().int().min(0).max(90),
});

/**
 * The owner a plan-driven entitlement is being read for.
 *
 * `BILLING_OWNER_TYPES` rather than a typed-out list, so this cannot drift from the
 * roles plans are actually scoped to.
 */
export const EntitlementParamsSchema = z.object({
  ownerType: PlanRoleSchema,
  ownerId: z.string().trim().regex(/^[a-f\d]{24}$/i, 'Not a valid id'),
});
