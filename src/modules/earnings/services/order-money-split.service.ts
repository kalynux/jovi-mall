import { Types } from 'mongoose';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { IOrder, OrderModel } from '../../orders/order.model';
import { IShipment, ShipmentModel } from '../../shipments/shipment.model';
import { CashCollectionModel, collectionKindOf, ICashCollection } from '../../cod/models/cash-collection.model';
// Safe: cash-collection.service imports earnings-split.service, and neither imports THIS file,
// so the graph has no loop. Its `cashAmountsOf` is the one definition of "the goods a COD
// shipment's cash pays for" — re-deriving it here would be a second copy of money arithmetic.
import { cashCollectionService } from '../../cod/services/cash-collection.service';
import { DeliveryAgencyRepository } from '../../delivery/delivery-agency.repository';
import { IAgencyPolicies } from '../../delivery/delivery-agency.model';
import { agentContractRepository, AgentContractRepository } from '../../agents/repositories/agent-contract.repository';
import {
  collectionBreakdownOf,
  customerDeliveryFeeOf,
  deliveryCashOf,
  deliveryFeeShares,
  deliveryPayerOf,
  orderItemsGrossOf,
  paysDeliveryFeeInCash,
} from '../../orders/domain/delivery-payer';
import { EarningsAllocationModel } from '../models/earnings-allocation.model';
import { EarningsAdjustmentModel } from '../models/earnings-adjustment.model';
import { EARNINGS_CONFIG } from '../config/earnings.config';
import { EarningsSplitService, earningsSplitService } from './earnings-split.service';
import { isReturnedCod } from './earnings-quote.service';
import {
  AllocationFacts,
  agentSplitBasisOf,
  BargainLineFacts,
  bargainFeeLinesOf,
  customerRefundLine,
  DeliveryBasis,
  feeSourceOf,
  goodsBasisOf,
  lineFromAllocation,
  MoneyAdjustmentLine,
  MoneyLine,
  MoneySplitNote,
  MoneySplitSection,
  OrderMoneySplitDto,
  prepaidGoodsFromRows,
  projectedLine,
  summarise,
} from '../domain/order-money-split';

const PLATFORM = { type: 'platform' as const, id: null };
const PLATFORM_AI = { type: 'platform_ai' as const, id: null };

/**
 * OrderMoneySplitService — who gets what from one order, on what basis, as early as it can be
 * known. The I/O half of `domain/order-money-split.ts`, whose header carries the design.
 *
 * ⚠ **This file prices NOTHING.** Every fee is either read from `earnings_allocations` (a split
 * that ran) or returned by one of `EarningsSplitService`'s `compute*` methods (a split that has
 * not) — the same methods the splits themselves call. What happens here is bookkeeping over
 * those numbers (summing one beneficiary's rows, reading the COD handling fee back as the agency
 * row's residual over the fee), never a rate. `test:order-money-split` scans for that: no
 * percentage, no rounding, no fee helper imported. A drifted diagnostic does not fail, it LIES —
 * support repeats it to a vendor.
 *
 * Read-only. Never writes, never mutates a document it loads (the `compute*` methods are
 * side-effect free by construction; the snapshots and refund marks are written only by the
 * `split*` methods around them).
 */
export class OrderMoneySplitService {
  constructor(
    private readonly splits: EarningsSplitService = earningsSplitService,
    private readonly agencyRepo: DeliveryAgencyRepository = new DeliveryAgencyRepository(),
    private readonly contracts: AgentContractRepository = agentContractRepository
  ) {}

  async getForOrder(orderId: string, now: Date = new Date()): Promise<OrderMoneySplitDto> {
    if (!Types.ObjectId.isValid(orderId)) {
      throw createAppError(ERROR_CODES.ORDER_NOT_FOUND, 404, 'Order not found');
    }
    const order = await OrderModel.findById(orderId);
    if (!order) throw createAppError(ERROR_CODES.ORDER_NOT_FOUND, 404, 'Order not found');

    const orderObjectId = order._id as Types.ObjectId;
    const [shipments, collections] = await Promise.all([
      ShipmentModel.find({ order_id: orderObjectId }).sort({ created_at: 1 }),
      CashCollectionModel.find({ order_id: orderObjectId }),
    ]);

    const rows = await EarningsAllocationModel.find({
      $or: [
        { source_type: 'order', source_id: orderObjectId },
        ...(shipments.length ? [{ source_type: 'shipment', source_id: { $in: shipments.map((s) => s._id) } }] : []),
        ...(collections.length
          ? [{ source_type: 'cod_collection', source_id: { $in: collections.map((c) => c._id) } }]
          : []),
      ],
    })
      .sort({ created_at: 1 })
      .lean<AllocationFacts[]>();

    const rowsFor = (sourceType: string, sourceId: unknown): AllocationFacts[] =>
      rows.filter((r) => r.source_type === sourceType && String(r.source_id) === String(sourceId));

    const agencyIds = [...new Set(shipments.map((s) => s.agency_id.toString()))];
    const agencies = agencyIds.length ? await this.agencyRepo.findByIds(agencyIds) : [];
    const policyByAgency = new Map(agencies.map((a) => [(a._id as any).toString(), a.policies ?? null]));

    // Nothing will be split for a moment that has not happened on a cancelled or refunded order.
    const orderVoid =
      order.fulfillment_status === 'cancelled' ||
      order.payment_status === 'refunded' ||
      order.payment_status === 'failed';

    const sections: MoneySplitSection[] = [];
    const isCod = order.payment_method === 'cash_on_delivery';

    if (!isCod) {
      sections.push(await this.paymentSection(order, rowsFor('order', orderObjectId), orderVoid, now));
    }

    for (const shipment of shipments) {
      const policies = policyByAgency.get(shipment.agency_id.toString()) ?? null;
      const collection = collections.find((c) => c.shipment_id.toString() === (shipment._id as any).toString());
      sections.push(
        isCod
          ? await this.cashCollectionSection(order, shipment, collection ?? null, policies, rowsFor, orderVoid, now)
          : await this.deliverySection(order, shipment, collection ?? null, policies, rowsFor, rows, orderVoid, now)
      );
    }

    const items = orderItemsGrossOf(order);
    const deliveryInCash = deliveryCashOf(order);
    const charged = {
      items,
      delivery: order.total_amount - items,
      deliveryInCash,
      total: order.total_amount + deliveryInCash,
    };
    // Refund clawbacks / recoveries / write-offs on this order's shares (REFUND-FLOW-PLAN § 6),
    // plus the vendor-beyond rows filed against the order itself (`allocation_id: null`).
    const adjustments: MoneyAdjustmentLine[] = (
      await EarningsAdjustmentModel.find({
        $or: [
          ...(rows.length ? [{ allocation_id: { $in: rows.map((r) => r._id) } }] : []),
          { allocation_id: null, source_type: 'order', source_id: orderObjectId },
        ],
      })
        .sort({ created_at: 1 })
        .lean<any[]>()
    ).map((a) => ({
      kind: a.kind,
      refundKey: a.refund_key,
      allocationId: a.allocation_id ? String(a.allocation_id) : null,
      beneficiary: { type: a.beneficiary_type, id: a.beneficiary_id ? String(a.beneficiary_id) : null },
      amount: a.amount,
      goodsAmount: a.goods_amount ?? 0,
      deliveryAmount: a.delivery_amount ?? 0,
      takenFrom: {
        pending: a.taken_from?.pending ?? 0,
        reserve: a.taken_from?.reserve ?? 0,
        available: a.taken_from?.available ?? 0,
        debt: a.taken_from?.debt ?? 0,
      },
      createdAt: a.created_at ?? null,
    }));
    const { totals, reconciliation, estimated } = summarise(sections, charged.total, adjustments);

    return {
      order: {
        id: orderObjectId.toString(),
        orderNumber: order.order_number,
        vendorId: order.vendor_id.toString(),
        customerId: order.customer_id.toString(),
        currency: order.currency,
        orderType: order.order_type,
        paymentMethod: order.payment_method,
        paymentStatus: order.payment_status,
        fulfillmentStatus: order.fulfillment_status,
        deliveryPayer: deliveryPayerOf(order),
        completedAt: order.completion?.confirmed_at ?? null,
        createdAt: order.created_at ?? null,
      },
      charged,
      sections,
      adjustments,
      totals,
      reconciliation,
      estimated,
      holdDays: EARNINGS_CONFIG.HOLD_DAYS,
      bargainFeePercent: EARNINGS_CONFIG.AI_MARGIN_PERCENT,
    };
  }

  // ── payment (prepaid items) ─────────────────────────────────────────────────────────────

  private async paymentSection(
    order: IOrder,
    rows: AllocationFacts[],
    orderVoid: boolean,
    now: Date
  ): Promise<MoneySplitSection> {
    const bargainLines = bargainFeeLinesOf(order.items.map((item) => this.lineFacts(item, item.quantity)));
    const base: MoneySplitSection = {
      key: 'payment',
      moment: 'payment',
      source: { type: 'order', id: order._id.toString() },
      state: 'allocated',
      noneReason: null,
      shipment: null,
      goods: null,
      delivery: null,
      lines: [],
      notes: [],
    };

    if (rows.length > 0) {
      const notes: MoneySplitNote[] = rows.some((r) => r.beneficiary_type === 'agency') ? ['legacy_agency_on_order'] : [];
      return {
        ...base,
        // A legacy order banked the agency's whole fee here at payment; it is a delivery line,
        // not goods, so it is shown but kept out of the goods basis.
        goods: prepaidGoodsFromRows(rows.filter((r) => r.beneficiary_type !== 'agency'), bargainLines),
        lines: rows.map((row) => lineFromAllocation(row, now)),
        notes,
      };
    }
    if (orderVoid) return { ...base, state: 'none', noneReason: 'order_void' };

    try {
      const c = await this.splits.computeOrderSplit(order);
      const notes: MoneySplitNote[] = ['commission_rate_may_change'];
      if (c.vendorNet < 0) notes.push('vendor_net_negative');
      return {
        ...base,
        state: 'projected',
        goods: goodsBasisOf({
          gross: c.gross,
          bargainFee: c.aiMargin,
          bargainLines,
          commissionPercent: c.commissionPercent,
          commission: c.commission,
          deliveryFeeCharged: c.vendorBorneDelivery,
          codHandlingFee: 0,
          vendorNet: c.vendorNet,
        }),
        lines: compact([
          projectedLine('vendor_net', { type: 'vendor', id: order.vendor_id.toString() }, Math.max(0, c.vendorNet)),
          projectedLine('commission', PLATFORM, c.commission),
          projectedLine('bargain_fee', PLATFORM_AI, c.aiMargin),
        ]),
        notes,
      };
    } catch (error) {
      return this.unavailable(base, 'payment', order, error);
    }
  }

  // ── delivery (prepaid, one shipment) ───────────────────────────────────────────────────

  private async deliverySection(
    order: IOrder,
    shipment: IShipment,
    collection: ICashCollection | null,
    policies: IAgencyPolicies | null,
    rowsFor: (sourceType: string, sourceId: unknown) => AllocationFacts[],
    allRows: AllocationFacts[],
    orderVoid: boolean,
    now: Date
  ): Promise<MoneySplitSection> {
    const shipmentId = (shipment._id as any).toString();
    const base = this.sectionShell(shipment, 'delivery', { type: 'shipment', id: shipmentId });
    const customerId = order.customer_id.toString();
    const customerFee = customerDeliveryFeeOf(order, shipment);
    const payer = deliveryPayerOf(order, shipment);
    const agentId = shipment.agent_id ? shipment.agent_id.toString() : null;
    const agentSplit = await this.agentSplitOf(agentId, shipment.agency_id.toString());

    // ── the customer pays this fee to the rider in cash (W-F) ──
    if (paysDeliveryFeeInCash(order, shipment)) {
      const cashRows = collection ? rowsFor('cod_collection', collection._id) : [];
      const returnRows = rowsFor('shipment', shipmentId);
      if (cashRows.length > 0 || returnRows.length > 0) {
        const fee = cashRows[0]?.gross_snapshot ?? returnRows[0]?.gross_snapshot ?? 0;
        const agency = sumOf(cashRows, 'agency');
        const agent = sumOf(cashRows, 'agent');
        const refundToVendor = sumOf(returnRows, 'vendor');
        const refundToCustomer = shipment.customer_fee_refundable ?? 0;
        return {
          ...base,
          source: cashRows.length
            ? { type: 'cod_collection', id: String(collection!._id) }
            : { type: 'shipment', id: shipmentId },
          delivery: this.deliveryBasis(shipment, {
            fee,
            payer,
            customerPaid: customerFee,
            outcome: shipment.status === 'returned' ? 'returned' : 'delivered',
            earnedFee: agency + agent,
            codHandlingFee: 0,
            agentCut: agent,
            agentSplit,
            refundToVendor,
            refundToCustomer,
          }),
          lines: compact([
            ...[...cashRows, ...returnRows].map((row) => lineFromAllocation(row, now)),
            customerRefundLine(customerId, refundToCustomer, false),
          ]),
        };
      }
      if (orderVoid) return { ...base, state: 'none', noneReason: 'order_void' };
      if (shipment.status === 'returned') return { ...base, state: 'none', noneReason: 'returned_without_cash' };
      try {
        const c = await this.splits.computeDeliveryFeeCollectionSplit(order, {
          shipment,
          policies,
          agentId,
          agencyId: shipment.agency_id.toString(),
          cash: collection ? collectionBreakdownOf(collection).deliveryFeeAmount : customerFee,
        });
        return this.projectedDelivery(base, order, shipment, {
          fee: c.deliveryFee,
          payer,
          customerPaid: customerFee,
          earnedFee: c.deliveryFee,
          codHandlingFee: 0,
          agentCut: c.agentCut,
          agencyCut: c.agencyCut,
          agentSplit,
          refundToVendor: 0,
          refundToCustomer: c.customerExcess,
          requiresCashSettlement: true,
        });
      } catch (error) {
        return this.unavailable(base, 'delivery', order, error);
      }
    }

    // ── the ordinary prepaid run ──
    const shipmentRows = rowsFor('shipment', shipmentId);
    if (shipmentRows.length > 0) {
      const agency = sumOf(shipmentRows, 'agency');
      const agent = sumOf(shipmentRows, 'agent');
      const refundToCustomer = shipment.customer_fee_refundable ?? 0;
      return {
        ...base,
        delivery: this.deliveryBasis(shipment, {
          fee: shipmentRows[0].gross_snapshot,
          payer,
          customerPaid: customerFee,
          outcome: shipment.status === 'returned' ? 'returned' : 'delivered',
          earnedFee: agency + agent,
          codHandlingFee: 0,
          agentCut: agent,
          agentSplit,
          refundToVendor: sumOf(shipmentRows, 'vendor'),
          refundToCustomer,
        }),
        lines: compact([
          ...shipmentRows.map((row) => lineFromAllocation(row, now)),
          customerRefundLine(customerId, refundToCustomer, false),
        ]),
      };
    }
    // An order paid before the fee was deferred banked this agency's fee at payment — the
    // payment section shows that row, and `splitShipmentDelivery` skips this run on purpose.
    const legacyAgencyRow = allRows.some(
      (r) =>
        r.source_type === 'order' &&
        r.beneficiary_type === 'agency' &&
        String(r.beneficiary_id) === shipment.agency_id.toString()
    );
    if (legacyAgencyRow) {
      return { ...base, state: 'none', noneReason: 'agency_paid_at_payment', notes: ['legacy_agency_on_order'] };
    }
    if (orderVoid) return { ...base, state: 'none', noneReason: 'order_void' };

    try {
      const outcome = shipment.status === 'returned' ? 'returned' : 'delivered';
      const c = await this.splits.computeShipmentDeliverySplit(order, shipment, outcome, policies);
      const section = this.projectedDelivery(base, order, shipment, {
        fee: c.reservedFee,
        payer,
        customerPaid: customerFee,
        earnedFee: c.earnedFee,
        codHandlingFee: 0,
        agentCut: c.agentCut,
        agencyCut: c.agencyCut,
        agentSplit,
        refundToVendor: c.vendorRefund,
        refundToCustomer: c.customerRefundable,
        requiresCashSettlement: false,
        outcome: shipment.status === 'returned' ? 'returned' : 'expected',
      });
      if (c.reservedFeeComputedLive) section.notes.push('fee_not_charged_to_vendor');
      return section;
    } catch (error) {
      return this.unavailable(base, 'delivery', order, error);
    }
  }

  // ── cash collection (COD, one shipment: goods + delivery at once) ───────────────────────

  private async cashCollectionSection(
    order: IOrder,
    shipment: IShipment,
    collection: ICashCollection | null,
    policies: IAgencyPolicies | null,
    rowsFor: (sourceType: string, sourceId: unknown) => AllocationFacts[],
    orderVoid: boolean,
    now: Date
  ): Promise<MoneySplitSection> {
    const shipmentId = (shipment._id as any).toString();
    const base = this.sectionShell(
      shipment,
      'cash_collection',
      collection ? { type: 'cod_collection', id: String(collection._id) } : { type: 'cod_collection', id: null }
    );
    const customerId = order.customer_id.toString();
    const payer = deliveryPayerOf(order, shipment);
    const agentId = shipment.agent_id ? shipment.agent_id.toString() : collection?.agent_id?.toString() ?? null;
    const agentSplit = await this.agentSplitOf(agentId, shipment.agency_id.toString());
    const bargainLines = bargainFeeLinesOf(this.shipmentLineFacts(order, shipment));

    const rows = collection && collectionKindOf(collection) !== 'delivery_fee' ? rowsFor('cod_collection', collection._id) : [];
    if (rows.length > 0) {
      const { itemsAmount, deliveryFeeAmount } = collectionBreakdownOf(collection!);
      const vendorNet = sumOf(rows, 'vendor');
      const commission = sumOf(rows, 'platform');
      const bargainFee = sumOf(rows, 'platform_ai');
      const agency = sumOf(rows, 'agency');
      const agent = sumOf(rows, 'agent');
      // `splitCodCollection` writes the fee onto the shipment at collection; the agency row is
      // `fee − agentCut + codFee`, so the handling fee is the residual against it.
      const fee = shipment.delivery_fee_snapshot ?? agency + agent;
      const codHandlingFee = Math.max(0, agency + agent - fee);
      const vendorBorne = deliveryFeeShares(fee, deliveryFeeAmount).vendorBorne;
      const refundToCustomer = shipment.customer_fee_refundable ?? 0;
      return {
        ...base,
        goods: goodsBasisOf({
          gross: rows[0].gross_snapshot ?? itemsAmount,
          bargainFee,
          bargainLines,
          commissionPercent: rows[0].commission_percent_snapshot,
          commission,
          deliveryFeeCharged: vendorBorne,
          codHandlingFee,
          vendorNet,
        }),
        delivery: this.deliveryBasis(shipment, {
          fee,
          payer,
          customerPaid: deliveryFeeAmount,
          outcome: 'delivered',
          earnedFee: fee,
          codHandlingFee,
          agentCut: agent,
          agentSplit,
          refundToVendor: 0,
          refundToCustomer,
        }),
        lines: compact([
          ...rows.map((row) => lineFromAllocation(row, now)),
          customerRefundLine(customerId, refundToCustomer, false),
        ]),
      };
    }
    if (orderVoid) return { ...base, state: 'none', noneReason: 'order_void' };
    if (isReturnedCod(order, shipment)) return { ...base, state: 'none', noneReason: 'returned_without_cash' };

    try {
      const amounts = collection
        ? collectionBreakdownOf(collection)
        : cashCollectionService.cashAmountsOf(order, shipment);
      const c = await this.splits.computeCodCollectionSplit(order, {
        shipment,
        policies,
        agentId,
        agencyId: shipment.agency_id.toString(),
        itemsAmount: amounts.itemsAmount,
        deliveryFeeAmount: amounts.deliveryFeeAmount,
      });
      const notes: MoneySplitNote[] = ['commission_rate_may_change'];
      if (!agentId) notes.push('agent_not_assigned');
      if (c.vendorNet < 0) notes.push('vendor_net_negative');
      const vendor = { type: 'vendor' as const, id: order.vendor_id.toString() };
      const agency = { type: 'agency' as const, id: shipment.agency_id.toString() };
      return {
        ...base,
        state: 'projected',
        goods: goodsBasisOf({
          gross: c.gross,
          bargainFee: c.aiMargin,
          bargainLines,
          commissionPercent: c.commissionPercent,
          commission: c.commission,
          deliveryFeeCharged: c.vendorBorneDelivery,
          codHandlingFee: c.codFee,
          vendorNet: c.vendorNet,
        }),
        delivery: this.deliveryBasis(shipment, {
          fee: c.deliveryFee,
          payer,
          customerPaid: amounts.deliveryFeeAmount,
          outcome: 'expected',
          earnedFee: c.deliveryFee,
          codHandlingFee: c.codFee,
          agentCut: agentId ? c.agentCut : null,
          agentSplit,
          refundToVendor: 0,
          refundToCustomer: c.customerExcess,
        }),
        lines: compact([
          projectedLine('vendor_net', vendor, Math.max(0, c.vendorNet), true),
          projectedLine('commission', PLATFORM, c.commission, true),
          projectedLine('bargain_fee', PLATFORM_AI, c.aiMargin, true),
          projectedLine('delivery_agency', agency, c.agencyCut, true),
          agentId
            ? projectedLine('delivery_agent', { type: 'agent', id: agentId }, c.agentCut, true)
            : null,
          customerRefundLine(customerId, c.customerExcess, true),
        ]),
        notes,
      };
    } catch (error) {
      return this.unavailable(base, `cash collection of shipment ${shipmentId}`, order, error);
    }
  }

  // ── helpers ─────────────────────────────────────────────────────────────────────────────

  private projectedDelivery(
    base: MoneySplitSection,
    order: IOrder,
    shipment: IShipment,
    p: {
      fee: number;
      payer: 'vendor' | 'customer';
      customerPaid: number;
      earnedFee: number;
      codHandlingFee: number;
      agentCut: number;
      agencyCut: number;
      agentSplit: DeliveryBasis['agentSplit'];
      refundToVendor: number;
      refundToCustomer: number;
      requiresCashSettlement: boolean;
      outcome?: DeliveryBasis['outcome'];
    }
  ): MoneySplitSection {
    const agentId = shipment.agent_id ? shipment.agent_id.toString() : null;
    const notes: MoneySplitNote[] = agentId ? [] : ['agent_not_assigned'];
    return {
      ...base,
      state: 'projected',
      delivery: this.deliveryBasis(shipment, {
        fee: p.fee,
        payer: p.payer,
        customerPaid: p.customerPaid,
        outcome: p.outcome ?? 'expected',
        earnedFee: p.earnedFee,
        codHandlingFee: p.codHandlingFee,
        agentCut: agentId ? p.agentCut : null,
        agentSplit: p.agentSplit,
        refundToVendor: p.refundToVendor,
        refundToCustomer: p.refundToCustomer,
      }),
      lines: compact([
        projectedLine(
          'delivery_agency',
          { type: 'agency', id: shipment.agency_id.toString() },
          p.agencyCut,
          p.requiresCashSettlement
        ),
        agentId
          ? projectedLine('delivery_agent', { type: 'agent', id: agentId }, p.agentCut, p.requiresCashSettlement)
          : null,
        projectedLine('delivery_refund_vendor', { type: 'vendor', id: order.vendor_id.toString() }, p.refundToVendor),
        customerRefundLine(order.customer_id.toString(), p.refundToCustomer, true),
      ]),
      notes,
    };
  }

  private deliveryBasis(
    shipment: IShipment,
    p: Omit<DeliveryBasis, 'feeSource' | 'vendorBorne'>
  ): DeliveryBasis {
    return {
      ...p,
      feeSource: feeSourceOf(shipment),
      vendorBorne: deliveryFeeShares(p.fee, p.customerPaid).vendorBorne,
    };
  }

  private sectionShell(
    shipment: IShipment,
    moment: MoneySplitSection['moment'],
    source: MoneySplitSection['source']
  ): MoneySplitSection {
    const shipmentId = (shipment._id as any).toString();
    return {
      key: `shipment:${shipmentId}`,
      moment,
      source,
      state: 'allocated',
      noneReason: null,
      shipment: {
        id: shipmentId,
        trackingNumber: shipment.tracking_number ?? null,
        status: shipment.status,
        agencyId: shipment.agency_id.toString(),
        agentId: shipment.agent_id ? shipment.agent_id.toString() : null,
      },
      goods: null,
      delivery: null,
      lines: [],
      notes: [],
    };
  }

  private unavailable(base: MoneySplitSection, what: string, order: IOrder, error: unknown): MoneySplitSection {
    console.error(
      `[OrderMoneySplitService] Could not project the ${what} split of order ${order._id.toString()}:`,
      error
    );
    return { ...base, state: 'unavailable' };
  }

  private async agentSplitOf(agentId: string | null, agencyId: string): Promise<DeliveryBasis['agentSplit']> {
    if (!agentId) return null;
    const contract = await this.contracts.findLiveOrLatest(agentId, agencyId);
    return agentSplitBasisOf(contract?.fee_split ?? null);
  }

  private lineFacts(item: IOrder['items'][number], quantity: number): BargainLineFacts {
    return {
      orderItemId: (item._id as any).toString(),
      title: item.variant_title ? `${item.title} — ${item.variant_title}` : item.title ?? null,
      unitPrice: item.price,
      floorPrice: item.floor_price_snapshot ?? null,
      quantity,
    };
  }

  /** A shipment's lines with the SHIPMENT's quantities — the pairing `computeShipmentAiMargin` uses. */
  private shipmentLineFacts(order: IOrder, shipment: IShipment): BargainLineFacts[] {
    const byId = new Map(order.items.map((i) => [(i._id as any).toString(), i]));
    return shipment.items.flatMap((si) => {
      const item = byId.get(si.order_item_id.toString());
      return item ? [this.lineFacts(item, si.quantity)] : [];
    });
  }
}

function sumOf(rows: AllocationFacts[], beneficiaryType: string): number {
  return rows.filter((r) => r.beneficiary_type === beneficiaryType).reduce((total, r) => total + r.amount, 0);
}

function compact(lines: Array<MoneyLine | null>): MoneyLine[] {
  return lines.filter((line): line is MoneyLine => line !== null);
}

export const orderMoneySplitService = new OrderMoneySplitService();
