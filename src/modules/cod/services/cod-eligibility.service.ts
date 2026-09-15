import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { DeliveryAgencyRepository } from '../../delivery/delivery-agency.repository';
import { MagazinRepository } from '../../magazin/repositories/magazin.repository';

/**
 * CodEligibilityService - decides whether an order may be placed as
 * cash-on-delivery, at checkout time.
 *
 * COD is a per-agency opt-in (`policies.cod.enabled`) with an optional
 * per-order amount cap (`policies.cod.max_order_amount`): EVERY agency that
 * would carry one of the order's shipments must support it, since each of its
 * agents physically collects the cash for their shipment.
 */
export class CodEligibilityService {
  constructor(
    private readonly agencyRepo: DeliveryAgencyRepository = new DeliveryAgencyRepository(),
    private readonly magazinRepo: MagazinRepository = new MagazinRepository(),
  ) {}

  /**
   * Validate one (single-vendor) order of a COD checkout. Called from
   * OrderService.buildVendorOrder inside the checkout transaction, after the
   * items' delivery agencies are resolved — a failure rolls back the whole
   * checkout group.
   */
  async assertVendorOrderEligible(params: {
    orderType: 'physical' | 'digital';
    totalAmount: number;
    agencyIds: string[];
  }): Promise<void> {
    const { orderType, totalAmount, agencyIds } = params;

    // Nothing is physically handed over for digital goods — nowhere to pay cash.
    if (orderType !== 'physical') {
      throw createAppError(
        ERROR_CODES.COD_NOT_AVAILABLE_FOR_DIGITAL,
        422,
        'Cash on delivery is only available for physical orders'
      );
    }

    const distinctIds = [...new Set(agencyIds)];
    const [agencies, magazinNames] = await Promise.all([
      this.agencyRepo.findByIds(distinctIds),
      this.magazinRepo.findNamesByAgencyIds(distinctIds),
    ]);
    const byId = new Map(agencies.map((a) => [(a._id as any).toString(), a]));

    for (const agencyId of distinctIds) {
      const agency = byId.get(agencyId);
      // Business name lives on the Magazin (source of truth).
      const agencyName = magazinNames.get(agencyId)?.name ?? null;

      /**
       * A missing/inactive agency shouldn't be orderable at all; report it as
       * COD-unsupported rather than leaking internals.
       *
       * ⚠ **`kyc_details.legit_verified` IS LOAD-BEARING AND WAS ADDED ON 2026-09-15 TO STOP
       * A REGRESSION, not to tighten a rule.** Until then `status === 'active'` implied an
       * administrator had vetted the business, because admin approval was the only thing that
       * set it — so this line already meant "vetted" without saying so. Agencies now activate
       * themselves on a proved phone (`core/accounts/activation.ts`), which severs that
       * implication: without this condition, an agency nobody had reviewed could tick its own
       * `policies.cod.enabled` and start taking cash from customers on delivery.
       *
       * Cash is the one thing the owner's rule names explicitly: **no cash-in-hand until
       * verified.** The agent half of that rule was already correct and needed no change —
       * `AgentGateService.assertCanHoldContract` gates COD cash on `kyc.status === 'verified'`
       * and has never consulted `status`. This is the agency half catching up.
       *
       * ⚠ Do not "simplify" this back to the status check. `test:cod` § COD verification pins
       * it, and the failure it prevents is silent: the order is accepted, the cash is
       * collected, and the platform finds out when the remittance does not arrive.
       */
      if (
        !agency
        || agency.status !== 'active'
        || !agency.kyc_details?.legit_verified
        || !agency.policies?.cod?.enabled
      ) {
        throw createAppError(ERROR_CODES.COD_AGENCY_NOT_SUPPORTED, 422, undefined, {
          agencyId,
          agencyName,
        });
      }

      const cap = agency.policies.cod.max_order_amount;
      if (cap !== null && cap !== undefined && totalAmount > cap) {
        throw createAppError(ERROR_CODES.COD_ORDER_AMOUNT_EXCEEDS_LIMIT, 422, undefined, {
          agencyId,
          agencyName,
          maxOrderAmount: cap,
          orderTotal: totalAmount,
        });
      }
    }
  }
}

export const codEligibilityService = new CodEligibilityService();
