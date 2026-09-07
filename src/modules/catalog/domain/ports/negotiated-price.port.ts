import { ClientSession } from 'mongoose';
import { createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';

/**
 * The negotiated-price seam — how `catalog` reads a price lock minted by
 * `negotiation` without importing it.
 *
 * ── Why a port and not an import (BARGAINING-AGENT-PLAN D-11) ────────────────
 *
 * A direct import closes a REQUIRE CYCLE. `negotiation` needs `catalog` to read
 * the vendor's window (`variant.price`, `bargain.maxPrice`) at gate time, and
 * `PriceResolverService` would need `negotiation` to check the lock. This
 * service has been broken by exactly that before — see `modules/agents/index.ts`
 * on the barrel that crashed the boot with "AuthService is not a constructor".
 *
 * So the direction of knowledge is one-way and the composition root joins them:
 * `catalog` declares this interface, `negotiation` implements it, and
 * `negotiation.bootstrap.ts` registers it at startup. Same shape as
 * `agents/ports/device-location.port.ts`, which exists for the same reason.
 *
 * ── Who decides what (D-11) ─────────────────────────────────────────────────
 *
 * **The verdict is the implementation's; the error mapping is the caller's.**
 * The resolver decides `ok` or a `reason` — INCLUDING D-10's re-read of the
 * vendor's window as it stands at consume time. That re-read must NOT be
 * duplicated in `catalog`: two modules interpreting one lock is the drift this
 * split exists to prevent. `PriceResolverService` maps `reason` onto the
 * `NEGOTIATION_LOCK_*` codes and does no price judgement of its own.
 *
 * ── Two operations, because the lock is consumed LATE (D-12) ────────────────
 *
 * `peek` runs at add-to-cart and writes nothing: a customer may remove and
 * re-add the item, or leave the basket overnight, without burning the price they
 * haggled for. `consume` runs INSIDE the order-creation transaction, so a
 * checkout that rolls back does not burn it either. That is why `consume` takes
 * a `ClientSession` and `peek` does not.
 */

/** Which line a lock is being presented for. All three are part of its binding. */
export interface NegotiatedPriceContext {
  customerId: string;
  variantId: string;
  quantity: number;
}

/**
 * What the resolver decided.
 *
 * `floorSnapshot` is the vendor's floor as of THIS verdict, and it is the number
 * the earnings split must use. Re-reading the floor at split time would read a
 * value the vendor may have changed since — see EarningsSplitService and
 * invariant 1 (`vendorGross >= floor x qty`).
 *
 * The five refusal reasons are a closed set. A caller must treat an unrecognised
 * one as a refusal, never as permission.
 */
export type LockVerdict =
  | { ok: true; unitPrice: number; floorSnapshot: number }
  | { ok: false; reason: 'not_found' | 'expired' | 'consumed' | 'mismatch' | 'window_moved' };

export interface INegotiatedPriceResolver {
  /** Stable name for diagnostics. */
  readonly name: string;

  /** Read-only check. Writes nothing, burns nothing. */
  peek(lockRef: string, context: NegotiatedPriceContext): Promise<LockVerdict>;

  /**
   * Spend the lock. Single-use, and must be idempotent only within the passed
   * transaction — a rolled-back checkout leaves the lock spendable.
   */
  consume(
    lockRef: string,
    context: NegotiatedPriceContext,
    session: ClientSession,
  ): Promise<LockVerdict>;
}

/**
 * The default, and it REFUSES rather than ignores (D-11).
 *
 * ⚠ This is the load-bearing half of the default. An unregistered resolver that
 * quietly fell through to the list price would charge a customer MORE than they
 * agreed — the one failure direction nobody reports as a bug, because the
 * customer assumes they misremembered and the vendor sees a normal sale. So a
 * presented lock with nothing to resolve it is a 500 and a loud log, not a
 * shrug.
 *
 * It throws rather than returning `{ ok: false }` deliberately: every value in
 * `LockVerdict`'s reason set is a statement ABOUT THE LOCK, and "nobody is
 * wired up to look" is a statement about us. Encoding it as `not_found` would
 * tell a customer their agreed price does not exist.
 */
export class UnregisteredNegotiatedPriceResolver implements INegotiatedPriceResolver {
  readonly name = 'unregistered';

  async peek(lockRef: string): Promise<LockVerdict> {
    return this.refuse(lockRef, 'peek');
  }

  async consume(lockRef: string): Promise<LockVerdict> {
    return this.refuse(lockRef, 'consume');
  }

  private refuse(lockRef: string, operation: string): never {
    console.error(
      `[NegotiatedPrice] ${operation}() was called with lock ${lockRef} but no resolver is `
      + 'registered. The negotiation module did not boot, or negotiation.bootstrap.ts was not '
      + 'called from lifecycle.ts. REFUSING the line rather than charging the list price.',
    );
    throw createAppError(
      ERROR_CODES.INTERNAL_SERVER_ERROR,
      500,
      'Negotiated pricing is not available on this deployment',
      { lockRef, operation },
    );
  }
}

/**
 * Registry holding the active resolver.
 *
 * Mirrors `setDeviceLocationProvider` rather than introducing a DI container the
 * codebase does not use. Stream A calls `setNegotiatedPriceResolver()` once at
 * startup; nothing in `PriceResolverService`, the cart or the order service
 * changes when it does.
 */
let activeResolver: INegotiatedPriceResolver = new UnregisteredNegotiatedPriceResolver();

export function setNegotiatedPriceResolver(resolver: INegotiatedPriceResolver): void {
  activeResolver = resolver;
}

export function getNegotiatedPriceResolver(): INegotiatedPriceResolver {
  return activeResolver;
}

/** Test seam: drop back to the refusing default. */
export function resetNegotiatedPriceResolver(): void {
  activeResolver = new UnregisteredNegotiatedPriceResolver();
}
