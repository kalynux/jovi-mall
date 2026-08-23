import { Types } from 'mongoose';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { COD_CONFIG } from '../config/cod.config';
import { CashCollectionModel } from '../models/cash-collection.model';
import { CodCashAccountService, codCashAccountService } from './cod-cash-account.service';
import { CodDiscrepancyService, codDiscrepancyService } from './cod-discrepancy.service';
import { IDeliveryAgent } from '../../agents';
import {
  effectiveTrustScore,
  resolveEffectiveTrustScore,
} from '../../agents/domain/services/agent-trust-override';

/**
 * CodExposureService - "never let an agent carry unlimited cash".
 *
 * Exposure = cash the agent already holds (CodCashAccount balance)
 *          + expected cash of their still-pending collections (packages out
 *            for delivery that WILL become cash on handoff).
 *
 * Effective limit = (agency override ?? platform default) × trust multiplier:
 *  - trust ≥ TRUST_FULL_THRESHOLD     → ×1
 *  - trust ≥ TRUST_REDUCED_THRESHOLD  → ×TRUST_REDUCED_MULTIPLIER
 *  - below                            → COD blocked entirely
 * An open cash-shortfall discrepancy also blocks new COD work outright.
 *
 * ── Where the override comes from ───────────────────────────────────────────
 *
 * The agency override is per-MEMBERSHIP, not per-agent: an agent may serve
 * several agencies and each caps its own risk appetite independently. It is
 * therefore passed in by the caller (who knows which agency is dispatching)
 * rather than read off the agent — reading it here would force this service to
 * guess whose limit applies, and two agencies would silently overwrite each
 * other's.
 *
 * Trust, by contrast, stays on the agent: the cash is one physical pot
 * regardless of who dispatched it, so trust follows the person.
 *
 * Enforced when an agency assigns an agent to a COD shipment.
 */
export class CodExposureService {
  constructor(
    private readonly cashAccounts: CodCashAccountService = codCashAccountService,
    private readonly discrepancies: CodDiscrepancyService = codDiscrepancyService
  ) {}

  /**
   * Throws when the agent may not take on `additionalAmount` more COD cash.
   *
   * @param maxExposureOverride the DISPATCHING agency's cap for this agent
   *        (membership.cod.max_exposure_override); null = platform default.
   */
  async assertCanTakeCodShipment(
    agent: IDeliveryAgent,
    additionalAmount: number,
    maxExposureOverride: number | null
  ): Promise<void> {
    const agentId = agent._id.toString();
    // ⚠ `resolveEffectiveTrustScore`, NEVER `agent.cod.trust_score`. An
    // administrator's persistent override outranks the computed score — see that
    // function's header for why (O-7). This is one of the two decision points
    // that must read it; the other is `effectiveLimit` below.
    const trust = resolveEffectiveTrustScore(agent);
    const trustScore = trust.score;

    if (trustScore < COD_CONFIG.TRUST_REDUCED_THRESHOLD) {
      throw createAppError(ERROR_CODES.COD_AGENT_TRUST_TOO_LOW, 422, undefined, {
        trustScore,
        minimum: COD_CONFIG.TRUST_REDUCED_THRESHOLD,
        // Which number refused them. An agency told "trust too low" about an
        // agent whose computed score is 100 needs to know a human pinned it, or
        // they will reasonably conclude the platform is broken.
        trustSource: trust.source,
        ...(trust.override ? { overrideReason: trust.override.reason } : {}),
      });
    }

    if (await this.discrepancies.hasOpenShortfallForAgent(agentId)) {
      throw createAppError(
        ERROR_CODES.COD_AGENT_TRUST_TOO_LOW,
        422,
        'Agent has an open cash-shortfall discrepancy — resolve it before assigning new COD shipments',
        { reason: 'open_cash_shortfall' }
      );
    }

    const effectiveLimit = this.effectiveLimit(agent, maxExposureOverride);
    const exposure = await this.currentExposure(agentId);

    if (exposure + additionalAmount > effectiveLimit) {
      throw createAppError(ERROR_CODES.COD_AGENT_EXPOSURE_EXCEEDED, 422, undefined, {
        currentExposure: exposure,
        additionalAmount,
        effectiveLimit,
      });
    }
  }

  /**
   * The agent's exposure limit after trust-tier scaling.
   *
   * @param maxExposureOverride the applicable agency cap; null = platform default.
   */
  effectiveLimit(agent: IDeliveryAgent, maxExposureOverride: number | null): number {
    const base = maxExposureOverride ?? COD_CONFIG.AGENT_MAX_EXPOSURE_DEFAULT;
    // The second decision point. ⚠ Note there are now TWO unrelated things called
    // an "override" on this method: `maxExposureOverride` is the dispatching
    // AGENCY's cash cap, and the trust override is an ADMINISTRATOR's pinned
    // score. They are multiplied together here and neither implies the other.
    const trustScore = effectiveTrustScore(agent);
    if (trustScore >= COD_CONFIG.TRUST_FULL_THRESHOLD) return base;
    if (trustScore >= COD_CONFIG.TRUST_REDUCED_THRESHOLD) {
      return Math.floor(base * COD_CONFIG.TRUST_REDUCED_MULTIPLIER);
    }
    return 0; // blocked tier
  }

  /** Cash held + expected cash of still-pending collections. */
  async currentExposure(agentId: string): Promise<number> {
    const [{ balance }, pending] = await Promise.all([
      this.cashAccounts.getBalance('agent', agentId),
      CashCollectionModel.aggregate([
        { $match: { status: 'pending', agent_id: new Types.ObjectId(agentId) } },
        { $group: { _id: null, total: { $sum: '$expected_amount' } } },
      ]),
    ]);
    return balance + (pending[0]?.total ?? 0);
  }
}

export const codExposureService = new CodExposureService();
