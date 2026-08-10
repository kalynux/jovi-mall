import { IPricingPlan } from '../models/pricing-plan.model';
import { BillingOwnerType } from '../billing.types';

/**
 * The pricing-plan shape served to unauthenticated callers (the marketing site).
 *
 * Deliberately a projection rather than the raw document the authenticated
 * `GET /api/{role}/plans` returns: `deletedAt`, `__v` and the audit timestamps
 * are internal bookkeeping and have no business on a public page. Everything a
 * price table needs is here — the tier's identity, what it costs, how long a
 * term lasts, and every limit that differentiates one tier from the next.
 *
 * `_id` becomes `id` (a plain string). It is emitted so a marketing CTA can deep
 * -link to a specific tier in the dashboard; nothing public consumes it otherwise.
 *
 * ⚠️ Adding a field to `PricingPlan` does NOT publish it — add it here too, on
 * purpose. That is the point of the projection: publication is a decision.
 */
export interface PublicPlanDto {
  id: string;
  role: BillingOwnerType;
  code: string;
  name: string;
  price: number;
  currency: string;
  term_days: number | null;
  credit_allowance: number;

  // Limit fields. Each role uses only its own; the rest are null (see the model).
  max_active_products: number | null;
  max_storage_bytes: number | null;
  commission_percent: number | null;
  max_unterminated_shipments: number | null;
  live_tracking_enabled: boolean;

  /**
   * Whether this tier can be bought TODAY. `false` covers two different
   * situations the model cannot tell apart — a tier defined ahead of launch and
   * a tier withdrawn from sale — which is why inactive rows are opt-in on the
   * public endpoint rather than returned by default.
   */
  is_active: boolean;
  sort_order: number;
}

export function toPublicPlanDto(plan: IPricingPlan): PublicPlanDto {
  return {
    id: String(plan._id),
    role: plan.role,
    code: plan.code,
    name: plan.name,
    price: plan.price,
    currency: plan.currency,
    term_days: plan.term_days ?? null,
    credit_allowance: plan.credit_allowance,
    max_active_products: plan.max_active_products ?? null,
    max_storage_bytes: plan.max_storage_bytes ?? null,
    commission_percent: plan.commission_percent ?? null,
    max_unterminated_shipments: plan.max_unterminated_shipments ?? null,
    live_tracking_enabled: plan.live_tracking_enabled,
    is_active: plan.is_active,
    sort_order: plan.sort_order,
  };
}
