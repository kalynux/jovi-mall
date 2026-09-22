import { categoryFor } from '../../../core/error-category';
import { ERROR_CODES } from '../../../core/error-codes';
import { AppError } from '../../../core/errors';
import { CartService } from '../../cart/services/cart.service';
import type { BasketRefusal } from '../domain/deal-in-basket';

/**
 * Put an agreed deal into the customer's basket, at the locked price — **the one place both
 * closers do it.**
 *
 * ── THE TWO CALLERS ─────────────────────────────────────────────────────────
 *   - the **Lock it in** press (`bot-negotiation.controller.ts`), right after `acceptOffer` minted
 *     or found the lock;
 *   - the **spoken close** (`NegotiationService.record` with `lock: true`), right after the gate
 *     minted it.
 *
 * Before 2026-09-22 only the first existed; a deal the agent agreed in words minted a lock and
 * stopped, and the item reached the basket only if a later turn remembered to spend it. Both now
 * run THIS, with the same arguments, so the two closers cannot drift apart on what "agreed" does.
 *
 * ── ⚠ THE SAME `CartService.addToCart` EVERY DOOR CALLS ─────────────────────
 * Every stock rule, digital cap and physical-or-digital rule stays where the storefront exercises
 * it, and the cart re-validates the lock itself (a `peek`, D-12) — so a lock that lapsed, or whose
 * window moved, is refused by the one rule checkout also applies, never by a second opinion here.
 *
 * ⭐ **Idempotent by construction.** A cart add that presents a lock SETS the line to the lock's
 * quantity and price rather than incrementing it (`cart.service.ts`, "A LOCKED add SETS the
 * line"). So a double press, a retried gate call, or a press after a spoken close all leave ONE
 * line at the agreed price — and a line already in the basket at the shelf price is re-priced to
 * the deal rather than duplicated.
 *
 * ── A REFUSAL IS AN OUTCOME, NEVER A THROW ──────────────────────────────────
 * By the time this runs the lock is committed: the deal is agreed whatever the basket says. The
 * gate must therefore still answer `approved` — failing it would tell the bargaining flow the price
 * was refused, and the customer would hear nothing about a deal that exists. So every failure comes
 * back as data, with the ORIGINAL error attached: the press rethrows it (its reply has always been
 * the bot surface's error envelope, and stays so), the gate renders it into its message.
 *
 * Dependencies are injected so `test:negotiation` drives every branch with no database.
 */

/** Everything a basket write needs — every field read from the negotiation record, never a caller. */
export interface AgreedDeal {
    /** The `Customer` profile — what sessions, carts and orders scope on. */
    customerId: string;
    productId: string;
    variantId: string;
    /** The quantity the lock is bound to. The cart sets the line to exactly this. */
    quantity: number;
    currency: string;
    /** The lock's handle. Presented to the cart, which peeks it; never shown to anybody. */
    lockRef: string;
}

export type DealBasketOutcome =
    | { placed: true }
    | {
          placed: false;
          /** The error exactly as the cart raised it — the press rethrows this unchanged. */
          error: unknown;
          refusal: BasketRefusal;
      };

export interface DealBasketDeps {
    addToCart(deal: AgreedDeal): Promise<unknown>;
}

export async function placeDealInBasket(deps: DealBasketDeps, deal: AgreedDeal): Promise<DealBasketOutcome> {
    try {
        await deps.addToCart(deal);
        return { placed: true };
    } catch (error) {
        if (error instanceof AppError) {
            return {
                placed: false,
                error,
                refusal: { code: error.code, category: error.category, details: error.details },
            };
        }

        /**
         * Not a refusal the cart meant — a fault. Classified as the global handler would classify
         * it, so the customer reads the platform's ordinary "something went wrong" sentence rather
         * than nothing, and the original error still travels with the outcome for the press.
         */
        return {
            placed: false,
            error,
            refusal: {
                code: ERROR_CODES.INTERNAL_SERVER_ERROR,
                category: categoryFor(ERROR_CODES.INTERNAL_SERVER_ERROR, 500),
            },
        };
    }
}

const cartService = new CartService();

/** Production wiring: the storefront's own cart write, with the lock presented. */
export const CART_DEAL_BASKET: DealBasketDeps = {
    addToCart: (deal) =>
        cartService.addToCart(
            deal.customerId,
            deal.productId,
            deal.variantId,
            deal.quantity,
            deal.currency,
            deal.lockRef,
        ),
};
