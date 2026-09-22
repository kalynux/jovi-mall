import { AGENT_CONFIG } from '../../config/agent.config';
import { AgentCodPoolSource, IDeliveryAgent } from '../../models/agent.model';

/**
 * ─── The agent's COD pool: the rule, as pure functions ───────────────────────
 *
 * Owner decision, 2026-09-21. The pool used to be a free-standing number only an
 * administrator could set, `0` until somebody did. It is now DERIVED:
 *
 *   ceiling = 0                          when the agent's KYC is not `verified`
 *           = an administrator's pin     when one is set (`cod.pool_override`)
 *           = plan.max_cod_pool ?? 0     otherwise — the agent's active plan, or
 *                                        the free tier when they hold none
 *   pool    ∈ [0, ceiling]               the agent may carry LESS than the
 *                                        ceiling, never more
 *
 * Three decisions are encoded here, each of which the owner made explicitly:
 *
 *   1. **Unverified means zero, and the pin does not outrank that.** KYC comes
 *      first in `resolveCodPoolCeiling`. An administrator's pin survives an
 *      unverified spell untouched and applies again on re-verification, but it
 *      never puts cash in the hands of someone the platform has not vetted.
 *   2. **The pin outranks the plan in both directions** — above it (a trusted
 *      agent on the free tier) and below it (a risky one on a paid tier). Same
 *      reasoning as `resolveEffectiveTrustScore`: clamping either way would
 *      discard half of what the pin is for.
 *   3. **The agent's own lower choice lasts exactly as long as the ceiling it was
 *      made under.** A renewal of the same plan re-emits `plan.activated` without
 *      changing anything, and must not wipe the choice. A real change of ceiling
 *      — a new plan, a verdict, a pin — resets the pool to the new ceiling.
 *
 * Nothing here reads a database, so all three are tested as behaviour, not scanned.
 * `AgentCodPoolService` is the only caller that writes what these compute.
 */

/** The ceiling and where it came from. */
export interface CodPoolCeiling {
    amount: number;
    source: AgentCodPoolSource;
    /** Only for `source === 'plan'`. Display, never a branch. */
    planCode: string | null;
}

export interface CodPoolInputs {
    kycStatus: string | null | undefined;
    override: { amount: number } | null | undefined;
    /** From `EntitlementService.resolveAgentCodPool` — `maxCodPool` is already `?? 0`. */
    plan: { planCode: string | null; maxCodPool: number };
}

/** Integer XAF within the platform bounds. A plan value above the ceiling is clamped, not refused. */
export function clampCodPool(amount: number): number {
    if (!Number.isFinite(amount)) return AGENT_CONFIG.COD_THRESHOLD_MIN;
    return Math.min(
        AGENT_CONFIG.COD_THRESHOLD_MAX,
        Math.max(AGENT_CONFIG.COD_THRESHOLD_MIN, Math.floor(amount)),
    );
}

/** Decision order is the rule: KYC, then the pin, then the plan. */
export function resolveCodPoolCeiling(input: CodPoolInputs): CodPoolCeiling {
    if (input.kycStatus !== 'verified') {
        return { amount: AGENT_CONFIG.COD_THRESHOLD_MIN, source: 'not_verified', planCode: null };
    }
    if (input.override) {
        return { amount: clampCodPool(input.override.amount), source: 'override', planCode: null };
    }
    return { amount: clampCodPool(input.plan.maxCodPool), source: 'plan', planCode: input.plan.planCode };
}

/** What a document holds today — read through Mongoose, so absent fields carry schema defaults. */
export interface StoredCodPool {
    maxThreshold: number;
    ceiling: number;
    source: AgentCodPoolSource;
}

export function storedCodPoolOf(agent: IDeliveryAgent): StoredCodPool {
    return {
        maxThreshold: agent.cod?.max_threshold ?? AGENT_CONFIG.COD_THRESHOLD_MIN,
        ceiling: agent.cod?.pool_ceiling ?? AGENT_CONFIG.COD_THRESHOLD_MIN,
        source: agent.cod?.pool_source ?? 'not_verified',
    };
}

/**
 * The pool after a sync to `next`.
 *
 * The agent's lower choice survives only when BOTH the amount and the source of the
 * ceiling are unchanged. Source matters as well as amount: an administrator pinning
 * exactly the plan's value is still a new ceiling with a new owner, and the agent
 * choosing under the old one did not choose under this one.
 *
 * ⚠ A document written before this rule existed reads `pool_source` at its schema
 * default (`not_verified`, ceiling 0), so a verified agent's first sync always
 * counts as a change and lands on the plan's value. A pool an administrator set
 * under the OLD model is therefore replaced, not preserved — there is no way to tell
 * a deliberate old value from a default one. Re-apply it as a pin if it mattered.
 */
export function nextCodPoolValue(stored: StoredCodPool, next: CodPoolCeiling): number {
    const sameCeiling = stored.ceiling === next.amount && stored.source === next.source;
    if (!sameCeiling) return next.amount;
    return Math.min(Math.max(stored.maxThreshold, AGENT_CONFIG.COD_THRESHOLD_MIN), next.amount);
}

/** Nothing to write: the stored pool already says exactly this. */
export function codPoolInSync(stored: StoredCodPool, next: CodPoolCeiling, planCodeStored: string | null): boolean {
    return stored.ceiling === next.amount
        && stored.source === next.source
        && stored.maxThreshold === nextCodPoolValue(stored, next)
        && (planCodeStored ?? null) === next.planCode;
}

/**
 * The pool as the agent app and the dashboards read it.
 *
 * ⚠ Deliberately NOT the pin's reason or who set it — `source: 'override'` is enough
 * for the agent to know a human decided, and the note is an administrator's internal
 * judgement about them. Same line `GET /agent/cod/balance` draws for `trustSource`.
 * wi-admin reads the pin itself directly off the document.
 */
export interface CodPoolView {
    /** What the agent may carry — the pool every contract sub-allocates from. */
    maxThreshold: number;
    /** The most `maxThreshold` may be raised to by the agent. */
    ceiling: number;
    source: AgentCodPoolSource;
    planCode: string | null;
    /** `maxThreshold < ceiling` — the agent chose to carry less. */
    selfLimited: boolean;
    syncedAt: Date | null;
}

export function describeCodPool(agent: IDeliveryAgent): CodPoolView {
    const stored = storedCodPoolOf(agent);
    return {
        maxThreshold: stored.maxThreshold,
        ceiling: stored.ceiling,
        source: stored.source,
        planCode: agent.cod?.pool_plan_code ?? null,
        selfLimited: stored.maxThreshold < stored.ceiling,
        syncedAt: agent.cod?.pool_synced_at ?? null,
    };
}
