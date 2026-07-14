import { Types } from 'mongoose';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { COD_CONFIG } from '../config/cod.config';
import { CashCollectionModel } from '../models/cash-collection.model';
import { CodCashAccountService, codCashAccountService } from './cod-cash-account.service';
import { CodDiscrepancyService, codDiscrepancyService } from './cod-discrepancy.service';
import { IDeliveryAgent } from '../../delivery/delivery-agent.model';

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
 * Enforced when an agency assigns an agent to a COD shipment.
 */
export class CodExposureService {
  constructor(
    private readonly cashAccounts: CodCashAccountService = codCashAccountService,
    private readonly discrepancies: CodDiscrepancyService = codDiscrepancyService
  ) {}

  /** Throws when the agent may not take on `additionalAmount` more COD cash. */
  async assertCanTakeCodShipment(agent: IDeliveryAgent, additionalAmount: number): Promise<void> {
    const agentId = agent._id.toString();
    const trustScore = agent.cod?.trust_score ?? 100;

    if (trustScore < COD_CONFIG.TRUST_REDUCED_THRESHOLD) {
      throw createAppError(ERROR_CODES.COD_AGENT_TRUST_TOO_LOW, 422, undefined, {
        trustScore,
        minimum: COD_CONFIG.TRUST_REDUCED_THRESHOLD,
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

    const effectiveLimit = this.effectiveLimit(agent);
    const exposure = await this.currentExposure(agentId);

    if (exposure + additionalAmount > effectiveLimit) {
      throw createAppError(ERROR_CODES.COD_AGENT_EXPOSURE_EXCEEDED, 422, undefined, {
        currentExposure: exposure,
        additionalAmount,
        effectiveLimit,
      });
    }
  }

  /** The agent's exposure limit after trust-tier scaling. */
  effectiveLimit(agent: IDeliveryAgent): number {
    const base = agent.cod?.max_exposure_override ?? COD_CONFIG.AGENT_MAX_EXPOSURE_DEFAULT;
    const trustScore = agent.cod?.trust_score ?? 100;
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
