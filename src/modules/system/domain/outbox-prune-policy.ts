/**
 * The policy for pruning delivered tracking-outbox rows.
 *
 * ADR-014 named "`sent` rows are never pruned" as a debt: the collection's only index is
 * `{status: 1, created_at: 1}`, so every scan over it — the dispatcher's own drain included —
 * gets slower with age, forever. This is the phase's ONE new dangerous verb, and it is shaped
 * by the same three guards the cache flush uses, with one of them pointed at a different field.
 *
 * Pure and DB-free, so `test:system` can drive every refusal from literals.
 */

/**
 * The floor, in days. Hard, and not configurable.
 *
 * A `sent` row younger than the dispatcher's own retry horizon is not safely disposable, and a
 * week of delivery history is the minimum an investigation into "did geo-tracker get this event"
 * needs. Making it an environment variable would let the one guard that bounds the blast radius
 * be turned down to zero by configuration.
 */
export const PRUNE_MIN_AGE_DAYS = 7;
export const PRUNE_MAX_AGE_DAYS = 365;
export const PRUNE_MAX_LIMIT = 50_000;

export interface PruneRequest {
    olderThanDays: number;
    /**
     * The literal string `'sent'`. Not an enum, and that is the decision — see the refusal
     * below for why a field that COULD take another value is a field somebody will pass another
     * value to.
     */
    status: string;
    limit?: number;
    dryRun?: boolean;
    confirm: string;
}

export interface PrunePlan {
    ok: true;
    status: 'sent';
    olderThanDays: number;
    cutoff: Date;
    limit: number;
    dryRun: boolean;
}

export interface PruneRefusal {
    ok: false;
    code: 'status_not_prunable' | 'age_below_floor' | 'age_above_ceiling' | 'confirmation_mismatch';
    message: string;
}

export function resolvePrunePlan(request: PruneRequest, now: Date): PrunePlan | PruneRefusal {
    /**
     * **Only `sent`.**
     *
     * Pruning `failed` rows destroys the evidence `POST /dev-tools/outbox/replay` exists to act
     * on — the operator would delete the backlog they were about to retry. Pruning `pending`
     * destroys undelivered events outright: geo-tracker would never learn that a shipment
     * completed, and the tracking session would stay open forever. Neither is a variant of this
     * operation; each would be a different endpoint with a different argument.
     */
    if (request.status !== 'sent') {
        return {
            ok: false,
            code: 'status_not_prunable',
            message:
                'Only `sent` rows may be pruned. `failed` rows are the input to outbox/replay and '
                + '`pending` rows have not reached geo-tracker yet — deleting either loses events '
                + 'rather than reclaiming space.',
        };
    }

    if (!Number.isFinite(request.olderThanDays) || request.olderThanDays < PRUNE_MIN_AGE_DAYS) {
        return {
            ok: false,
            code: 'age_below_floor',
            message:
                `olderThanDays must be at least ${PRUNE_MIN_AGE_DAYS}. A row younger than the `
                + 'dispatcher\'s own retry horizon is not safely disposable, and a week of delivery '
                + 'history is the minimum an investigation needs.',
        };
    }

    if (request.olderThanDays > PRUNE_MAX_AGE_DAYS) {
        return {
            ok: false,
            code: 'age_above_ceiling',
            message: `olderThanDays must be at most ${PRUNE_MAX_AGE_DAYS}.`,
        };
    }

    /**
     * `confirm` repeats the AGE, not a magic word.
     *
     * The cache flush's `confirm` repeats a database name because the database is what decides
     * that operation's blast radius. Here the only variable that decides it is the age, so that
     * is what gets repeated. `confirm: "sent"` would be typed reflexively and would confirm
     * nothing — the status is already fixed.
     */
    if (request.confirm !== String(request.olderThanDays)) {
        return {
            ok: false,
            code: 'confirmation_mismatch',
            message: `"confirm" must repeat olderThanDays exactly (as the string "${request.olderThanDays}").`,
        };
    }

    const requested = request.limit ?? PRUNE_MAX_LIMIT;
    const limit = Math.min(Math.max(Math.trunc(requested), 1), PRUNE_MAX_LIMIT);

    return {
        ok: true,
        status: 'sent',
        olderThanDays: request.olderThanDays,
        cutoff: new Date(now.getTime() - request.olderThanDays * 24 * 60 * 60 * 1000),
        limit,
        // Defaults to a dry run, exactly as the cache flush does. An operator has to ask twice.
        dryRun: request.dryRun !== false,
    };
}
