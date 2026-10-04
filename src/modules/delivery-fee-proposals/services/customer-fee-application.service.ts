import { ClientSession, FilterQuery, Types } from 'mongoose';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { IOrder, OrderModel } from '../../orders/order.model';
import { IShipment, ShipmentModel, ShipmentStatus } from '../../shipments/shipment.model';
import { CashCollectionModel } from '../../cod/models/cash-collection.model';
import { IAgencyPolicies } from '../../delivery/delivery-agency.model';
import { DeliveryAgencyRepository } from '../../delivery/delivery-agency.repository';
import { EntitlementService, entitlementService } from '../../billing/services/entitlement.service';
import { EarningsQuoteService, earningsQuoteService } from '../../earnings/services/earnings-quote.service';
import { EarningsAllocationRepository } from '../../earnings/repositories/earnings-allocation.repository';
import { EarningsAccountService, earningsAccountService } from '../../earnings/services/earnings-account.service';
import { bargainLineOf } from '../../earnings/services/earnings-split.service';
import { computeOrderAiMargin } from '../../earnings/services/negotiation-margin.service';
import { customerDeliveryFeeOf, deliveryFeePaymentOf, deliveryPayerOf, orderItemsGrossOf } from '../../orders/domain/delivery-payer';
import { FeeChangePlan, FeeState, feeIsCash, PaymentMode, vendorBorneOf } from '../domain/customer-fee-change.rules';
import { codShipmentVendorNet, prepaidOrderVendorNet } from '../domain/delivery-fee-proposal.rules';

export interface ApplyCustomerFeeInput {
  order: IOrder;
  shipmentId: Types.ObjectId;
  /** The proposal the new fee comes from (written on `delivery_fee_override.proposal_id`). */
  proposalId: Types.ObjectId;
  /** The pending pointer the shipment must carry for the write to land (null = none pending). */
  expectedPointer: Types.ObjectId | null;
  window: readonly ShipmentStatus[];
  plan: FeeChangePlan;
  at: Date;
}

export interface CustomerFeeApplication {
  codCollectionAdjusted: boolean;
  vendorAllocationBefore: number | null;
  vendorAllocationAfter: number | null;
}

/**
 * Lands a customer-paid delivery-fee change on the money, INSIDE the caller's transaction
 * (ADR-A11 § Fee changes after checkout). One method, used by every path that moves a
 * customer-paid fee — an applied decrease, an approved COD increase, a paid online top-up, a
 * vendor-covered change-agency difference — so the five numbers that must agree are written in
 * one place:
 *
 *   shipment   `delivery_fee_override` + `delivery_fee_snapshot`  → the new fee (what the agency is
 *                                                                    paid; the splits read it first)
 *              `customer_delivery_fee`                           → online: money paid (gross, only
 *                                                                    ever grows); COD: cash to collect
 *              `customer_fee_refundable`                         → online: the excess at the new fee
 *              `pending_delivery_fee_proposal_id`                → cleared (pickup unblocks)
 *   collection `delivery_fee_amount` / `expected_amount`          → COD: re-priced while `pending`
 *   order      `price_breakdown.delivery` / `.total` / `total_amount` → by `plan.orderTotalDelta`
 *              (COD: what will be collected; online: what was CHARGED — grows with a top-up,
 *              never shrinks on a decrease: a refund is recorded beside it, never subtracted)
 *   vendor     the held `('order', vendor)` allocation               → online, split already, only
 *                                                                    when the vendor's SHARE moved
 *
 * Every write is a compare-and-set on the values the plan was computed from; a miss throws, and
 * the caller's transaction rolls every other write back.
 */
export class CustomerFeeApplicationService {
  constructor(
    private readonly allocations: EarningsAllocationRepository = new EarningsAllocationRepository(),
    private readonly accounts: EarningsAccountService = earningsAccountService,
    private readonly agencies: DeliveryAgencyRepository = new DeliveryAgencyRepository(),
    private readonly entitlements: EntitlementService = entitlementService,
    private readonly quotes: EarningsQuoteService = earningsQuoteService
  ) {}

  /**
   * COD order → `cod`; an online order paying its delivery fee to the rider in cash (W-F) →
   * `cash_fee`; otherwise `online`. Per ORDER: every customer-paid shipment of a `cash_to_rider`
   * order pays in cash (a partial move's new shipment is vendor-paid and never reaches here).
   */
  modeOf(order: Pick<IOrder, 'payment_method'> & Partial<Pick<IOrder, 'delivery_fee_payment'>>): PaymentMode {
    if (order.payment_method === 'cash_on_delivery') return 'cod';
    return deliveryFeePaymentOf(order) === 'cash_to_rider' ? 'cash_fee' : 'online';
  }

  /** The fee the agency is paid today: override → snapshot → the live formula. */
  effectiveFee(shipment: IShipment, order: IOrder, policies: IAgencyPolicies | null): number {
    return this.quotes.computeShipmentDeliveryFee(
      shipment,
      policies,
      new Map(order.items.map((i) => [(i._id as any).toString(), i])),
      order._id.toString(),
      order.delivery_address?.components?.region ?? null
    );
  }

  /**
   * The new agency's POSTED price for a shipment as it stands — the formula only, ignoring the
   * shipment's own snapshot and override (a change-agency move is priced afresh, D-10).
   */
  formulaFee(
    shipmentLike: Pick<IShipment, 'items' | 'agency_id'> & { _id?: unknown },
    order: IOrder,
    policies: IAgencyPolicies | null
  ): number {
    const synthetic = {
      _id: shipmentLike._id ?? new Types.ObjectId(),
      agency_id: shipmentLike.agency_id,
      items: shipmentLike.items,
      delivery_fee_snapshot: null,
      delivery_fee_override: null,
    } as unknown as IShipment;
    return this.effectiveFee(synthetic, order, policies);
  }

  async stateOf(shipment: IShipment, order: IOrder): Promise<FeeState> {
    const agency = await this.agencies.findById(shipment.agency_id.toString());
    return {
      mode: this.modeOf(order),
      fee: this.effectiveFee(shipment, order, agency?.policies ?? null),
      customerFee: customerDeliveryFeeOf(order, shipment),
    };
  }

  /**
   * The vendor's net if its share of THIS shipment's fee moved from `borneBefore` to `borneAfter`,
   * on the unit the split measures it on:
   *  - COD: this shipment's collection (its goods, AI margin, commission, COD fee, vendor share);
   *  - online, split: the held allocation moved by the delta (exact — the number `applyInSession`
   *    would write);
   *  - online, not split: the order, with every other shipment's vendor-borne share.
   *
   * Pass `session` from inside a transaction (the change of agency, ADR-A11 D-12) so the sibling
   * shipments and the allocation are read as that transaction sees them.
   */
  async vendorNetWithBorne(
    order: IOrder,
    shipment: IShipment,
    borneBefore: number,
    borneAfter: number,
    session?: ClientSession
  ): Promise<number> {
    const vendorId = order.vendor_id.toString();
    const { commissionPercent } = await this.entitlements.getEntitlements(vendorId);
    const itemsById = new Map(order.items.map((i) => [(i._id as any).toString(), i]));

    if (order.payment_method === 'cash_on_delivery') {
      const agency = await this.agencies.findById(shipment.agency_id.toString());
      let gross = 0;
      const lines = shipment.items.flatMap((si) => {
        const item = itemsById.get(si.order_item_id.toString());
        if (!item) return [];
        gross += item.price * si.quantity;
        return [{ ...bargainLineOf(item), quantity: si.quantity }];
      });
      return codShipmentVendorNet({
        shipmentGross: gross,
        aiMargin: computeOrderAiMargin(lines),
        commissionPercent,
        fee: borneAfter,
        codHandling: agency?.policies?.pricing?.additional_fees?.cod_handling_fee ?? null,
      });
    }

    const allocation = await this.allocations.findOneBySourceAndBeneficiary('order', order._id.toString(), 'vendor', vendorId, session);
    if (allocation) return allocation.amount + borneBefore - borneAfter;

    const siblings = await ShipmentModel.find({ order_id: order._id }, null, { session: session ?? undefined });
    let others = 0;
    for (const s of siblings) {
      if ((s._id as Types.ObjectId).equals(shipment._id as Types.ObjectId)) continue;
      const policies = (await this.agencies.findById(s.agency_id.toString()))?.policies ?? null;
      others += vendorBorneOf(this.effectiveFee(s, order, policies), customerDeliveryFeeOf(order, s));
    }
    return prepaidOrderVendorNet({
      orderGross: orderItemsGrossOf(order),
      aiMargin: computeOrderAiMargin(order.items.map(bargainLineOf)),
      commissionPercent,
      otherShipmentsFees: others,
      fee: borneAfter,
    });
  }

  async applyInSession(input: ApplyCustomerFeeInput, session: ClientSession): Promise<CustomerFeeApplication> {
    const { order, plan } = input;
    const mode = this.modeOf(order);

    // 1. The shipment — CAS on the pointer, the window and the customer fee the plan was
    //    computed from (null and 0 are the same "nothing paid" on legacy rows).
    const filter: FilterQuery<IShipment> = {
      _id: input.shipmentId,
      status: { $in: [...input.window] },
      pending_delivery_fee_proposal_id: input.expectedPointer,
      customer_delivery_fee: plan.customerFeeBefore === 0 ? { $in: [null, 0] } : plan.customerFeeBefore,
    };
    const updated = await ShipmentModel.findOneAndUpdate(
      filter,
      {
        $set: {
          pending_delivery_fee_proposal_id: null,
          delivery_fee_override: { amount: plan.feeAfter, proposal_id: input.proposalId, approved_at: input.at },
          delivery_fee_snapshot: plan.feeAfter,
          customer_delivery_fee: plan.customerFeeAfter,
          ...(mode === 'online' ? { customer_fee_refundable: plan.refundableAfter } : {}),
        },
      },
      { new: true, session }
    );
    if (!updated) throw createAppError(ERROR_CODES.DELIVERY_FEE_PROPOSAL_STALE, 409);

    // 2. COD / cash for delivery: the pending cash collection (created at agent accept) follows
    //    the customer fee. Re-priced only while `pending` — the money has not changed hands.
    //    Read-then-CAS rather than `$inc`, because a pre-ADR-A11 row carries
    //    `delivery_fee_amount: null`. A fee-only collection (W-F) has `items_amount: 0`.
    let codCollectionAdjusted = false;
    if (feeIsCash(mode) && plan.collectDelta !== 0) {
      const collection = await CashCollectionModel.findOne({ shipment_id: input.shipmentId }, null, { session });
      if (collection) {
        if (collection.status !== 'pending') throw createAppError(ERROR_CODES.DELIVERY_FEE_PROPOSAL_STALE, 409);
        const deliveryBefore = collection.delivery_fee_amount ?? 0;
        const itemsAmount = typeof collection.items_amount === 'number' ? collection.items_amount : collection.expected_amount - deliveryBefore;
        const deliveryAfter = Math.max(0, deliveryBefore + plan.collectDelta);
        // A fee-only collection (W-F) lowered to nothing has no cash left to collect: it is
        // cancelled (the shipment then delivers like any online one — `paysDeliveryFeeInCash`
        // needs a fee > 0), never left pending at 0, which no remittance could ever settle.
        const cancelFeeOnly = collection.kind === 'delivery_fee' && itemsAmount + deliveryAfter === 0;
        const moved = await CashCollectionModel.updateOne(
          { _id: collection._id, status: 'pending', expected_amount: collection.expected_amount },
          {
            $set: {
              items_amount: itemsAmount,
              delivery_fee_amount: deliveryAfter,
              expected_amount: itemsAmount + deliveryAfter,
              ...(cancelFeeOnly ? { status: 'cancelled' } : {}),
            },
          },
          { session }
        );
        if (moved.modifiedCount !== 1) throw createAppError(ERROR_CODES.DELIVERY_FEE_PROPOSAL_STALE, 409);
        codCollectionAdjusted = true;
      }
    }

    // 3. The order's totals. Cash for delivery (W-F): `total_amount` is what was charged ONLINE
    //    and never held the fee — only `price_breakdown.delivery_cash` (the riders' cash) moves.
    if (plan.orderTotalDelta !== 0 && mode === 'cash_fee') {
      const moved = await OrderModel.updateOne(
        { _id: order._id, 'price_breakdown.delivery_cash': { $gte: -plan.orderTotalDelta } },
        { $inc: { 'price_breakdown.delivery_cash': plan.orderTotalDelta }, $set: { updated_at: input.at } },
        { session }
      );
      if (moved.modifiedCount !== 1) throw createAppError(ERROR_CODES.DELIVERY_FEE_PROPOSAL_STALE, 409);
    } else if (plan.orderTotalDelta !== 0) {
      const moved = await OrderModel.updateOne(
        { _id: order._id, total_amount: { $gte: -plan.orderTotalDelta } },
        {
          $inc: {
            'price_breakdown.delivery': plan.orderTotalDelta,
            'price_breakdown.total': plan.orderTotalDelta,
            total_amount: plan.orderTotalDelta,
          },
          $set: { updated_at: input.at },
        },
        { session }
      );
      if (moved.modifiedCount !== 1) throw createAppError(ERROR_CODES.DELIVERY_FEE_PROPOSAL_STALE, 409);
    }

    // 4. The vendor's held allocation — online (cash for delivery included: the goods were split
    //    at payment), already split, and only if its share moved.
    let vendorAllocationBefore: number | null = null;
    let vendorAllocationAfter: number | null = null;
    if (mode !== 'cod' && plan.vendorAllocationDelta !== 0) {
      const orderId = order._id.toString();
      const vendorId = order.vendor_id.toString();
      const allocation = await this.allocations.findOneBySourceAndBeneficiary('order', orderId, 'vendor', vendorId, session);
      if (allocation) {
        if (allocation.status !== 'held') {
          throw createAppError(ERROR_CODES.DELIVERY_FEE_PROPOSAL_SETTLEMENT_CONFLICT, 409, undefined, {
            allocationStatus: allocation.status,
          });
        }
        const after = allocation.amount + plan.vendorAllocationDelta;
        if (after <= 0) throw createAppError(ERROR_CODES.DELIVERY_FEE_PROPOSAL_VENDOR_NET_NOT_POSITIVE, 422);
        const repriced = await this.allocations.adjustHeldAmount(allocation._id as Types.ObjectId, allocation.amount, after, session);
        if (!repriced) {
          throw createAppError(ERROR_CODES.DELIVERY_FEE_PROPOSAL_SETTLEMENT_CONFLICT, 409, undefined, {
            allocationStatus: allocation.status,
          });
        }
        await this.accounts.adjustHeldInSession(repriced, plan.vendorAllocationDelta, session);
        vendorAllocationBefore = allocation.amount;
        vendorAllocationAfter = repriced.amount;
      } else if (await this.allocations.existsForSource('order', orderId, session)) {
        // Split, but no vendor row (`persist` skips a zero share): there is nothing to move it
        // from, and inventing a row would invent money. Refuse rather than mis-state the net.
        throw createAppError(ERROR_CODES.DELIVERY_FEE_PROPOSAL_VENDOR_NET_NOT_POSITIVE, 422);
      }
      // Not split yet: `splitOrder` divides the shipments as they now stand.
    }

    return { codCollectionAdjusted, vendorAllocationBefore, vendorAllocationAfter };
  }

  /** Who pays this shipment's delivery — re-exported for the services' one import. */
  payerOf(order: IOrder, shipment: IShipment) {
    return deliveryPayerOf(order, shipment);
  }
}

export const customerFeeApplicationService = new CustomerFeeApplicationService();
