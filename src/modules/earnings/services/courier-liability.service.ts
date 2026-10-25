import { Types } from 'mongoose';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { ShipmentModel } from '../../shipments/shipment.model';
import { OrderModel } from '../../orders/order.model';
import { DeliveryAgencyModel } from '../../delivery/delivery-agency.model';
import { TicketModel } from '../../tickets/models/ticket.model';
import { CustomerModel } from '../../customers/customer.model';
import { PROBLEM_REPORT_TICKET_TYPES } from '../../tickets/domain/problem-report.rule';
import { ActorRole, EntityType } from '../../tickets/types/ticket.types';
import { customerDeliveryFeeOf, deliveryFeeShares } from '../../orders/domain/delivery-payer';
import type { DeliveryFaultAssessment } from '../../payments/domain/refund-ports';
import { EarningsAllocationRepository } from '../repositories/earnings-allocation.repository';
import { IEarningsAllocation } from '../models/earnings-allocation.model';
import { EARNINGS_CONFIG } from '../config/earnings.config';
import { courierHoldStartOf } from '../domain/courier-hold';
import { agencyWindowDays, insideAgencyWindow, problemRaisedAt } from '../domain/courier-liability';
import { earningsCompletionService, EarningsCompletionService } from './earnings-completion.service';

/** Everything the liability rules need to know about one parcel. */
export interface ParcelLiabilityFacts {
  shipmentId: string;
  orderId: string;
  orderNumber: string | null;
  vendorId: string | null;
  agencyId: string | null;
  trackingNumber: string | null;
  currency: string;
  /** Its own delivery (the courier clock's held-start rule), or null when not delivered. */
  deliveredAt: Date | null;
  /** The earliest customer problem report about the order or this parcel, or null. */
  firstProblemAt: Date | null;
  claimDeadlineDays: number | null;
  returnsPayer: string | null;
  protectionDays: number;
  windowDays: number;
  /** Customer-paid delivery money of this parcel (0 on a vendor-paid one). */
  customerDeliveryFee: number;
  /** The part of the agency's fee the VENDOR bore (deducted from their net). */
  vendorBorneDeliveryFee: number;
  deliveryFeeSnapshot: number | null;
  /** The agency's own damage terms, for a claim. */
  maxRefundPerItem: number | null;
  investigationFee: number;
  /** The agency and rider rows of this parcel, any status. */
  courierRows: IEarningsAllocation[];
}

/**
 * The agency side of a parcel's problems (owner decisions F-6…F-8, 2026-10-22): when its agency
 * answers, and the facts every explanation quotes. The rules are pure, in
 * `domain/courier-liability.ts`; this reads the parcel, its order, the agency's terms and the
 * customer's problem reports.
 *
 * ── Which terms ───────────────────────────────────────────────────────────────────────────
 * The snapshot on the parcel's own courier rows (`courier_hold`), when there is one: the terms
 * as they stood at the delivery, the same ones that decided how long its money was held. A
 * parcel delivered before that snapshot existed reads the agency's live policies.
 */
export class CourierLiabilityService {
  constructor(
    private readonly allocationRepo: EarningsAllocationRepository = new EarningsAllocationRepository(),
    private readonly completion: EarningsCompletionService = earningsCompletionService
  ) {}

  async parcelFacts(shipmentId: string, now: Date = new Date()): Promise<ParcelLiabilityFacts | null> {
    if (!Types.ObjectId.isValid(shipmentId)) return null;
    const shipment: any = await ShipmentModel.findById(shipmentId).lean();
    if (!shipment) return null;
    const order: any = await OrderModel.findById(shipment.order_id).lean();
    if (!order) return null;
    const isCod = order.payment_method === 'cash_on_delivery';

    const sources = await this.completion.sourcesOfShipment(shipmentId);
    const courierRows = (await this.allocationRepo.findBySources(sources)).filter(
      (r) => r.beneficiary_type === 'agency' || r.beneficiary_type === 'agent'
    );
    const snapshot = courierRows.find((r) => r.courier_hold)?.courier_hold ?? null;
    const agency: any = shipment.agency_id
      ? await DeliveryAgencyModel.findById(shipment.agency_id, { policies: 1 }).lean()
      : null;
    const damage = agency?.policies?.damage ?? null;

    const claimDeadlineDays = snapshot ? snapshot.claim_deadline_days : (damage?.claim_deadline_days ?? null);
    const returnsPayer = snapshot ? snapshot.returns_payer : (agency?.policies?.returns?.payer ?? null);
    const protectionDays = snapshot ? snapshot.protection_days : EARNINGS_CONFIG.HOLD_DAYS;
    const customerDeliveryFee = customerDeliveryFeeOf(order, shipment);
    const feeSnapshot = typeof shipment.delivery_fee_snapshot === 'number' ? shipment.delivery_fee_snapshot : null;

    return {
      shipmentId,
      orderId: order._id.toString(),
      orderNumber: order.order_number ?? null,
      vendorId: order.vendor_id ? order.vendor_id.toString() : null,
      agencyId: shipment.agency_id ? shipment.agency_id.toString() : null,
      trackingNumber: shipment.tracking_number ?? null,
      currency: order.currency ?? 'XAF',
      deliveredAt: courierHoldStartOf(shipment, isCod, false, now),
      firstProblemAt: await this.firstProblemAt(order._id.toString(), shipmentId, order.customer_id?.toString() ?? null),
      claimDeadlineDays: typeof claimDeadlineDays === 'number' ? claimDeadlineDays : null,
      returnsPayer: returnsPayer ?? null,
      protectionDays,
      windowDays: agencyWindowDays(
        { claim_deadline_days: claimDeadlineDays, returns_payer: returnsPayer },
        protectionDays
      ),
      customerDeliveryFee,
      vendorBorneDeliveryFee: feeSnapshot !== null ? deliveryFeeShares(feeSnapshot, customerDeliveryFee).vendorBorne : 0,
      deliveryFeeSnapshot: feeSnapshot,
      maxRefundPerItem: typeof damage?.max_refund_per_item === 'number' ? damage.max_refund_per_item : null,
      investigationFee: typeof damage?.investigation_fee === 'number' ? damage.investigation_fee : 0,
      courierRows,
    };
  }

  /**
   * For a refund: each parcel named as delivered at fault, judged against its agency's window.
   * The problem's moment is the earliest customer problem report about the order or the parcel,
   * else `now` (the refund being opened).
   */
  async assessDeliveryFault(orderId: string, shipmentIds: string[], now: Date = new Date()): Promise<DeliveryFaultAssessment[]> {
    const out: DeliveryFaultAssessment[] = [];
    for (const id of [...new Set(shipmentIds)]) {
      const facts = await this.parcelFacts(id, now);
      if (!facts || facts.orderId !== orderId) {
        throw createAppError(ERROR_CODES.REFUND_DELIVERY_FAULT_INVALID, 422, undefined, { shipmentId: id });
      }
      const raisedAt = problemRaisedAt([facts.firstProblemAt], now);
      const inside = insideAgencyWindow(facts.deliveredAt, raisedAt, facts.windowDays);
      out.push({
        shipmentId: id,
        agencyId: facts.agencyId,
        trackingNumber: facts.trackingNumber,
        deliveredAt: facts.deliveredAt,
        raisedAt,
        windowDays: facts.windowDays,
        insideWindow: inside,
        customerDeliveryAmount: inside ? facts.customerDeliveryFee : 0,
        claimDeadlineDays: facts.claimDeadlineDays,
        returnsPayer: facts.returnsPayer,
      });
    }
    return out;
  }

  /**
   * The earliest problem the order's OWN customer reported about the order or this parcel.
   * ⛔ Ownership matters: `createTicket` checks only that the order exists, so without it
   * anybody could open an early request and pull an agency inside its window.
   */
  private async firstProblemAt(orderId: string, shipmentId: string, customerId: string | null): Promise<Date | null> {
    if (!customerId || !Types.ObjectId.isValid(customerId)) return null;
    const customer: any = await CustomerModel.findById(customerId, { user_id: 1 }).lean();
    if (!customer?.user_id) return null;
    const ticket: any = await TicketModel.findOne(
      {
        $or: [
          { entity_type: EntityType.ORDER, entity_id: orderId },
          { entity_type: EntityType.SHIPMENT, entity_id: shipmentId },
        ],
        created_by_role: ActorRole.CUSTOMER,
        created_by_user_id: customer.user_id,
        type: { $in: [...PROBLEM_REPORT_TICKET_TYPES] },
      },
      { createdAt: 1 }
    )
      .sort({ createdAt: 1 })
      .lean();
    return ticket?.createdAt ?? null;
  }
}

export const courierLiabilityService = new CourierLiabilityService();
