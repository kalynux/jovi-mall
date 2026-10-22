import { z } from 'zod';
import {
  DeprecatedGatewaySchema,
  PaymentChannelSchema,
  PaymentProviderSchema,
} from '../../payments/validators/payment.validators';
import { BILLING_OWNER_TYPES } from '../billing.types';
import { VENDOR_KINDS } from '../../vendors/domain/vendor-kind';

// Derived from the module's own list, never retyped beside it — the same rule the
// notification catalogs follow, for the same reason: two hand-maintained copies of one
// vocabulary drift, and the drift is silent until a request is refused for no reason.
const PlanRoleSchema = z.enum([...BILLING_OWNER_TYPES]);

/**
 * Admin: create a pricing plan. Limit fields are role-specific and nullable —
 * vendor plans carry products/storage/commission; agency/agent plans carry
 * `max_unterminated_shipments`; agent plans carry `max_cod_pool` (⚠ `null` = no COD
 * at all, not unlimited — see the model). `live_tracking_enabled` defaults true everywhere.
 */
const PlanFieldsSchema = z.object({
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
  max_cod_pool: z.number().int().min(0).nullable().optional(),
  live_tracking_enabled: z.boolean().optional(),
  is_active: z.boolean().optional(),
  sort_order: z.number().int().optional(),
  /**
   * SERVICE-LISTINGS-PLAN § C-5: which vendor KIND a vendor plan is for. Absent or null on a
   * vendor plan means SELLER (every plan seeded before the field existed). Refused on an agency
   * or agent plan below. Immutable once created — see `UpdatePlanSchema`.
   */
  vendor_kind: z.enum([...VENDOR_KINDS]).nullable().optional(),
  /** Provider plans: listings occupying a slot (§ C-8a). `null` = unlimited. */
  max_active_listings: z.number().int().min(0).nullable().optional(),
});

export const CreatePlanSchema = PlanFieldsSchema.superRefine((plan, ctx) => {
  if (plan.role !== 'vendor' && plan.vendor_kind != null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['vendor_kind'],
      message: 'Only a vendor plan has a vendor kind',
    });
  }
});

/**
 * Admin: update a pricing plan. `code`, `role` and `vendor_kind` are immutable and stripped if
 * sent — the kind for the reason the role is: an in-place flip would move every subscriber on
 * the plan onto a plan of the other kind (`PricingPlanService.update` deletes all three again).
 */
export const UpdatePlanSchema = PlanFieldsSchema.partial().omit({ role: true, code: true, vendor_kind: true });

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
  /**
   * SERVICE-LISTINGS-PLAN § C-5: narrow to the VENDOR plans of one kind — the sign-up page's
   * seller and provider price tables. Set, it returns vendor plans only (an agency plan has no
   * kind); absent, every plan as before, each carrying `vendorKind` so a client can group.
   */
  vendorKind: z.enum([...VENDOR_KINDS]).optional(),
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

// ── Provider-based bodies (ADR-A08) ─────────────────────────────────────────
//
// The owner names what they pay with (`provider`); the server picks the aggregator. `gateway`
// is still accepted from apps that predate `provider`, validated against nothing and never
// used to route. A missing `provider` is derived by the controller (`deriveProviderOrThrow`),
// and which `channel` fields a charge needs is judged once its route is known, not here.
// Both field schemas are the payment module's own, not copies (C1 removed billing's copies and
// the old gateway-enum `InitiateTopupSchema` / `InitiatePlanPurchaseSchema`).

/** Owner: start a credit top-up, provider-based. */
export const InitiateTopupRequestSchema = z.object({
  packCode: z.string().trim().min(1),
  provider: PaymentProviderSchema.optional(),
  gateway: DeprecatedGatewaySchema,
  channel: BillingPaymentChannelSchema,
});

/** Owner: start a plan purchase, provider-based (planId comes from the URL). */
export const InitiatePlanPurchaseRequestSchema = z.object({
  provider: PaymentProviderSchema.optional(),
  gateway: DeprecatedGatewaySchema,
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
