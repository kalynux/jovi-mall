import { Types } from 'mongoose';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { CodTrustEventModel, CodTrustEventType, ICodTrustEvent } from '../models/cod-trust-event.model';
import { DeliveryAgentModel, IDeliveryAgent, agentMembershipRepository } from '../../agents';
import { agentRepository } from '../../agents/repositories/agent.repository';
import { agentTrustRecomputeWorker } from '../../agents/workers/agent-trust-recompute.worker';
import { RoleActorRef, actorStamp } from '../../../core/types/actor-source.types';

/**
 * CodTrustService - the agent trust score: a 0–100 signal of how safely an
 * agent handles cash. The current value is denormalized on
 * `DeliveryAgent.cod.trust_score`; every movement appends a CodTrustEvent.
 *
 * Trust is platform-wide rather than per-agency: the agent holds one physical
 * pot of cash whoever dispatched it, so a shortfall is a fact about the person.
 * The trust EVENT still records an agency for context (which relationship the
 * movement arose under) — under multi-agency that is the agent's primary
 * agency, since the event itself has no dispatching agency in scope.
 *
 * Score effects live in CodExposureService (limit tiers / COD block).
 */
export class CodTrustService {
  /**
   * Pin, or release, the administrator's persistent trust override (O-7).
   *
   * ⚠ **This does NOT write `cod.trust_score`.** That is the whole point: the
   * computed score keeps moving underneath, so releasing the override reveals
   * what the platform actually thinks today rather than whatever it thought on
   * the day somebody pinned it. See `resolveEffectiveTrustScore`.
   *
   * A `CodTrustEvent` is still appended, because the append-only log is the audit
   * trail for everything that changes an agent's cash standing and an override
   * changes it more decisively than any delta. Its `delta` is recorded as **0** —
   * the computed score genuinely did not move — with the pinned value and the
   * reason in the note. A reader reconstructing the score history from deltas
   * alone would otherwise see no reason why an agent's exposure changed.
   */
  async setOverride(params: {
    agentId: string;
    /** `null` releases the override and returns the agent to the computed score. */
    score: number | null;
    reason: string;
    actor: RoleActorRef;
  }): Promise<IDeliveryAgent> {
    const { agentId, score, reason, actor } = params;

    const agent = await DeliveryAgentModel.findById(agentId);
    if (!agent) throw createAppError(ERROR_CODES.AGENT_NOT_FOUND, 404);

    if (score !== null && (!Number.isInteger(score) || score < 0 || score > 100)) {
      throw createAppError(ERROR_CODES.AGENT_TRUST_OVERRIDE_OUT_OF_BOUNDS, 422, undefined, {
        requested: score,
        min: 0,
        max: 100,
      });
    }

    const previous = agent.cod?.trust_override ?? null;

    const updated = await agentRepository.setTrustOverride(
      agentId,
      score === null
        ? null
        : {
            score,
            reason,
            set_at: new Date(),
            ...(actorStamp('set_by', actor) as Pick<
              NonNullable<IDeliveryAgent['cod']['trust_override']>,
              'set_by_user_id' | 'set_by_source' | 'set_by_name'
            >),
          },
    );
    if (!updated) throw createAppError(ERROR_CODES.AGENT_NOT_FOUND, 404);

    const primary = await agentMembershipRepository.findPrimary(agentId);
    await CodTrustEventModel.create({
      agent_id: agentId,
      agency_id: primary?.agency_id ?? null,
      event_type: 'admin_adjustment',
      // Zero, and truthfully so: the COMPUTED score did not move. The override is
      // a separate axis, and recording a fictional delta here would corrupt the
      // one log that reconstructs how the computed score got where it is.
      delta: 0,
      score_after: agent.cod?.trust_score ?? 100,
      ref_type: 'admin',
      ref_id: null,
      note: score === null
        ? `Trust override RELEASED (was ${previous?.score ?? 'none'}). ${reason}`
        : `Trust override SET to ${score}. ${reason}`,
    });

    return updated;
  }

  /**
   * Apply a signed score movement, clamped to [0, 100], and append the audit
   * event. Returns the new score.
   *
   * ⚠ This moves the COMPUTED score and says nothing about an override. An agent
   * with one pinned still accumulates deltas here — that is deliberate, so that
   * releasing the override reveals what the platform thinks TODAY rather than
   * what it thought on the day it was pinned.
   */
  async applyEvent(params: {
    agentId: string;
    eventType: CodTrustEventType;
    delta: number;
    refType?: 'cod_discrepancy' | 'admin' | null;
    refId?: string | null;
    note?: string | null;
  }): Promise<{ scoreAfter: number; event: ICodTrustEvent }> {
    const { agentId, eventType, delta, refType, refId, note } = params;

    const agent = await DeliveryAgentModel.findById(agentId);
    if (!agent) {
      throw createAppError(ERROR_CODES.AGENT_NOT_FOUND, 404);
    }

    const current = agent.cod?.trust_score ?? 100;
    const scoreAfter = Math.max(0, Math.min(100, current + delta));

    await DeliveryAgentModel.updateOne(
      { _id: agentId },
      { $set: { 'cod.trust_score': scoreAfter } }
    );

    // Context only: an agent may serve several agencies, so attribute the event
    // to their primary one. null when they currently serve none.
    const primary = await agentMembershipRepository.findPrimary(agentId);

    const event = await CodTrustEventModel.create({
      agent_id: agentId,
      agency_id: primary?.agency_id ?? null,
      event_type: eventType,
      delta: scoreAfter - current, // effective (post-clamp) movement
      score_after: scoreAfter,
      ref_type: refType ?? null,
      ref_id: refId ? new Types.ObjectId(refId) : null,
      note: note ?? null,
    });

    /**
     * Refresh the SHADOW composite for this agent immediately (Phase 6 D-2).
     *
     * This is the choke point every COD trust movement passes through, which is
     * why the call is here rather than at the two discrepancy sites — a third
     * caller added later inherits it.
     *
     * It closes the safety regression `AGENT-CONTRACT-REFACTOR.md` flagged to the
     * product owner and left unresolved: recompute is nightly by decision, so a
     * cash shortfall would not throttle an agent's limit until 03:00, where the
     * delta model above throttles it instantly. When the composite becomes the
     * live score (Step 11) this call is what keeps that property.
     *
     * Fire-and-forget on purpose. A trust recompute must never fail the COD write
     * that triggered it, and the nightly sweep is the backstop; `recomputeOne`
     * catches its own errors and the `void` is here to say so at the call site.
     */
    void agentTrustRecomputeWorker.recomputeOne(agentId);

    return { scoreAfter, event };
  }

  /** Current score with the append-only history (agent/agency/admin views). */
  async getHistory(agentId: string, page: number, limit: number) {
    const filter = { agent_id: agentId };
    const [total, docs] = await Promise.all([
      CodTrustEventModel.countDocuments(filter).exec(),
      CodTrustEventModel.find(filter)
        .sort({ created_at: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
    ]);
    return {
      data: docs.map((e) => ({
        id: e._id.toString(),
        eventType: e.event_type,
        delta: e.delta,
        scoreAfter: e.score_after,
        note: e.note,
        createdAt: e.created_at,
      })),
      meta: { total, page, limit, pages: Math.ceil(total / limit) },
    };
  }

  /**
   * The COMPUTED score. ⚠ Not the effective one — an administrator's override is
   * not consulted here. It has no callers today; if it acquires one that makes a
   * DECISION, that caller wants `effectiveTrustScore()` instead.
   */
  static scoreOf(agent: IDeliveryAgent): number {
    return agent.cod?.trust_score ?? 100;
  }
}

export const codTrustService = new CodTrustService();
