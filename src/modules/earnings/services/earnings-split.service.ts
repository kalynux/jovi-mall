import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { transactionManager } from '../../../core/database/transaction.manager';
import { eventBus } from '../../../core/events/event-bus';
import { EntitlementService, entitlementService } from '../../billing/services/entitlement.service';
import {
  EarningsAllocationRepository,
  CreateAllocationInput,
} from '../repositories/earnings-allocation.repository';
import { EarningsAccountService, earningsAccountService } from './earnings-account.service';
import { EARNINGS_CONFIG } from '../config/earnings.config';
import { IOrder } from '../../orders/order.model';
import { IBooking } from '../../booking/models/booking.model';

/**
 * EarningsSplitService - splits a freshly-paid order/booking into per-beneficiary
 * allocations and holds each share in escrow.
 *
 * The split runs at payment success so a vendor immediately sees their NET
 * (post-fee) earnings, even though the money stays held until the order is
 * completed. Idempotent: re-firing a payment webhook never double-splits
 * (guarded by a unique index on (source, beneficiary) plus an up-front check).
 *
 * All amounts are integers in minor currency units.
 */
export class EarningsSplitService {
  constructor(
    private readonly allocationRepo: EarningsAllocationRepository = new EarningsAllocationRepository(),
    private readonly accounts: EarningsAccountService = earningsAccountService,
    private readonly entitlements: EntitlementService = entitlementService
  ) {}

  /**
   * Split a paid order: platform commission, per-agency delivery fee, vendor net.
   * Digital orders have no delivery agency, so only commission + vendor net.
   */
  async splitOrder(order: IOrder): Promise<void> {
    const sourceId = order._id.toString();
    if (await this.allocationRepo.existsForSource('order', sourceId)) return; // idempotent

    const vendorId = order.vendor_id.toString();
    const gross = order.total_amount;
    const currency = order.currency;

    const { commissionPercent } = await this.entitlements.getEntitlements(vendorId);
    const commission = Math.floor((gross * commissionPercent) / 100);

    // Distinct delivery agencies on the order (physical only); flat fee each.
    const agencyIds =
      order.order_type === 'physical'
        ? [
            ...new Set(
              order.items
                .map((i) => i.delivery?.agency_id?.toString())
                .filter((id): id is string => Boolean(id))
            ),
          ]
        : [];
    const deliveryFeeEach = EARNINGS_CONFIG.DELIVERY_FLAT_FEE;
    const deliveryTotal = agencyIds.length * deliveryFeeEach;

    const vendorNet = gross - commission - deliveryTotal;
    if (vendorNet < 0) {
      throw createAppError(ERROR_CODES.EARNINGS_INVALID_SPLIT, 422, undefined, {
        gross,
        commission,
        deliveryTotal,
      });
    }

    const allocations: CreateAllocationInput[] = [
      {
        source_type: 'order',
        source_id: sourceId,
        beneficiary_type: 'vendor',
        beneficiary_id: vendorId,
        gross_snapshot: gross,
        commission_percent_snapshot: commissionPercent,
        amount: vendorNet,
        currency,
      },
      {
        source_type: 'order',
        source_id: sourceId,
        beneficiary_type: 'platform',
        beneficiary_id: null,
        gross_snapshot: gross,
        commission_percent_snapshot: commissionPercent,
        amount: commission,
        currency,
      },
      ...agencyIds.map((agencyId) => ({
        source_type: 'order' as const,
        source_id: sourceId,
        beneficiary_type: 'agency' as const,
        beneficiary_id: agencyId,
        gross_snapshot: gross,
        commission_percent_snapshot: commissionPercent,
        amount: deliveryFeeEach,
        currency,
      })),
    ];

    await this.persist(allocations);

    await this.emitSplit('order', sourceId, vendorId, { gross, commission, deliveryTotal, vendorNet });
  }

  /**
   * Split a paid booking (service product): platform commission + vendor net.
   * Bookings have no delivery agency.
   */
  async splitBooking(booking: IBooking): Promise<void> {
    const sourceId = booking._id.toString();
    if (await this.allocationRepo.existsForSource('booking', sourceId)) return; // idempotent

    const vendorId = booking.vendorId.toString();
    const gross = booking.priceSnapshot;
    const currency = booking.currency;

    const { commissionPercent } = await this.entitlements.getEntitlements(vendorId);
    const commission = Math.floor((gross * commissionPercent) / 100);
    const vendorNet = gross - commission;
    if (vendorNet < 0) {
      throw createAppError(ERROR_CODES.EARNINGS_INVALID_SPLIT, 422, undefined, { gross, commission });
    }

    const allocations: CreateAllocationInput[] = [
      {
        source_type: 'booking',
        source_id: sourceId,
        beneficiary_type: 'vendor',
        beneficiary_id: vendorId,
        gross_snapshot: gross,
        commission_percent_snapshot: commissionPercent,
        amount: vendorNet,
        currency,
      },
      {
        source_type: 'booking',
        source_id: sourceId,
        beneficiary_type: 'platform',
        beneficiary_id: null,
        gross_snapshot: gross,
        commission_percent_snapshot: commissionPercent,
        amount: commission,
        currency,
      },
    ];

    await this.persist(allocations);

    await this.emitSplit('booking', sourceId, vendorId, { gross, commission, vendorNet });
  }

  /** Create allocations and hold each share — all in ONE transaction. */
  private async persist(allocations: CreateAllocationInput[]): Promise<void> {
    await transactionManager.runInTransaction(async (session) => {
      for (const input of allocations) {
        // Skip zero-value shares (e.g. 0% commission, no delivery fee) so we
        // don't create no-op ledger noise.
        if (input.amount <= 0) continue;
        const allocation = await this.allocationRepo.create(input, session);
        await this.accounts.holdInSession(allocation, session);
      }
    });
  }

  private async emitSplit(
    sourceType: 'order' | 'booking',
    sourceId: string,
    vendorId: string,
    breakdown: Record<string, number>
  ): Promise<void> {
    try {
      await eventBus.publish('earnings.split', {
        eventType: 'earnings.split',
        aggregateId: sourceId,
        payload: { sourceType, sourceId, vendorId, ...breakdown },
        occurredAt: new Date(),
      });
    } catch (error) {
      console.error('[EarningsSplitService] Failed to emit earnings.split event:', error);
    }
  }
}

export const earningsSplitService = new EarningsSplitService();
