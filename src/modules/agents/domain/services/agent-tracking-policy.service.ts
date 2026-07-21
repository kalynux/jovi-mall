import { createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import { AgentRepository, agentRepository } from '../../repositories/agent.repository';
import {
  AgentContractRepository,
  agentContractRepository,
} from '../../repositories/agent-contract.repository';
import { IDeliveryAgent, IAgentLastKnownTrackingState, AgentTrackingStateStatus } from '../../models/agent.model';
import { AGENT_CONFIG } from '../../config/agent.config';
import { IGeoPoint } from '../../../../core/types/geo.types';
import { eventBus } from '../../../../core/events/event-bus';

/**
 * The answer geo-tracker needs before streaming an agent's position.
 *
 * Deliberately NOT just a boolean: geo-tracker has to tell an operator WHY a
 * stream was refused, and "tracking is off" versus "this agent is suspended"
 * are different conversations.
 */
export interface AgentTrackingPolicy {
  agentId: string;
  /** The single verdict geo-tracker enforces. */
  trackingAllowed: boolean;
  /** Stable machine-readable cause when trackingAllowed is false. */
  denyReason: 'tracking_disabled' | 'agent_not_active' | 'agent_not_found' | 'no_approved_agency' | null;
  /** Human-supplied note from whoever flipped the flag. */
  note: string | null;
  agentStatus: string | null;
  approvedAgencyIds: string[];
  /** Lets geo-tracker cache with a TTL of its choosing without guessing. */
  evaluatedAt: Date;
}

/**
 * AgentTrackingPolicyService — jovi-mall's half of the tracking split.
 *
 * The division of responsibility, stated once so it is not eroded later:
 *
 *   jovi-mall  owns whether tracking is ALLOWED (this service, the business flag)
 *   geo-tracker owns tracking EXECUTION (connections, positions, fan-out)
 *
 * geo-tracker must never decide policy, and this service must never attempt to
 * stream, store positions, or reason about liveness. `last_known_tracking_state`
 * is a business-reference mirror, not a position store — reading it to answer
 * "where is this agent?" is a bug, and the field's staleness is the tell.
 */
export class AgentTrackingPolicyService {
  constructor(
    private readonly agents: AgentRepository = agentRepository,
    private readonly memberships: AgentContractRepository = agentContractRepository
  ) {}

  // ─── Policy resolution (consumed by geo-tracker) ──────────────────────────

  async resolve(agentId: string): Promise<AgentTrackingPolicy> {
    const agent = await this.agents.findById(agentId);
    if (!agent) {
      return {
        agentId,
        trackingAllowed: false,
        denyReason: 'agent_not_found',
        note: null,
        agentStatus: null,
        approvedAgencyIds: [],
        evaluatedAt: new Date(),
      };
    }
    const approvedAgencyIds = await this.memberships.listActiveAgencyIds(agentId);
    return this.buildPolicy(agent, approvedAgencyIds);
  }

  /** Batch form — geo-tracker resolves whole watch-sets at once. */
  async resolveMany(agentIds: string[]): Promise<AgentTrackingPolicy[]> {
    const unique = [...new Set(agentIds)];
    const agents = await this.agents.findManyByIds(unique);
    const byId = new Map(agents.map((a) => [a._id.toString(), a]));

    return await Promise.all(
      unique.map(async (id) => {
        const agent = byId.get(id);
        if (!agent) {
          return {
            agentId: id,
            trackingAllowed: false,
            denyReason: 'agent_not_found' as const,
            note: null,
            agentStatus: null,
            approvedAgencyIds: [],
            evaluatedAt: new Date(),
          };
        }
        const approvedAgencyIds = await this.memberships.listActiveAgencyIds(id);
        return this.buildPolicy(agent, approvedAgencyIds);
      })
    );
  }

  /**
   * Pure policy derivation — no I/O, so the rule itself is unit-testable.
   *
   * Order matters only for which reason is reported; any single failure denies.
   * An agent with no approved agency is denied because tracking exists to serve
   * a delivery relationship — nobody is entitled to watch an unaffiliated
   * person move around.
   */
  buildPolicy(agent: IDeliveryAgent, approvedAgencyIds: string[]): AgentTrackingPolicy {
    const base = {
      agentId: agent._id.toString(),
      note: agent.tracking?.reason ?? null,
      agentStatus: agent.status,
      approvedAgencyIds,
      evaluatedAt: new Date(),
    };

    if (agent.tracking?.allowed !== true) {
      return { ...base, trackingAllowed: false, denyReason: 'tracking_disabled' };
    }
    if (agent.status !== 'active') {
      return { ...base, trackingAllowed: false, denyReason: 'agent_not_active' };
    }
    if (approvedAgencyIds.length === 0) {
      return { ...base, trackingAllowed: false, denyReason: 'no_approved_agency' };
    }
    return { ...base, trackingAllowed: true, denyReason: null };
  }

  // ─── Flag management (admin / agency) ─────────────────────────────────────

  /**
   * Flip the tracking flag. Emits a business event so the integration layer can
   * push the change to geo-tracker rather than wait for a cache to expire —
   * revoking tracking is time-critical in exactly the way granting it is not.
   */
  async setTrackingAllowed(
    agentId: string,
    allowed: boolean,
    reason: string | null,
    actor: { userId: string | null; role: string }
  ): Promise<IDeliveryAgent> {
    const agent = await this.agents.findById(agentId);
    if (!agent) throw createAppError(ERROR_CODES.AGENT_NOT_FOUND, 404);

    const previous = agent.tracking?.allowed ?? null;
    const updated = await this.agents.setTrackingAllowed(agentId, allowed, reason, {
      userId: actor.userId,
      role: actor.role,
    });
    if (!updated) throw createAppError(ERROR_CODES.AGENT_NOT_FOUND, 404);

    if (previous !== allowed) {
      void eventBus
        .publish('agent.tracking_allow_changed', {
          eventType: 'agent.tracking_allow_changed',
          aggregateId: agentId,
          occurredAt: new Date(),
          payload: { agentId, from: previous, to: allowed, reason, actorRole: actor.role },
        })
        .catch((err) => console.error('[AgentTrackingPolicyService] tracking emit failed:', err));
    }

    return updated;
  }

  async requireTrackingAllowed(agentId: string): Promise<AgentTrackingPolicy> {
    const policy = await this.resolve(agentId);
    if (!policy.trackingAllowed) {
      throw createAppError(ERROR_CODES.AGENT_TRACKING_NOT_ALLOWED, 422, undefined, {
        agentId,
        denyReason: policy.denyReason,
      });
    }
    return policy;
  }

  // ─── Last-known tracking state (written by geo-tracker) ───────────────────

  /**
   * Record what geo-tracker last observed. Business reference ONLY.
   *
   * jovi-mall must never serve this as a live position, and no assignment rule
   * reads it: it is stale by construction and geo-tracker is the source of
   * truth. It exists so operational screens can say "last seen 3 minutes ago"
   * without a synchronous cross-service call, and so the information survives a
   * geo-tracker outage.
   */
  async recordTrackingState(
    agentId: string,
    input: {
      status: AgentTrackingStateStatus;
      position?: IGeoPoint | null;
      reportedAt?: Date | null;
      source?: string;
    }
  ): Promise<IDeliveryAgent> {
    const agent = await this.agents.findById(agentId);
    if (!agent) throw createAppError(ERROR_CODES.AGENT_NOT_FOUND, 404);

    const state: Partial<IAgentLastKnownTrackingState> = {
      status: input.status,
      source: input.source ?? 'geo_tracker',
      last_reported_at: input.reportedAt ?? new Date(),
    };
    if (input.position !== undefined) state.last_position = input.position;

    const updated = await this.agents.updateLastKnownTrackingState(agentId, state);
    if (!updated) throw createAppError(ERROR_CODES.AGENT_NOT_FOUND, 404);
    return updated;
  }

  /**
   * Derive whether the mirrored state should be read as stale.
   *
   * Computed on read rather than stored, because staleness is a function of the
   * clock: a stored 'streaming' becomes a lie the moment the process stops
   * writing, and nothing would ever correct it.
   */
  isTrackingStateStale(agent: IDeliveryAgent, now: Date = new Date()): boolean {
    const reportedAt = agent.last_known_tracking_state?.last_reported_at;
    if (!reportedAt) return true;
    const ageSeconds = (now.getTime() - new Date(reportedAt).getTime()) / 1000;
    return ageSeconds > AGENT_CONFIG.TRACKING_STATE_STALE_AFTER_SECONDS;
  }

  /** The mirror as it should be presented — never claiming live when stale. */
  effectiveTrackingStateStatus(agent: IDeliveryAgent, now: Date = new Date()): AgentTrackingStateStatus {
    const stored = agent.last_known_tracking_state?.status ?? 'unknown';
    if (stored === 'streaming' && this.isTrackingStateStale(agent, now)) return 'stale';
    return stored;
  }
}

export const agentTrackingPolicyService = new AgentTrackingPolicyService();
