import { OrderModel, FulfillmentStatus } from '../../orders/order.model';
import { Booking } from '../../booking/models/booking.model';
import { CashCollectionModel } from '../../cod/models/cash-collection.model';
import { CodCashAccountModel } from '../../cod/models/cod-cash-account.model';
import { AgentDepositModel } from '../../cod/models/agent-deposit.model';
import { AgencyRemittanceModel } from '../../cod/models/agency-remittance.model';
import { CodDiscrepancyModel } from '../../cod/models/cod-discrepancy.model';
import { PayoutRequestModel, PAYOUT_HELD_STATUSES } from '../../earnings/models/payout-request.model';
import { EarningsAccountModel } from '../../earnings/models/earnings-account.model';
import { EarningsAllocationModel } from '../../earnings/models/earnings-allocation.model';
import { AgencyStockLevelModel } from '../../inventory/models/agency-stock-level.model';
import { AgencyStorageInvoiceModel } from '../../inventory/models/agency-storage-invoice.model';
import { NegotiationSessionModel } from '../../negotiation/models/negotiation-session.model';
import { StockAdjustmentRequestModel } from '../../stock-requests/models/stock-adjustment-request.model';
import { ShipmentModel, UNTERMINATED_SHIPMENT_STATUSES } from '../../shipments/shipment.model';
import { ShipmentAssignmentOfferModel } from '../../shipment-assignment/models/shipment-assignment-offer.model';
import { SubscriberPlanModel } from '../../billing/models/subscriber-plan.model';
import { CreditWalletModel } from '../../billing/models/credit-wallet.model';
import { freePlanCode } from '../../billing/billing.types';
import { ACTIVE_SHIPMENT_STATUSES } from '../../agents/config/agent.config';
import {
  ClosableRole,
  RoleClosureBlocker,
  RoleClosureBlockerCode,
  RoleClosureWarning,
} from '../role-closure.types';

/**
 * What stops a role closing (O-2), and what closing it costs the user (O-6) — ADR-A10.
 *
 * ── Every blocker is a REFUSAL, not a cascade ────────────────────────────────────
 * Each one names something another party depends on: a parcel an agent is holding, cash a
 * platform is owed, a payout in flight, goods on an agency's shelf. Closing over any of them
 * either strands it or corrupts someone else's balance, and anonymising the role removes the
 * contact details needed to settle it afterwards. So the answer is "settle it first", itemised,
 * and the list is evaluated TWICE — when the administrator asks and when the user confirms —
 * because seven days is long enough for a new order to arrive.
 *
 * ── Exclusion lists, where the source has one ────────────────────────────────────
 * "In flight" for orders is derived by exclusion from the settled fulfilment statuses, as
 * `AccountClosureRepository` does: a status added later counts as live until somebody says
 * otherwise, which is the safe direction when the wrong answer is an undeliverable parcel.
 *
 * ── Reads only, and outside any transaction ───────────────────────────────────────
 * These are counts deciding whether to start. The confirm's transaction re-runs nothing here;
 * the compare-and-set on the request and on each entity is what guards the race, and the
 * window between this read and that transaction is the same one ADR-A02 self-closure accepts.
 */

const SETTLED_FULFILMENT: readonly FulfillmentStatus[] = ['fulfilled', 'cancelled', 'returned'];
const OPEN_BOOKING_STATUSES = ['pending', 'confirmed'];
const OPEN_BOOKING_PAYMENT_STATUSES = ['pending', 'disputed', 'refund_pending'];
/** `failed` is not terminal for an agency (`failed → in_transit | returned`). */
const AGENCY_LIVE_SHIPMENT_STATUSES = [...UNTERMINATED_SHIPMENT_STATUSES, 'failed'];

type Push = (code: RoleClosureBlockerCode, count: number, money?: { amount: number; currency?: string }) => void;

function collector(): { blockers: RoleClosureBlocker[]; push: Push } {
  const blockers: RoleClosureBlocker[] = [];
  const push: Push = (code, count, money) => {
    if (count <= 0) return;
    blockers.push(money ? { code, count, amount: money.amount, currency: money.currency } : { code, count });
  };
  return { blockers, push };
}

export class RoleClosureBlockersService {
  /** Every reason this role cannot close now. Empty means it may. */
  async evaluate(role: ClosableRole, roleEntityId: string, userId: string): Promise<RoleClosureBlocker[]> {
    const { blockers, push } = collector();
    const now = new Date();

    switch (role) {
      case 'customer':
        await this.customer(roleEntityId, userId, push);
        break;
      case 'vendor':
        await this.vendor(roleEntityId, push, now);
        break;
      case 'agency':
        await this.agency(roleEntityId, push);
        break;
      case 'agent':
        await this.agent(roleEntityId, push);
        break;
    }
    return blockers;
  }

  /** O-6 — forfeitures to show the user before they confirm. Never blocking. */
  async warnings(role: ClosableRole, roleEntityId: string): Promise<RoleClosureWarning[]> {
    if (role === 'customer') return [];
    const now = new Date();
    const out: RoleClosureWarning[] = [];

    const plans = await SubscriberPlanModel.find({
      owner_type: role,
      owner_id: roleEntityId,
      status: { $in: ['active', 'pending_activation'] },
      plan_code: { $ne: freePlanCode(role) },
      expires_at: { $gt: now },
    }).lean().exec();
    for (const plan of plans) {
      out.push({ code: 'prepaid_plan_forfeited', planCode: plan.plan_code, expiresAt: plan.expires_at ?? undefined });
    }

    const wallet = await CreditWalletModel.findOne({ owner_type: role, owner_id: roleEntityId }).lean().exec();
    if (wallet && (wallet.balance ?? 0) > 0) {
      out.push({ code: 'credit_balance_forfeited', amount: wallet.balance });
    }
    return out;
  }

  // ─── Per role ──────────────────────────────────────────────────────────────

  private async customer(customerId: string, userId: string, push: Push): Promise<void> {
    const [orders, bookings] = await Promise.all([
      OrderModel.countDocuments({
        customer_id: customerId,
        $or: [{ fulfillment_status: { $nin: SETTLED_FULFILMENT } }, { 'dispute_hold.active': true }],
      }).exec(),
      // Bookings key the customer by `userId` (the account), not by the customer profile.
      Booking.countDocuments({
        userId,
        $or: [
          { status: { $in: OPEN_BOOKING_STATUSES } },
          { paymentStatus: { $in: OPEN_BOOKING_PAYMENT_STATUSES } },
        ],
      }).exec(),
    ]);
    push('orders_in_flight', orders);
    push('bookings_upcoming', bookings);
  }

  private async vendor(vendorId: string, push: Push, now: Date): Promise<void> {
    const [orders, bookings, cod, stock, invoices, negotiations, stockRequests] = await Promise.all([
      OrderModel.countDocuments({
        vendor_id: vendorId,
        $or: [{ fulfillment_status: { $nin: SETTLED_FULFILMENT } }, { 'dispute_hold.active': true }],
      }).exec(),
      Booking.countDocuments({
        vendorId,
        $or: [
          { status: { $in: OPEN_BOOKING_STATUSES } },
          { paymentStatus: { $in: OPEN_BOOKING_PAYMENT_STATUSES } },
          { 'settlement.balanceDue': { $gt: 0 } },
        ],
      }).exec(),
      CashCollectionModel.countDocuments({ vendor_id: vendorId, status: 'pending' }).exec(),
      AgencyStockLevelModel.countDocuments({
        vendor_id: vendorId,
        $or: [{ quantity_on_hand: { $ne: 0 } }, { quantity_reserved: { $ne: 0 } }],
      }).exec(),
      AgencyStorageInvoiceModel.countDocuments({ vendor_id: vendorId, status: 'open' }).exec(),
      // A spendable price lock is a price a customer was promised; an open session is one
      // being haggled right now. Stale sessions past their expiry are neither.
      NegotiationSessionModel.countDocuments({
        vendor_id: vendorId,
        $or: [
          { status: 'open', expires_at: { $gt: now } },
          { status: 'agreed', 'lock.consumed_at': null, 'lock.expires_at': { $gt: now } },
        ],
      }).exec(),
      StockAdjustmentRequestModel.countDocuments({ vendor_id: vendorId, status: 'pending' }).exec(),
    ]);
    push('vendor_orders_in_flight', orders);
    push('vendor_bookings_open', bookings);
    push('cod_collections_pending', cod);
    push('agency_stock_held', stock);
    push('storage_invoices_open', invoices);
    push('negotiations_open', negotiations);
    push('stock_requests_pending', stockRequests);
    await this.money('vendor', vendorId, push);
  }

  private async agency(agencyId: string, push: Push): Promise<void> {
    const [shipments, cod, remittances, discrepancies, stock, invoices, stockRequests] = await Promise.all([
      ShipmentModel.countDocuments({ agency_id: agencyId, status: { $in: AGENCY_LIVE_SHIPMENT_STATUSES } }).exec(),
      CashCollectionModel.countDocuments({ agency_id: agencyId, status: 'pending' }).exec(),
      AgencyRemittanceModel.countDocuments({ agency_id: agencyId, status: 'declared' }).exec(),
      CodDiscrepancyModel.countDocuments({ agency_id: agencyId, status: 'open' }).exec(),
      AgencyStockLevelModel.countDocuments({
        agency_id: agencyId,
        $or: [{ quantity_on_hand: { $ne: 0 } }, { quantity_reserved: { $ne: 0 } }],
      }).exec(),
      AgencyStorageInvoiceModel.countDocuments({ agency_id: agencyId, status: 'open' }).exec(),
      StockAdjustmentRequestModel.countDocuments({ agency_id: agencyId, status: 'pending' }).exec(),
    ]);
    push('shipments_unterminated', shipments);
    push('cod_collections_pending', cod);
    push('cod_remittances_declared', remittances);
    push('cod_discrepancies_open', discrepancies);
    push('agency_stock_held', stock);
    push('storage_invoices_open', invoices);
    push('stock_requests_pending', stockRequests);
    await this.codCash('agency', agencyId, push);
    await this.money('agency', agencyId, push);
  }

  private async agent(agentId: string, push: Push): Promise<void> {
    const [shipments, handover, offers, cod, deposits, discrepancies] = await Promise.all([
      ShipmentModel.countDocuments({ agent_id: agentId, status: { $in: [...ACTIVE_SHIPMENT_STATUSES] } }).exec(),
      // After a post-pickup reassignment `agent_id` is cleared while the OLD agent still
      // physically holds the parcel until the replacement collects it.
      ShipmentModel.countDocuments({ status: 'handing_over', 'handover.from_agent_id': agentId }).exec(),
      ShipmentAssignmentOfferModel.countDocuments({ agent_id: agentId, status: 'pending' }).exec(),
      CashCollectionModel.countDocuments({ agent_id: agentId, status: 'pending' }).exec(),
      AgentDepositModel.countDocuments({ agent_id: agentId, status: 'declared' }).exec(),
      CodDiscrepancyModel.countDocuments({ agent_id: agentId, status: 'open' }).exec(),
    ]);
    push('shipments_active', shipments);
    push('shipments_handover_held', handover);
    push('offers_pending', offers);
    push('cod_collections_pending', cod);
    push('cod_deposits_declared', deposits);
    push('cod_discrepancies_open', discrepancies);
    await this.codCash('agent', agentId, push);
    await this.money('agent', agentId, push);
  }

  // ─── Shared money checks ──────────────────────────────────────────────────

  /** Cash the role holds on the platform's behalf. Its own blocker: it is a liability, not earnings. */
  private async codCash(ownerType: 'agent' | 'agency', ownerId: string, push: Push): Promise<void> {
    const account = await CodCashAccountModel.findOne({ owner_type: ownerType, owner_id: ownerId }).lean().exec();
    const balance = account?.balance ?? 0;
    if (balance !== 0) push('cod_cash_held', 1, { amount: balance });
  }

  /**
   * Earnings the role is owed or has requested. Closing over a balance clears the payout
   * details it would be paid to, so the money becomes unpayable — including auto-threshold
   * payouts nobody is watching.
   */
  private async money(ownerType: 'vendor' | 'agency' | 'agent', ownerId: string, push: Push): Promise<void> {
    const [held, accounts, allocations] = await Promise.all([
      PayoutRequestModel.countDocuments({
        owner_type: ownerType,
        owner_id: ownerId,
        status: { $in: [...PAYOUT_HELD_STATUSES] },
      }).exec(),
      EarningsAccountModel.find({ owner_type: ownerType, owner_id: ownerId }).lean().exec(),
      EarningsAllocationModel.countDocuments({
        beneficiary_type: ownerType,
        beneficiary_id: ownerId,
        status: 'held',
      }).exec(),
    ]);
    push('payout_request_held', held);
    push('earnings_allocations_held', allocations);
    for (const account of accounts) {
      const total =
        (account.pending_balance ?? 0)
        + (account.available_balance ?? 0)
        + (account.reserve_balance ?? 0)
        + (account.requested_balance ?? 0);
      if (total !== 0) push('earnings_balance', 1, { amount: total, currency: account.currency });
    }
  }
}

export const roleClosureBlockersService = new RoleClosureBlockersService();
