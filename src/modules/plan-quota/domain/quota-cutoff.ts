/**
 * Where a plan's allowance runs out.
 *
 * These two functions are the whole judgement of the plan-quota feature, and they are
 * **pure** — no database, no clock, no I/O — so the rule can be asserted exhaustively
 * without Mongo (`npm run test:plan-quota`). Everything around them is plumbing that
 * fetches rows, writes flags and reports counts.
 *
 * ── The rule, stated once ────────────────────────────────────────────────────────
 * Items are ordered **oldest first** and the allowance is filled from that end. What
 * fits stays; everything past the cut-off is suspended (products) or blocked (files),
 * newest first. An upgrade re-runs the identical computation against the bigger number,
 * so restoration is oldest-first by construction rather than by a second algorithm that
 * could disagree with this one.
 *
 * The caller supplies the ordering. It must be `createdAt` ASC with an `_id` tie-break —
 * see the repository methods, where the reason (bulk writes landing in one millisecond,
 * and an unstable sort moving the cut-off between runs) is written out.
 */

/** An item competing for a plan slot or for storage bytes. */
export interface QuotaCandidate {
    id: string;
    /** Bytes this item consumes. Ignored by the count-based planner. */
    size?: number;
    /** Whether the item is *currently* held back by the quota. */
    blocked: boolean;
    /**
     * The item consumes its slot but can never be taken away by this rule.
     *
     * Products suspended for one of the OTHER four reasons are pinned: a listing an
     * administrator took down, or an agency froze over unpaid storage, still occupies
     * room in the plan the vendor is paying for, and the disjointness rule forbids the
     * quota sweep from touching its suspension.
     *
     * ⚠ Without this, the sweep cannot converge. Such a product is counted by
     * `countActiveByVendor` but is refused by `suspendProductsForQuota` (already
     * `suspended`), so if the planner denied it the sweep would try to suspend it, fail,
     * find the owner still over cap, and repeat forever. Pinning makes it consume a slot
     * and pushes a *suspendable* product out in its place, which converges.
     *
     * Files have no equivalent and never set this — see `planSizeCutoff`.
     */
    pinned?: boolean;
}

/** What must change to bring the owner in line with their plan. */
export interface QuotaPlan {
    /** Items that must become blocked/suspended (currently free, now outside the allowance). */
    toBlock: string[];
    /** Items that must be released (currently held back, now inside the allowance). */
    toRelease: string[];
    /** Everything inside the allowance after this plan is applied — the survivors. */
    allowed: string[];
    /** Everything outside it. */
    denied: string[];
}

function diff(candidates: QuotaCandidate[], allowedIds: Set<string>): QuotaPlan {
    const toBlock: string[] = [];
    const toRelease: string[] = [];
    const allowed: string[] = [];
    const denied: string[] = [];

    for (const c of candidates) {
        const fits = allowedIds.has(c.id);
        if (fits) {
            allowed.push(c.id);
            if (c.blocked) toRelease.push(c.id);
        } else {
            denied.push(c.id);
            if (!c.blocked) toBlock.push(c.id);
        }
    }

    return { toBlock, toRelease, allowed, denied };
}

/**
 * Count-based cut-off — the product rule. The oldest `limit` candidates fit.
 *
 * `limit === null` means unlimited: everything fits, and every currently-suspended item
 * is released. That is the upgrade-to-Business path and it must not be special-cased
 * anywhere else.
 *
 * ⚠ A `limit` of 0 is a real value, not a missing one, and it denies everything. Only
 * `null` means unlimited — do not collapse the two, or a plan configured with no
 * product allowance would silently grant an infinite one.
 *
 * ── Pinned items are budgeted FIRST, not in sequence ─────────────────────────────
 * Their slots are reserved before the walk rather than consumed as they are met. Taking
 * them in order would let an *older* suspendable product claim a slot that a *newer*
 * pinned one then also takes, leaving the owner one over cap — and the sweep would
 * report success while the count still exceeded the limit. Reserving first means the
 * survivors are always exactly `max(pinnedCount, limit)`.
 *
 * When pinned items alone exceed the limit the remaining budget is zero and every
 * suspendable item is denied. That is a real terminal state (more administratively
 * suspended listings than the plan allows), it is the best achievable, and it is
 * idempotent — the next sweep changes nothing.
 */
export function planCountCutoff(candidates: QuotaCandidate[], limit: number | null): QuotaPlan {
    if (limit === null) {
        return diff(candidates, new Set(candidates.map(c => c.id)));
    }

    const pinnedCount = candidates.reduce((n, c) => (c.pinned ? n + 1 : n), 0);
    let remaining = Math.max(0, limit - pinnedCount);

    const allowedIds = new Set<string>();
    for (const c of candidates) {
        if (c.pinned) {
            allowedIds.add(c.id);
            continue;
        }
        if (remaining > 0) {
            allowedIds.add(c.id);
            remaining -= 1;
        }
    }

    return diff(candidates, allowedIds);
}

/**
 * Size-based cut-off — the storage rule. Accumulate sizes oldest-first; **the first
 * item that does not fit ends the run, and everything from there on is denied**
 * regardless of its own size.
 *
 * ⚠ **Stop-at-first-miss, deliberately, rather than skip-and-continue.** The tempting
 * alternative — keep walking and admit any later item small enough to squeeze into the
 * remaining bytes — packs the allowance fuller, and is wrong here for two reasons.
 * It makes the visible set depend on the *sizes* of files rather than on their age, so
 * a customer looking at a product cannot be told "your oldest images are the ones that
 * stay". And it is unstable under unrelated edits: deleting one small file can change
 * which of the *later* files fit, so an owner tidying up their library watches a
 * different, arbitrary subset of images reappear and vanish. The rule the owner asked
 * for is a prefix — "images 1–4 fit, so 5, 6, 7 and 8 are blocked" — and a prefix is
 * what this returns.
 *
 * An item larger than the entire allowance therefore denies everything after it, which
 * is correct: there is no arrangement in which it and its successors all fit.
 *
 * `pinned` is ignored here, deliberately: no file can be pinned. The flag exists for the
 * product rule, where a listing suspended for an unrelated reason must keep its slot.
 */
export function planSizeCutoff(candidates: QuotaCandidate[], limitBytes: number): QuotaPlan {
    const allowedIds = new Set<string>();
    let used = 0;

    for (const c of candidates) {
        const size = c.size ?? 0;
        if (used + size > limitBytes) break;
        used += size;
        allowedIds.add(c.id);
    }

    return diff(candidates, allowedIds);
}
