import { Types } from 'mongoose';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { COD_CONFIG } from '../config/cod.config';
import { CashCollectionModel } from '../models/cash-collection.model';
import { CodCashAccountService, codCashAccountService } from './cod-cash-account.service';
import { CodDiscrepancyService, codDiscrepancyService } from './cod-discrepancy.service';
import { IDeliveryAgent } from '../../agents';
import {
  resolveEffectiveTrustScore,
  TrustScoreSource,
} from '../../agents/domain/services/agent-trust-override';

/** Why an agent may not take on more COD cash. Stable codes — surfaced to operators. */
export type CodCapacityBlocker = 'trust_too_low' | 'open_cash_shortfall' | 'exposure_exceeded';

/** One COD package already in the agent's hands, and what it becomes on handoff. */
export interface CodPendingCollection {
  collectionId: string;
  shipmentId: string;
  agencyId: string | null;
  expectedAmount: number;
}

/**
 * Where an agent's exposure comes from.
 *
 * ⚠ Agent-WIDE, across every agency. The cash is one physical pot — see the
 * service header — so `cashHeld` and the pending list both span agencies while
 * the limit they are compared against belongs to ONE contract. That asymmetry is
 * the single most misread thing about this check, which is why the breakdown
 * carries `agencyId` on every row rather than a bare total.
 */
export interface CodExposureBreakdown {
  currency: string;
  /** Cash the agent physically holds and has not yet deposited. */
  cashHeld: number;
  /** Expected cash of COD packages out with the agent but not yet collected. */
  pendingCollections: {
    total: number;
    count: number;
    items: CodPendingCollection[];
  };
  /** `cashHeld + pendingCollections.total` — the figure the limit bounds. */
  total: number;
}

/** How the effective limit was arrived at, term by term. */
export interface CodLimitBreakdown {
  /**
   * The dispatching agency's slice (`contract.cod.threshold`), or null when the
   * caller passed none and the platform default applied.
   */
  contractThreshold: number | null;
  /** What the multiplier was applied to. */
  base: number;
  /** The score the tier was chosen by — the OVERRIDE when one is pinned. */
  trustScore: number;
  trustSource: TrustScoreSource;
  /** The computed score, reported beside the override so both are visible. */
  computedTrustScore: number;
  overrideReason: string | null;
  tier: 'full' | 'reduced' | 'blocked';
  multiplier: number;
  fullThreshold: number;
  reducedThreshold: number;
  /** `base` for the full tier, `floor(base × multiplier)` otherwise. */
  effectiveLimit: number;
}

/** The full, non-throwing answer to "may this agent take `additionalAmount` more?". */
export interface CodCapacityVerdict {
  allowed: boolean;
  /** The FIRST rule that refused, in the order the gate applies them. */
  blocker: CodCapacityBlocker | null;
  additionalAmount: number;
  limit: CodLimitBreakdown;
  openCashShortfall: boolean;
  /**
   * `null` only when the verdict short-circuited before the cash was read — i.e.
   * `full` was off and trust or a shortfall had already refused. The diagnostic
   * path passes `full: true` and always gets a breakdown.
   */
  exposure: CodExposureBreakdown | null;
  /** `effectiveLimit - exposure.total`, floored at 0. Null when not computed. */
  headroom: number | null;
  /**
   * The smallest deposit that would make `additionalAmount` fit. 0 when it
   * already fits; null when exposure was not computed.
   */
  depositNeeded: number | null;
}

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
 *
 * ── One evaluation, two callers ─────────────────────────────────────────────
 *
 * `evaluate` holds every rule and every number; `assertCanTakeCodShipment` is a
 * thin throw over it, and the admin assignability diagnostic reads the same
 * verdict with `full: true`. Nothing re-derives a threshold, a multiplier or the
 * comparison. A diagnostic built on a second copy of the rule eventually
 * explains a refusal wrongly, and that is worse than no diagnostic at all
 * because an operator believes it and tells an agency something untrue.
 */
export class CodExposureService {
  constructor(
    private readonly cashAccounts: CodCashAccountService = codCashAccountService,
    private readonly discrepancies: CodDiscrepancyService = codDiscrepancyService
  ) {}

  /**
   * Every COD capacity rule, evaluated without throwing.
   *
   * @param maxExposureOverride the DISPATCHING agency's cap for this agent
   *        (contract.cod.threshold); null = platform default.
   * @param opts.full read the cash even when trust or a shortfall has already
   *        refused. The gate leaves this OFF so a blocked agent costs no cash
   *        queries on the dispatch path — including once per candidate in the
   *        auto ranking. The diagnostic turns it on: "why was this refused"
   *        needs every number, not just the first one that failed.
   */
  async evaluate(
    agent: IDeliveryAgent,
    additionalAmount: number,
    maxExposureOverride: number | null,
    opts: { full?: boolean } = {}
  ): Promise<CodCapacityVerdict> {
    const agentId = agent._id.toString();
    const limit = this.limitBreakdown(agent, maxExposureOverride);

    const trustBlocks = limit.trustScore < COD_CONFIG.TRUST_REDUCED_THRESHOLD;
    // Only asked when it can still change the answer, or when the caller wants
    // the whole picture.
    const shortfall =
      trustBlocks && !opts.full ? false : await this.discrepancies.hasOpenShortfallForAgent(agentId);

    const blockedEarly = trustBlocks || shortfall;
    const exposure = blockedEarly && !opts.full ? null : await this.exposureBreakdown(agentId);

    const headroom = exposure ? Math.max(0, limit.effectiveLimit - exposure.total) : null;
    const overBy = exposure ? exposure.total + additionalAmount - limit.effectiveLimit : 0;
    const exposureBlocks = exposure !== null && overBy > 0;

    // This order is the gate's order, and it is meaning rather than style: an
    // agent refused for trust must be reported as refused for TRUST, not for the
    // exposure that a zero limit trivially exceeds.
    const blocker: CodCapacityBlocker | null = trustBlocks
      ? 'trust_too_low'
      : shortfall
        ? 'open_cash_shortfall'
        : exposureBlocks
          ? 'exposure_exceeded'
          : null;

    return {
      allowed: blocker === null,
      blocker,
      additionalAmount,
      limit,
      openCashShortfall: shortfall,
      exposure,
      headroom,
      depositNeeded: exposure ? Math.max(0, overBy) : null,
    };
  }

  /**
   * Throws when the agent may not take on `additionalAmount` more COD cash.
   *
   * @param maxExposureOverride the DISPATCHING agency's cap for this agent
   *        (contract.cod.threshold); null = platform default.
   */
  async assertCanTakeCodShipment(
    agent: IDeliveryAgent,
    additionalAmount: number,
    maxExposureOverride: number | null
  ): Promise<void> {
    this.assertVerdict(await this.evaluate(agent, additionalAmount, maxExposureOverride));
  }

  /**
   * Turn a refusing verdict into the error the gate throws. A no-op when the
   * verdict allows.
   *
   * Separate from `assertCanTakeCodShipment` so a caller that has ALREADY
   * evaluated — `ContractPolicyService.assert` has, to build its gate list — can
   * throw without paying for a second evaluation. The three error shapes below
   * are consumed by three dashboards and are not free to change.
   */
  assertVerdict(verdict: CodCapacityVerdict): void {
    if (verdict.allowed) return;
    const additionalAmount = verdict.additionalAmount;

    if (verdict.blocker === 'trust_too_low') {
      throw createAppError(ERROR_CODES.COD_AGENT_TRUST_TOO_LOW, 422, undefined, {
        trustScore: verdict.limit.trustScore,
        minimum: COD_CONFIG.TRUST_REDUCED_THRESHOLD,
        // Which number refused them. An agency told "trust too low" about an
        // agent whose computed score is 100 needs to know a human pinned it, or
        // they will reasonably conclude the platform is broken.
        trustSource: verdict.limit.trustSource,
        ...(verdict.limit.overrideReason ? { overrideReason: verdict.limit.overrideReason } : {}),
      });
    }

    if (verdict.blocker === 'open_cash_shortfall') {
      throw createAppError(
        ERROR_CODES.COD_AGENT_TRUST_TOO_LOW,
        422,
        'Agent has an open cash-shortfall discrepancy — resolve it before assigning new COD shipments',
        { reason: 'open_cash_shortfall' }
      );
    }

    throw createAppError(ERROR_CODES.COD_AGENT_EXPOSURE_EXCEEDED, 422, undefined, {
      currentExposure: verdict.exposure!.total,
      additionalAmount,
      effectiveLimit: verdict.limit.effectiveLimit,
    });
  }

  /**
   * The agent's exposure limit after trust-tier scaling.
   *
   * @param maxExposureOverride the applicable agency cap; null = platform default.
   */
  effectiveLimit(agent: IDeliveryAgent, maxExposureOverride: number | null): number {
    return this.limitBreakdown(agent, maxExposureOverride).effectiveLimit;
  }

  /**
   * The same number as `effectiveLimit`, with every term that produced it.
   *
   * ⚠ Note there are TWO unrelated things called an "override" on this method:
   * `maxExposureOverride` is the dispatching AGENCY's cash cap, and the trust
   * override is an ADMINISTRATOR's pinned score. They are multiplied together
   * here and neither implies the other.
   */
  limitBreakdown(agent: IDeliveryAgent, maxExposureOverride: number | null): CodLimitBreakdown {
    const base = maxExposureOverride ?? COD_CONFIG.AGENT_MAX_EXPOSURE_DEFAULT;
    // ⚠ `resolveEffectiveTrustScore`, NEVER `agent.cod.trust_score`. An
    // administrator's persistent override outranks the computed score — see that
    // function's header for why (O-7). This is one of the two decision points
    // that must read it; the other is the trust floor in `evaluate` above, which
    // reads `limit.trustScore` from here rather than resolving a second time.
    const trust = resolveEffectiveTrustScore(agent);

    const tier: CodLimitBreakdown['tier'] =
      trust.score >= COD_CONFIG.TRUST_FULL_THRESHOLD
        ? 'full'
        : trust.score >= COD_CONFIG.TRUST_REDUCED_THRESHOLD
          ? 'reduced'
          : 'blocked';
    const multiplier = tier === 'full' ? 1 : tier === 'reduced' ? COD_CONFIG.TRUST_REDUCED_MULTIPLIER : 0;

    return {
      contractThreshold: maxExposureOverride,
      base,
      trustScore: trust.score,
      trustSource: trust.source,
      computedTrustScore: trust.computed,
      overrideReason: trust.override?.reason ?? null,
      tier,
      multiplier,
      fullThreshold: COD_CONFIG.TRUST_FULL_THRESHOLD,
      reducedThreshold: COD_CONFIG.TRUST_REDUCED_THRESHOLD,
      // `base` unscaled on the full tier rather than `base * 1`, and `floor`
      // elsewhere: a limit must never round UP past what the agency granted.
      effectiveLimit: tier === 'full' ? base : Math.floor(base * multiplier),
    };
  }

  /** Cash held + expected cash of still-pending collections. */
  async currentExposure(agentId: string): Promise<number> {
    return (await this.exposureBreakdown(agentId)).total;
  }

  /**
   * `currentExposure`, itemised.
   *
   * The pending rows are returned rather than summed away because the total on
   * its own is unexplainable: an operator looking at a refusal needs to see
   * WHICH packages are holding the headroom, and that some of them may belong to
   * a different agency than the one being refused.
   */
  async exposureBreakdown(agentId: string): Promise<CodExposureBreakdown> {
    const [{ balance, currency }, pending] = await Promise.all([
      this.cashAccounts.getBalance('agent', agentId),
      CashCollectionModel.find(
        { status: 'pending', agent_id: new Types.ObjectId(agentId) },
        { expected_amount: 1, shipment_id: 1, agency_id: 1 }
      )
        .sort({ expected_amount: -1 })
        .lean()
        .exec(),
    ]);

    const items: CodPendingCollection[] = pending.map((row: any) => ({
      collectionId: row._id.toString(),
      shipmentId: row.shipment_id?.toString() ?? '',
      agencyId: row.agency_id?.toString() ?? null,
      expectedAmount: row.expected_amount ?? 0,
    }));
    const pendingTotal = items.reduce((sum, item) => sum + item.expectedAmount, 0);

    return {
      currency,
      cashHeld: balance,
      pendingCollections: { total: pendingTotal, count: items.length, items },
      total: balance + pendingTotal,
    };
  }
}

export const codExposureService = new CodExposureService();
