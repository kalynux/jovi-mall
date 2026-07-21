import { ClientSession } from 'mongoose';
import { createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import { transactionManager } from '../../../../core/database/transaction.manager';
import { AgentRepository, agentRepository } from '../../repositories/agent.repository';
import {
  AgentContractRepository,
  agentContractRepository,
} from '../../repositories/agent-contract.repository';
import { IDeliveryAgent } from '../../models/agent.model';
import { AGENT_CONFIG } from '../../config/agent.config';
import { eventBus } from '../../../../core/events/event-bus';

export interface ThresholdAllocation {
  agentId: string;
  /** The agent's global pool. */
  maxThreshold: number;
  /** Sum of thresholds across allocating contracts. */
  allocated: number;
  /** maxThreshold - allocated. Never negative. */
  headroom: number;
  /** Per-contract breakdown — what the agency review screen needs. */
  contracts: Array<{
    contractId: string;
    agencyId: string;
    status: string;
    threshold: number;
    outstandingBalance: number;
  }>;
}

/**
 * AgentCodThresholdService — the shared-pool constraint.
 *
 * **The rule, in one line: an agent's COD threshold is a shared pool; every
 * contract is a sub-allocation of it, and the sum across allocating contracts
 * can never exceed the agent's own limit.**
 *
 * This replaces the old `cod.max_exposure_override`, which was an independent
 * per-agency cap. That model let three agencies each grant 1M to an agent
 * willing to hold 1M, and the platform only discovered the 3M of real exposure
 * when the cash went missing. A pool cannot be over-committed by construction.
 *
 * ── Which contracts consume the pool ────────────────────────────────────────
 *
 * `active`, `paused` and `suspended` all consume it (see
 * ALLOCATING_CONTRACT_STATUSES). Pausing does NOT free capacity — the agent may
 * still be holding that agency's cash, and handing their slice to someone else
 * while they hold it is precisely how the pool gets over-committed.
 * `pending` doesn't consume (never approved, no interaction) and `deactivated`
 * doesn't either (termination is blocked while any COD is outstanding, so it
 * necessarily holds zero).
 *
 * A consequence worth naming: reactivating a paused contract can never fail a
 * headroom check, because it never left the sum.
 *
 * ── Where the constraint is enforced ────────────────────────────────────────
 *
 * From both directions, because either side can breach it:
 *   - agent lowering `max_threshold` below what is already allocated → reject
 *   - agency raising `contract.threshold` beyond remaining headroom → reject
 *   - approving a pending contract whose threshold exceeds headroom → reject
 *
 * Every check runs INSIDE the caller's transaction against a session-scoped
 * read. A check outside the transaction is decoration: two agencies approving
 * simultaneously would both read the same headroom and both commit.
 */
export class AgentCodThresholdService {
  constructor(
    private readonly agents: AgentRepository = agentRepository,
    private readonly contracts: AgentContractRepository = agentContractRepository
  ) {}

  // ─── Reads ────────────────────────────────────────────────────────────────

  /** The agent's pool, what's allocated, and what's left. */
  async getAllocation(agentId: string, session?: ClientSession): Promise<ThresholdAllocation> {
    const agent = await this.agents.findById(agentId, session);
    if (!agent) throw createAppError(ERROR_CODES.AGENT_NOT_FOUND, 404);

    const allocating = await this.contracts.listAllocating(agentId, session);
    const allocated = allocating.reduce((sum, c) => sum + (c.cod?.threshold ?? 0), 0);
    const maxThreshold = agent.cod?.max_threshold ?? 0;

    return {
      agentId,
      maxThreshold,
      allocated,
      headroom: Math.max(0, maxThreshold - allocated),
      contracts: allocating.map((c) => ({
        contractId: c._id.toString(),
        agencyId: c.agency_id.toString(),
        status: c.status,
        threshold: c.cod?.threshold ?? 0,
        outstandingBalance: c.cod?.outstanding_balance ?? 0,
      })),
    };
  }

  /**
   * Headroom available to a specific contract — its own current threshold does
   * not count against itself. Raising a contract from 200k to 300k needs 100k
   * of headroom, not 300k; treating the contract's own slice as competing with
   * itself would make every raise look impossible.
   */
  async headroomFor(agentId: string, excludeContractId: string | null, session?: ClientSession): Promise<number> {
    const agent = await this.agents.findById(agentId, session);
    if (!agent) throw createAppError(ERROR_CODES.AGENT_NOT_FOUND, 404);

    const allocating = await this.contracts.listAllocating(agentId, session);
    const allocated = allocating
      .filter((c) => (excludeContractId ? c._id.toString() !== excludeContractId : true))
      .reduce((sum, c) => sum + (c.cod?.threshold ?? 0), 0);

    return Math.max(0, (agent.cod?.max_threshold ?? 0) - allocated);
  }

  // ─── Agent side: the global pool ──────────────────────────────────────────

  /**
   * The agent sets their own global threshold.
   *
   * Lowering below what is already allocated is a HARD rejection — not a
   * partial write, not a queued intent, no side effects. There is deliberately
   * no remediation workflow: freeing the headroom means getting agencies to
   * lower their contract thresholds or end a contract, which is an off-platform
   * negotiation. The system's job here is to refuse and say exactly how much is
   * in the way.
   */
  async setAgentThreshold(agentId: string, maxThreshold: number): Promise<IDeliveryAgent> {
    if (
      !Number.isInteger(maxThreshold) ||
      maxThreshold < AGENT_CONFIG.COD_THRESHOLD_MIN ||
      maxThreshold > AGENT_CONFIG.COD_THRESHOLD_MAX
    ) {
      throw createAppError(ERROR_CODES.AGENT_COD_THRESHOLD_OUT_OF_BOUNDS, 422, undefined, {
        requested: maxThreshold,
        min: AGENT_CONFIG.COD_THRESHOLD_MIN,
        max: AGENT_CONFIG.COD_THRESHOLD_MAX,
      });
    }

    return await transactionManager.runInTransaction(async (session) => {
      const agent = await this.agents.findById(agentId, session);
      if (!agent) throw createAppError(ERROR_CODES.AGENT_NOT_FOUND, 404);

      const allocating = await this.contracts.listAllocating(agentId, session);
      const allocated = allocating.reduce((sum, c) => sum + (c.cod?.threshold ?? 0), 0);

      if (maxThreshold < allocated) {
        throw createAppError(ERROR_CODES.AGENT_COD_THRESHOLD_BELOW_ALLOCATED, 422, undefined, {
          requested: maxThreshold,
          currentlyAllocated: allocated,
          shortfall: allocated - maxThreshold,
          contracts: allocating.map((c) => ({
            contractId: c._id.toString(),
            agencyId: c.agency_id.toString(),
            threshold: c.cod?.threshold ?? 0,
          })),
        });
      }

      const previous = agent.cod?.max_threshold ?? 0;
      const updated = await this.agents.setCodMaxThreshold(agentId, maxThreshold, session);
      if (!updated) throw createAppError(ERROR_CODES.AGENT_NOT_FOUND, 404);

      // Raising the pool can unblock contracts sitting pending for want of
      // headroom — emit so an agency's review queue can refresh rather than
      // poll. Nothing subscribes yet; the event is the seam.
      if (previous !== maxThreshold) {
        void eventBus
          .publish('agent.cod_threshold_changed', {
            eventType: 'agent.cod_threshold_changed',
            aggregateId: agentId,
            occurredAt: new Date(),
            payload: {
              agentId,
              from: previous,
              to: maxThreshold,
              allocated,
              headroom: maxThreshold - allocated,
            },
          })
          .catch((err) => console.error('[AgentCodThresholdService] threshold emit failed:', err));
      }

      return updated;
    });
  }

  // ─── Contract side: the sub-allocation ────────────────────────────────────

  /**
   * Validate a contract threshold against BOTH bounds — the absolute per-contract
   * cap and the agent's remaining headroom.
   *
   * Must be called inside the caller's transaction with its session, so the
   * headroom read and the write that depends on it cannot be interleaved by a
   * concurrent approval.
   */
  async assertContractThresholdAllowed(
    agentId: string,
    contractId: string | null,
    threshold: number,
    session: ClientSession
  ): Promise<void> {
    if (
      !Number.isInteger(threshold) ||
      threshold < AGENT_CONFIG.CONTRACT_COD_THRESHOLD_MIN ||
      threshold > AGENT_CONFIG.CONTRACT_COD_THRESHOLD_MAX
    ) {
      throw createAppError(ERROR_CODES.CONTRACT_COD_THRESHOLD_OUT_OF_BOUNDS, 422, undefined, {
        requested: threshold,
        min: AGENT_CONFIG.CONTRACT_COD_THRESHOLD_MIN,
        max: AGENT_CONFIG.CONTRACT_COD_THRESHOLD_MAX,
      });
    }

    const headroom = await this.headroomFor(agentId, contractId, session);
    if (threshold > headroom) {
      throw createAppError(ERROR_CODES.CONTRACT_COD_THRESHOLD_EXCEEDS_HEADROOM, 422, undefined, {
        requested: threshold,
        headroom,
        shortfall: threshold - headroom,
        hint: 'The agent must raise their global COD threshold, or another contract must free capacity.',
      });
    }
  }

  /**
   * The agency sets/updates its contract's slice.
   *
   * Lowering below the contract's own outstanding balance is rejected, mirroring
   * the agent-level rule: a threshold beneath the cash already in the agent's
   * hands under this contract describes a state that already exists and cannot
   * be un-created by a config write. (See the open-questions note — §1 specified
   * this only for the agent level; the same hard rejection is applied here
   * deliberately rather than silently allowing it.)
   */
  async setContractThreshold(
    agentId: string,
    contractId: string,
    threshold: number
  ): Promise<{ threshold: number; headroomAfter: number }> {
    return await transactionManager.runInTransaction(async (session) => {
      const contract = await this.contracts.findById(contractId, session);
      if (!contract) throw createAppError(ERROR_CODES.CONTRACT_NOT_FOUND, 404);

      const outstanding = contract.cod?.outstanding_balance ?? 0;
      if (threshold < outstanding) {
        throw createAppError(ERROR_CODES.CONTRACT_COD_THRESHOLD_BELOW_OUTSTANDING, 422, undefined, {
          requested: threshold,
          outstandingBalance: outstanding,
          hint: 'The agent must settle cash held under this contract before the threshold can be lowered this far.',
        });
      }

      await this.assertContractThresholdAllowed(agentId, contractId, threshold, session);

      const updated = await this.contracts.setCodThreshold(contractId, threshold, session);
      if (!updated) throw createAppError(ERROR_CODES.CONTRACT_NOT_FOUND, 404);

      const headroomAfter = await this.headroomFor(agentId, null, session);
      return { threshold, headroomAfter };
    });
  }
}

export const agentCodThresholdService = new AgentCodThresholdService();
