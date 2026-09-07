import { Types } from 'mongoose';
import { createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import { eventBus } from '../../../../core/events/event-bus';
import { transactionManager } from '../../../../core/database/transaction.manager';
import { PaginationOptions, Page } from '../../../../core/repositories/base.repository';

import { ShipmentRepository } from '../../../shipments/shipment.repository';
import { ShipmentService } from '../../../shipments/shipment.service';
import { IShipment, ShipmentStatus, IShipmentHandoverPickup, AgentCancellationReason } from '../../../shipments/shipment.model';
import { HandoverPickupService, handoverPickupService } from './handover-pickup.service';
import { OrderModel, IOrder } from '../../../orders/order.model';
import { CustomerModel } from '../../../customers/customer.model';
import { AddressDetail, fromHandoverPickup } from '../../../../core/read-models/address-detail.resolver';
import { EarningsQuoteService, earningsQuoteService } from '../../../earnings/services/earnings-quote.service';
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
import { ICashCollection } from '../../../cod/models/cash-collection.model';
import { ContractPolicyService, contractPolicyService } from './contract-policy.service';

import {
  ShipmentAssignmentOfferRepository,
  shipmentAssignmentOfferRepository,
} from '../../repositories/shipment-assignment-offer.repository';
import {
  ShipmentAssignmentSessionRepository,
  shipmentAssignmentSessionRepository,
} from '../../repositories/shipment-assignment-session.repository';
import { IShipmentAssignmentOffer, OfferStatus } from '../../models/shipment-assignment-offer.model';
import { IShipmentAssignmentSession, ISessionCandidate } from '../../models/shipment-assignment-session.model';
import { ASSIGNMENT_CONFIG } from '../../config/assignment.config';
import { AssignmentCandidateService, assignmentCandidateService, RankedCandidate } from './assignment-candidate.service';
import { agentAssignmentAuditService } from '../../services/assignment-audit.service';
import { trackingOutboxEmitter } from '../../../tracking-integration/services/tracking-outbox.emitter';

/**
 * Who is placing an offer. `system` for auto-assignment, `agency` for a manual pick,
 * `admin` for a platform intervention through `/api/internal/admin/shipments`.
 */
export interface OfferCreator {
  role: 'agency' | 'system' | 'admin';
  userId: string | null;
  /**
   * The actor's display name, snapshotted.
   *
   * Load-bearing only when `role` is `admin`: that id is a wi-admin `admin_accounts._id`
   * and resolves in NO collection here, so this snapshot is the only record of who acted
   * there will ever be. See `core/types/actor-source.types.ts` — `role` is itself the
   * identity-space discriminator, which is why no `_source` field sits beside it.
   */
  name?: string | null;
}

/**
 * The customer's first name — what a pending offer shows instead of their full
 * identity. Enough for an agent to recognise the job on their list; not enough
 * to identify the person to anyone who ends up declining.
 */
export function firstNameOf(name: string | null | undefined): string | null {
  if (!name) return null;
  return name.trim().split(/\s+/)[0] ?? null;
}

/**
 * Coarsen a drop-off address for a pending offer: keep the city, the region and
 * the coordinates — everything needed to judge distance and decide — and drop
 * the street line that identifies the household.
 */
export function redactAddress(address: AddressDetail | null, revealed: boolean): AddressDetail | null {
  if (!address || revealed) return address;
  return {
    ...address,
    label: null,
    addressLine1: null,
    addressLine2: null,
    formattedAddress: [address.city, address.state, address.country].filter(Boolean).join(', ') || null,
  };
}

/** A shipment can be offered/accepted while it sits with the agency. */
const OFFERABLE_STATUSES: ShipmentStatus[] = ['assigned', 'handing_over'];

/** Statuses a shipment can be reassigned FROM (it still has a bound agent). */
const REASSIGNABLE_STATUSES: ShipmentStatus[] = ['assigned', 'picked_up', 'in_transit', 'failed', 'returned'];

/** Reassignable statuses where the parcel already left with the old agent (manual-only). */
const POST_PICKUP_REASSIGN_STATUSES: ShipmentStatus[] = ['picked_up', 'in_transit', 'failed', 'returned'];

/** Statuses an assigned agent may cancel their own shipment from (mid-delivery). */
const AGENT_CANCELLABLE_STATUSES: ShipmentStatus[] = ['assigned', 'handing_over', 'picked_up', 'in_transit', 'failed'];

/** Of those, the ones where a handover collection point must be resolved (parcel is with the agent). */
const AGENT_CANCEL_POST_PICKUP_STATUSES: ShipmentStatus[] = ['handing_over', 'picked_up', 'in_transit', 'failed'];

export interface OfferResult {
  offer: ReturnType<ShipmentAssignmentService['toOfferSummary']>;
  shipment: ReturnType<ShipmentAssignmentService['toShipmentSummary']>;
  autoAccepted: boolean;
}

/**
 * ShipmentAssignmentService — the agent-acceptance state machine, now driven by a
 * temporary per-shipment RANKING SESSION for auto-assignment.
 *
 *   offerToAgent (manual) → a single one-shot offer the agent accepts/declines.
 *   autoAssign            → build the ranking (nearest-first via the Geo Provider),
 *                           persist it as a session, and offer the first candidate.
 *   [broadcast]           → the session sweep walks the ranking one candidate per
 *                           2-min window, across up to two rounds; a timed-out
 *                           (ignored) agent KEEPS an acceptable offer; a reject
 *                           advances immediately. After round 2 the agency is told.
 *   accept                → the critical txn: a shipment-level bind CAS makes
 *                           "first valid approval wins"; capacity + COD ride it.
 *   reject                → decline; auto advances to the next candidate.
 *   cancelByAgent         → the assigned agent walks away mid-delivery; the agent
 *                           is released and the broadcast RESUMES from its cursor.
 *
 * The session is disposed of only when the shipment finishes (terminal / permanent
 * cancel) — see the session-cleanup subscriber — so a reassignment can still resume.
 */
export class ShipmentAssignmentService {
  constructor(
    private readonly offers: ShipmentAssignmentOfferRepository = shipmentAssignmentOfferRepository,
    private readonly sessions: ShipmentAssignmentSessionRepository = shipmentAssignmentSessionRepository,
    private readonly shipments: ShipmentRepository = new ShipmentRepository(),
    private readonly agents: AgentRepository = agentRepository,
    private readonly eligibility: AgentEligibilityService = agentEligibilityService,
    private readonly contracts: AgentContractService = agentContractService,
    private readonly capacity: AgentCapacityService = agentCapacityService,
    private readonly availability: AgentAvailabilityService = agentAvailabilityService,
    private readonly cashCollection: CashCollectionService = cashCollectionService,
    private readonly contractPolicy: ContractPolicyService = contractPolicyService,
    private readonly candidates: AssignmentCandidateService = assignmentCandidateService,
    private readonly shipmentSvc: ShipmentService = new ShipmentService(),
    private readonly handoverPickup: HandoverPickupService = handoverPickupService,
    private readonly earningsQuotes: EarningsQuoteService = earningsQuoteService
  ) {}

  // ─── Manual placement ───────────────────────────────────────────────────────

  /** Manual placement: an agency offers a specific agent (one-shot, no session). */
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
    await this.assertNoLiveOfferForAgent(shipmentId, agentId);

    await this.eligibility.assertEligible(agentId, agencyId);
    const agent = await this.requireAgent(agentId);
    const order = await this.requireOrder(shipment.order_id.toString());
    await this.assertContractPolicy(agent, agencyId, shipment, order);

    return await this.placeManualOffer(shipment, order, agent, creator, pickupLocation);
  }

  // ─── Auto-assignment ────────────────────────────────────────────────────────

  /**
   * Build the ranked candidate pool (nearest-first via the Geo Provider), persist
   * it as a temporary session, and offer the first candidate. `expectedAgencyId`,
   * when given, scopes the shipment to a caller's agency (404 otherwise).
   */
  async autoAssign(
    shipmentId: string,
    creator: OfferCreator,
    expectedAgencyId?: string
  ): Promise<OfferResult | null> {
    const shipment = await this.shipments.findById(shipmentId);
    if (!shipment) throw createAppError(ERROR_CODES.SHIPMENT_NOT_FOUND, 404);
    if (expectedAgencyId && shipment.agency_id.toString() !== expectedAgencyId) {
      throw createAppError(ERROR_CODES.SHIPMENT_NOT_FOUND, 404);
    }

    this.assertOfferable(shipment);

    const order = await this.requireOrder(shipment.order_id.toString());
    const ranking = await this.candidates.buildRanking(shipment, order);
    if (ranking.candidates.length === 0) {
      await this.emitNoAgentAvailable(shipment, 'no_candidates');
      return null;
    }

    // A fresh auto-assignment replaces any prior ranking (e.g. an agency reassign).
    await this.sessions.deleteForShipment(shipmentId);

    const isCod = order.payment_method === 'cash_on_delivery';
    const session = await this.sessions.create({
      shipment_id: shipment._id as Types.ObjectId,
      order_id: order._id as Types.ObjectId,
      agency_id: shipment.agency_id,
      status: 'active',
      ranking_source: ranking.source,
      ranking: ranking.candidates.map((c) => this.toSessionCandidate(c)),
      cursor: 0,
      round: 1,
      renudge_index: 0,
      is_cod: isCod,
      expected_cod_amount: isCod ? this.cashCollection.computeExpectedAmount(order, shipment) : null,
      currency: order.currency ?? null,
      assigned_agent_id: null,
      frontier_at: null,
    });

    // Kick off: offer the top candidate now and arm the frontier for the next.
    // Walk past any top candidates that vanished/became ineligible since ranking,
    // so the first real offer goes out immediately rather than after a full window.
    const sessionId = (session._id as Types.ObjectId).toString();
    let result = await this.stepSession(session, order, shipment);
    let guard = session.ranking.length;
    while (!result && guard-- > 0) {
      const fresh = await this.sessions.findById(sessionId);
      if (!fresh || fresh.status !== 'active') break;
      result = await this.stepSession(fresh, order, shipment);
    }
    // `result` may be null if EVERY candidate vanished — the session is still
    // active and the sweep will keep trying, but there is nothing to hand back now.
    return result;
  }

  // ─── The broadcast step (sweep + reject + kickoff share this) ────────────────

  /**
   * Advance ONE session by one unit of work, multi-instance-safely. Every state
   * change is a guarded compare-and-set on the exact (status, round, cursor,
   * renudge_index, frontier_at) read here, so two server instances sweeping at
   * once cannot both advance the same session. Returns the OfferResult when this
   * step placed a fresh offer (used by the kickoff), else null.
   */
  private async stepSession(
    session: IShipmentAssignmentSession,
    order?: IOrder,
    shipmentArg?: IShipment
  ): Promise<OfferResult | null> {
    const shipmentId = session.shipment_id.toString();
    const sessionId = (session._id as Types.ObjectId).toString();
    const shipment = shipmentArg ?? (await this.shipments.findById(shipmentId));
    if (!shipment) {
      await this.sessions.deleteForShipment(shipmentId);
      return null;
    }
    // Someone already bound an agent — stop broadcasting and record it.
    if (shipment.agent_id) {
      await this.sessions.markAssigned(sessionId, shipment.agent_id.toString());
      return null;
    }
    const now = new Date();
    const expected = {
      status: session.status,
      round: session.round,
      cursor: session.cursor,
      renudge_index: session.renudge_index,
      frontier_at: session.frontier_at,
    };
    // The shipment temporarily left the offerable state (an agency reject/cascade).
    // Back off one window rather than busy-loop; the cleanup subscriber closes it
    // on a terminal outcome.
    if (!OFFERABLE_STATUSES.includes(shipment.status)) {
      await this.sessions.advanceState(sessionId, expected, { frontier_at: this.nextFrontier(now) });
      return null;
    }

    const len = session.ranking.length;
    const maxRounds = Math.max(1, ASSIGNMENT_CONFIG.MAX_ROUNDS);

    if (session.round === 1 && session.cursor < len) {
      // Round 1: offer the candidate at the cursor, then arm the next frontier.
      const claimed = await this.sessions.advanceState(sessionId, expected, {
        cursor: session.cursor + 1,
        frontier_at: this.nextFrontier(now),
      });
      if (!claimed) return null; // another instance advanced first
      const ord = order ?? (await this.requireOrder(session.order_id.toString()));
      return await this.offerSessionCandidate(claimed, session.ranking[session.cursor], shipment, ord);
    }

    if (session.round === 1) {
      // Round 1 exhausted the ranking. Start round 2 (re-nudge) or give up.
      if (maxRounds >= 2) {
        await this.sessions.advanceState(sessionId, expected, {
          round: 2,
          renudge_index: 0,
          frontier_at: this.nextFrontier(now),
        });
      } else {
        await this.exhaust(session, expected, shipment);
      }
      return null;
    }

    // Round >= 2: re-nudge the still-standing (ignored) offers.
    if (session.renudge_index < len) {
      const claimed = await this.sessions.advanceState(sessionId, expected, {
        renudge_index: session.renudge_index + 1,
        frontier_at: this.nextFrontier(now),
      });
      if (!claimed) return null;
      await this.renudgeSessionCandidate(claimed, session.ranking[session.renudge_index], shipment);
      return null;
    }

    // Round finished. Another re-nudge round, or exhausted.
    if (session.round < maxRounds) {
      await this.sessions.advanceState(sessionId, expected, {
        round: session.round + 1,
        renudge_index: 0,
        frontier_at: this.nextFrontier(now),
      });
    } else {
      await this.exhaust(session, expected, shipment);
    }
    return null;
  }

  /** Give up after the last round: mark exhausted and tell the agency. */
  private async exhaust(
    session: IShipmentAssignmentSession,
    expected: Parameters<ShipmentAssignmentSessionRepository['advanceState']>[1],
    shipment: IShipment
  ): Promise<void> {
    const claimed = await this.sessions.advanceState((session._id as Types.ObjectId).toString(), expected, {
      status: 'exhausted',
      frontier_at: null,
    });
    if (claimed) await this.emitNoAgentAvailable(shipment, 'timed_out');
  }

  /**
   * Offer the given candidate the shipment. Best-effort: an agent who vanished or
   * became ineligible since ranking is skipped (the broadcast simply moves on),
   * and an agent who already holds a standing offer is not offered twice.
   */
  private async offerSessionCandidate(
    session: IShipmentAssignmentSession,
    candidate: ISessionCandidate,
    shipment: IShipment,
    order: IOrder
  ): Promise<OfferResult | null> {
    const agentId = candidate.agent_id.toString();
    const shipmentId = shipment._id.toString();

    const agent = await this.agents.findById(agentId);
    if (!agent) return null; // candidate vanished

    // Stale-ranking guard: re-validate eligibility at OFFER time, not just at rank.
    const elig = await this.eligibility.evaluate(agentId, session.agency_id.toString());
    if (!elig.eligible) return null;

    // Never place two standing offers on the same agent for the same shipment.
    const existing = await this.offers.findPendingForShipmentAndAgent(shipmentId, agentId);
    if (existing) return null;

    const offer = await this.offers.create({
      shipment_id: shipment._id as Types.ObjectId,
      order_id: session.order_id,
      agency_id: session.agency_id,
      agent_id: new Types.ObjectId(agentId),
      status: 'pending',
      origin: 'auto',
      session_id: session._id as Types.ObjectId,
      round: session.round,
      created_by: { role: 'system', user_id: null },
      expires_at: this.nextFrontier(new Date()),
      score: candidate.score,
      score_breakdown: candidate.breakdown,
      candidate_pool: [],
      pool_index: 0,
      is_cod: session.is_cod,
      expected_cod_amount: session.expected_cod_amount,
      currency: session.currency,
      pickup_location: shipment.handover?.pickup ?? null,
    });

    await this.shipments.markOffered(shipmentId, (offer._id as Types.ObjectId).toString(), agentId);
    this.emitOfferEvent('shipment.offer_created', offer, order);

    // Auto-accept agents resolve in the same breath (the offer row remains as audit).
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

  /** Round-2 nudge: re-notify a still-standing (ignored) offer; skip rejected ones. */
  private async renudgeSessionCandidate(
    session: IShipmentAssignmentSession,
    candidate: ISessionCandidate,
    shipment: IShipment
  ): Promise<void> {
    const agentId = candidate.agent_id.toString();
    const offer = await this.offers.findPendingForShipmentAndAgent(shipment._id.toString(), agentId);
    if (!offer) return; // rejected / superseded / never offered — nothing to remind
    const order = await OrderModel.findById(offer.order_id).select('order_number').lean().exec();
    this.emitOfferReminder(offer, session.round, (order as any)?.order_number ?? null);
  }

  /** Drain due sessions — the auto-assignment sweep's entry point. Returns count advanced. */
  async advanceDueSessions(): Promise<number> {
    const due = await this.sessions.findDueForAdvance(new Date(), ASSIGNMENT_CONFIG.OFFER_EXPIRY_SWEEP_BATCH);
    let advanced = 0;
    for (const session of due) {
      try {
        await this.stepSession(session);
        advanced++;
      } catch (err) {
        console.error(`[ShipmentAssignmentService] failed to advance session ${session._id}:`, err);
      }
    }
    return advanced;
  }

  // ─── Accept (the critical path) ─────────────────────────────────────────────

  async accept(agentId: string, offerId: string): Promise<Omit<OfferResult, 'autoAccepted'>> {
    const offer = await this.offers.findByIdAndAgent(offerId, agentId);
    if (!offer) throw createAppError(ERROR_CODES.SHIPMENT_OFFER_NOT_FOUND, 404);

    if (offer.status !== 'pending') {
      // superseded/cancelled ⇒ someone else won or it was withdrawn; expired ⇒ a
      // lapsed MANUAL offer; otherwise already responded.
      const code =
        offer.status === 'superseded' || offer.status === 'cancelled'
          ? ERROR_CODES.SHIPMENT_ALREADY_HAS_AGENT
          : offer.status === 'expired'
            ? ERROR_CODES.SHIPMENT_OFFER_EXPIRED
            : ERROR_CODES.SHIPMENT_OFFER_NOT_PENDING;
      throw createAppError(code, 409, undefined, { status: offer.status });
    }

    const agencyId = offer.agency_id.toString();
    const shipmentId = offer.shipment_id.toString();

    const shipment = await this.shipments.findById(shipmentId);
    if (!shipment) throw createAppError(ERROR_CODES.SHIPMENT_NOT_FOUND, 404);

    // Already taken by another agent — the requirement's STEP 7 answer. Retire my
    // now-stale standing offer so my app stops showing an accept button.
    if (shipment.agent_id) {
      void this.offers.transitionFromPending(offerId, 'superseded').catch(() => undefined);
      throw createAppError(ERROR_CODES.SHIPMENT_ALREADY_HAS_AGENT, 409, 'Another agent has already accepted this shipment');
    }
    if (!OFFERABLE_STATUSES.includes(shipment.status)) {
      void this.offers.transitionFromPending(offerId, 'superseded').catch(() => undefined);
      throw createAppError(ERROR_CODES.SHIPMENT_NOT_OFFERABLE, 409, undefined, { status: shipment.status });
    }

    const order = await this.requireOrder(offer.order_id.toString());
    const agent = await this.requireAgent(agentId);

    // Hard re-check: the offer may have sat while the agent went offline, filled
    // up, or had their contract terms renegotiated under it.
    await this.eligibility.assertEligible(agentId, agencyId);
    await this.assertContractPolicy(agent, agencyId, shipment, order);
    const isCod = order.payment_method === 'cash_on_delivery';

    let boundShipment: IShipment | null = null;
    let issuedCode: { collection: ICashCollection; code: string | null } | null = null;

    // withRetry: two agents accepting the SAME shipment at the same instant produce
    // a write-conflict on the shipment doc; the driver retries the loser, which then
    // re-reads the bound state and gets the honest "already assigned" answer.
    await transactionManager.runInTransactionWithRetry(async (session) => {
      const claimed = await this.offers.claimForAccept(offerId, agentId, session);
      if (!claimed) throw createAppError(ERROR_CODES.SHIPMENT_OFFER_NOT_PENDING, 409);

      // THE serialisation point — only one concurrent accept matches `agent_id: null`.
      const bound = await this.shipments.bindAgentIfUnassigned(shipmentId, agentId, OFFERABLE_STATUSES, session);
      if (!bound) throw createAppError(ERROR_CODES.SHIPMENT_ALREADY_HAS_AGENT, 409, 'Another agent has already accepted this shipment');

      const reserved = await this.capacity.tryReserve(agentId, session);
      if (!reserved) {
        throw createAppError(ERROR_CODES.AGENT_AT_CAPACITY, 422, undefined, {
          activeShipmentCount: agent.capacity?.active_shipment_count ?? 0,
          maxActiveShipments: agent.capacity?.max_active_shipments ?? 0,
        });
      }

      boundShipment = bound;
      if (isCod) {
        issuedCode = await this.cashCollection.ensureForShipmentInSession(order, bound, session);
      }
      if (offer.session_id) {
        await this.sessions.markAssigned(offer.session_id.toString(), agentId, session);
      }

      /**
       * ── THE SESSION-OPENING EVENT, AND IT IS THE MOST IMPORTANT ONE (plan step 3.A.1) ──
       *
       * This is the moment `agent_id` is bound, so this is the row that makes geo-tracker
       * OPEN the shipment's tracking session. Lose it and the agent streams while nobody can
       * watch — X-1's cost table, row `shipmentTrackable: true` — and it self-heals only on
       * the next event for that shipment, which on a clean delivery may be the terminal one.
       *
       * It belongs in this transaction for the same reason as the eight sites in
       * `ShipmentService` and `CashCollectionService`, and `...WithRetry` is already the
       * right primitive here: `bindAgentIfUnassigned` is the serialisation point, so a losing
       * concurrent accept aborts and takes its outbox row with it.
       */
      await trackingOutboxEmitter.emitShipmentStatusChanged({
        shipmentId,
        agentId,
        agencyId: bound.agency_id.toString(),
        customerId: order.customer_id?.toString() ?? null,
        status: bound.status,
      }, session);
    });

    // ── Post-commit, best-effort, off the critical path ─────────────────────
    const issued = issuedCode as { collection: ICashCollection; code: string | null } | null;
    if (issued?.code) {
      await this.cashCollection.notifyCodeIssued(order, issued.collection, issued.code);
    }
    this.emitTrackingStatusChanged(boundShipment!, order.customer_id?.toString() ?? null);
    void this.availability
      .recomputeWorkingState(agentId)
      .catch((err) => console.error('[ShipmentAssignmentService] working state recompute failed:', err));
    void agentAssignmentAuditService
      .emitOfferResponse(boundShipment!, agentId, 'accept', 'success')
      .catch((err) => console.error('[ShipmentAssignmentService] accept audit failed:', err));
    this.emitOfferEvent('shipment.offer_accepted', offer, order, { agentName: agent.name });

    // Retire every OTHER standing offer now that this agent won (STEP 7 losers).
    void this.offers
      .supersedeOtherPendingForShipment(shipmentId, offerId)
      .catch((err) => console.error('[ShipmentAssignmentService] supersede losers failed:', err));

    return {
      offer: this.toOfferSummary({ ...offer.toObject(), status: 'accepted', responded_at: new Date() } as any),
      shipment: this.toShipmentSummary(boundShipment!),
    };
  }

  // ─── Reject ─────────────────────────────────────────────────────────────────

  async reject(
    agentId: string,
    offerId: string,
    reason: string | null
  ): Promise<{ offer: ReturnType<ShipmentAssignmentService['toOfferSummary']> }> {
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

    if (updated.session_id) {
      // Auto: remove this agent (their offer is now `rejected`) and offer the next
      // candidate IMMEDIATELY, rather than waiting for the frontier tick.
      const session = await this.sessions.findById(updated.session_id.toString());
      if (session && session.status === 'active') await this.stepSession(session);
    } else {
      // Manual: no ranking to walk — back to the agency queue.
      await this.releaseManualOffer(updated);
    }

    return { offer: this.toOfferSummary(updated) };
  }

  // ─── Manual-offer timeout (the sweep's other half) ──────────────────────────

  /** Expire every due MANUAL offer past its deadline. Auto offers never expire here. */
  async expireDueOffers(): Promise<number> {
    const due = await this.offers.findDueForExpiry(new Date(), ASSIGNMENT_CONFIG.OFFER_EXPIRY_SWEEP_BATCH);
    let expired = 0;
    for (const offer of due) {
      try {
        const updated = await this.offers.transitionFromPending((offer._id as Types.ObjectId).toString(), 'expired');
        if (!updated) continue;
        const order = await OrderModel.findById(offer.order_id);
        this.emitOfferEvent('shipment.offer_expired', updated, order);
        await this.releaseManualOffer(updated);
        expired++;
      } catch (err) {
        console.error(`[ShipmentAssignmentService] failed to expire offer ${offer._id}:`, err);
      }
    }
    return expired;
  }

  /** A manual offer lapsed/declined and there is no ranking — return to the queue. */
  private async releaseManualOffer(offer: IShipmentAssignmentOffer): Promise<void> {
    const shipment = await this.shipments.findById(offer.shipment_id.toString());
    if (!shipment) return;
    if (shipment.agent_id || shipment.assignment?.state === 'offered') return;
    await this.emitNoAgentAvailable(shipment, offer.status === 'expired' ? 'timed_out' : 'rejected');
    await this.shipments.markUnassigned(offer.shipment_id.toString());
  }

  // ─── Agency withdrawal ──────────────────────────────────────────────────────

  /** Withdraw a shipment's live offers AND dispose of its ranking (agency action). */
  async cancelActiveOffer(agencyId: string, shipmentId: string): Promise<{ cancelled: number }> {
    const shipment = await this.shipments.findByIdAndAgency(shipmentId, agencyId);
    if (!shipment) throw createAppError(ERROR_CODES.SHIPMENT_NOT_FOUND, 404);

    const pending = await this.offers.findPendingForShipment(shipmentId);
    const cancelled = await this.offers.cancelPendingForShipment(shipmentId);
    await this.sessions.deleteForShipment(shipmentId);
    if (cancelled > 0) {
      await this.shipments.markUnassigned(shipmentId);
      if (pending) this.emitOfferEvent('shipment.offer_cancelled', pending, await OrderModel.findById(shipment.order_id));
    }
    return { cancelled };
  }

  // ─── Agent-initiated cancellation + resume (STEP 8 / STEP 10) ───────────────

  /**
   * The assigned agent cancels mid-delivery. Releases the agent (capacity +
   * tracking), records the reason, then RESUMES the auto-assignment broadcast from
   * its stored cursor — never from the top.
   */
  async cancelByAgent(
    agentId: string,
    shipmentId: string,
    input: { reason: AgentCancellationReason; note: string | null }
  ): Promise<{
    shipmentId: string;
    previousStatus: ShipmentStatus;
    reason: AgentCancellationReason;
    resumed: boolean;
    shipment: ReturnType<ShipmentAssignmentService['toShipmentSummary']>;
  }> {
    const shipment = await this.shipments.findByIdAndAgent(shipmentId, agentId);
    if (!shipment) throw createAppError(ERROR_CODES.SHIPMENT_NOT_FOUND, 404);
    if (!AGENT_CANCELLABLE_STATUSES.includes(shipment.status)) {
      throw createAppError(ERROR_CODES.SHIPMENT_CANCEL_NOT_ALLOWED, 422, undefined, { status: shipment.status });
    }

    const order = await this.requireOrder(shipment.order_id.toString());

    // Where a replacement collects, for a post-pickup cancellation. Best-effort:
    // if it cannot be resolved, the replacement falls back to the order's pickup.
    let pickup: IShipmentHandoverPickup | null = null;
    if (AGENT_CANCEL_POST_PICKUP_STATUSES.includes(shipment.status)) {
      try {
        pickup = await this.handoverPickup.resolve({
          shipment,
          order,
          previousStatus: shipment.status,
          previousAgentId: agentId,
          agencyId: shipment.agency_id.toString(),
          override: null,
        });
      } catch (err) {
        console.error('[ShipmentAssignmentService] cancel handover resolve failed; using no pickup:', err);
      }
    }

    const { shipment: released, previousStatus } = await this.shipmentSvc.releaseForAgentCancel(
      agentId,
      shipmentId,
      input.reason,
      input.note,
      pickup
    );

    void this.availability
      .recomputeWorkingState(agentId)
      .catch((err) => console.error('[ShipmentAssignmentService] cancel working-state recompute failed:', err));

    // Resume the broadcast from the cursor (if this shipment had an auto session).
    const resumedSession = await this.sessions.resumeForShipment(shipmentId, new Date());
    if (resumedSession) await this.stepSession(resumedSession, order, released);

    return {
      shipmentId,
      previousStatus,
      reason: input.reason,
      resumed: !!resumedSession,
      shipment: this.toShipmentSummary(released),
    };
  }

  // ─── Agent → agent reassignment (agency action) ─────────────────────────────

  async reassign(
    agencyId: string,
    shipmentId: string,
    input: { agentId?: string | null; reason: string; pickupLocation?: Parameters<HandoverPickupService['resolve']>[0]['override'] },
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
    if (isPostPickup && !agentId) {
      throw createAppError(ERROR_CODES.SHIPMENT_REASSIGN_REQUIRES_MANUAL_AGENT, 422,
        'A picked-up, failed or returned shipment must be reassigned to a specific agent, not auto-assigned');
    }
    if (agentId && agentId === currentAgentId) {
      throw createAppError(ERROR_CODES.SHIPMENT_REASSIGN_SAME_AGENT, 422, 'The shipment is already assigned to this agent');
    }

    const previousStatus = shipment.status;
    const order = await this.requireOrder(shipment.order_id.toString());

    if (agentId) {
      await this.eligibility.assertEligible(agentId, agencyId);
      const agent = await this.requireAgent(agentId);
      await this.assertContractPolicy(agent, agencyId, shipment, order);
    }

    const pickup = await this.handoverPickup.resolve({
      shipment,
      order,
      previousStatus,
      previousAgentId: currentAgentId,
      agencyId,
      override,
    });

    const detach = await this.shipmentSvc.reassignAgent(
      agencyId, shipmentId, reason, { userId: creator.userId, role: creator.role }, pickup
    );

    // A deliberate re-pick disposes of any prior auto-assignment ranking.
    await this.sessions.deleteForShipment(shipmentId);

    void this.availability
      .recomputeWorkingState(detach.previousAgentId)
      .catch((err) => console.error('[ShipmentAssignmentService] reassign working-state recompute failed:', err));

    const result = agentId
      ? await this.offerToAgent(agencyId, shipmentId, agentId, creator, pickup)
      : await this.autoAssign(shipmentId, creator);

    if (!result) {
      throw createAppError(ERROR_CODES.SHIPMENT_NO_ELIGIBLE_AGENTS, 422,
        'The shipment was released from its agent but no replacement is available right now');
    }

    return { reassignedFrom: detach.previousAgentId, previousStatus: detach.previousStatus, pickupLocation: pickup, ...result };
  }

  // ─── Session lifecycle (called by the terminal-status subscriber) ───────────

  /** Dispose of a shipment's ranking — completed or permanently cancelled (STEP 9). */
  async disposeSessionForShipment(shipmentId: string): Promise<number> {
    return await this.sessions.deleteForShipment(shipmentId);
  }

  // ─── Reads (controllers) ────────────────────────────────────────────────────

  async listForAgent(
    agentId: string,
    filters: { status?: OfferStatus; q?: string } = {},
    pagination: PaginationOptions = { page: 1, limit: 20 }
  ): Promise<Page<any>> {
    // Text search reaches offers through the shipments it matches, so searching
    // offers means exactly what searching the shipment list means.
    const shipmentIds = filters.q ? await this.shipments.findIdsMatchingSearch(filters.q) : undefined;
    if (shipmentIds && shipmentIds.length === 0) {
      return { data: [], meta: { total: 0, page: pagination.page, limit: pagination.limit, pages: 0 } };
    }

    const page = await this.offers.listForAgent(
      agentId,
      { status: filters.status, shipmentIds },
      pagination
    );
    return { data: await this._enrichOffers(page.data, agentId), meta: page.meta };
  }

  async getForAgent(agentId: string, offerId: string): Promise<any> {
    const offer = await this.offers.findByIdAndAgent(offerId, agentId);
    if (!offer) throw createAppError(ERROR_CODES.SHIPMENT_OFFER_NOT_FOUND, 404);
    const [enriched] = await this._enrichOffers([offer], agentId);
    return enriched;
  }

  /**
   * Turn bare offer rows into something an agent can actually decide on.
   *
   * The raw offer carries ids and money only — no order number, no customer, no
   * products, no addresses — while the shipment those describe is unreadable to
   * the agent until they accept (`findByIdAndAgent` is scoped on `agent_id`,
   * which is still null). So accepting or declining was a blind choice; this is
   * what makes it an informed one.
   *
   * Customer PII is gated on the offer having been accepted — see
   * `ASSIGNMENT_CONFIG.OFFER_PII_REVEAL` for why that is the default.
   */
  private async _enrichOffers(offers: IShipmentAssignmentOffer[], agentId: string): Promise<any[]> {
    if (offers.length === 0) return [];

    const shipmentIds = [...new Set(offers.map((o) => o.shipment_id.toString()))];
    const orderIds = [...new Set(offers.map((o) => o.order_id.toString()))];

    const [shipments, orders] = await Promise.all([
      this.shipments.findManyByIds(shipmentIds),
      OrderModel.find({ _id: { $in: orderIds } })
        .select('order_number vendor_id customer_id items delivery_address payment_method total_amount currency')
        .lean()
        .exec() as Promise<any[]>,
    ]);

    const shipmentById = new Map(shipments.map((s) => [(s._id as Types.ObjectId).toString(), s]));
    const orderById = new Map(orders.map((o) => [o._id.toString(), o]));

    const customerIds = [...new Set(orders.map((o) => o.customer_id.toString()))];
    const [customers, earningByShipment, listContext] = await Promise.all([
      CustomerModel.find({ _id: { $in: customerIds } }).select('name phone').lean().exec() as Promise<any[]>,
      this.earningsQuotes.quoteForShipments(shipments, orderById as any, agentId),
      this.shipmentSvc.buildShipmentContext(shipments, orderById),
    ]);
    const customerById = new Map(customers.map((c) => [c._id.toString(), c]));

    return offers.map((offer) => {
      const summary = this.toOfferSummary(offer);
      const shipment = shipmentById.get(offer.shipment_id.toString());
      const order = orderById.get(offer.order_id.toString());
      const customer = order ? customerById.get(order.customer_id.toString()) : null;
      const context = shipment ? listContext.get((shipment._id as Types.ObjectId).toString()) : null;
      const earning = shipment ? earningByShipment.get((shipment._id as Types.ObjectId).toString()) : null;

      // An accepted offer means the shipment is this agent's; anything earlier
      // is still a proposal that may go to someone else.
      const revealed =
        ASSIGNMENT_CONFIG.OFFER_PII_REVEAL === 'on_offer' || offer.status === 'accepted';

      return {
        ...summary,
        orderNumber: order?.order_number ?? null,
        shipmentStatus: shipment?.status ?? null,
        itemCount: shipment?.items.length ?? 0,
        items: context?.items ?? [],
        // The agency behind the offer — name, logo, support contacts. NOT gated
        // on acceptance: it is the agent's own contracted counterparty, not the
        // customer's identity, and "who is asking?" is half the decision.
        agency: context?.agency ?? null,
        vendor: context?.vendor ?? null,
        customer: customer
          ? {
              // First name only until accepted — enough to recognise the job.
              name: revealed ? customer.name : firstNameOf(customer.name),
              phone: revealed ? (customer.phone ?? null) : null,
              redacted: !revealed,
            }
          : null,
        // The offer's own pickup_location (set on a reassignment handover) is
        // authoritative; otherwise the shipment's resolved pickup.
        pickup: offer.pickup_location
          ? { address: fromHandoverPickup(offer.pickup_location), mode: 'pickup_based' as const, count: 1 }
          : (context?.pickup ?? null),
        deliveryAddress: redactAddress(context?.deliveryAddress ?? null, revealed),
        orderValue: order ? { total: order.total_amount ?? null, currency: order.currency ?? null } : null,
        earning: earning?.earning ?? null,
        earningUnavailable: earning?.earningUnavailable ?? null,
      };
    });
  }

  /** Preview the ranked candidates for a shipment (agency dispatch screen). */
  async previewCandidates(agencyId: string, shipmentId: string): Promise<RankedCandidate[]> {
    const shipment = await this.shipments.findByIdAndAgency(shipmentId, agencyId);
    if (!shipment) throw createAppError(ERROR_CODES.SHIPMENT_NOT_FOUND, 404);
    const order = await this.requireOrder(shipment.order_id.toString());
    const ranking = await this.candidates.buildRanking(shipment, order);
    return ranking.candidates;
  }

  // ─── Guards & helpers ───────────────────────────────────────────────────────

  private placeManualOffer = async (
    shipment: IShipment,
    order: IOrder,
    agent: IDeliveryAgent,
    creator: OfferCreator,
    pickupLocation: IShipmentHandoverPickup | null
  ): Promise<OfferResult> => {
    const shipmentId = (shipment._id as Types.ObjectId).toString();
    const agentId = agent._id.toString();
    const isCod = order.payment_method === 'cash_on_delivery';
    const expectedCod = isCod ? this.cashCollection.computeExpectedAmount(order, shipment) : null;

    const offer = await this.offers.create({
      shipment_id: shipment._id as Types.ObjectId,
      order_id: order._id as Types.ObjectId,
      agency_id: shipment.agency_id,
      agent_id: new Types.ObjectId(agentId),
      status: 'pending',
      origin: 'manual',
      session_id: null,
      round: 0,
      created_by: {
        role: creator.role,
        user_id: creator.userId ? new Types.ObjectId(creator.userId) : null,
        name: creator.name ?? null,
      },
      expires_at: this.nextFrontier(new Date()),
      score: null,
      score_breakdown: null,
      candidate_pool: [],
      pool_index: 0,
      is_cod: isCod,
      expected_cod_amount: expectedCod,
      currency: order.currency ?? null,
      pickup_location: pickupLocation,
    });

    await this.shipments.markOffered(shipmentId, (offer._id as Types.ObjectId).toString(), agentId);
    this.emitOfferEvent('shipment.offer_created', offer, order);

    if (agent.settings?.auto_accept_assignments === true) {
      try {
        const accepted = await this.accept(agentId, (offer._id as Types.ObjectId).toString());
        return { ...accepted, autoAccepted: true };
      } catch (err) {
        console.error('[ShipmentAssignmentService] manual auto-accept failed; leaving offer pending:', err);
      }
    }

    const refreshed = (await this.shipments.findById(shipmentId)) ?? shipment;
    return { offer: this.toOfferSummary(offer), shipment: this.toShipmentSummary(refreshed), autoAccepted: false };
  };

  private assertOfferable(shipment: IShipment): void {
    if (shipment.agent_id) throw createAppError(ERROR_CODES.SHIPMENT_ALREADY_HAS_AGENT, 409);
    if (!OFFERABLE_STATUSES.includes(shipment.status)) {
      throw createAppError(ERROR_CODES.SHIPMENT_NOT_OFFERABLE, 422, undefined, { status: shipment.status });
    }
  }

  private async assertNoLiveOfferForAgent(shipmentId: string, agentId: string): Promise<void> {
    const pending = await this.offers.findPendingForShipmentAndAgent(shipmentId, agentId);
    if (pending) throw createAppError(ERROR_CODES.SHIPMENT_ALREADY_HAS_PENDING_OFFER, 409);
  }

  /**
   * Every contract-term gate on giving THIS shipment to THIS agent.
   *
   * Generalised from the old `assertCodAssignable`, which only ever ran for COD
   * and so could load the contract inside its own payment-method check. Two of
   * the three terms here apply to prepaid shipments as well, so the contract is
   * loaded unconditionally and the COD half keeps its own guard.
   *
   * Called from all THREE command paths — `offerToAgent` (the agency's manual
   * assign), `accept`, and `reassign` with a named agent. Gating only the auto
   * ranking would let a manual assign quietly bypass the terms the auto path
   * enforces, which is worse than not enforcing them at all: the rule would
   * appear to work.
   *
   * ── The rules moved; this is now a one-line delegation ──────────────────────
   *
   * They live in `ContractPolicyService`, which evaluates them without throwing
   * and lets `assert` throw the first failure. That extraction was made so the
   * admin assignability diagnostic could report EVERY gate and every number
   * without a second implementation of any rule — see that service's header for
   * why a drifted diagnostic is worse than none. Behaviour here is unchanged:
   * same order (contract, coverage, value, cash), same codes, same `details`.
   */
  private async assertContractPolicy(
    agent: IDeliveryAgent,
    agencyId: string,
    shipment: IShipment,
    order: IOrder
  ): Promise<void> {
    await this.contractPolicy.assert(agent, agencyId, shipment, order);
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

  private nextFrontier(now: Date): Date {
    return new Date(now.getTime() + ASSIGNMENT_CONFIG.OFFER_TIMEOUT_SECONDS * 1000);
  }

  private toSessionCandidate(c: RankedCandidate): ISessionCandidate {
    return {
      agent_id: new Types.ObjectId(c.agentId),
      rank: c.rank,
      distance_m: c.distanceMeters,
      duration_s: c.durationSeconds,
      score: c.score,
      breakdown: c.breakdown,
    };
  }

  // ─── Event emission (post-commit, fire-and-forget) ──────────────────────────

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

  /** Round-2 re-nudge of a still-standing offer — a fresh push, keyed per round. */
  private emitOfferReminder(offer: IShipmentAssignmentOffer, round: number, orderNumber: string | null): void {
    void eventBus
      .publish('shipment.offer_reminder', {
        eventType: 'shipment.offer_reminder',
        aggregateId: (offer._id as Types.ObjectId).toString(),
        occurredAt: new Date(),
        payload: {
          offerId: (offer._id as Types.ObjectId).toString(),
          shipmentId: offer.shipment_id.toString(),
          orderId: offer.order_id.toString(),
          orderNumber,
          agencyId: offer.agency_id.toString(),
          agentId: offer.agent_id.toString(),
          round,
        },
      })
      .catch((err) => console.error('[ShipmentAssignmentService] offer_reminder emit failed:', err));
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

  /**
   * ⚠ BUS-ONLY. This no longer feeds geo-tracker — the outbox row for an accepted offer is
   * written inside `accept`'s transaction (plan step 3.A.1). The method keeps its name and its
   * publish because two in-process consumers need the event: the customer notification stack
   * and `assignment-event-subscriber.ts`.
   *
   * Do not re-add a tracking consumer here. If a new status-changing path is added to this
   * service, it needs its own `trackingOutboxEmitter` call inside its own transaction —
   * publishing this event is not enough and has not been since step 3.A.1b.
   */
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

  // ─── Mappers ────────────────────────────────────────────────────────────────

  toOfferSummary(offer: IShipmentAssignmentOffer) {
    return {
      id: (offer._id as Types.ObjectId).toString(),
      shipmentId: offer.shipment_id.toString(),
      orderId: offer.order_id.toString(),
      agencyId: offer.agency_id.toString(),
      agentId: offer.agent_id.toString(),
      status: offer.status,
      origin: offer.origin,
      round: offer.round ?? 0,
      expiresAt: offer.expires_at,
      respondedAt: offer.responded_at ?? null,
      rejectionReason: offer.rejection_reason ?? null,
      isCod: offer.is_cod,
      expectedCodAmount: offer.expected_cod_amount ?? null,
      currency: offer.currency ?? null,
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
