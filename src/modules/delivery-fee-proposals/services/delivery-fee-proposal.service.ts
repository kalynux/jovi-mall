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
import {
  DeliveryFeeProposalRepository,
  deliveryFeeProposalRepository,
} from '../repositories/delivery-fee-proposal.repository';
import {
  DeliveryFeeProposalStatus,
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
import { DeliveryFeeProposalDto, toDeliveryFeeProposalDto } from '../dto/delivery-fee-proposal.dto';

export type ProposerActor =
  | { role: 'agency'; agencyId: string; userId: string }
  | { role: 'agent'; agentId: string; userId: string };

export interface ProposeInput {
  proposedFee: number;
  reason: string;
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
 * DeliveryFeeProposalService —an agency (or its agent, if the agency allows it) proposes a
 * different delivery fee for ONE shipment, before pickup; the vendor who pays it approves
 * or rejects. Every write is a compare-and-set inside a transaction that also moves the
 * shipment's pending pointer, so a proposal can never be half-applied and pickup can never
 * slip past a pending one.
 *
 * Money (see `planFeeApplication`): COD and not-yet-split prepaid orders only record the
 * override — the split charges it. A split prepaid order has its snapshot rewritten and the
 * vendor's held `('order', vendor)` allocation re-priced IN PLACE, in the approval's
 * transaction, with a `delivery_fee_adjustment` ledger row.
 */
export class DeliveryFeeProposalService {
  constructor(
    private readonly proposals: DeliveryFeeProposalRepository = deliveryFeeProposalRepository,
    private readonly agencies: DeliveryAgencyRepository = new DeliveryAgencyRepository(),
    private readonly entitlements: EntitlementService = entitlementService,
    private readonly quotes: EarningsQuoteService = earningsQuoteService,
    private readonly allocations: EarningsAllocationRepository = new EarningsAllocationRepository(),
    private readonly accounts: EarningsAccountService = earningsAccountService
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

    const netRefusal = checkVendorNet(await this.vendorNetAt(order, shipment, input.proposedFee, agency?.policies ?? null));
    if (netRefusal) throw refusalToError(netRefusal);

    const proposalId = new Types.ObjectId();
    const now = new Date();
    const created = await transactionManager.runInTransactionWithRetry(async (session) => {
      const claimed = await this.proposals.claimPendingPointer(
        {
          shipmentId,
          proposalId,
          agencyId,
          agentId: actor.role === 'agent' ? actor.agentId : null,
          window: DELIVERY_FEE_PROPOSAL_WINDOW,
        },
        session
      );
      if (!claimed) {
        // The shipment moved since it was read: picked up, declined, or a second proposal
        // landed first. Report which, from a fresh read inside the transaction.
        const fresh = await this.proposals.findShipmentInSession(shipmentId, session);
        if (fresh?.pending_delivery_fee_proposal_id) {
          throw refusalToError({
            code: 'already_pending',
            proposalId: fresh.pending_delivery_fee_proposal_id.toString(),
          });
        }
        throw refusalToError({ code: 'window_closed', status: fresh?.status ?? shipment.status });
      }
      return this.proposals.create(
        {
          _id: proposalId,
          shipment_id: shipment._id as Types.ObjectId,
          order_id: order._id as Types.ObjectId,
          vendor_id: order.vendor_id as Types.ObjectId,
          agency_id: shipment.agency_id,
          proposed_by_role: actor.role,
          proposed_by_user_id: Types.ObjectId.isValid(actor.userId) ? new Types.ObjectId(actor.userId) : null,
          proposed_by_agent_id: actor.role === 'agent' ? new Types.ObjectId(actor.agentId) : null,
          payment_method: order.payment_method,
          currency: order.currency,
          fee_before: currentFee,
          proposed_fee: input.proposedFee,
          reason: input.reason,
          status: 'pending',
          status_history: [
            {
              status: 'pending',
              changed_at: now,
              changed_by_role: actor.role,
              changed_by_user_id: Types.ObjectId.isValid(actor.userId) ? new Types.ObjectId(actor.userId) : null,
              note: null,
            },
          ],
        } as Partial<IDeliveryFeeProposal>,
        session
      );
    });

    this.emit('delivery_fee_proposal.created', created, { orderNumber: (order as any).order_number ?? null });
    return toDeliveryFeeProposalDto(created, this.viewerOf(actor));
  }

  // ── Withdraw ───────────────────────────────────────────────────────────────

  async withdraw(actor: ProposerActor, shipmentId: string, proposalId: string): Promise<DeliveryFeeProposalDto> {
    await this.loadScopedShipment(actor, shipmentId);
    const proposal = await this.proposals.findById(proposalId);
    if (!proposal || proposal.shipment_id.toString() !== shipmentId) {
      throw createAppError(ERROR_CODES.DELIVERY_FEE_PROPOSAL_NOT_FOUND, 404);
    }
    const allowed = resolveAvailableActions(
      {
        status: proposal.status,
        proposed_by_role: proposal.proposed_by_role,
        proposed_by_agent_id: proposal.proposed_by_agent_id ? proposal.proposed_by_agent_id.toString() : null,
        agency_edited: !!proposal.agency_edited,
      },
      this.viewerOf(actor)
    );
    if (proposal.status !== 'pending') {
      throw createAppError(ERROR_CODES.DELIVERY_FEE_PROPOSAL_NOT_PENDING, 409, undefined, { status: proposal.status });
    }
    if (!allowed.includes('withdraw')) throw createAppError(ERROR_CODES.DELIVERY_FEE_PROPOSAL_NOT_YOURS, 403);

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
    const allowed = resolveAvailableActions(
      {
        status: proposal.status,
        proposed_by_role: proposal.proposed_by_role,
        proposed_by_agent_id: proposal.proposed_by_agent_id ? proposal.proposed_by_agent_id.toString() : null,
        agency_edited: !!proposal.agency_edited,
      },
      { ...this.viewerOf(actor), agentsMayPropose }
    );
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
    if (!DELIVERY_FEE_PROPOSAL_WINDOW.includes(shipment.status)) {
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
    if (newFee !== proposal.proposed_fee) {
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
    return toDeliveryFeeProposalDto(updated, { ...this.viewerOf(actor), agentsMayPropose });
  }

  // ── Vendor: approve / reject ───────────────────────────────────────────────

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
      if (!updated) throw await this.vendorAnswerMiss(proposalId);
      return updated;
    });

    this.emit('delivery_fee_proposal.approved', approved, { orderNumber: (order as any).order_number ?? null });
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
      if (!updated) throw await this.vendorAnswerMiss(proposalId);
      await this.proposals.releasePendingPointer(updated.shipment_id, updated._id as Types.ObjectId, session);
      return updated;
    });

    this.emit('delivery_fee_proposal.rejected', rejected, { orderNumber: (order as any).order_number ?? null });
    return toDeliveryFeeProposalDto(rejected, { role: 'vendor' });
  }

  // ── Lifecycle hooks (called by ShipmentService, inside ITS transaction) ─────

  /**
   * Close a shipment's pending proposal because the shipment itself moved on — the agency
   * declined it (`shipment_declined`), or the proposing agent was detached
   * (`agent_detached`, only when `onlyProposedByAgentId` matches). Recorded as a `system`
   * withdrawal so the trail says why. A no-op when nothing is pending.
   */
  async withdrawPendingInSession(
    shipment: Pick<IShipment, '_id' | 'pending_delivery_fee_proposal_id'>,
    reason: 'shipment_declined' | 'agent_detached',
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

  // ── Internals ──────────────────────────────────────────────────────────────

  /** A proposal applies only while its shipment is in the window — and, if an agent raised
   *  it, while that agent is still the one on the shipment. */
  private assertStillApplies(proposal: IDeliveryFeeProposal, shipment: IShipment): void {
    if (!shipment.pending_delivery_fee_proposal_id || !shipment.pending_delivery_fee_proposal_id.equals(proposal._id as Types.ObjectId)) {
      throw createAppError(ERROR_CODES.DELIVERY_FEE_PROPOSAL_NOT_PENDING, 409, undefined, { status: proposal.status });
    }
    if (!DELIVERY_FEE_PROPOSAL_WINDOW.includes(shipment.status)) {
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

  /** Explain a missed vendor CAS: answered meanwhile (NOT_PENDING) or edited (VERSION_MISMATCH). */
  private async vendorAnswerMiss(proposalId: string) {
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

  /** What the shipment is charged today: the snapshot if charged, else the (override-aware)
   *  formula — the same resolution the agent's quote uses. */
  private async effectiveFee(shipment: IShipment, order: IOrder, policies: IAgencyPolicies | null): Promise<number> {
    if (typeof shipment.delivery_fee_snapshot === 'number') return shipment.delivery_fee_snapshot;
    return this.quotes.computeShipmentDeliveryFee(shipment, policies, this.itemsById(order), order._id.toString());
  }

  /**
   * The vendor's net on the split's unit if THIS shipment carried `fee`:
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
          : this.quotes.computeShipmentDeliveryFee(s, policyByAgency.get(s.agency_id.toString()) ?? null, itemsById, order._id.toString());
    }
    return prepaidOrderVendorNet({
      orderGross: order.total_amount,
      aiMargin: computeOrderAiMargin(order.items.map(bargainLineOf)),
      commissionPercent,
      otherShipmentsFees: others,
      fee,
    });
  }

  /**
   * Post-commit, fire-and-forget, in-process only. Nothing subscribes today — the hook is
   * published so notifications can be wired as a catalog job (see the FRONTEND-CHANGELOG).
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
          proposedByRole: proposal.proposed_by_role,
          proposedByAgentId: proposal.proposed_by_agent_id ? proposal.proposed_by_agent_id.toString() : null,
          feeBefore: proposal.fee_before,
          proposedFee: proposal.proposed_fee,
          currency: proposal.currency,
          status: proposal.status,
          ...extra,
        },
      })
      .catch((err) => console.error(`[DeliveryFeeProposalService] ${eventType} emit failed:`, err));
  }
}

export const deliveryFeeProposalService = new DeliveryFeeProposalService();
