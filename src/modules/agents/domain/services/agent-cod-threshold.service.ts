import { ClientSession } from 'mongoose';
import { createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import { transactionManager } from '../../../../core/database/transaction.manager';
import { AgentRepository, agentRepository } from '../../repositories/agent.repository';
import {
  AgentContractRepository,
  agentContractRepository,
} from '../../repositories/agent-contract.repository';
import { AGENT_CONFIG } from '../../config/agent.config';
import { CodPoolView, describeCodPool } from './agent-cod-pool';

export interface ThresholdAllocation {
  agentId: string;
  /** The agent's global pool. */
  maxThreshold: number;
  /** Sum of thresholds across allocating contracts. */
  allocated: number;
  /** maxThreshold - allocated. Never negative. */
  headroom: number;
  /**
   * `allocated - maxThreshold` when contracts hold MORE than the pool, else 0. Only
   * an automatic sync can produce this (a plan downgrade, a revoked KYC verdict) —
   * the human writers refuse to. While it is above 0 no slice can be raised, and
   * the exposure gate binds at the pool rather than at any larger slice.
   */
  overAllocatedBy: number;
  /** Where the pool comes from — the plan, a pinned value, or 0 while unverified. */
  pool: CodPoolView;
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
 *   - the agent or an administrator lowering the pool below what is already
 *     allocated → reject (`AgentCodPoolService`, which owns every pool write)
 *   - agency raising `contract.threshold` beyond remaining headroom → reject
 *   - approving a pending contract whose threshold exceeds headroom → reject
 *
 * Every check runs INSIDE the caller's transaction against a session-scoped
 * read. A check outside the transaction is decoration: two agencies approving
 * simultaneously would both read the same headroom and both commit.
 *
 * ── The pool itself is not written here any more (2026-09-21) ──────────────
 *
 * `setAgentThreshold` lived here and wrote `cod.max_threshold` directly. The pool
 * is now derived from the agent's plan and KYC verdict (see `agent-cod-pool.ts`),
 * and a direct write would be silently undone by the next sync — so every write
 * moved to `AgentCodPoolService`, and this service only reads the pool it
 * sub-allocates.
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
      overAllocatedBy: Math.max(0, allocated - maxThreshold),
      pool: describeCodPool(agent),
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
        hint:
          'The agent\'s COD pool has no room for this. Their pool comes from their plan once their identity '
          + 'is verified (they may also have chosen to carry less); otherwise another contract must free capacity.',
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
