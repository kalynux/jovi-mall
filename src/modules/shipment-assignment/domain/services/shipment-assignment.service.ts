import { Types } from 'mongoose';
import { createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import { eventBus } from '../../../../core/events/event-bus';
import { transactionManager } from '../../../../core/database/transaction.manager';
import { PaginationOptions, Page } from '../../../../core/repositories/base.repository';

import { ShipmentRepository } from '../../../shipments/shipment.repository';
import { ShipmentService } from '../../../shipments/shipment.service';
import { IShipment, ShipmentStatus, IShipmentHandoverPickup } from '../../../shipments/shipment.model';
import { HandoverPickupService, handoverPickupService, HandoverPickupOverride } from './handover-pickup.service';
import { OrderModel, IOrder } from '../../../orders/order.model';
import {
  AgentRepository,
  agentRepository,
  AgentEligibilityService,
  agentEligibilityService,
  AgentContractService,
  agentContractService,
  AgentCapacityService,
  agentCapacityService,
  AgentAvailabilityService,
  agentAvailabilityService,
  IDeliveryAgent,
} from '../../../agents';
import { CashCollectionService, cashCollectionService } from '../../../cod/services/cash-collection.service';
import { CodExposureService, codExposureService } from '../../../cod/services/cod-exposure.service';
import { ICashCollection } from '../../../cod/models/cash-collection.model';

import {
  ShipmentAssignmentOfferRepository,
  shipmentAssignmentOfferRepository,
} from '../../repositories/shipment-assignment-offer.repository';
import {
  IShipmentAssignmentOffer,
  IOfferCandidate,
  OfferStatus,
} from '../../models/shipment-assignment-offer.model';
import { ASSIGNMENT_CONFIG } from '../../config/assignment.config';
import { AssignmentCandidateService, assignmentCandidateService, ScoredCandidate } from './assignment-candidate.service';
import { agentAssignmentAuditService } from '../../services/assignment-audit.service';

/** Who is placing an offer. `system` for auto-assignment, `agency` for a manual pick. */
export interface OfferCreator {
  role: 'agency' | 'system';
  userId: string | null;
}

/**
 * A shipment can be offered/accepted while it sits with the agency: `assigned`
 * (the normal case) or `handing_over` (a post-pickup reassignment awaiting its
 * replacement agent). Both carry a null `agent_id` at offer time.
 */
const OFFERABLE_STATUSES: ShipmentStatus[] = ['assigned', 'handing_over'];

/** Statuses a shipment can be reassigned FROM (it still has a bound agent). */
const REASSIGNABLE_STATUSES: ShipmentStatus[] = ['assigned', 'picked_up', 'in_transit', 'failed', 'returned'];

/**
 * Reassignable statuses where the parcel has already left the agency with the
 * old agent (or come back to the agency after a failed/returned attempt). These
 * are MANUAL-only (no auto-reassignment of an in-flight/returned parcel) and
 * reset the shipment to `handing_over` rather than `assigned`.
 */
const POST_PICKUP_REASSIGN_STATUSES: ShipmentStatus[] = ['picked_up', 'in_transit', 'failed', 'returned'];

export interface OfferResult {
  offer: ReturnType<ShipmentAssignmentService['toOfferSummary']>;
  shipment: ReturnType<ShipmentAssignmentService['toShipmentSummary']>;
  autoAccepted: boolean;
}

/**
 * ShipmentAssignmentService — the agent-acceptance state machine.
 *
 * Replaces the old direct push (ShipmentService.assignAgent wrote agent_id and
 * issued the COD code with no agent consent). Now every placement — manual pick
 * OR auto-assignment — creates an OFFER the agent must accept; the shipment only
 * gains an `agent_id` on acceptance, which is the moment it becomes trackable
 * and (for COD) the delivery code is issued.
 *
 *   offerToAgent / autoAssign → pending offer (expires_at = now + timeout)
 *   accept  → agent bound, tracking opens, COD code issued  (the critical txn)
 *   reject  → offer rejected; auto ⇒ next candidate, else back to agency queue
 *   expire  → offer expired (the "Ignore" branch); same advance/release as reject
 *   cancel  → agency withdrew, or a reassignment superseded the shipment
 *
 * Notifications and the spatial audit are decoupled: this service publishes
 * domain events (`shipment.offer_*`, `shipment.no_agent_available`) that the
 * notification consumers and the agent-action audit react to. It never blocks a
 * delivery: geo-tracker/notifications are off the critical path.
 */
export class ShipmentAssignmentService {
  constructor(
    private readonly offers: ShipmentAssignmentOfferRepository = shipmentAssignmentOfferRepository,
    private readonly shipments: ShipmentRepository = new ShipmentRepository(),
    private readonly agents: AgentRepository = agentRepository,
    private readonly eligibility: AgentEligibilityService = agentEligibilityService,
    private readonly contracts: AgentContractService = agentContractService,
    private readonly capacity: AgentCapacityService = agentCapacityService,
    private readonly availability: AgentAvailabilityService = agentAvailabilityService,
    private readonly cashCollection: CashCollectionService = cashCollectionService,
    private readonly exposure: CodExposureService = codExposureService,
    private readonly candidates: AssignmentCandidateService = assignmentCandidateService,
    private readonly shipmentSvc: ShipmentService = new ShipmentService(),
    private readonly handoverPickup: HandoverPickupService = handoverPickupService
  ) {}

  // ─── Placement ────────────────────────────────────────────────────────────

  /**
   * Manual placement: an agency offers a specific agent (requirement — the
   * "Agency selects an agent" branch). Validates eligibility up front so the
   * dispatcher gets an immediate answer, then creates a pending offer.
   */
  async offerToAgent(
    agencyId: string,
    shipmentId: string,
    agentId: string,
    creator: OfferCreator,
    pickupLocation: IShipmentHandoverPickup | null = null
  ): Promise<OfferResult> {
    const shipment = await this.shipments.findByIdAndAgency(shipmentId, agencyId);
    if (!shipment) throw createAppError(ERROR_CODES.SHIPMENT_NOT_FOUND, 404);

    this.assertOfferable(shipment);
    await this.assertNoLiveOffer(shipmentId);

    // Fail fast: report every eligibility blocker now rather than after the
    // agent tries to accept. The accept path re-checks — this is a convenience.
    await this.eligibility.assertEligible(agentId, agencyId);
    const agent = await this.requireAgent(agentId);
    const order = await this.requireOrder(shipment.order_id.toString());
    await this.assertCodAssignable(agent, agencyId, shipment, order);

    return await this.placeOffer(shipment, order, agent, 'manual', creator, [], 0, pickupLocation);
  }

  /**
   * Auto-assignment: compute the ranked candidate pool and offer the top agent.
   * Called by the dispatch subscriber when the agency has auto-assign enabled,
   * or on demand by the agency. The full ranked pool is snapshotted onto the
   * offer so a timeout/reject can walk to the next agent WITHOUT recomputing.
   */
  async autoAssign(shipmentId: string, creator: OfferCreator): Promise<OfferResult | null> {
    const shipment = await this.shipments.findById(shipmentId);
    if (!shipment) throw createAppError(ERROR_CODES.SHIPMENT_NOT_FOUND, 404);

    this.assertOfferable(shipment);
    await this.assertNoLiveOffer(shipmentId);

    const order = await this.requireOrder(shipment.order_id.toString());
    const pool = await this.candidates.rankCandidates(shipment, order);
    if (pool.length === 0) {
      await this.emitNoAgentAvailable(shipment, 'no_candidates');
      return null;
    }

    return await this.offerToPoolIndex(shipment, order, pool, 0, creator);
  }

  /** Offer the pool entry at `index` (creation and the timeout/reject advance share this). */
  private async offerToPoolIndex(
    shipment: IShipment,
    order: IOrder,
    pool: ScoredCandidate[],
    index: number,
    creator: OfferCreator
  ): Promise<OfferResult | null> {
    const candidate = pool[index];
    if (!candidate) {
      await this.emitNoAgentAvailable(shipment, 'pool_exhausted');
      return null;
    }

    const agent = await this.agents.findById(candidate.agentId);
    if (!agent) {
      // Candidate vanished — skip to the next without failing the whole assignment.
      return await this.offerToPoolIndex(shipment, order, pool, index + 1, creator);
    }

    return await this.placeOffer(
      shipment,
      order,
      agent,
      'auto',
      creator,
      pool.map(this.toCandidateDoc),
      index
    );
  }

  /** Shared offer write + notify + optional auto-accept. */
  private async placeOffer(
    shipment: IShipment,
    order: IOrder,
    agent: IDeliveryAgent,
    origin: 'manual' | 'auto',
    creator: OfferCreator,
    pool: IOfferCandidate[],
    poolIndex: number,
    pickupLocation: IShipmentHandoverPickup | null = null
  ): Promise<OfferResult> {
    const shipmentId = (shipment._id as Types.ObjectId).toString();
    const agentId = agent._id.toString();
    const isCod = order.payment_method === 'cash_on_delivery';
    const expectedCod = isCod ? this.cashCollection.computeExpectedAmount(order, shipment) : null;
    const chosen = pool[poolIndex] ?? null;

    let offer: IShipmentAssignmentOffer;
    try {
      offer = await this.offers.create({
        shipment_id: shipment._id as any,
        order_id: order._id as any,
        agency_id: shipment.agency_id,
        agent_id: new Types.ObjectId(agentId),
        status: 'pending',
        origin,
        created_by: {
          role: creator.role,
          user_id: creator.userId ? new Types.ObjectId(creator.userId) : null,
        },
        expires_at: new Date(Date.now() + ASSIGNMENT_CONFIG.OFFER_TIMEOUT_SECONDS * 1000),
        score: chosen?.score ?? null,
        score_breakdown: chosen?.breakdown ?? null,
        candidate_pool: pool,
        pool_index: poolIndex,
        is_cod: isCod,
        expected_cod_amount: expectedCod,
        currency: order.currency ?? null,
        pickup_location: pickupLocation,
      });
    } catch (err: any) {
      // The partial unique index (one pending offer per shipment) rejected a
      // racing second placement. Report it rather than crash.
      if (err?.code === 11000) {
        throw createAppError(ERROR_CODES.SHIPMENT_ALREADY_HAS_PENDING_OFFER, 409, undefined, { shipmentId });
      }
      throw err;
    }

    await this.shipments.markOffered(shipmentId, (offer._id as Types.ObjectId).toString(), agentId);
    this.emitOfferEvent('shipment.offer_created', offer, order);

    // An agent who opted into auto-accept is bound immediately — the offer still
    // exists as the audit record, it just resolves in the same breath.
    if (agent.settings?.auto_accept_assignments === true) {
      try {
        const accepted = await this.accept(agentId, (offer._id as Types.ObjectId).toString());
        return { ...accepted, autoAccepted: true };
      } catch (err) {
        console.error('[ShipmentAssignmentService] auto-accept failed; leaving offer pending:', err);
      }
    }

    const refreshed = (await this.shipments.findById(shipmentId)) ?? shipment;
    return { offer: this.toOfferSummary(offer), shipment: this.toShipmentSummary(refreshed), autoAccepted: false };
  }

  // ─── Agent responses ──────────────────────────────────────────────────────

  /**
   * Accept an offer — the critical path. Binds the agent, reserves capacity,
   * issues the COD code, and informs geo-tracker, all so the customer's tracking
   * goes live the instant the agent takes the job.
   */
  async accept(agentId: string, offerId: string): Promise<Omit<OfferResult, 'autoAccepted'>> {
    const offer = await this.offers.findByIdAndAgent(offerId, agentId);
    if (!offer) throw createAppError(ERROR_CODES.SHIPMENT_OFFER_NOT_FOUND, 404);

    if (offer.status !== 'pending') {
      throw createAppError(
        offer.status === 'expired' ? ERROR_CODES.SHIPMENT_OFFER_EXPIRED : ERROR_CODES.SHIPMENT_OFFER_NOT_PENDING,
        409,
        undefined,
        { status: offer.status }
      );
    }

    const now = new Date();
    if (offer.expires_at.getTime() <= now.getTime()) {
      // Beat the sweep to it: expire + advance now, then tell the agent it lapsed.
      await this.expireOffer(offer);
      throw createAppError(ERROR_CODES.SHIPMENT_OFFER_EXPIRED, 409, undefined, { expiredAt: offer.expires_at });
    }

    const agencyId = offer.agency_id.toString();
    const shipmentId = offer.shipment_id.toString();

    const shipment = await this.shipments.findById(shipmentId);
    if (!shipment) throw createAppError(ERROR_CODES.SHIPMENT_NOT_FOUND, 404);
    if (shipment.agent_id) throw createAppError(ERROR_CODES.SHIPMENT_ALREADY_HAS_AGENT, 409);
    // The shipment may have left the offerable state since the offer was placed
    // (the agency rejected it for reassignment, or an admin cascade held it).
    // `handing_over` is offerable too — a replacement agent accepting a post-pickup
    // reassignment binds exactly as an `assigned` acceptance does.
    if (!OFFERABLE_STATUSES.includes(shipment.status)) {
      throw createAppError(ERROR_CODES.SHIPMENT_NOT_OFFERABLE, 409, undefined, { status: shipment.status });
    }

    const order = await this.requireOrder(offer.order_id.toString());
    const agent = await this.requireAgent(agentId);

    // Hard re-check: the offer may have sat while the agent went offline, lost
    // tracking, or filled up. Refuse now rather than bind on stale state.
    await this.eligibility.assertEligible(agentId, agencyId);
    const isCod = order.payment_method === 'cash_on_delivery';
    if (isCod) {
      const contract = await this.contracts.requireActive(agentId, agencyId);
      const expectedAmount = this.cashCollection.computeExpectedAmount(order, shipment);
      await this.exposure.assertCanTakeCodShipment(agent, expectedAmount, contract.cod?.threshold ?? 0);
    }

    let boundShipment: IShipment | null = null;
    let issuedCode: { collection: ICashCollection; code: string | null } | null = null;

    await transactionManager.runInTransaction(async (session) => {
      // Claim the offer first (guarded compare-and-set): the double-accept and
      // accept-after-timeout guard. Null ⇒ someone/the sweep beat us.
      const claimed = await this.offers.claimForAccept(offerId, agentId, now, session);
      if (!claimed) throw createAppError(ERROR_CODES.SHIPMENT_OFFER_NOT_PENDING, 409);

      // Atomic admission control — this is where "capacity free" is actually
      // enforced. Rolls back with the transaction if anything below fails.
      const reserved = await this.capacity.tryReserve(agentId, session);
      if (!reserved) {
        throw createAppError(ERROR_CODES.AGENT_AT_CAPACITY, 422, undefined, {
          activeShipmentCount: agent.capacity?.active_shipment_count ?? 0,
          maxActiveShipments: agent.capacity?.max_active_shipments ?? 0,
        });
      }

      boundShipment = await this.shipments.assignAgent(shipmentId, agentId, session);

      if (isCod && boundShipment) {
        issuedCode = await this.cashCollection.ensureForShipmentInSession(order, boundShipment, session);
      }
    });

    // ── Post-commit, best-effort, off the critical path ─────────────────────
    const issued = issuedCode as { collection: ICashCollection; code: string | null } | null;
    if (issued?.code) {
      await this.cashCollection.notifyCodeIssued(order, issued.collection, issued.code);
    }

    // Tell geo-tracker: agent_id is now populated, so the shipment (already in a
    // trackable status) opens its tracking session and the customer can watch.
    this.emitTrackingStatusChanged(boundShipment!, order.customer_id?.toString() ?? null);

    void this.availability
      .recomputeWorkingState(agentId)
      .catch((err) => console.error('[ShipmentAssignmentService] working state recompute failed:', err));

    void agentAssignmentAuditService
      .emitOfferResponse(boundShipment!, agentId, 'accept', 'success')
      .catch((err) => console.error('[ShipmentAssignmentService] accept audit failed:', err));

    this.emitOfferEvent('shipment.offer_accepted', offer, order, { agentName: agent.name });

    return { offer: this.toOfferSummary({ ...offer.toObject(), status: 'accepted', responded_at: now } as any), shipment: this.toShipmentSummary(boundShipment!) };
  }

  /** Reject an offer (the agent declines). Advances to the next candidate (auto) or releases the shipment. */
  async reject(agentId: string, offerId: string, reason: string | null): Promise<{ offer: ReturnType<ShipmentAssignmentService['toOfferSummary']> }> {
    const offer = await this.offers.findByIdAndAgent(offerId, agentId);
    if (!offer) throw createAppError(ERROR_CODES.SHIPMENT_OFFER_NOT_FOUND, 404);
    if (offer.status !== 'pending') {
      throw createAppError(ERROR_CODES.SHIPMENT_OFFER_NOT_PENDING, 409, undefined, { status: offer.status });
    }

    const updated = await this.offers.transitionFromPending(offerId, 'rejected', { rejection_reason: reason });
    if (!updated) throw createAppError(ERROR_CODES.SHIPMENT_OFFER_NOT_PENDING, 409);

    const order = await OrderModel.findById(offer.order_id);
    this.emitOfferEvent('shipment.offer_rejected', updated, order, { reason });

    void agentAssignmentAuditService
      .emitOfferResponseById(offer.shipment_id.toString(), agentId, 'reject', 'success', reason)
      .catch((err) => console.error('[ShipmentAssignmentService] reject audit failed:', err));

    await this.advanceOrRelease(updated);
    return { offer: this.toOfferSummary(updated) };
  }

  // ─── Timeout (the "Ignore" branch) ────────────────────────────────────────

  /**
   * Expire every pending offer past its deadline, then advance/release each.
   * Driven by the expiry worker on a short interval. Returns how many expired.
   */
  async expireDueOffers(): Promise<number> {
    const due = await this.offers.findDueForExpiry(new Date(), ASSIGNMENT_CONFIG.OFFER_EXPIRY_SWEEP_BATCH);
    let expired = 0;
    for (const offer of due) {
      try {
        if (await this.expireOffer(offer)) expired++;
      } catch (err) {
        console.error(`[ShipmentAssignmentService] failed to expire offer ${offer._id}:`, err);
      }
    }
    return expired;
  }

  /** Expire one offer + advance/release. Returns false if it was already resolved. */
  private async expireOffer(offer: IShipmentAssignmentOffer): Promise<boolean> {
    const updated = await this.offers.transitionFromPending((offer._id as Types.ObjectId).toString(), 'expired');
    if (!updated) return false;

    const order = await OrderModel.findById(offer.order_id);
    this.emitOfferEvent('shipment.offer_expired', updated, order);
    await this.advanceOrRelease(updated);
    return true;
  }

  // ─── Agency withdrawal / reassignment supersede ───────────────────────────

  /** Cancel a shipment's live offer (agency withdraws, or a reassignment supersedes it). */
  async cancelActiveOffer(agencyId: string, shipmentId: string): Promise<{ cancelled: number }> {
    const shipment = await this.shipments.findByIdAndAgency(shipmentId, agencyId);
    if (!shipment) throw createAppError(ERROR_CODES.SHIPMENT_NOT_FOUND, 404);

    const pending = await this.offers.findPendingForShipment(shipmentId);
    const cancelled = await this.offers.cancelPendingForShipment(shipmentId);
    if (cancelled > 0) {
      await this.shipments.markUnassigned(shipmentId);
      if (pending) this.emitOfferEvent('shipment.offer_cancelled', pending, await OrderModel.findById(shipment.order_id));
    }
    return { cancelled };
  }

  // ─── Agent → agent reassignment ───────────────────────────────────────────

  /**
   * Reassign a shipment from its current agent to a new one — the "change agents"
   * flow, for the critical case where the bound agent picked the parcel up but
   * cannot deliver it (or, pre-pickup, simply needs replacing).
   *
   * It is deliberately guarded and two-phase:
   *   1. **Thorough pre-checks** (before touching anything): the shipment must
   *      still have a bound agent and be in a reassignable status; past pickup the
   *      caller MUST name a replacement (no auto-reassignment of an in-flight
   *      parcel); a named replacement must differ from the current agent and pass
   *      the full eligibility + COD-exposure gate up front, so a bad target fails
   *      fast and never strands the shipment.
   *   2. **Detach then re-offer**: `ShipmentService.reassignAgent` performs the
   *      guarded compare-and-set that removes the old agent (releasing their
   *      tracking session — a release, NOT a terminal — and their capacity), resets
   *      the status (`assigned` pre-pickup, `handing_over` post-pickup), and
   *      re-mirrors the order. The shipment is then offerable again, so the new
   *      offer reuses the ordinary `offerToAgent` / `autoAssign` paths. The new
   *      agent's tracking session opens only when THEY accept — so at no point are
   *      two agents tracked for one shipment.
   */
  async reassign(
    agencyId: string,
    shipmentId: string,
    input: { agentId?: string | null; reason: string; pickupLocation?: HandoverPickupOverride | null },
    creator: OfferCreator
  ): Promise<{ reassignedFrom: string; previousStatus: ShipmentStatus; pickupLocation: IShipmentHandoverPickup | null } & OfferResult> {
    const { agentId, reason, pickupLocation: override } = input;

    const shipment = await this.shipments.findByIdAndAgency(shipmentId, agencyId);
    if (!shipment) throw createAppError(ERROR_CODES.SHIPMENT_NOT_FOUND, 404);

    const currentAgentId = shipment.agent_id ? shipment.agent_id.toString() : null;
    if (!currentAgentId) {
      throw createAppError(ERROR_CODES.SHIPMENT_NOT_REASSIGNABLE, 422,
        'This shipment has no agent bound to reassign from; use assign-agent or auto-assign instead');
    }
    if (!REASSIGNABLE_STATUSES.includes(shipment.status)) {
      throw createAppError(ERROR_CODES.SHIPMENT_REASSIGNMENT_NOT_ALLOWED, 422, undefined, { status: shipment.status });
    }

    const isPostPickup = POST_PICKUP_REASSIGN_STATUSES.includes(shipment.status);
    // Past pickup the parcel is physically with the old agent (or back at the
    // agency after a failed/returned attempt) — the agency must name the
    // replacement; there is no auto-reassignment of an in-flight/returned parcel.
    if (isPostPickup && !agentId) {
      throw createAppError(ERROR_CODES.SHIPMENT_REASSIGN_REQUIRES_MANUAL_AGENT, 422,
        'A picked-up, failed or returned shipment must be reassigned to a specific agent, not auto-assigned');
    }
    if (agentId && agentId === currentAgentId) {
      throw createAppError(ERROR_CODES.SHIPMENT_REASSIGN_SAME_AGENT, 422,
        'The shipment is already assigned to this agent');
    }

    const previousStatus = shipment.status;
    const order = await this.requireOrder(shipment.order_id.toString());

    // Thorough pre-validation of the replacement BEFORE any detach.
    if (agentId) {
      await this.eligibility.assertEligible(agentId, agencyId);
      const agent = await this.requireAgent(agentId);
      await this.assertCodAssignable(agent, agencyId, shipment, order);
    }

    // Determine WHERE the replacement collects — the automatic default from the
    // shipment's status (Rules 1/2/3), or the agency's manual override (Part 3).
    // Resolved from the pre-detach state (previous agent + status still intact).
    const pickup = await this.handoverPickup.resolve({
      shipment,
      order,
      previousStatus,
      previousAgentId: currentAgentId,
      agencyId,
      override,
    });

    // Detach the old agent (guarded CAS + tracking release + capacity give-back),
    // storing the handover pickup on the shipment.
    const detach = await this.shipmentSvc.reassignAgent(agencyId, shipmentId, reason, creator.userId, pickup);

    // The old agent's active-shipment count changed — refresh their working state.
    void this.availability
      .recomputeWorkingState(detach.previousAgentId)
      .catch((err) => console.error('[ShipmentAssignmentService] reassign working-state recompute failed:', err));

    // Offer the now-offerable shipment to the replacement, carrying the pickup so
    // they see where to collect BEFORE accepting. Post-pickup is manual-only
    // (guarded above); pre-pickup may auto-assign when no agent named.
    const result = agentId
      ? await this.offerToAgent(agencyId, shipmentId, agentId, creator, pickup)
      : await this.autoAssign(shipmentId, creator);

    if (!result) {
      // Detached but nobody available — the shipment is safely back in the queue.
      throw createAppError(ERROR_CODES.SHIPMENT_NO_ELIGIBLE_AGENTS, 422,
        'The shipment was released from its agent but no replacement is available right now');
    }

    return { reassignedFrom: detach.previousAgentId, previousStatus: detach.previousStatus, pickupLocation: pickup, ...result };
  }

  // ─── The advance-or-release branch (shared by reject + expire) ─────────────

  /**
   * After an offer is rejected/expired: if it was an AUTO offer with a next
   * candidate, offer that one (the spec's "next agent in the previously computed
   * list"); otherwise return the shipment to the agency queue and tell them.
   */
  private async advanceOrRelease(offer: IShipmentAssignmentOffer): Promise<void> {
    const shipment = await this.shipments.findById(offer.shipment_id.toString());
    if (!shipment) return;
    // If something else already bound an agent or opened a new offer, stop.
    if (shipment.agent_id || (shipment.assignment?.state === 'offered')) return;

    if (offer.origin === 'auto' && offer.candidate_pool.length > 0) {
      const order = await this.requireOrder(offer.order_id.toString());
      const pool = offer.candidate_pool.map(this.toScoredCandidate);
      const result = await this.offerToPoolIndex(shipment, order, pool, offer.pool_index + 1, {
        role: 'system',
        userId: null,
      });
      if (result) return; // next candidate offered
      // pool exhausted → offerToPoolIndex already emitted no_agent_available
    } else {
      await this.emitNoAgentAvailable(shipment, offer.status === 'expired' ? 'timed_out' : 'rejected');
    }

    await this.shipments.markUnassigned(offer.shipment_id.toString());
  }

  // ─── Reads (controllers) ──────────────────────────────────────────────────

  async listForAgent(
    agentId: string,
    filters: { status?: OfferStatus } = {},
    pagination: PaginationOptions = { page: 1, limit: 20 }
  ): Promise<Page<ReturnType<ShipmentAssignmentService['toOfferSummary']>>> {
    const page = await this.offers.listForAgent(agentId, filters, pagination);
    return { data: page.data.map((o) => this.toOfferSummary(o)), meta: page.meta };
  }

  async getForAgent(agentId: string, offerId: string): Promise<ReturnType<ShipmentAssignmentService['toOfferSummary']>> {
    const offer = await this.offers.findByIdAndAgent(offerId, agentId);
    if (!offer) throw createAppError(ERROR_CODES.SHIPMENT_OFFER_NOT_FOUND, 404);
    return this.toOfferSummary(offer);
  }

  /** Preview the ranked candidates for a shipment (agency dispatch screen). */
  async previewCandidates(agencyId: string, shipmentId: string): Promise<ScoredCandidate[]> {
    const shipment = await this.shipments.findByIdAndAgency(shipmentId, agencyId);
    if (!shipment) throw createAppError(ERROR_CODES.SHIPMENT_NOT_FOUND, 404);
    const order = await this.requireOrder(shipment.order_id.toString());
    return await this.candidates.rankCandidates(shipment, order);
  }

  // ─── Guards & helpers ─────────────────────────────────────────────────────

  /** A shipment can be offered only while it's with the agency and has no agent. */
  private assertOfferable(shipment: IShipment): void {
    if (shipment.agent_id) throw createAppError(ERROR_CODES.SHIPMENT_ALREADY_HAS_AGENT, 409);
    if (!OFFERABLE_STATUSES.includes(shipment.status)) {
      throw createAppError(ERROR_CODES.SHIPMENT_NOT_OFFERABLE, 422, undefined, { status: shipment.status });
    }
  }

  private async assertNoLiveOffer(shipmentId: string): Promise<void> {
    const pending = await this.offers.findPendingForShipment(shipmentId);
    if (pending) throw createAppError(ERROR_CODES.SHIPMENT_ALREADY_HAS_PENDING_OFFER, 409);
  }

  private async assertCodAssignable(agent: IDeliveryAgent, agencyId: string, shipment: IShipment, order: IOrder): Promise<void> {
    if (order.payment_method !== 'cash_on_delivery') return;
    const contract = await this.contracts.requireActive(agent._id.toString(), agencyId);
    const expectedAmount = this.cashCollection.computeExpectedAmount(order, shipment);
    await this.exposure.assertCanTakeCodShipment(agent, expectedAmount, contract.cod?.threshold ?? 0);
  }

  private async requireAgent(agentId: string): Promise<IDeliveryAgent> {
    const agent = await this.agents.findById(agentId);
    if (!agent) throw createAppError(ERROR_CODES.AGENT_NOT_FOUND, 404);
    return agent;
  }

  private async requireOrder(orderId: string): Promise<IOrder> {
    const order = await OrderModel.findById(orderId);
    if (!order) throw createAppError(ERROR_CODES.ORDER_NOT_FOUND, 404);
    return order;
  }

  // ─── Event emission (post-commit, fire-and-forget) ────────────────────────

  private emitOfferEvent(
    type:
      | 'shipment.offer_created'
      | 'shipment.offer_accepted'
      | 'shipment.offer_rejected'
      | 'shipment.offer_expired'
      | 'shipment.offer_cancelled',
    offer: IShipmentAssignmentOffer,
    order: IOrder | null,
    extra: Record<string, any> = {}
  ): void {
    void eventBus
      .publish(type, {
        eventType: type,
        aggregateId: (offer._id as Types.ObjectId).toString(),
        occurredAt: new Date(),
        payload: {
          offerId: (offer._id as Types.ObjectId).toString(),
          shipmentId: offer.shipment_id.toString(),
          orderId: offer.order_id.toString(),
          orderNumber: order?.order_number ?? null,
          agencyId: offer.agency_id.toString(),
          agentId: offer.agent_id.toString(),
          origin: offer.origin,
          expiresAt: offer.expires_at,
          isCod: offer.is_cod,
          expectedCodAmount: offer.expected_cod_amount,
          currency: offer.currency,
          ...extra,
        },
      })
      .catch((err) => console.error(`[ShipmentAssignmentService] ${type} emit failed:`, err));
  }

  private async emitNoAgentAvailable(shipment: IShipment, reason: string): Promise<void> {
    const order = await OrderModel.findById(shipment.order_id).select('order_number').lean().exec();
    void eventBus
      .publish('shipment.no_agent_available', {
        eventType: 'shipment.no_agent_available',
        aggregateId: (shipment._id as Types.ObjectId).toString(),
        occurredAt: new Date(),
        payload: {
          shipmentId: (shipment._id as Types.ObjectId).toString(),
          orderId: shipment.order_id.toString(),
          orderNumber: (order as any)?.order_number ?? null,
          agencyId: shipment.agency_id.toString(),
          reason,
        },
      })
      .catch((err) => console.error('[ShipmentAssignmentService] no_agent_available emit failed:', err));
  }

  /** Mirror of ShipmentService._emitTrackingStatusChanged — informs geo-tracker of the bound agent. */
  private emitTrackingStatusChanged(shipment: IShipment, customerId: string | null): void {
    void eventBus
      .publish('shipment.status_changed', {
        eventType: 'shipment.status_changed',
        aggregateId: (shipment._id as Types.ObjectId).toString(),
        occurredAt: new Date(),
        payload: {
          shipmentId: (shipment._id as Types.ObjectId).toString(),
          orderId: shipment.order_id.toString(),
          agencyId: shipment.agency_id.toString(),
          agentId: shipment.agent_id ? shipment.agent_id.toString() : null,
          customerId,
          status: shipment.status,
        },
      })
      .catch((err) => console.error('[ShipmentAssignmentService] tracking emit failed:', err));
  }

  // ─── Mappers ──────────────────────────────────────────────────────────────

  private toCandidateDoc = (c: ScoredCandidate): IOfferCandidate => ({
    agent_id: new Types.ObjectId(c.agentId),
    rank: c.rank,
    score: c.score,
    breakdown: c.breakdown,
  });

  private toScoredCandidate = (c: IOfferCandidate): ScoredCandidate => ({
    agentId: c.agent_id.toString(),
    rank: c.rank,
    score: c.score,
    breakdown: c.breakdown as any,
  });

  toOfferSummary(offer: IShipmentAssignmentOffer) {
    return {
      id: (offer._id as Types.ObjectId).toString(),
      shipmentId: offer.shipment_id.toString(),
      orderId: offer.order_id.toString(),
      agencyId: offer.agency_id.toString(),
      agentId: offer.agent_id.toString(),
      status: offer.status,
      origin: offer.origin,
      expiresAt: offer.expires_at,
      respondedAt: offer.responded_at ?? null,
      rejectionReason: offer.rejection_reason ?? null,
      isCod: offer.is_cod,
      expectedCodAmount: offer.expected_cod_amount ?? null,
      currency: offer.currency ?? null,
      // Where to collect, for a reassignment offer (null on a first-assignment
      // offer — the agent uses the order's per-item pickup locations instead).
      pickupLocation: offer.pickup_location ?? null,
      score: offer.score ?? null,
      createdAt: offer.created_at,
    };
  }

  toShipmentSummary(shipment: IShipment) {
    return {
      id: (shipment._id as Types.ObjectId).toString(),
      orderId: shipment.order_id.toString(),
      agencyId: shipment.agency_id.toString(),
      agentId: shipment.agent_id ? shipment.agent_id.toString() : null,
      status: shipment.status,
      assignmentState: shipment.assignment?.state ?? 'unassigned',
    };
  }
}

export const shipmentAssignmentService = new ShipmentAssignmentService();
