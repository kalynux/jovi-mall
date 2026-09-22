import { ClientSession } from 'mongoose';
import { createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import { transactionManager } from '../../../../core/database/transaction.manager';
import { eventBus } from '../../../../core/events/event-bus';
import { logger } from '../../../../core/logging';
import { RoleActorRef, actorStamp } from '../../../../core/types/actor-source.types';
import { EntitlementService, entitlementService } from '../../../billing/services/entitlement.service';
import { AgentRepository, agentRepository } from '../../repositories/agent.repository';
import {
  AgentContractRepository,
  agentContractRepository,
} from '../../repositories/agent-contract.repository';
import { IAgentCodPoolOverride, IDeliveryAgent } from '../../models/agent.model';
import { AGENT_CONFIG } from '../../config/agent.config';
import {
  CodPoolCeiling,
  codPoolInSync,
  nextCodPoolValue,
  resolveCodPoolCeiling,
  storedCodPoolOf,
} from './agent-cod-pool';

/** What made a sync run — logged and carried on the event, never branched on. */
export type CodPoolSyncTrigger =
  | 'kyc_verdict'
  | 'plan_activated'
  | 'plan_edited'
  | 'agent_request'
  | 'reconcile';

export interface CodPoolSyncResult {
  agentId: string;
  changed: boolean;
  from: number;
  to: number;
  ceiling: CodPoolCeiling;
}

/** Attempts before a sync that keeps losing its compare-and-set gives up to the reconcile. */
const SYNC_ATTEMPTS = 3;

/**
 * AgentCodPoolService — the ONLY writer of an agent's COD pool (`cod.max_threshold`)
 * and its provenance (`cod.pool_*`). The rule itself is `agent-cod-pool.ts`; this
 * file decides WHEN it runs and makes the write safe.
 *
 * ── Three writers, one compare-and-set ──────────────────────────────────────
 *
 *   sync          the platform — plan activated or edited, KYC verdict, nightly
 *                 reconcile. Never refuses: it records a consequence.
 *   setAgentLimit the agent — may only LOWER, within [allocated, ceiling].
 *   setOverride   an administrator — pins (or clears) the ceiling, with a reason.
 *
 * All three go through `AgentRepository.writeCodPool`, keyed on `pool_synced_at`,
 * so none of them can overwrite an answer another computed from newer inputs.
 *
 * ── Why a sync may leave the pool BELOW what contracts hold ─────────────────
 *
 * A downgrade or a revoked verdict is a fact, not a request — there is nobody to
 * refuse. So the pool is written as computed and contract slices are left alone
 * (there is deliberately no platform write path to contract terms). Two things
 * make that safe rather than a hole: headroom floors at 0, so no agency can raise
 * or approve a slice until the sum fits again; and `CodExposureService` caps each
 * dispatch at `min(slice, pool)`, so the agent cannot carry more than the pool
 * however large a slice an agency granted before the change.
 *
 * The two HUMAN writers keep the older rule and refuse to go below what is
 * allocated — a person choosing a number can be told which contracts are in the
 * way, and `AGENT_COD_THRESHOLD_BELOW_ALLOCATED` says exactly that.
 */
export class AgentCodPoolService {
  constructor(
    private readonly agents: AgentRepository = agentRepository,
    private readonly contracts: AgentContractRepository = agentContractRepository,
    private readonly entitlements: EntitlementService = entitlementService
  ) {}

  // ─── The platform: sync ───────────────────────────────────────────────────

  /**
   * Recompute this agent's pool from their KYC verdict, pin and plan, and write it
   * if it differs. Idempotent — running it on an in-sync agent writes nothing.
   *
   * Returns `null` for an unknown agent, and when every attempt lost its
   * compare-and-set to a concurrent writer (logged; the reconcile converges it).
   */
  async sync(agentId: string, trigger: CodPoolSyncTrigger): Promise<CodPoolSyncResult | null> {
    for (let attempt = 0; attempt < SYNC_ATTEMPTS; attempt++) {
      const agent = await this.agents.findById(agentId);
      if (!agent) return null;

      const plan = await this.entitlements.resolveAgentCodPool(agentId);
      const ceiling = resolveCodPoolCeiling({
        kycStatus: agent.kyc?.status,
        override: agent.cod?.pool_override,
        plan,
      });
      const stored = storedCodPoolOf(agent);
      const from = stored.maxThreshold;

      if (codPoolInSync(stored, ceiling, agent.cod?.pool_plan_code ?? null)) {
        return { agentId, changed: false, from, to: from, ceiling };
      }

      const to = nextCodPoolValue(stored, ceiling);
      const written = await this.agents.writeCodPool(agentId, agent.cod?.pool_synced_at ?? null, {
        maxThreshold: to,
        ceiling: ceiling.amount,
        source: ceiling.source,
        planCode: ceiling.planCode,
        syncedAt: new Date(),
      });
      if (!written) continue; // lost a race — re-read and recompute from the winner

      this.emitChanged(agentId, from, to, ceiling, trigger);
      return { agentId, changed: from !== to, from, to, ceiling };
    }

    logger().warn({ agentId, trigger }, 'agent COD pool: sync lost every compare-and-set; left to the reconcile');
    return null;
  }

  /**
   * Sync every agent. The reconcile worker's body, and what an in-place plan edit
   * runs. Sequential and per-agent fault-isolated: one agent's failure is counted and
   * logged, and never stops the sweep.
   */
  async syncAll(trigger: CodPoolSyncTrigger): Promise<{ checked: number; changed: number; failed: number }> {
    const ids = await this.agents.listAllIds();
    let changed = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        const result = await this.sync(id, trigger);
        if (result?.changed) changed++;
      } catch (err) {
        failed++;
        logger().error({ err, agentId: id, trigger }, 'agent COD pool: sync failed');
      }
    }
    return { checked: ids.length, changed, failed };
  }

  // ─── The agent: carry less ────────────────────────────────────────────────

  /**
   * The agent chooses their own pool, between what their contracts already hold and
   * their ceiling. `null` means "the whole ceiling" — the way back from a choice.
   *
   * Syncs first, OUTSIDE the transaction, so the ceiling judged against is today's:
   * an agent whose upgrade event was lost must be able to use the plan they bought
   * without waiting for the night.
   */
  async setAgentLimit(agentId: string, requested: number | null): Promise<IDeliveryAgent> {
    await this.sync(agentId, 'agent_request');

    return await transactionManager.runInTransaction(async (session) => {
      const agent = await this.requireAgent(agentId, session);
      const stored = storedCodPoolOf(agent);
      const target = requested ?? stored.ceiling;

      if (!Number.isInteger(target) || target < AGENT_CONFIG.COD_THRESHOLD_MIN) {
        throw createAppError(ERROR_CODES.AGENT_COD_THRESHOLD_OUT_OF_BOUNDS, 422, undefined, {
          requested: target,
          min: AGENT_CONFIG.COD_THRESHOLD_MIN,
          max: stored.ceiling,
        });
      }
      if (target > stored.ceiling) {
        throw createAppError(ERROR_CODES.AGENT_COD_POOL_ABOVE_CEILING, 422, undefined, {
          requested: target,
          ceiling: stored.ceiling,
          source: stored.source,
          planCode: agent.cod?.pool_plan_code ?? null,
          hint:
            stored.source === 'not_verified'
              ? 'Your COD pool opens once your identity documents are verified.'
              : 'Your plan sets the most you can carry. Upgrade to raise it.',
        });
      }
      await this.assertNotBelowAllocated(agentId, target, session);

      const written = await this.agents.writeCodPool(
        agentId,
        agent.cod?.pool_synced_at ?? null,
        {
          maxThreshold: target,
          ceiling: stored.ceiling,
          source: stored.source,
          planCode: agent.cod?.pool_plan_code ?? null,
          syncedAt: new Date(),
        },
        session
      );
      if (!written) throw createAppError(ERROR_CODES.AGENT_COD_POOL_CONFLICT, 409);

      this.emitChanged(agentId, stored.maxThreshold, target, {
        amount: stored.ceiling,
        source: stored.source,
        planCode: agent.cod?.pool_plan_code ?? null,
      }, 'agent_request');
      return written;
    });
  }

  // ─── An administrator: pin or release ─────────────────────────────────────

  /**
   * Pin a pool that replaces the plan's value as the ceiling — above or below it —
   * or release the pin with `amount: null`. A reason is required either way.
   *
   * Like the trust override, the pin is a separate field no sync writes, so a plan
   * renewal cannot erase it. Unlike it, the pin does not outrank KYC: an unverified
   * agent stays at 0 and the pin waits for the verdict.
   *
   * Refuses (like the agent's own write) to leave the pool below what contracts
   * already hold — including on RELEASE, when the plan's value is lower than the
   * pin was. An administrator is a person choosing a number, and the refusal names
   * the contracts in the way. Skipped while the agent is unverified: their pool is 0
   * regardless and the pin is only being stored.
   */
  async setOverride(params: {
    agentId: string;
    amount: number | null;
    reason: string;
    actor: RoleActorRef;
  }): Promise<IDeliveryAgent> {
    const { agentId, amount, reason, actor } = params;

    if (
      amount !== null &&
      (!Number.isInteger(amount) ||
        amount < AGENT_CONFIG.COD_THRESHOLD_MIN ||
        amount > AGENT_CONFIG.COD_THRESHOLD_MAX)
    ) {
      throw createAppError(ERROR_CODES.AGENT_COD_THRESHOLD_OUT_OF_BOUNDS, 422, undefined, {
        requested: amount,
        min: AGENT_CONFIG.COD_THRESHOLD_MIN,
        max: AGENT_CONFIG.COD_THRESHOLD_MAX,
      });
    }

    // Catalog read, outside the transaction — it touches no document this writes.
    const plan = await this.entitlements.resolveAgentCodPool(agentId);

    const { updated, from, ceiling } = await transactionManager.runInTransaction(async (session) => {
      const agent = await this.requireAgent(agentId, session);

      const override: IAgentCodPoolOverride | null =
        amount === null
          ? null
          : {
              amount,
              reason,
              set_at: new Date(),
              ...(actorStamp('set_by', actor) as Pick<
                IAgentCodPoolOverride,
                'set_by_user_id' | 'set_by_source' | 'set_by_name'
              >),
            };

      const next = resolveCodPoolCeiling({ kycStatus: agent.kyc?.status, override, plan });
      const stored = storedCodPoolOf(agent);
      const to = nextCodPoolValue(stored, next);
      if (next.source !== 'not_verified') {
        await this.assertNotBelowAllocated(agentId, to, session);
      }

      const written = await this.agents.writeCodPool(
        agentId,
        agent.cod?.pool_synced_at ?? null,
        {
          maxThreshold: to,
          ceiling: next.amount,
          source: next.source,
          planCode: next.planCode,
          syncedAt: new Date(),
          override,
        },
        session
      );
      if (!written) throw createAppError(ERROR_CODES.AGENT_COD_POOL_CONFLICT, 409);
      return { updated: written, from: stored.maxThreshold, ceiling: next };
    });

    this.emitChanged(agentId, from, updated.cod.max_threshold, ceiling, 'override');
    logger().info(
      { agentId, amount, actorSource: actor.source, pool: updated.cod.max_threshold },
      amount === null ? 'agent COD pool: pin released' : 'agent COD pool: pin set'
    );
    return updated;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private async requireAgent(agentId: string, session: ClientSession): Promise<IDeliveryAgent> {
    const agent = await this.agents.findById(agentId, session);
    if (!agent) throw createAppError(ERROR_CODES.AGENT_NOT_FOUND, 404);
    return agent;
  }

  /** The pre-existing human-write rule, with the contracts in the way. Inside the caller's transaction. */
  private async assertNotBelowAllocated(agentId: string, target: number, session: ClientSession): Promise<void> {
    const allocating = await this.contracts.listAllocating(agentId, session);
    const allocated = allocating.reduce((sum, c) => sum + (c.cod?.threshold ?? 0), 0);
    if (target >= allocated) return;

    throw createAppError(ERROR_CODES.AGENT_COD_THRESHOLD_BELOW_ALLOCATED, 422, undefined, {
      requested: target,
      currentlyAllocated: allocated,
      shortfall: allocated - target,
      contracts: allocating.map((c) => ({
        contractId: c._id.toString(),
        agencyId: c.agency_id.toString(),
        threshold: c.cod?.threshold ?? 0,
      })),
    });
  }

  /**
   * `agent.cod_threshold_changed` — the pre-existing seam, now with the ceiling's
   * provenance. Nothing subscribes yet; raising the pool can unblock contracts
   * sitting pending for want of headroom, which is what a subscriber would refresh.
   */
  private emitChanged(
    agentId: string,
    from: number,
    to: number,
    ceiling: CodPoolCeiling,
    trigger: CodPoolSyncTrigger | 'override'
  ): void {
    if (from === to) return;
    void eventBus
      .publish('agent.cod_threshold_changed', {
        eventType: 'agent.cod_threshold_changed',
        aggregateId: agentId,
        occurredAt: new Date(),
        payload: {
          agentId,
          from,
          to,
          ceiling: ceiling.amount,
          source: ceiling.source,
          planCode: ceiling.planCode,
          trigger,
        },
      })
      .catch((err) => logger().error({ err, agentId }, 'agent COD pool: change emit failed'));
  }
}

export const agentCodPoolService = new AgentCodPoolService();
