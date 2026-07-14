import { Types } from 'mongoose';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { CodTrustEventModel, CodTrustEventType, ICodTrustEvent } from '../models/cod-trust-event.model';
import { DeliveryAgentModel, IDeliveryAgent } from '../../delivery/delivery-agent.model';

/**
 * CodTrustService - the agent trust score: a 0–100 signal of how safely an
 * agent handles cash. The current value is denormalized on
 * `DeliveryAgent.cod.trust_score`; every movement appends a CodTrustEvent.
 *
 * Score effects live in CodExposureService (limit tiers / COD block).
 */
export class CodTrustService {
  /**
   * Apply a signed score movement, clamped to [0, 100], and append the audit
   * event. Returns the new score.
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
      throw createAppError(ERROR_CODES.DELIVERY_AGENT_NOT_FOUND, 404);
    }

    const current = agent.cod?.trust_score ?? 100;
    const scoreAfter = Math.max(0, Math.min(100, current + delta));

    await DeliveryAgentModel.updateOne(
      { _id: agentId },
      { $set: { 'cod.trust_score': scoreAfter } }
    );

    const event = await CodTrustEventModel.create({
      agent_id: agentId,
      agency_id: agent.agency_id ?? null,
      event_type: eventType,
      delta: scoreAfter - current, // effective (post-clamp) movement
      score_after: scoreAfter,
      ref_type: refType ?? null,
      ref_id: refId ? new Types.ObjectId(refId) : null,
      note: note ?? null,
    });

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

  static scoreOf(agent: IDeliveryAgent): number {
    return agent.cod?.trust_score ?? 100;
  }
}

export const codTrustService = new CodTrustService();
