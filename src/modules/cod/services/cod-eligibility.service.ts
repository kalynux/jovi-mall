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

      // A missing/inactive agency shouldn't be orderable at all; report it as
      // COD-unsupported rather than leaking internals.
      if (!agency || agency.status !== 'active' || !agency.policies?.cod?.enabled) {
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
