import { IDeliveryAgent } from '../../models/agent.model';

/**
 * ─── The effective trust score, and the ONE place the two are reconciled ─────
 *
 * An agent has a **computed** trust score and, sometimes, a **pinned** one.
 * Everything that makes a decision on trust must read this function and never
 * `agent.cod.trust_score` directly — that is the entire mechanism, and it is
 * three lines of code because the design work went into where it is called.
 *
 * ── Why this exists (O-7, answered 2026-08-23) ───────────────────────────────
 *
 * `cod.trust_score` is derived. Today `CodTrustService.applyEvent` derives it
 * from deltas; after the cutover `AgentTrustRecomputeWorker` will derive it from
 * the five-factor composite. Either way a recompute overwrites it, which is
 * correct for a signal and destructive for a judgement.
 *
 * Phase 6 Step 11 measured what that costs: an agent the platform had **blocked**
 * at a live 35 scores **100** under the composite, because half its weight is
 * ratings and there are no ratings yet. The first nightly recompute after the
 * flip would hand that agent full cash exposure. O-7 asked whether an
 * administrator's judgement survives a recompute; the owner answered that it
 * must, as a persistent override.
 *
 * ── The property that makes the cutover safe ─────────────────────────────────
 *
 * The override is a **separate field, consulted at read time**. Nothing about it
 * is coupled to which mechanism computes the score, so it behaves identically
 * before and after the flip and **no recompute can erase it** — not because
 * somebody remembered to exclude it, but because no recompute writes this field
 * at all. The flip stays the one-line change it was always meant to be.
 *
 * The alternative shapes were both rejected for the same reason: an admin
 * writing `trust_score` directly is exactly what does not survive, and a
 * recompute that folds the override in (`override ?? composite` → `trust_score`)
 * collapses *computed* and *pinned* into one field, after which nothing can tell
 * them apart and there is no way to un-pin.
 */

export type TrustScoreSource = 'override' | 'computed';

export interface EffectiveTrustScore {
    /** What every gate must act on. */
    score: number;
    /** Which of the two it came from — for DTOs and audit, never for a branch. */
    source: TrustScoreSource;
    /** The computed score, always. Reported beside the override so a screen can show both. */
    computed: number;
    /** Present only when `source === 'override'`. */
    override: {
        score: number;
        reason: string;
        setAt: Date;
        setByName: string | null;
    } | null;
}

/**
 * Resolve the score that actually applies to this agent.
 *
 * ⚠ **An override wins in BOTH directions.** It is not a floor and not a ceiling:
 * an administrator pinning 35 on an agent the composite scores 100 is the case
 * O-7 was raised about, and an administrator pinning 90 on an agent a bad month
 * dropped to 40 is the ordinary remediation. Clamping either way would silently
 * discard half of what the override is for.
 */
export function resolveEffectiveTrustScore(agent: IDeliveryAgent): EffectiveTrustScore {
    const computed = agent.cod?.trust_score ?? 100;
    const pinned = agent.cod?.trust_override ?? null;

    if (!pinned) {
        return { score: computed, source: 'computed', computed, override: null };
    }

    return {
        score: pinned.score,
        source: 'override',
        computed,
        override: {
            score: pinned.score,
            reason: pinned.reason,
            setAt: pinned.set_at,
            setByName: pinned.set_by_name ?? null,
        },
    };
}

/** Shorthand for the many call sites that want only the number. */
export function effectiveTrustScore(agent: IDeliveryAgent): number {
    return resolveEffectiveTrustScore(agent).score;
}
