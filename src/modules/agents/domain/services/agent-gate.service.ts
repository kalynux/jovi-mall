import { ClientSession } from 'mongoose';
import { createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import { AgentRepository, agentRepository } from '../../repositories/agent.repository';
import { IDeliveryAgent } from '../../models/agent.model';
import { eventBus } from '../../../../core/events/event-bus';
import { RoleActorRef, actorStampOrCleared } from '../../../../core/types/actor-source.types';

export type GateFailure = 'agent_not_found' | 'kyc_not_verified' | 'platform_banned';

export interface GateResult {
  passed: boolean;
  failures: GateFailure[];
  kycStatus: string | null;
  banned: boolean;
}

/**
 * AgentGateService — the platform-wide gates that outrank everything else.
 *
 * §6b is explicit that these run BEFORE the COD and capacity checks, not
 * alongside them, and the ordering carries meaning: an unverified or banned
 * agent must be refused for being unverified or banned, not for happening to be
 * offline. Reporting "not available" to an agency whose agent is actually
 * banned sends them to fix the wrong thing.
 *
 * These are also the gates that no agency can override. An agency may set its
 * own contract terms, but it cannot contract with someone the platform has not
 * verified or has thrown off.
 */
export class AgentGateService {
  constructor(private readonly agents: AgentRepository = agentRepository) {}

  /** Evaluate without throwing. Both gates reported, not just the first. */
  async evaluate(agentId: string, session?: ClientSession): Promise<GateResult> {
    const agent = await this.agents.findById(agentId, session);
    if (!agent) {
      return { passed: false, failures: ['agent_not_found'], kycStatus: null, banned: false };
    }
    return this.evaluateAgent(agent);
  }

  /** Pure form — no I/O, so the rule is unit-testable. */
  evaluateAgent(agent: IDeliveryAgent): GateResult {
    const failures: GateFailure[] = [];
    const banned = agent.platform_ban?.banned === true;
    const kycStatus = agent.kyc?.status ?? 'unverified';

    if (banned) failures.push('platform_banned');
    if (kycStatus !== 'verified') failures.push('kyc_not_verified');

    return { passed: failures.length === 0, failures, kycStatus, banned };
  }

  /**
   * Gate for holding a contract or COD cash. Throws with the specific cause.
   *
   * The ban is reported before KYC: a banned agent's verification status is
   * irrelevant, and telling an operator "complete KYC" for someone who has been
   * thrown off the platform is actively misleading.
   */
  async assertCanHoldContract(agentId: string, session?: ClientSession): Promise<void> {
    const result = await this.evaluate(agentId, session);
    if (result.passed) return;

    if (result.failures.includes('agent_not_found')) {
      throw createAppError(ERROR_CODES.AGENT_NOT_FOUND, 404);
    }
    if (result.failures.includes('platform_banned')) {
      throw createAppError(ERROR_CODES.AGENT_PLATFORM_BANNED, 403, undefined, {
        hint: 'A platform-wide ban overrides every contract; lift the ban before contracting.',
      });
    }
    throw createAppError(ERROR_CODES.AGENT_KYC_NOT_VERIFIED, 422, undefined, {
      kycStatus: result.kycStatus,
      hint: 'An unverified agent cannot be approved into a contract or hold COD cash.',
    });
  }

  // ─── KYC (admin) ──────────────────────────────────────────────────────────

  async setKycStatus(
    agentId: string,
    status: IDeliveryAgent['kyc']['status'],
    actor: RoleActorRef,
    options: { reference?: string | null; rejectionReason?: string | null } = {}
  ): Promise<IDeliveryAgent> {
    const agent = await this.agents.findById(agentId);
    if (!agent) throw createAppError(ERROR_CODES.AGENT_NOT_FOUND, 404);

    const updated = await this.agents.setKyc(agentId, {
      status,
      verified_at: status === 'verified' ? new Date() : null,
      // Set on `verified`, cleared on anything else — including a later `rejected`, which
      // must not leave the previous approver's name attached to a rejection. One call
      // writes all three so the id, the space it lives in and the snapshot cannot diverge.
      ...(actorStampOrCleared('verified_by', status === 'verified' ? actor : null) as Partial<
        IDeliveryAgent['kyc']
      >),
      rejection_reason: status === 'rejected' ? (options.rejectionReason ?? null) : null,
      ...(options.reference !== undefined ? { reference: options.reference } : {}),
    });
    if (!updated) throw createAppError(ERROR_CODES.AGENT_NOT_FOUND, 404);

    void eventBus
      .publish('agent.kyc_status_changed', {
        eventType: 'agent.kyc_status_changed',
        aggregateId: agentId,
        occurredAt: new Date(),
        payload: { agentId, from: agent.kyc?.status ?? 'unverified', to: status },
      })
      .catch((err) => console.error('[AgentGateService] kyc emit failed:', err));

    return updated;
  }

  // ─── Platform ban (admin) ─────────────────────────────────────────────────

  /**
   * Ban or unban platform-wide.
   *
   * **The ban is an override, not a cascade.** It does NOT walk the agent's
   * contracts flipping each to paused: that would be lossy (which were already
   * paused before the ban? un-banning could not restore them) and racy. Instead
   * every read path — eligibility, contract approval, tracking policy —
   * consults the flag, so one field suppresses every contract at once and
   * lifting it restores exactly the prior state.
   *
   * The consequence, stated because it is the subtle part: a contract-level
   * `reactivate` while the ban is set will WRITE `active`, but the agent stays
   * unusable because every gate still refuses. That is intentional — the
   * contract's status describes the agency relationship, and the ban describes
   * the platform's. Blocking the reactivate outright would conflate them and
   * leave the agency unable to record its own decision.
   */
  async setPlatformBan(
    agentId: string,
    banned: boolean,
    reason: string | null,
    actor: RoleActorRef
  ): Promise<IDeliveryAgent> {
    const agent = await this.agents.findById(agentId);
    if (!agent) throw createAppError(ERROR_CODES.AGENT_NOT_FOUND, 404);

    const updated = await this.agents.setPlatformBan(agentId, {
      banned,
      reason: banned ? reason : null,
      banned_at: banned ? new Date() : null,
      // Cleared on unban alongside the reason and the timestamp: the three describe one
      // ban, so leaving the stamp behind would make an unbanned agent read as banned by
      // whoever last banned them.
      ...(actorStampOrCleared('banned_by', banned ? actor : null) as Partial<
        IDeliveryAgent['platform_ban']
      >),
    });
    if (!updated) throw createAppError(ERROR_CODES.AGENT_NOT_FOUND, 404);

    void eventBus
      .publish('agent.platform_ban_changed', {
        eventType: 'agent.platform_ban_changed',
        aggregateId: agentId,
        occurredAt: new Date(),
        payload: { agentId, banned, reason, actorRole: actor.role },
      })
      .catch((err) => console.error('[AgentGateService] ban emit failed:', err));

    return updated;
  }
}

export const agentGateService = new AgentGateService();
