import { ClientSession, Types } from 'mongoose';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { transactionManager } from '../../../core/database/transaction.manager';
import { eventBus } from '../../../core/events/event-bus';
import { IOrder, OrderModel } from '../../orders/order.model';
import { IShipment, ShipmentModel } from '../../shipments/shipment.model';
import { DeliveryAgencyRepository } from '../../delivery/delivery-agency.repository';
import { IAgencyPolicies } from '../../delivery/delivery-agency.model';
import { EntitlementService, entitlementService } from '../../billing/services/entitlement.service';
import { EarningsQuoteService, earningsQuoteService } from '../../earnings/services/earnings-quote.service';
import { EarningsAllocationRepository } from '../../earnings/repositories/earnings-allocation.repository';
import { EarningsAccountService, earningsAccountService } from '../../earnings/services/earnings-account.service';
import { bargainLineOf } from '../../earnings/services/earnings-split.service';
import { computeOrderAiMargin } from '../../earnings/services/negotiation-margin.service';
import { PaymentTransactionModel } from '../../payments/models/payment-transaction.model';
import type { ChargeSelection } from '../../payments/services/payment-orchestrator.service';
import type { PaymentChannelInfo } from '../../payments/gateways/gateway.interface';
import {
  DeliveryFeeProposalRepository,
  deliveryFeeProposalRepository,
} from '../repositories/delivery-fee-proposal.repository';
import {
  DeliveryFeeProposalStatus,
  DeliveryFeeProposerRole,
  IDeliveryFeeApplication,
  IDeliveryFeeProposal,
  IDeliveryFeeProposalEdit,
} from '../models/delivery-fee-proposal.model';
import {
  DELIVERY_FEE_PROPOSAL_WINDOW,
  EditRefusal,
  ProposalRefusal,
  checkCreation,
  checkEdit,
  checkVendorVersion,
  checkProposer,
  checkVendorNet,
  codShipmentVendorNet,
  planFeeApplication,
  prepaidOrderVendorNet,
  resolveAvailableActions,
  splitOrderVendorNetAfter,
} from '../domain/delivery-fee-proposal.rules';
import {
  FeeChangePlan,
  FeeState,
  ProposalOrigin,
  checkCustomerProposalEdit,
  feeDirection,
  planCustomerApprovedIncrease,
  planDecrease,
  planVendorCoveredIncrease,
  resolveApprover,
  windowFor,
} from '../domain/customer-fee-change.rules';
import {
  CustomerDeliveryFeeProposalDto,
  DeliveryFeeProposalDto,
  toCustomerDeliveryFeeProposalDto,
  toDeliveryFeeProposalDto,
} from '../dto/delivery-fee-proposal.dto';
import { customerDeliveryFeeOf, deliveryPayerOf, orderItemsGrossOf } from '../../orders/domain/delivery-payer';
import { CustomerFeeApplicationService, customerFeeApplicationService } from './customer-fee-application.service';
import { customerFeeNotifier } from './customer-fee-notifier';
import { deliveryFeeRefundService } from './delivery-fee-refund.service';

export type ProposerActor =
  | { role: 'agency'; agencyId: string; userId: string }
  | { role: 'agent'; agentId: string; userId: string };

export interface ProposeInput {
  proposedFee: number;
  reason: string;
}

/** What a system-raised proposal (change-agency, combined request) carries. */
export interface SystemProposalInput {
  shipment: IShipment;
  order: IOrder;
  proposedFee: number;
  reason: string;
  origin: Exclude<ProposalOrigin, 'agency'>;
  /** The combined request answered (origin `combined_request`). */
  combinedRequestId?: Types.ObjectId | null;
  /** The agency user answering a combined request — recorded as the proposer. */
  agencyActor?: { agencyId: string; userId: string } | null;
}

/**
 * Map a pure refusal onto the error the API answers with. One status per code — the
 * `test:errors` census refuses a code raised at two statuses that disagree on category.
 */
function refusalToError(refusal: ProposalRefusal) {
  switch (refusal.code) {
    case 'window_closed':
      return createAppError(ERROR_CODES.DELIVERY_FEE_PROPOSAL_WINDOW_CLOSED, 422, undefined, {
        status: refusal.status,
        allowed: [...DELIVERY_FEE_PROPOSAL_WINDOW],
      });
    case 'agents_not_allowed':
      return createAppError(ERROR_CODES.DELIVERY_FEE_PROPOSAL_AGENTS_NOT_ALLOWED, 403);
    case 'agent_not_on_shipment':
      // The scoped read already 404s a shipment that is not this agent's; reaching here means
      // the agent is not the one holding the accepted offer. Same answer, same reason.
      return createAppError(ERROR_CODES.SHIPMENT_NOT_FOUND, 404);
    case 'already_pending':
      return createAppError(ERROR_CODES.DELIVERY_FEE_PROPOSAL_ALREADY_PENDING, 409, undefined, {
        proposalId: refusal.proposalId,
      });
    case 'limit_reached':
      return createAppError(ERROR_CODES.DELIVERY_FEE_PROPOSAL_LIMIT_REACHED, 422, undefined, {
        used: refusal.used,
        max: refusal.max,
      });
    case 'invalid_fee':
      // The Zod schema already refuses this at 400; this is the belt over it.
      return createAppError(ERROR_CODES.VALIDATION_ERROR, 400, 'proposedFee must be an integer ≥ 0');
    case 'no_change':
      return createAppError(ERROR_CODES.DELIVERY_FEE_PROPOSAL_NO_CHANGE, 422, undefined, {
        currentFee: refusal.currentFee,
      });
    case 'vendor_net_not_positive':
      // ⚠ No numbers in `details`: the vendor's net (and so their commission) is not the
      // proposer's to see, and the max proposable fee would reveal it by subtraction.
      return createAppError(ERROR_CODES.DELIVERY_FEE_PROPOSAL_VENDOR_NET_NOT_POSITIVE, 422);
  }
}

function editRefusalToError(refusal: EditRefusal) {
  switch (refusal.code) {
    case 'version_mismatch':
      return createAppError(ERROR_CODES.DELIVERY_FEE_PROPOSAL_VERSION_MISMATCH, 409, undefined, {
        currentVersion: refusal.currentVersion,
      });
    case 'invalid_fee':
      return refusalToError({ code: 'invalid_fee' });
    case 'no_change':
      return createAppError(ERROR_CODES.DELIVERY_FEE_PROPOSAL_NO_CHANGE, 422, 'The edit changes nothing');
    case 'same_as_current':
      return refusalToError({ code: 'no_change', currentFee: refusal.currentFee });
  }
}

/**
 * DeliveryFeeProposalService — an agency (or its agent, if the agency allows it) proposes a
 * different delivery fee for ONE shipment, before pickup. Every write is a compare-and-set inside
 * a transaction that also moves the shipment's pending pointer, so a proposal can never be
 * half-applied and pickup can never slip past a pending one.
 *
 * WHO ANSWERS depends on who pays the delivery (ADR-A11, owner decision D-8):
 *
 *   vendor-paid      the VENDOR approves or rejects (ADR-A09, unchanged). Money: COD and
 *                    not-yet-split prepaid orders only record the override; a split prepaid order
 *                    has its snapshot rewritten and the vendor's held allocation re-priced IN
 *                    PLACE (`planFeeApplication`).
 *   customer-paid    a DECREASE applies directly when proposed (online: the difference is
 *                    refunded; COD: less cash). An INCREASE waits for the CUSTOMER: COD — the cash
 *                    to collect grows on approval; online — approval freezes the figure and a
 *                    top-up payment (`purpose: 'order_delivery_topup'`) must succeed before the
 *                    fee applies and pickup unblocks (`DeliveryFeeTopupService`). On a rejection
 *                    the agency may decline the job or re-propose once (ADR-A09 D-8, unchanged).
 *
 * Two SYSTEM origins ride the same machinery: a change-agency difference (D-10, the customer
 * answers, the vendor covers on a rejection) and a combined-price answer (D-8, always a decrease).
 * The money for every customer-paid change is written by ONE method,
 * `CustomerFeeApplicationService.applyInSession`.
 */
export class DeliveryFeeProposalService {
  constructor(
    private readonly proposals: DeliveryFeeProposalRepository = deliveryFeeProposalRepository,
    private readonly agencies: DeliveryAgencyRepository = new DeliveryAgencyRepository(),
    private readonly entitlements: EntitlementService = entitlementService,
    private readonly quotes: EarningsQuoteService = earningsQuoteService,
    private readonly allocations: EarningsAllocationRepository = new EarningsAllocationRepository(),
    private readonly accounts: EarningsAccountService = earningsAccountService,
    private readonly feeApp: CustomerFeeApplicationService = customerFeeApplicationService
  ) {}

  // ── Reads ──────────────────────────────────────────────────────────────────

  async listForShipment(actor: ProposerActor, shipmentId: string): Promise<DeliveryFeeProposalDto[]> {
    await this.loadScopedShipment(actor, shipmentId);
    const rows = await this.proposals.listByShipment(shipmentId);
    return rows.map((p) => toDeliveryFeeProposalDto(p, this.viewerOf(actor)));
  }

  /** All proposals on these shipments, grouped — one query, for list/detail enrichment. */
  async mapForShipments(
    shipmentIds: string[],
    viewer: { role: 'vendor' | 'agency' | 'agent'; agentId?: string | null }
  ): Promise<Map<string, DeliveryFeeProposalDto[]>> {
    const out = new Map<string, DeliveryFeeProposalDto[]>();
    const rows = await this.proposals.listByShipments(shipmentIds);
    for (const p of rows) {
      const key = p.shipment_id.toString();
      const list = out.get(key) ?? [];
      list.push(toDeliveryFeeProposalDto(p, viewer));
      out.set(key, list);
    }
    return out;
  }

  async listForVendorOrder(vendorId: string, orderId: string): Promise<DeliveryFeeProposalDto[]> {
    await this.loadVendorOrder(vendorId, orderId);
    const rows = await this.proposals.listByOrder(orderId);
    return rows.map((p) => toDeliveryFeeProposalDto(p, { role: 'vendor' }));
  }

  /** Read-model hook for the vendor order detail. Never throws on an unknown order. */
  async listForOrderUnchecked(orderId: string): Promise<DeliveryFeeProposalDto[]> {
    if (!Types.ObjectId.isValid(orderId)) return [];
    const rows = await this.proposals.listByOrder(orderId);
    return rows.map((p) => toDeliveryFeeProposalDto(p, { role: 'vendor' }));
  }

  async listForVendor(
    vendorId: string,
    filter: { status?: DeliveryFeeProposalStatus; orderId?: string },
    page: number,
    limit: number
  ) {
    const result = await this.proposals.listForVendor(vendorId, filter, page, limit);
    return {
      data: result.data.map((p) => toDeliveryFeeProposalDto(p, { role: 'vendor' })),
      meta: result.meta,
    };
  }

  /**
   * The customer's view of one order's delivery fees (ADR-A11): every fee change on its
   * customer-paid shipments, what each shipment's delivery stands at, and the delivery money
   * returned or owed.
   */
  async listForCustomerOrder(
    customerId: string,
    orderId: string
  ): Promise<{
    proposals: CustomerDeliveryFeeProposalDto[];
    shipments: Array<{
      shipmentId: string;
      status: string;
      deliveryPayer: 'vendor' | 'customer';
      fee: number;
      /** Online: what you paid for this delivery (incl. top-ups). COD: what you will pay in cash. */
      customerFee: number;
      pendingProposalId: string | null;
    }>;
    refunds: { owed: number; entries: Array<{ amount: number; status: string; cause: string; createdAt: Date; settledAt: Date | null }> };
    currency: string;
  }> {
    const order = await this.loadCustomerOrder(customerId, orderId);
    const [rows, shipments, refundState] = await Promise.all([
      this.proposals.listForCustomerOrder(customerId, orderId),
      ShipmentModel.find({ order_id: order._id }),
      deliveryFeeRefundService.outstandingFor(orderId),
    ]);
    const policies = new Map<string, IAgencyPolicies | null>();
    for (const s of shipments) {
      const id = s.agency_id.toString();
      if (!policies.has(id)) policies.set(id, (await this.agencies.findById(id))?.policies ?? null);
    }
    return {
      proposals: rows.map(toCustomerDeliveryFeeProposalDto),
      shipments: shipments.map((s) => ({
        shipmentId: (s._id as Types.ObjectId).toString(),
        status: s.status,
        deliveryPayer: deliveryPayerOf(order, s),
        fee: deliveryPayerOf(order, s) === 'customer' ? this.feeApp.effectiveFee(s, order, policies.get(s.agency_id.toString()) ?? null) : 0,
        customerFee: customerDeliveryFeeOf(order, s),
        pendingProposalId: s.pending_delivery_fee_proposal_id ? s.pending_delivery_fee_proposal_id.toString() : null,
      })),
      refunds: {
        owed: refundState.owed,
        entries: refundState.ledger.map((r) => ({
          amount: r.amount,
          status: r.status,
          cause: r.cause,
          createdAt: r.created_at,
          settledAt: r.settled_at ?? null,
        })),
      },
      currency: order.currency,
    };
  }

  // ── Propose ────────────────────────────────────────────────────────────────

  async propose(actor: ProposerActor, shipmentId: string, input: ProposeInput): Promise<DeliveryFeeProposalDto> {
    const shipment = await this.loadScopedShipment(actor, shipmentId);
    const agencyId = shipment.agency_id.toString();
    const agency = await this.agencies.findById(agencyId);

    const proposerRefusal = checkProposer({
      role: actor.role,
      agentsMayPropose: agency?.assignment_settings?.agents_can_propose_delivery_fee ?? false,
      shipmentAgentId: shipment.agent_id ? shipment.agent_id.toString() : null,
      actorAgentId: actor.role === 'agent' ? actor.agentId : null,
    });
    if (proposerRefusal) throw refusalToError(proposerRefusal);

    const order = await this.loadOrder(shipment.order_id.toString());
    const currentFee = await this.effectiveFee(shipment, order, agency?.policies ?? null);

    const counted = await this.proposals.countCountedForShipment(shipmentId);
    const creationRefusal = checkCreation({
      shipmentStatus: shipment.status,
      pendingProposalId: shipment.pending_delivery_fee_proposal_id
        ? shipment.pending_delivery_fee_proposal_id.toString()
        : null,
      countedProposals: counted,
      proposedFee: input.proposedFee,
      currentFee,
    });
    if (creationRefusal) throw refusalToError(creationRefusal);

    // ADR-A11: a customer-paid shipment's fee change goes to the CUSTOMER (D-8). The vendor's
    // share does not move in that flow, so the vendor-net ceiling below is not this branch's
    // question; D-9 — no `max_fee_per_shipment` ceiling either.
    if (deliveryPayerOf(order, shipment) === 'customer') {
      const created = await this.createCustomerPaidProposal({
        shipment,
        order,
        currentFee,
        proposedFee: input.proposedFee,
        reason: input.reason,
        proposer: {
          role: actor.role,
          userId: actor.userId,
          agentId: actor.role === 'agent' ? actor.agentId : null,
        },
        origin: 'agency',
        claimAgentId: actor.role === 'agent' ? actor.agentId : null,
      });
      return toDeliveryFeeProposalDto(created, this.viewerOf(actor));
    }

    const netRefusal = checkVendorNet(await this.vendorNetAt(order, shipment, input.proposedFee, agency?.policies ?? null));
    if (netRefusal) throw refusalToError(netRefusal);

    const proposalId = new Types.ObjectId();
    const now = new Date();
    const created = await transactionManager.runInTransactionWithRetry(async (session) => {
      await this.claimOrExplain(
        { shipmentId, proposalId, agencyId, agentId: actor.role === 'agent' ? actor.agentId : null, window: DELIVERY_FEE_PROPOSAL_WINDOW },
        shipment,
        session
      );
      return this.proposals.create(
        {
          ...this.baseRow({
            proposalId,
            shipment,
            order,
            role: actor.role,
            userId: actor.userId,
            agentId: actor.role === 'agent' ? actor.agentId : null,
            feeBefore: currentFee,
            proposedFee: input.proposedFee,
            reason: input.reason,
            now,
          }),
          approver: 'vendor',
          origin: 'agency',
          direction: feeDirection(currentFee, input.proposedFee),
        } as Partial<IDeliveryFeeProposal>,
        session
      );
    });

    this.emit('delivery_fee_proposal.created', created, { orderNumber: (order as any).order_number ?? null });
    return toDeliveryFeeProposalDto(created, this.viewerOf(actor));
  }

  /**
   * A change the PLATFORM raises on a customer-paid shipment (ADR-A11): the price difference of a
   * change-agency move (D-10), or one fee of an agency's answer to a combined-price request (D-8).
   * Same creation rules as an agency proposal, minus the proposer check (no actor proposes it).
   */
  async raiseSystemProposal(input: SystemProposalInput): Promise<IDeliveryFeeProposal> {
    const { shipment, order } = input;
    if (deliveryPayerOf(order, shipment) !== 'customer') {
      // A change the platform raises is always about the customer's money.
      throw createAppError(ERROR_CODES.DELIVERY_FEE_PROPOSAL_NOT_YOURS, 403);
    }
    const agency = await this.agencies.findById(shipment.agency_id.toString());
    const currentFee = await this.effectiveFee(shipment, order, agency?.policies ?? null);
    const window = windowFor(input.origin);
    if (!window.includes(shipment.status)) {
      throw refusalToError({ code: 'window_closed', status: shipment.status });
    }
    if (shipment.pending_delivery_fee_proposal_id) {
      throw refusalToError({ code: 'already_pending', proposalId: shipment.pending_delivery_fee_proposal_id.toString() });
    }
    if (input.origin === 'combined_request') {
      const counted = await this.proposals.countCountedForShipment((shipment._id as Types.ObjectId).toString());
      const refusal = checkCreation({
        shipmentStatus: shipment.status,
        pendingProposalId: null,
        countedProposals: counted,
        proposedFee: input.proposedFee,
        currentFee,
      });
      if (refusal) throw refusalToError(refusal);
    } else if (input.proposedFee === currentFee) {
      throw refusalToError({ code: 'no_change', currentFee });
    }
    return this.createCustomerPaidProposal({
      shipment,
      order,
      currentFee,
      proposedFee: input.proposedFee,
      reason: input.reason,
      proposer: input.agencyActor
        ? { role: 'agency', userId: input.agencyActor.userId, agentId: null }
        : { role: 'system', userId: null, agentId: null },
      origin: input.origin,
      combinedRequestId: input.combinedRequestId ?? null,
      claimAgentId: null,
    });
  }

  // ── Withdraw ───────────────────────────────────────────────────────────────

  async withdraw(actor: ProposerActor, shipmentId: string, proposalId: string): Promise<DeliveryFeeProposalDto> {
    await this.loadScopedShipment(actor, shipmentId);
    const proposal = await this.proposals.findById(proposalId);
    if (!proposal || proposal.shipment_id.toString() !== shipmentId) {
      throw createAppError(ERROR_CODES.DELIVERY_FEE_PROPOSAL_NOT_FOUND, 404);
    }
    const allowed = resolveAvailableActions(this.authorityOf(proposal), this.viewerOf(actor));
    if (proposal.status !== 'pending') {
      throw createAppError(ERROR_CODES.DELIVERY_FEE_PROPOSAL_NOT_PENDING, 409, undefined, { status: proposal.status });
    }
    if (!allowed.includes('withdraw')) throw createAppError(ERROR_CODES.DELIVERY_FEE_PROPOSAL_NOT_YOURS, 403);
    // A customer who approved may be paying for it right now: a withdrawal under a live charge
    // would leave money landing on a closed proposal. (Should it race anyway, the top-up is
    // credited to the customer and returned — `DeliveryFeeTopupService`.)
    if (proposal.customer_approval && (await this.hasLiveTopup(proposal._id as Types.ObjectId))) {
      throw createAppError(ERROR_CODES.DELIVERY_FEE_TOPUP_IN_PROGRESS, 409);
    }

    const withdrawn = await transactionManager.runInTransactionWithRetry(async (session) => {
      const updated = await this.proposals.transitionFromPending(
        proposal._id as Types.ObjectId,
        'withdrawn',
        {
          role: actor.role,
          userId: actor.userId,
          withdrawalReason: null,
          // An agent may withdraw only while it is still theirs — an agency edit racing
          // this makes it agency-owned, and the CAS then misses.
          ...(actor.role === 'agent' ? { scope: { agency_edited: { $ne: true } } } : {}),
        },
        session
      );
      if (!updated) throw createAppError(ERROR_CODES.DELIVERY_FEE_PROPOSAL_NOT_PENDING, 409);
      await this.proposals.releasePendingPointer(updated.shipment_id, updated._id as Types.ObjectId, session);
      return updated;
    });

    this.emit('delivery_fee_proposal.withdrawn', withdrawn);
    return toDeliveryFeeProposalDto(withdrawn, this.viewerOf(actor));
  }

  // ── Edit (still the ONE pending request — no new document, no count) ───────

  /**
   * Change a pending proposal's fee and/or reason. The agency may edit any pending proposal
   * on its shipment (its agent's included — which makes it agency-owned); the proposing
   * agent may edit their own while it is still theirs and the agency preference is on.
   * Same window and vendor-net ceiling as creation. CAS on `status: 'pending'` + version.
   *
   * A customer-approver proposal (ADR-A11) stays an increase — an edit that would lower it is
   * refused (withdraw and propose the lower fee, which applies directly) — and is frozen once the
   * customer approved it.
   */
  async edit(
    actor: ProposerActor,
    shipmentId: string,
    proposalId: string,
    input: { proposedFee?: number; reason?: string; version?: number }
  ): Promise<DeliveryFeeProposalDto> {
    const shipment = await this.loadScopedShipment(actor, shipmentId);
    const proposal = await this.proposals.findById(proposalId);
    if (!proposal || proposal.shipment_id.toString() !== shipmentId) {
      throw createAppError(ERROR_CODES.DELIVERY_FEE_PROPOSAL_NOT_FOUND, 404);
    }
    if (proposal.status !== 'pending') {
      throw createAppError(ERROR_CODES.DELIVERY_FEE_PROPOSAL_NOT_PENDING, 409, undefined, { status: proposal.status });
    }

    const agency = await this.agencies.findById(shipment.agency_id.toString());
    const agentsMayPropose = agency?.assignment_settings?.agents_can_propose_delivery_fee ?? false;
    const isCustomerApprover = (proposal.approver ?? 'vendor') === 'customer';
    if (isCustomerApprover && proposal.customer_approval) {
      throw createAppError(ERROR_CODES.DELIVERY_FEE_TOPUP_IN_PROGRESS, 409);
    }
    const allowed = resolveAvailableActions(this.authorityOf(proposal), { ...this.viewerOf(actor), agentsMayPropose });
    if (!allowed.includes('edit')) {
      // The proposing agent whose agency switched the preference off gets the specific answer.
      const ownProposal =
        actor.role === 'agent' &&
        proposal.proposed_by_role === 'agent' &&
        !proposal.agency_edited &&
        proposal.proposed_by_agent_id?.toString() === actor.agentId;
      if (ownProposal && !agentsMayPropose) throw refusalToError({ code: 'agents_not_allowed' });
      throw createAppError(ERROR_CODES.DELIVERY_FEE_PROPOSAL_NOT_YOURS, 403);
    }
    if (!windowFor(proposal.origin).includes(shipment.status)) {
      throw refusalToError({ code: 'window_closed', status: shipment.status });
    }

    const order = await this.loadOrder(shipment.order_id.toString());
    const currentFee = await this.effectiveFee(shipment, order, agency?.policies ?? null);
    const editRefusal = checkEdit({
      currentVersion: proposal.version ?? 1,
      expectedVersion: input.version,
      proposedFee: proposal.proposed_fee,
      reason: proposal.reason,
      newFee: input.proposedFee,
      newReason: input.reason,
      shipmentCurrentFee: currentFee,
    });
    if (editRefusal) throw editRefusalToError(editRefusal);

    const newFee = input.proposedFee ?? proposal.proposed_fee;
    const newReason = input.reason ?? proposal.reason;
    if (isCustomerApprover) {
      const refusal = checkCustomerProposalEdit({ currentFee, newFee, customerApproved: !!proposal.customer_approval });
      if (refusal?.code === 'direction_changed') {
        throw createAppError(ERROR_CODES.DELIVERY_FEE_PROPOSAL_DIRECTION_CHANGED, 422, undefined, { currentFee });
      }
      if (refusal) throw createAppError(ERROR_CODES.DELIVERY_FEE_TOPUP_IN_PROGRESS, 409);
    } else if (newFee !== proposal.proposed_fee) {
      const netRefusal = checkVendorNet(await this.vendorNetAt(order, shipment, newFee, agency?.policies ?? null));
      if (netRefusal) throw refusalToError(netRefusal);
    }

    const fromVersion = proposal.version ?? 1;
    const edit: IDeliveryFeeProposalEdit = {
      edited_by_role: actor.role,
      edited_by_user_id: Types.ObjectId.isValid(actor.userId) ? new Types.ObjectId(actor.userId) : null,
      edited_by_agent_id: actor.role === 'agent' ? new Types.ObjectId(actor.agentId) : null,
      fee_before: proposal.proposed_fee,
      fee_after: newFee,
      reason_before: proposal.reason,
      reason_after: newReason,
      version: fromVersion + 1,
      at: new Date(),
    };
    const updated = await this.proposals.applyEdit(proposal._id as Types.ObjectId, fromVersion, edit, newReason, newFee);
    if (!updated) {
      const fresh = await this.proposals.findById(proposalId);
      if (fresh && fresh.status === 'pending') {
        throw editRefusalToError({ code: 'version_mismatch', currentVersion: fresh.version ?? 1 });
      }
      throw createAppError(ERROR_CODES.DELIVERY_FEE_PROPOSAL_NOT_PENDING, 409, undefined, {
        status: fresh?.status ?? null,
      });
    }

    this.emit('delivery_fee_proposal.edited', updated, {
      orderNumber: (order as any).order_number ?? null,
      version: updated.version,
      previousFee: edit.fee_before,
      reasonChanged: edit.reason_before !== edit.reason_after,
      editedByRole: actor.role,
      editedByAgentId: actor.role === 'agent' ? actor.agentId : null,
    });
    if (isCustomerApprover) {
      // The customer must answer the figure they are SHOWN — the new version.
      customerFeeNotifier.approvalNeeded(order, {
        proposalId: (updated._id as Types.ObjectId).toString(),
        version: updated.version ?? 1,
        feeBefore: updated.fee_before,
        proposedFee: updated.proposed_fee,
        reason: updated.reason,
      });
    }
    return toDeliveryFeeProposalDto(updated, { ...this.viewerOf(actor), agentsMayPropose });
  }

  // ── Vendor: approve / reject (vendor-paid) · cover (change-agency) ──────────

  /**
   * `seenVersion` is the version the vendor was shown. It is checked up front AND carried
   * into the compare-and-set, so an edit landing between the vendor's read and this write
   * makes the approval fail (409 VERSION_MISMATCH) instead of applying an unseen fee.
   */
  async approve(
    vendorId: string,
    userId: string,
    orderId: string,
    proposalId: string,
    seenVersion: number
  ): Promise<DeliveryFeeProposalDto> {
    const order = await this.loadVendorOrder(vendorId, orderId);
    const proposal = await this.loadVendorProposal(vendorId, orderId, proposalId, seenVersion);
    this.assertVendorAnswers(proposal);

    const shipment = await ShipmentModel.findById(proposal.shipment_id);
    if (!shipment) throw createAppError(ERROR_CODES.SHIPMENT_NOT_FOUND, 404);
    this.assertStillApplies(proposal, shipment);

    const agency = await this.agencies.findById(shipment.agency_id.toString());
    const isCod = order.payment_method === 'cash_on_delivery';

    // Re-check the ceiling against today's numbers (commission, sibling fees and the COD fee
    // may all have moved since the proposal was raised). A split prepaid order is checked
    // AGAIN inside the transaction against the allocation it actually re-prices.
    const netRefusal = checkVendorNet(
      await this.vendorNetAt(order, shipment, proposal.proposed_fee, agency?.policies ?? null)
    );
    if (netRefusal) throw refusalToError(netRefusal);

    const approvedAt = new Date();
    const approved = await transactionManager.runInTransactionWithRetry(async (session) => {
      const fresh = await this.proposals.findShipmentInSession(shipment._id.toString(), session);
      if (!fresh) throw createAppError(ERROR_CODES.SHIPMENT_NOT_FOUND, 404);
      this.assertStillApplies(proposal, fresh);

      const snapshot = isCod ? null : (fresh.delivery_fee_snapshot ?? null);
      const vendorAllocation =
        snapshot === null
          ? null
          : await this.allocations.findOneBySourceAndBeneficiary('order', orderId, 'vendor', vendorId, session);
      const orderSplit =
        snapshot === null ? false : !!vendorAllocation || (await this.allocations.existsForSource('order', orderId));

      const plan = planFeeApplication({
        isCod,
        snapshot,
        vendorAllocation: vendorAllocation
          ? { amount: vendorAllocation.amount, status: vendorAllocation.status }
          : null,
        orderSplit,
        newFee: proposal.proposed_fee,
      });
      if (!plan.ok) {
        if (plan.reason === 'allocation_not_held') {
          throw createAppError(ERROR_CODES.DELIVERY_FEE_PROPOSAL_SETTLEMENT_CONFLICT, 409, undefined, {
            allocationStatus: vendorAllocation?.status ?? null,
          });
        }
        throw refusalToError({ code: 'vendor_net_not_positive' });
      }

      const applied = await this.proposals.applyApprovedFee(
        {
          shipmentId: fresh._id as Types.ObjectId,
          proposalId: proposal._id as Types.ObjectId,
          fee: proposal.proposed_fee,
          rewriteSnapshot: plan.rewriteSnapshot,
          expectedSnapshot: snapshot,
          window: DELIVERY_FEE_PROPOSAL_WINDOW,
          approvedAt,
        },
        session
      );
      if (!applied) throw createAppError(ERROR_CODES.DELIVERY_FEE_PROPOSAL_STALE, 409);

      let allocationBefore: number | null = null;
      let allocationAfter: number | null = null;
      if (plan.allocationDelta !== 0 && vendorAllocation) {
        allocationBefore = vendorAllocation.amount;
        const repriced = await this.allocations.adjustHeldAmount(
          vendorAllocation._id as Types.ObjectId,
          vendorAllocation.amount,
          plan.allocationAfter!,
          session
        );
        if (!repriced) {
          throw createAppError(ERROR_CODES.DELIVERY_FEE_PROPOSAL_SETTLEMENT_CONFLICT, 409, undefined, {
            allocationStatus: vendorAllocation.status,
          });
        }
        await this.accounts.adjustHeldInSession(repriced, plan.allocationDelta, session);
        allocationAfter = repriced.amount;
      }

      const application: IDeliveryFeeApplication = {
        fee_at_apply: snapshot ?? proposal.fee_before,
        vendor_allocation_before: allocationBefore,
        vendor_allocation_after: allocationAfter,
        snapshot_rewritten: plan.rewriteSnapshot,
      };
      const updated = await this.proposals.transitionFromPending(
        proposal._id as Types.ObjectId,
        'approved',
        {
          role: 'vendor',
          userId,
          application,
          scope: { vendor_id: new Types.ObjectId(vendorId), version: seenVersion },
        },
        session
      );
      if (!updated) throw await this.answerMiss(proposalId);
      return updated;
    });

    this.emit('delivery_fee_proposal.approved', approved, {
      orderNumber: (order as any).order_number ?? null,
      respondedByRole: 'vendor',
    });
    return toDeliveryFeeProposalDto(approved, { role: 'vendor' });
  }

  async reject(
    vendorId: string,
    userId: string,
    orderId: string,
    proposalId: string,
    note: string | null,
    seenVersion: number
  ): Promise<DeliveryFeeProposalDto> {
    const order = await this.loadVendorOrder(vendorId, orderId);
    const proposal = await this.loadVendorProposal(vendorId, orderId, proposalId, seenVersion);
    this.assertVendorAnswers(proposal);

    const rejected = await transactionManager.runInTransactionWithRetry(async (session) => {
      const updated = await this.proposals.transitionFromPending(
        proposal._id as Types.ObjectId,
        'rejected',
        {
          role: 'vendor',
          userId,
          rejectionNote: note,
          scope: { vendor_id: new Types.ObjectId(vendorId), version: seenVersion },
        },
        session
      );
      if (!updated) throw await this.answerMiss(proposalId);
      await this.proposals.releasePendingPointer(updated.shipment_id, updated._id as Types.ObjectId, session);
      return updated;
    });

    this.emit('delivery_fee_proposal.rejected', rejected, {
      orderNumber: (order as any).order_number ?? null,
      respondedByRole: 'vendor',
    });
    return toDeliveryFeeProposalDto(rejected, { role: 'vendor' });
  }

  /**
   * The vendor takes a change-agency difference on itself (D-10) without waiting for the
   * customer — it moved the parcel, and it is the party that covers the difference anyway when
   * the customer declines. Recorded as `rejected` (the customer is not paying it) with
   * `responded_by_role: 'vendor'` and the note `covered_by_vendor`.
   */
  async coverByVendor(vendorId: string, userId: string, orderId: string, proposalId: string): Promise<DeliveryFeeProposalDto> {
    const order = await this.loadVendorOrder(vendorId, orderId);
    const proposal = await this.proposals.findById(proposalId);
    if (!proposal || proposal.vendor_id.toString() !== vendorId || proposal.order_id.toString() !== orderId) {
      throw createAppError(ERROR_CODES.DELIVERY_FEE_PROPOSAL_NOT_FOUND, 404);
    }
    if (proposal.status !== 'pending') {
      throw createAppError(ERROR_CODES.DELIVERY_FEE_PROPOSAL_NOT_PENDING, 409, undefined, { status: proposal.status });
    }
    if (!resolveAvailableActions(this.authorityOf(proposal), { role: 'vendor' }).includes('cover')) {
      throw createAppError(ERROR_CODES.DELIVERY_FEE_PROPOSAL_NOT_YOURS, 403);
    }
    const covered = await this.applyVendorCover(order, proposal, { role: 'vendor', userId, note: 'covered_by_vendor' });
    return toDeliveryFeeProposalDto(covered, { role: 'vendor' });
  }

  // ── Customer: approve / reject / pay (customer-paid increases, ADR-A11) ─────

  async customerApprove(
    customerId: string,
    userId: string,
    orderId: string,
    proposalId: string,
    seenVersion: number
  ): Promise<CustomerDeliveryFeeProposalDto> {
    const order = await this.loadCustomerOrder(customerId, orderId);
    const proposal = await this.loadCustomerProposal(customerId, orderId, proposalId, seenVersion);
    const actions = resolveAvailableActions(this.authorityOf(proposal), { role: 'customer' });
    if (proposal.customer_approval) {
      // Already approved, awaiting its top-up: answering again is not an error, it is a re-read.
      return toCustomerDeliveryFeeProposalDto(proposal);
    }
    if (!actions.includes('approve')) throw createAppError(ERROR_CODES.DELIVERY_FEE_PROPOSAL_NOT_YOURS, 403);
    this.assertOnlinePaid(order);

    const shipment = await ShipmentModel.findById(proposal.shipment_id);
    if (!shipment) throw createAppError(ERROR_CODES.SHIPMENT_NOT_FOUND, 404);
    this.assertStillApplies(proposal, shipment);
    const state = await this.feeApp.stateOf(shipment, order);
    const plan = planCustomerApprovedIncrease(state, proposal.proposed_fee);

    if (state.mode === 'online' && plan.topupDue > 0) {
      // The figure is frozen and the money is asked for; nothing applies until it is paid.
      const updated = await this.proposals.setCustomerApproval(proposal._id as Types.ObjectId, {
        version: seenVersion,
        customerId,
        userId,
        topupAmount: plan.topupDue,
        at: new Date(),
      });
      if (!updated) throw await this.answerMiss(proposalId);
      customerFeeNotifier.topupDue(order, {
        proposalId: (updated._id as Types.ObjectId).toString(),
        amount: plan.topupDue,
        proposedFee: updated.proposed_fee,
      });
      return toCustomerDeliveryFeeProposalDto(updated);
    }

    // COD (or an online change needing no money): it applies now.
    const approved = await this.applyAndTransition(order, proposal, plan, {
      status: 'approved',
      role: 'customer',
      userId,
      scope: { customer_id: new Types.ObjectId(customerId), version: seenVersion },
    });
    this.emit('delivery_fee_proposal.approved', approved, {
      orderNumber: order.order_number ?? null,
      respondedByRole: 'customer',
    });
    customerFeeNotifier.updated(order, {
      proposalId: (approved._id as Types.ObjectId).toString(),
      feeAfter: approved.proposed_fee,
      how: 'cod_more',
      amount: plan.collectDelta,
    });
    return toCustomerDeliveryFeeProposalDto(approved);
  }

  async customerReject(
    customerId: string,
    userId: string,
    orderId: string,
    proposalId: string,
    note: string | null,
    seenVersion: number
  ): Promise<CustomerDeliveryFeeProposalDto> {
    const order = await this.loadCustomerOrder(customerId, orderId);
    const proposal = await this.loadCustomerProposal(customerId, orderId, proposalId, seenVersion);
    if (!resolveAvailableActions(this.authorityOf(proposal), { role: 'customer' }).includes('reject')) {
      throw createAppError(ERROR_CODES.DELIVERY_FEE_PROPOSAL_NOT_YOURS, 403);
    }
    if (proposal.customer_approval && (await this.hasLiveTopup(proposal._id as Types.ObjectId))) {
      throw createAppError(ERROR_CODES.DELIVERY_FEE_TOPUP_IN_PROGRESS, 409);
    }

    if (proposal.origin === 'change_agency') {
      // D-10: the customer declines to pay the new agency's higher price — the VENDOR covers it.
      const covered = await this.applyVendorCover(order, proposal, { role: 'customer', userId, note, seenVersion });
      return toCustomerDeliveryFeeProposalDto(covered);
    }

    const rejected = await transactionManager.runInTransactionWithRetry(async (session) => {
      const updated = await this.proposals.transitionFromPending(
        proposal._id as Types.ObjectId,
        'rejected',
        {
          role: 'customer',
          userId,
          rejectionNote: note,
          scope: { customer_id: new Types.ObjectId(customerId), version: seenVersion },
        },
        session
      );
      if (!updated) throw await this.answerMiss(proposalId);
      await this.proposals.releasePendingPointer(updated.shipment_id, updated._id as Types.ObjectId, session);
      return updated;
    });
    // The agency hears it and may carry at the old fee, re-propose once, or decline (ADR-A09 D-8).
    this.emit('delivery_fee_proposal.rejected', rejected, {
      orderNumber: order.order_number ?? null,
      respondedByRole: 'customer',
    });
    return toCustomerDeliveryFeeProposalDto(rejected);
  }

  /**
   * Start the top-up an approved increase needs (online). The amount is the one the approval
   * froze — never recomputed here, so the customer pays exactly what they were shown.
   */
  async customerPay(
    customerId: string,
    orderId: string,
    proposalId: string,
    selection: ChargeSelection,
    channel: PaymentChannelInfo,
    options: { originChat?: 'whatsapp' | 'telegram' | null } = {}
  ) {
    await this.loadCustomerOrder(customerId, orderId);
    const proposal = await this.proposals.findById(proposalId);
    if (
      !proposal ||
      proposal.order_id.toString() !== orderId ||
      !proposal.customer_id ||
      proposal.customer_id.toString() !== customerId
    ) {
      throw createAppError(ERROR_CODES.DELIVERY_FEE_PROPOSAL_NOT_FOUND, 404);
    }
    if (proposal.status !== 'pending') {
      throw createAppError(ERROR_CODES.DELIVERY_FEE_PROPOSAL_NOT_PENDING, 409, undefined, { status: proposal.status });
    }
    if (!proposal.customer_approval || !proposal.topup || proposal.topup.status !== 'awaiting_payment' || proposal.topup.amount <= 0) {
      throw createAppError(ERROR_CODES.DELIVERY_FEE_TOPUP_NOT_DUE, 409);
    }
    const shipment = await ShipmentModel.findById(proposal.shipment_id);
    if (!shipment) throw createAppError(ERROR_CODES.SHIPMENT_NOT_FOUND, 404);
    this.assertStillApplies(proposal, shipment);

    const { PaymentOrchestratorService } = await import('../../payments/services/payment-orchestrator.service');
    const result = await new PaymentOrchestratorService().initiateOrderDeliveryTopup(
      {
        orderId,
        shipmentId: proposal.shipment_id.toString(),
        proposalId,
        amount: proposal.topup.amount,
      },
      selection,
      channel,
      options
    );
    return { ...result, proposalId };
  }

  // ── Lifecycle hooks (called by ShipmentService, inside ITS transaction) ─────

  /**
   * Close a shipment's pending proposal because the shipment itself moved on — the agency
   * declined it (`shipment_declined`), the proposing agent was detached (`agent_detached`,
   * only when `onlyProposedByAgentId` matches), or its parcel moved to another agency and the
   * row is going away (`shipment_moved`, ADR-A11). Recorded as a `system` withdrawal so the
   * trail says why. A no-op when nothing is pending.
   */
  async withdrawPendingInSession(
    shipment: Pick<IShipment, '_id' | 'pending_delivery_fee_proposal_id'>,
    reason: 'shipment_declined' | 'agent_detached' | 'shipment_moved',
    session: ClientSession,
    onlyProposedByAgentId: string | null = null
  ): Promise<IDeliveryFeeProposal | null> {
    const pendingId = shipment.pending_delivery_fee_proposal_id;
    if (!pendingId) return null;
    // An agency-edited proposal is agency-owned and survives the agent's detachment.
    const scope = onlyProposedByAgentId
      ? {
          proposed_by_role: 'agent',
          proposed_by_agent_id: new Types.ObjectId(onlyProposedByAgentId),
          agency_edited: { $ne: true },
        }
      : {};
    const withdrawn = await this.proposals.transitionFromPending(
      pendingId,
      'withdrawn',
      { role: 'system', userId: null, withdrawalReason: reason, scope },
      session
    );
    if (withdrawn) await this.proposals.releasePendingPointer(shipment._id as Types.ObjectId, pendingId, session);
    return withdrawn;
  }

  // ── Customer-paid internals ────────────────────────────────────────────────

  /**
   * Create a proposal on a CUSTOMER-paid shipment. A decrease is applied in the same transaction
   * (proposal created, money landed, proposal `approved` by `system`); an increase stays pending
   * for the customer.
   */
  private async createCustomerPaidProposal(args: {
    shipment: IShipment;
    order: IOrder;
    currentFee: number;
    proposedFee: number;
    reason: string;
    proposer: { role: DeliveryFeeProposerRole; userId: string | null; agentId: string | null };
    origin: ProposalOrigin;
    combinedRequestId?: Types.ObjectId | null;
    claimAgentId: string | null;
  }): Promise<IDeliveryFeeProposal> {
    const { shipment, order } = args;
    this.assertOnlinePaid(order);
    const direction = feeDirection(args.currentFee, args.proposedFee);
    const approver = resolveApprover('customer', direction);
    const window = windowFor(args.origin);
    const shipmentId = (shipment._id as Types.ObjectId).toString();
    const state: FeeState = {
      mode: this.feeApp.modeOf(order),
      fee: args.currentFee,
      customerFee: customerDeliveryFeeOf(order, shipment),
    };
    const plan = direction === 'decrease' ? planDecrease(state, args.proposedFee) : null;

    const proposalId = new Types.ObjectId();
    const now = new Date();
    const result = await transactionManager.runInTransactionWithRetry(async (session) => {
      await this.claimOrExplain(
        { shipmentId, proposalId, agencyId: shipment.agency_id.toString(), agentId: args.claimAgentId, window },
        shipment,
        session
      );
      const created = await this.proposals.create(
        {
          ...this.baseRow({
            proposalId,
            shipment,
            order,
            role: args.proposer.role,
            userId: args.proposer.userId,
            agentId: args.proposer.agentId,
            feeBefore: args.currentFee,
            proposedFee: args.proposedFee,
            reason: args.reason,
            now,
          }),
          approver,
          origin: args.origin,
          direction,
          customer_id: order.customer_id as Types.ObjectId,
          combined_request_id: args.combinedRequestId ?? null,
        } as Partial<IDeliveryFeeProposal>,
        session
      );
      if (!plan) return { created, applied: null as IDeliveryFeeProposal | null };

      const application = await this.feeApp.applyInSession(
        { order, shipmentId: shipment._id as Types.ObjectId, proposalId, expectedPointer: proposalId, window, plan, at: now },
        session
      );
      const applied = await this.proposals.transitionFromPending(
        proposalId,
        'approved',
        { role: 'system', userId: null, application: this.applicationOf(plan, application, args.currentFee), note: 'applied_directly' },
        session
      );
      if (!applied) throw createAppError(ERROR_CODES.DELIVERY_FEE_PROPOSAL_STALE, 409);
      return { created, applied };
    });

    this.emit('delivery_fee_proposal.created', result.created, { orderNumber: order.order_number ?? null });
    if (result.applied && plan) {
      this.emit('delivery_fee_proposal.approved', result.applied, {
        orderNumber: order.order_number ?? null,
        respondedByRole: 'system',
      });
      customerFeeNotifier.lowered(order, {
        proposalId: proposalId.toString(),
        feeBefore: plan.feeBefore,
        feeAfter: plan.feeAfter,
        customerSaving: state.mode === 'cod' ? -plan.collectDelta : Math.max(0, plan.refundableAfter - this.refundableBefore(shipment)),
      });
      if (state.mode === 'online' && plan.refundableAfter > 0) {
        void deliveryFeeRefundService.refundOutstanding(order._id.toString(), { cause: 'fee_decrease', shipmentId });
      }
      return result.applied;
    }
    customerFeeNotifier.approvalNeeded(order, {
      proposalId: proposalId.toString(),
      version: 1,
      feeBefore: args.currentFee,
      proposedFee: args.proposedFee,
      reason: args.reason,
    });
    return result.created;
  }

  /** The vendor covers a change-agency difference: on the customer's rejection, or by choice. */
  private async applyVendorCover(
    order: IOrder,
    proposal: IDeliveryFeeProposal,
    by: { role: 'customer' | 'vendor'; userId: string; note: string | null; seenVersion?: number }
  ): Promise<IDeliveryFeeProposal> {
    if (proposal.customer_approval && (await this.hasLiveTopup(proposal._id as Types.ObjectId))) {
      throw createAppError(ERROR_CODES.DELIVERY_FEE_TOPUP_IN_PROGRESS, 409);
    }
    const shipment = await ShipmentModel.findById(proposal.shipment_id);
    if (!shipment) throw createAppError(ERROR_CODES.SHIPMENT_NOT_FOUND, 404);
    this.assertStillApplies(proposal, shipment);
    const state = await this.feeApp.stateOf(shipment, order);
    const plan = planVendorCoveredIncrease(state, proposal.proposed_fee);
    // The vendor's net must survive carrying the difference (the move was pre-checked; commission
    // or a sibling's fee may have moved since).
    const net = await this.feeApp.vendorNetWithBorne(order, shipment, plan.vendorBorneBefore, plan.vendorBorneAfter);
    if (net <= 0) throw refusalToError({ code: 'vendor_net_not_positive' });

    const covered = await this.applyAndTransition(order, proposal, plan, {
      status: 'rejected',
      role: by.role,
      userId: by.userId,
      rejectionNote: by.note,
      scope: by.role === 'customer'
        ? { customer_id: order.customer_id, ...(by.seenVersion !== undefined ? { version: by.seenVersion } : {}) }
        : { vendor_id: order.vendor_id },
    });
    this.emit('delivery_fee_proposal.rejected', covered, {
      orderNumber: order.order_number ?? null,
      respondedByRole: by.role,
      coveredByVendor: true,
      vendorBorneDelta: plan.vendorBorneAfter - plan.vendorBorneBefore,
    });
    customerFeeNotifier.updated(order, {
      proposalId: (covered._id as Types.ObjectId).toString(),
      feeAfter: covered.proposed_fee,
      how: 'shop_covers',
      amount: plan.vendorBorneAfter - plan.vendorBorneBefore,
    });
    return covered;
  }

  /** Land `plan` on the money and close the proposal, in ONE transaction. */
  private async applyAndTransition(
    order: IOrder,
    proposal: IDeliveryFeeProposal,
    plan: FeeChangePlan,
    t: {
      status: 'approved' | 'rejected';
      role: 'customer' | 'vendor' | 'system';
      userId: string | null;
      rejectionNote?: string | null;
      scope: Record<string, unknown>;
      extraSet?: Record<string, unknown>;
    }
  ): Promise<IDeliveryFeeProposal> {
    const at = new Date();
    return transactionManager.runInTransactionWithRetry(async (session) => {
      const application = await this.feeApp.applyInSession(
        {
          order,
          shipmentId: proposal.shipment_id,
          proposalId: proposal._id as Types.ObjectId,
          expectedPointer: proposal._id as Types.ObjectId,
          window: windowFor(proposal.origin),
          plan,
          at,
        },
        session
      );
      const updated = await this.proposals.transitionFromPending(
        proposal._id as Types.ObjectId,
        t.status,
        {
          role: t.role,
          userId: t.userId,
          application: this.applicationOf(plan, application, plan.feeBefore),
          ...(t.rejectionNote !== undefined ? { rejectionNote: t.rejectionNote } : {}),
          scope: t.scope,
          extraSet: t.extraSet,
        },
        session
      );
      if (!updated) throw await this.answerMiss((proposal._id as Types.ObjectId).toString());
      return updated;
    });
  }

  private applicationOf(
    plan: FeeChangePlan,
    applied: { codCollectionAdjusted: boolean; vendorAllocationBefore: number | null; vendorAllocationAfter: number | null },
    feeAtApply: number
  ): IDeliveryFeeApplication {
    return {
      fee_at_apply: feeAtApply,
      vendor_allocation_before: applied.vendorAllocationBefore,
      vendor_allocation_after: applied.vendorAllocationAfter,
      snapshot_rewritten: true,
      customer_fee_before: plan.customerFeeBefore,
      customer_fee_after: plan.customerFeeAfter,
      customer_topup_amount: plan.topupDue > 0 ? plan.topupDue : null,
      customer_refund_due: plan.refundableAfter > 0 ? plan.refundableAfter : null,
      cod_collection_adjusted: applied.codCollectionAdjusted,
      vendor_borne_delta: plan.vendorBorneAfter - plan.vendorBorneBefore,
    };
  }

  private refundableBefore(shipment: IShipment): number {
    const v = shipment.customer_fee_refundable;
    return typeof v === 'number' && v > 0 ? v : 0;
  }

  /**
   * An ONLINE customer-paid order's delivery money can only move while its payment is simply
   * `paid` — a refunded or disputed order's money is already somebody else's question.
   */
  private assertOnlinePaid(order: IOrder): void {
    if (order.payment_method === 'cash_on_delivery') return;
    if (order.payment_status !== 'paid') {
      throw createAppError(ERROR_CODES.DELIVERY_FEE_PROPOSAL_ORDER_NOT_PAID, 422, undefined, {
        paymentStatus: order.payment_status,
      });
    }
  }

  private async hasLiveTopup(proposalId: Types.ObjectId): Promise<boolean> {
    const live = await PaymentTransactionModel.exists({
      purpose: 'order_delivery_topup',
      'deliveryTopup.proposalId': proposalId,
      status: { $in: ['INITIATED', 'PENDING'] },
    });
    return !!live;
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private baseRow(r: {
    proposalId: Types.ObjectId;
    shipment: IShipment;
    order: IOrder;
    role: DeliveryFeeProposerRole;
    userId: string | null;
    agentId: string | null;
    feeBefore: number;
    proposedFee: number;
    reason: string;
    now: Date;
  }): Partial<IDeliveryFeeProposal> {
    const userObjectId = r.userId && Types.ObjectId.isValid(r.userId) ? new Types.ObjectId(r.userId) : null;
    return {
      _id: r.proposalId,
      shipment_id: r.shipment._id as Types.ObjectId,
      order_id: r.order._id as Types.ObjectId,
      vendor_id: r.order.vendor_id as Types.ObjectId,
      agency_id: r.shipment.agency_id,
      proposed_by_role: r.role,
      proposed_by_user_id: userObjectId,
      proposed_by_agent_id: r.agentId ? new Types.ObjectId(r.agentId) : null,
      payment_method: r.order.payment_method,
      currency: r.order.currency,
      fee_before: r.feeBefore,
      proposed_fee: r.proposedFee,
      reason: r.reason,
      status: 'pending',
      status_history: [
        { status: 'pending', changed_at: r.now, changed_by_role: r.role, changed_by_user_id: userObjectId, note: null },
      ],
    } as Partial<IDeliveryFeeProposal>;
  }

  /** Claim the pending pointer, or explain from a fresh read why it could not be claimed. */
  private async claimOrExplain(
    input: { shipmentId: string; proposalId: Types.ObjectId; agencyId: string; agentId: string | null; window: readonly IShipment['status'][] },
    shipment: IShipment,
    session: ClientSession
  ): Promise<void> {
    const claimed = await this.proposals.claimPendingPointer(input, session);
    if (claimed) return;
    // The shipment moved since it was read: picked up, declined, or a second proposal landed
    // first. Report which, from a fresh read inside the transaction.
    const fresh = await this.proposals.findShipmentInSession(input.shipmentId, session);
    if (fresh?.pending_delivery_fee_proposal_id) {
      throw refusalToError({ code: 'already_pending', proposalId: fresh.pending_delivery_fee_proposal_id.toString() });
    }
    throw refusalToError({ code: 'window_closed', status: fresh?.status ?? shipment.status });
  }

  /** The authority-table input for a stored proposal. */
  private authorityOf(p: IDeliveryFeeProposal) {
    return {
      status: p.status,
      proposed_by_role: p.proposed_by_role,
      proposed_by_agent_id: p.proposed_by_agent_id ? p.proposed_by_agent_id.toString() : null,
      agency_edited: !!p.agency_edited,
      approver: p.approver ?? 'vendor',
      origin: p.origin ?? 'agency',
      customer_approved: !!p.customer_approval,
    };
  }

  /** The vendor answers only vendor-approver proposals; a customer-paid one is the customer's. */
  private assertVendorAnswers(proposal: IDeliveryFeeProposal): void {
    if (!resolveAvailableActions(this.authorityOf(proposal), { role: 'vendor' }).includes('approve')) {
      throw createAppError(ERROR_CODES.DELIVERY_FEE_PROPOSAL_NOT_YOURS, 403);
    }
  }

  /** A proposal applies only while its shipment is in the window — and, if an agent raised
   *  it, while that agent is still the one on the shipment. */
  private assertStillApplies(proposal: IDeliveryFeeProposal, shipment: IShipment): void {
    if (!shipment.pending_delivery_fee_proposal_id || !shipment.pending_delivery_fee_proposal_id.equals(proposal._id as Types.ObjectId)) {
      throw createAppError(ERROR_CODES.DELIVERY_FEE_PROPOSAL_NOT_PENDING, 409, undefined, { status: proposal.status });
    }
    if (!windowFor(proposal.origin).includes(shipment.status)) {
      throw createAppError(ERROR_CODES.DELIVERY_FEE_PROPOSAL_STALE, 409, undefined, { shipmentStatus: shipment.status });
    }
    if (
      proposal.proposed_by_role === 'agent' &&
      !proposal.agency_edited &&
      (!shipment.agent_id || !proposal.proposed_by_agent_id || !shipment.agent_id.equals(proposal.proposed_by_agent_id))
    ) {
      throw createAppError(ERROR_CODES.DELIVERY_FEE_PROPOSAL_STALE, 409, undefined, { shipmentStatus: shipment.status });
    }
  }

  private viewerOf(actor: ProposerActor) {
    return actor.role === 'agent' ? { role: 'agent' as const, agentId: actor.agentId } : { role: 'agency' as const };
  }

  /** Ownership-scoped shipment read — 404 (never 403) for one that is not the caller's. */
  private async loadScopedShipment(actor: ProposerActor, shipmentId: string): Promise<IShipment> {
    if (!Types.ObjectId.isValid(shipmentId)) throw createAppError(ERROR_CODES.SHIPMENT_NOT_FOUND, 404);
    const shipment =
      actor.role === 'agency'
        ? await ShipmentModel.findOne({ _id: shipmentId, agency_id: actor.agencyId })
        : await ShipmentModel.findOne({ _id: shipmentId, agent_id: actor.agentId });
    if (!shipment) throw createAppError(ERROR_CODES.SHIPMENT_NOT_FOUND, 404);
    return shipment;
  }

  private async loadOrder(orderId: string): Promise<IOrder> {
    const order = await OrderModel.findById(orderId);
    if (!order) throw createAppError(ERROR_CODES.ORDER_NOT_FOUND, 404);
    return order;
  }

  private async loadVendorOrder(vendorId: string, orderId: string): Promise<IOrder> {
    if (!Types.ObjectId.isValid(orderId)) throw createAppError(ERROR_CODES.ORDER_NOT_FOUND, 404);
    const order = await OrderModel.findOne({ _id: orderId, vendor_id: vendorId });
    if (!order) throw createAppError(ERROR_CODES.ORDER_NOT_FOUND, 404);
    return order;
  }

  /** The customer's own order — 404 (never 403) for one that is not theirs. */
  private async loadCustomerOrder(customerId: string, orderId: string): Promise<IOrder> {
    if (!Types.ObjectId.isValid(orderId)) throw createAppError(ERROR_CODES.ORDER_NOT_FOUND, 404);
    const order = await OrderModel.findOne({ _id: orderId, customer_id: customerId });
    if (!order) throw createAppError(ERROR_CODES.ORDER_NOT_FOUND, 404);
    return order;
  }

  private async loadVendorProposal(
    vendorId: string,
    orderId: string,
    proposalId: string,
    seenVersion: number
  ): Promise<IDeliveryFeeProposal> {
    const proposal = await this.proposals.findById(proposalId);
    if (!proposal || proposal.vendor_id.toString() !== vendorId || proposal.order_id.toString() !== orderId) {
      throw createAppError(ERROR_CODES.DELIVERY_FEE_PROPOSAL_NOT_FOUND, 404);
    }
    if (proposal.status !== 'pending') {
      throw createAppError(ERROR_CODES.DELIVERY_FEE_PROPOSAL_NOT_PENDING, 409, undefined, { status: proposal.status });
    }
    const versionRefusal = checkVendorVersion(seenVersion, proposal.version ?? 1);
    if (versionRefusal) throw editRefusalToError(versionRefusal);
    return proposal;
  }

  /** A customer answers the version they were SHOWN — the same rule the vendor follows (D-11). */
  private async loadCustomerProposal(
    customerId: string,
    orderId: string,
    proposalId: string,
    seenVersion: number
  ): Promise<IDeliveryFeeProposal> {
    const proposal = await this.proposals.findById(proposalId);
    if (
      !proposal ||
      proposal.order_id.toString() !== orderId ||
      !proposal.customer_id ||
      proposal.customer_id.toString() !== customerId
    ) {
      throw createAppError(ERROR_CODES.DELIVERY_FEE_PROPOSAL_NOT_FOUND, 404);
    }
    if (proposal.status !== 'pending') {
      throw createAppError(ERROR_CODES.DELIVERY_FEE_PROPOSAL_NOT_PENDING, 409, undefined, { status: proposal.status });
    }
    const versionRefusal = checkVendorVersion(seenVersion, proposal.version ?? 1);
    if (versionRefusal) throw editRefusalToError(versionRefusal);
    return proposal;
  }

  /** Explain a missed answer CAS: answered meanwhile (NOT_PENDING) or edited (VERSION_MISMATCH). */
  private async answerMiss(proposalId: string) {
    const fresh = await this.proposals.findById(proposalId);
    if (fresh && fresh.status === 'pending') {
      return editRefusalToError({ code: 'version_mismatch', currentVersion: fresh.version ?? 1 });
    }
    return createAppError(ERROR_CODES.DELIVERY_FEE_PROPOSAL_NOT_PENDING, 409, undefined, {
      status: fresh?.status ?? null,
    });
  }

  private itemsById(order: IOrder) {
    return new Map(order.items.map((i) => [(i._id as any).toString(), i]));
  }

  /** What the shipment is charged today: override → snapshot → formula — the same resolution
   *  every split and quote uses (`computeShipmentDeliveryFee`). */
  private async effectiveFee(shipment: IShipment, order: IOrder, policies: IAgencyPolicies | null): Promise<number> {
    return this.quotes.computeShipmentDeliveryFee(
      shipment,
      policies,
      this.itemsById(order),
      order._id.toString(),
      order.delivery_address?.components?.region ?? null
    );
  }

  /**
   * The vendor's net on the split's unit if THIS (vendor-paid) shipment carried `fee`:
   *  - COD: this shipment (gross = its cash, AI margin on its lines, its COD handling fee);
   *  - prepaid, split: the vendor allocation moved by (charged − fee);
   *  - prepaid, unsplit: the order, with every other shipment at its effective fee.
   */
  private async vendorNetAt(order: IOrder, shipment: IShipment, fee: number, policies: IAgencyPolicies | null): Promise<number> {
    const vendorId = order.vendor_id.toString();
    const { commissionPercent } = await this.entitlements.getEntitlements(vendorId);
    const itemsById = this.itemsById(order);

    if (order.payment_method === 'cash_on_delivery') {
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
        fee,
        codHandling: policies?.pricing?.additional_fees?.cod_handling_fee ?? null,
      });
    }

    const vendorAllocation = await this.allocations.findOneBySourceAndBeneficiary(
      'order',
      order._id.toString(),
      'vendor',
      vendorId
    );
    if (vendorAllocation) {
      // A shipment with no snapshot on a split order was never charged to the vendor (a late
      // item); its fee does not touch the vendor's net at all.
      if (typeof shipment.delivery_fee_snapshot !== 'number') return vendorAllocation.amount;
      return splitOrderVendorNetAfter({
        vendorAllocation: vendorAllocation.amount,
        chargedFee: shipment.delivery_fee_snapshot,
        fee,
      });
    }

    const siblings = await ShipmentModel.find({ order_id: order._id });
    const agencyIds = [...new Set(siblings.map((s) => s.agency_id.toString()))];
    const agencies = await this.agencies.findByIds(agencyIds);
    const policyByAgency = new Map(agencies.map((a) => [(a._id as any).toString(), a.policies ?? null]));
    let others = 0;
    for (const s of siblings) {
      if ((s._id as Types.ObjectId).equals(shipment._id as Types.ObjectId)) continue;
      others +=
        typeof s.delivery_fee_snapshot === 'number'
          ? s.delivery_fee_snapshot
          : this.quotes.computeShipmentDeliveryFee(
              s,
              policyByAgency.get(s.agency_id.toString()) ?? null,
              itemsById,
              order._id.toString(),
              order.delivery_address?.components?.region ?? null
            );
    }
    return prepaidOrderVendorNet({
      // The ITEMS (ADR-A11) — what splitOrder measures the vendor on.
      orderGross: orderItemsGrossOf(order),
      aiMargin: computeOrderAiMargin(order.items.map(bargainLineOf)),
      commissionPercent,
      otherShipmentsFees: others,
      fee,
    });
  }

  /**
   * Post-commit, fire-and-forget, in-process only. ADR-A11 added `approverRole`, `origin`,
   * `direction` and (on answers) `respondedByRole` — the notification handlers route on them:
   * the vendor stack ignores a customer-approver proposal, the agency stack names the customer
   * as the one who answered and stays silent on a change it did not raise.
   */
  private emit(eventType: string, proposal: IDeliveryFeeProposal, extra: Record<string, unknown> = {}): void {
    void eventBus
      .publish(eventType, {
        eventType,
        aggregateId: (proposal._id as any).toString(),
        occurredAt: new Date(),
        payload: {
          proposalId: (proposal._id as any).toString(),
          shipmentId: proposal.shipment_id.toString(),
          orderId: proposal.order_id.toString(),
          vendorId: proposal.vendor_id.toString(),
          agencyId: proposal.agency_id.toString(),
          customerId: proposal.customer_id ? proposal.customer_id.toString() : null,
          proposedByRole: proposal.proposed_by_role,
          proposedByAgentId: proposal.proposed_by_agent_id ? proposal.proposed_by_agent_id.toString() : null,
          approverRole: proposal.approver ?? 'vendor',
          origin: proposal.origin ?? 'agency',
          direction: proposal.direction ?? null,
          feeBefore: proposal.fee_before,
          proposedFee: proposal.proposed_fee,
          currency: proposal.currency,
          status: proposal.status,
          ...extra,
        },
      })
      .catch((err) => console.error(`[DeliveryFeeProposalService] ${eventType} emit failed:`, err));
  }

  /** Re-publish after a top-up settled (`DeliveryFeeTopupService`), same payload shape. */
  emitAnswered(eventType: 'delivery_fee_proposal.approved', proposal: IDeliveryFeeProposal, extra: Record<string, unknown>): void {
    this.emit(eventType, proposal, extra);
  }
}

export const deliveryFeeProposalService = new DeliveryFeeProposalService();
