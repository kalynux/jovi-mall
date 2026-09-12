import { ClientSession } from 'mongoose';

import {
    INegotiatedPriceResolver,
    LockVerdict,
    NegotiatedPriceContext,
} from '../../catalog/domain/ports/negotiated-price.port';
import { judgeLock, LockWindow } from '../domain/lock-verdict.rule';
import { NegotiationSessionModel } from '../models/negotiation-session.model';
import { liveWindowReader } from './live-window.reader';

/**
 * `negotiation`'s implementation of catalog's negotiated-price port (plan D-11).
 *
 * Registered once at boot by `negotiation.bootstrap.ts`. Until it is, the port's
 * default resolver REFUSES every presented lock with a 500 and a loud log rather
 * than falling through to the shelf price — so the two halves deploy in either
 * order, and a missing registration is noisy instead of expensive.
 *
 * ── This class is I/O; the decision is `lock-verdict.rule.ts` ───────────────
 *
 * Find the session by its lock handle, read the vendor's window as it stands,
 * hand both to `judgeLock`, and — for `consume` only — burn the lock. Every
 * branch that decides whether a customer is charged their agreed price lives in
 * the pure rule, where `test:negotiation-lock` can reach it without Mongo.
 *
 * ── Two operations, because the lock is consumed LATE (D-12) ────────────────
 *
 * `peek` runs at add-to-cart and writes nothing, so a customer may remove and
 * re-add the line, or leave the basket overnight, without burning the price they
 * haggled for. `consume` runs INSIDE the order-creation transaction, so a
 * checkout that rolls back does not burn it either.
 *
 * ── A refusal is a returned verdict, never a throw ──────────────────────────
 *
 * `PriceResolverService` maps the five reasons onto the `NEGOTIATION_LOCK_*`
 * codes, all of which are client-safe so the chat can explain what happened and
 * reopen the negotiation. Throwing from here would bypass that mapping and
 * produce the generic 500 the whole seam is built to avoid.
 */
export class NegotiatedPriceResolver implements INegotiatedPriceResolver {
    readonly name = 'negotiation';

    /** Read-only check. Writes nothing, burns nothing. */
    async peek(lockRef: string, context: NegotiatedPriceContext): Promise<LockVerdict> {
        return this.judge(lockRef, context);
    }

    /**
     * Spend the lock, inside the caller's transaction.
     *
     * The burn is a **compare-and-set on `lock.consumed_at: null`**, not a
     * read-then-save. Two checkouts racing for one lock is exactly the situation
     * a single-use credential exists to lose, and an unguarded `save()` lets both
     * win: each reads `consumed_at: null`, each writes its own timestamp, and the
     * customer is charged the negotiated price twice. The CAS makes the loser's
     * update match zero documents, and it is answered `consumed` — the truth.
     *
     * Everything here runs on the passed `session`, the read included, so the
     * window the verdict was judged against and the row it burns are the same
     * snapshot. A rollback afterwards leaves the lock spendable, which is the
     * property D-12 is buying.
     */
    async consume(
        lockRef: string,
        context: NegotiatedPriceContext,
        session: ClientSession,
    ): Promise<LockVerdict> {
        const verdict = await this.judge(lockRef, context, session);
        if (!verdict.ok) {
            // A refused consume is a checkout dying on a promise the bot already
            // made to a customer, which is worth a line in the log even though the
            // caller renders it properly. A refused `peek` is not: a stale ref in a
            // model's context is ordinary and self-correcting.
            console.warn(
                `[NegotiatedPrice] consume REFUSED lock ${lockRef} (${verdict.reason}) for variant `
                + `${context.variantId} x${context.quantity}`,
            );
            return verdict;
        }

        const burn = await NegotiationSessionModel.updateOne(
            { 'lock.ref': lockRef, 'lock.consumed_at': null, deletedAt: null },
            {
                $set: {
                    'lock.consumed_at': new Date(),
                    // The haggle is over: this session minted the price that was
                    // just spent. `expired` is for a lapse nobody acted on, so
                    // `closed` is the honest terminal state here.
                    status: 'closed',
                },
            },
            { session },
        );

        /**
         * Zero matched after a verdict that said `ok` means somebody else burned
         * it between the read and the write. Inside a transaction that is a narrow
         * window, and Mongo would more often raise a write conflict than let it
         * happen — but "narrow" is not "closed", and the failure it guards against
         * is charging one agreed price twice.
         */
        if (burn.matchedCount === 0) return { ok: false, reason: 'consumed' };

        /**
         * ⚠ `lock.consumed_by_order_id` is deliberately left null, and it is the
         * one field on the lock this implementation cannot fill.
         *
         * D-12 puts `consume` BEFORE the order document exists — `resolveNegotiatedLines`
         * runs first inside the transaction precisely so a refusal costs nothing,
         * and it runs before the totals because the verdict may carry a different
         * price from the cart's snapshot. So there is no order id to record yet,
         * and the port's signature carries none. The column is audit-only (the
         * model's own comment says so) and `consumed_at` already establishes that
         * the lock was spent; the order side of the link is recoverable from
         * `order_items.negotiation_lock_ref`. Filling it would mean either passing
         * a pre-minted order id through the port — a two-sided change to a
         * published interface — or a second write after the order is built.
         */
        return verdict;
    }

    /**
     * The shared read-and-judge behind both operations.
     *
     * `session` is present for `consume` and absent for `peek`, and it is threaded
     * into BOTH reads. Judging a lock against a window read outside the
     * transaction that burns it would reintroduce the check-then-act gap the
     * transaction exists to close.
     */
    private async judge(
        lockRef: string,
        context: NegotiatedPriceContext,
        session?: ClientSession,
    ): Promise<LockVerdict> {
        const options = session ? { session } : {};

        const negotiation = await NegotiationSessionModel.findOne(
            { 'lock.ref': lockRef, deletedAt: null },
            null,
            options,
        );

        // No session carries this handle. Also the answer for a handle belonging to
        // somebody else, decided one level down in `judgeLock` — see its note on
        // why confirming a guessed lock is real is itself a disclosure.
        if (!negotiation?.lock) return { ok: false, reason: 'not_found' };

        const read = await liveWindowReader.read(negotiation.variant_id.toString(), options);

        /**
         * Every miss collapses to "no window in force", which `judgeLock` refuses
         * as `window_moved`.
         *
         * The finer misses the reader distinguishes — an archived variant, a
         * product pulled from sale — are unreachable from here in practice:
         * `PriceResolverService` gates on all of them and throws the catalogue's
         * own codes BEFORE it asks the port. What is reachable is
         * `not_bargainable`, the vendor clearing the window mid-lock, and that is
         * `window_moved` in the most literal sense.
         */
        const window: LockWindow | null = read.ok
            ? { floor: read.window.floor, ask: read.window.ask }
            : null;

        return judgeLock({
            lock: {
                unit_price: negotiation.lock.unit_price,
                expires_at: negotiation.lock.expires_at,
                consumed_at: negotiation.lock.consumed_at ?? null,
            },
            binding: {
                // The binding is the SESSION's, not a copy on the lock — see
                // `LockBinding`. `customer_id` is the Customer profile, which is
                // what the cart and the order scope on and therefore what arrives
                // in `context.customerId`.
                customerId: negotiation.customer_id.toString(),
                variantId: negotiation.variant_id.toString(),
                quantity: negotiation.quantity,
            },
            presented: context,
            window,
            now: new Date(),
        });
    }
}

export const negotiatedPriceResolver = new NegotiatedPriceResolver();
