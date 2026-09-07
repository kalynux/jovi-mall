import { ClientSession } from 'mongoose';
import { createAppError } from '../../../../../core/errors';
import { ERROR_CODES } from '../../../../../core/error-codes';
import { IProductRepository } from '../../../repositories/interfaces/product.repository.interface';
import { IVariantRepository } from '../../../repositories/interfaces/variant.repository.interface';
import {
  getNegotiatedPriceResolver,
  LockVerdict,
  NegotiatedPriceContext,
} from '../../ports/negotiated-price.port';
// ⚠ A domain service reaching into `read-models/` is unusual here, and it is the
// right call: `publicDisplayPrice` is the ONE definition of what a variant is
// shelved at (D-1), written once in two dialects because five storefront
// derivations depend on it. Re-deriving `bargain.maxPrice` in this file would be
// a sixth copy — and the copy that decides what a customer is actually CHARGED,
// which is the one where a divergence is a revenue defect rather than a display
// bug. Stream D owns the rule; this service is a consumer of it.
import { publicDisplayPrice } from '../../../read-models/public-display-price';

/**
 * A negotiated-price lock presented alongside a price request.
 *
 * `mode` is the D-12 split, and it is not an optimisation. `peek` runs at
 * add-to-cart and writes nothing, so a customer may remove and re-add the item
 * or leave the basket overnight without burning the price they haggled for;
 * `consume` runs inside the order-creation transaction, so a checkout that rolls
 * back does not burn it either.
 */
export interface NegotiationLockCommand {
  /** The opaque reference the bargaining agent minted when the deal closed. */
  lockRef: string;
  /** Who is spending it. Part of the lock's binding — never taken from a body. */
  customerId: string;
  mode: 'peek' | 'consume';
  /** The order-creation transaction. Required for `consume`; unused by `peek`. */
  session?: ClientSession;
}

export interface ResolvePriceCommand {
  productId: string;
  variantId: string;
  vendorId: string;
  quantity: number;
  /** Optional. Absent = the ordinary list-price path, unchanged. */
  negotiation?: NegotiationLockCommand;
}

export interface ResolvedPrice {
  unitPrice: number;
  compareAtPrice?: number;
  total: number;
  discount?: number;
  /**
   * Present ONLY when a lock was honoured, in which case `unitPrice` is the
   * agreed price rather than the shelf price.
   */
  negotiated?: {
    lockRef: string;
    /**
     * The vendor's floor as of the verdict that honoured this lock. Carried
     * forward to the earnings split, which must not re-read it: the vendor may
     * have changed it since, and the AI margin is a share of the uplift over the
     * floor that was actually in force.
     */
    floorPrice: number;
  };
}

/**
 * PriceResolverService: Compute final payable price with deterministic logic.
 *
 * ── The negotiated-price seam (BARGAINING-AGENT-PLAN Stream C) ───────────────
 *
 * This is the one place a unit price is decided, which is why the lock is read
 * here and not in the cart or the order service. It reads through
 * `catalog/domain/ports/negotiated-price.port.ts` — the negotiation module
 * implements it and registers itself at boot — because a direct import would
 * close a require cycle: `negotiation` needs `catalog` to read the vendor's
 * window at gate time.
 *
 * **The verdict is the resolver's; only the error mapping is here.** In
 * particular D-10's re-read of `variant.price` / `bargain.maxPrice` as they
 * stand at consume time happens on the resolver's side and must NOT be
 * duplicated in this file — two modules interpreting one lock is the drift the
 * port exists to prevent. This service asks, and renders the answer.
 *
 * ⚠ A presented lock that cannot be resolved is REFUSED, never ignored. Falling
 * back to the shelf price would charge a customer more than they agreed, which
 * is the one failure direction nobody reports as a bug — the customer assumes
 * they misremembered and the vendor sees an ordinary sale. The port's default
 * resolver throws for exactly that reason.
 */
export class PriceResolverService {
  constructor(
    private readonly productRepository: IProductRepository,
    private readonly variantRepository: IVariantRepository
  ) { }

  async execute(command: ResolvePriceCommand): Promise<ResolvedPrice> {
    const product = await this.productRepository.findById(command.productId, command.vendorId);

    if (!product) throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);
    if (product.vendorId !== command.vendorId) throw createAppError(ERROR_CODES.CATALOG_PRODUCT_ACCESS_DENIED, 403);
    if (product.status !== 'active') throw createAppError(ERROR_CODES.CATALOG_PRODUCT_INVALID_STATE, 422, undefined, { status: product.status });

    const variant = await this.variantRepository.findById(command.variantId);

    if (!variant) throw createAppError(ERROR_CODES.CATALOG_VARIANT_NOT_FOUND, 404);
    if (variant.productId !== command.productId) throw createAppError(ERROR_CODES.CATALOG_VARIANT_ACCESS_DENIED, 403);
    if (variant.status !== 'active') throw createAppError(ERROR_CODES.CATALOG_VARIANT_ARCHIVED, 422);

    if (command.quantity < 1) throw createAppError(ERROR_CODES.CATALOG_VARIANT_INVALID_QUANTITY, 400, 'Quantity must be at least 1');

    if (product.type === 'service' && command.quantity !== 1) {
      throw createAppError(ERROR_CODES.CATALOG_VARIANT_INVALID_QUANTITY, 400, 'Service products must have quantity of 1');
    }

    // The lock is resolved AFTER the catalogue gates above, deliberately. A
    // product pulled from sale is refused whatever price was agreed for it, and
    // `consume` must not spend a single-use lock on a line that was going to be
    // refused anyway.
    const negotiated = command.negotiation
      ? await this.resolveNegotiatedPrice(command.negotiation, command.variantId, command.quantity)
      : null;

    /**
     * With a lock: the agreed price. Without one: what the STOREFRONT displays.
     *
     * ⚠ The second half is not cosmetic and it closes a live defect Stream D
     * handed over. Under D-1 a bargainable variant is shelved at its ask and
     * `variant.price` becomes the vendor's FLOOR — so once the storefront flipped
     * (it has), returning `variant.price` here meant a shopper who added such a
     * variant without negotiating was shown 48 000 and charged 30 001. It fails
     * customer-favourably, which is exactly why nothing went red: no test breaks
     * and no vendor sees an error, they are simply paid their floor on every
     * un-haggled sale.
     *
     * Re-read at resolve time from the same function the storefront quotes from,
     * so the two cannot drift.
     *
     * ⚠ This makes D-5's "only on orders carrying a negotiation lock" do real
     * work rather than describe an edge case: an un-negotiated sale of a
     * bargainable variant now has `P === ask` and therefore a non-zero uplift
     * over the floor — and must still yield NO AI margin, because no model was
     * involved. `EarningsSplitService` gates on the lock explicitly for that
     * reason; see the `negotiated_unit_price != null` test at both call sites.
     */
    const unitPrice = negotiated
      ? negotiated.unitPrice
      : publicDisplayPrice(product.vectorisationEnabled, variant);

    if (unitPrice < 0) throw createAppError(ERROR_CODES.CATALOG_VARIANT_INVALID_PRICE, 400, 'Price cannot be negative');

    const total = unitPrice * command.quantity;

    let discount: number | undefined;
    if (variant.compareAtPrice && variant.compareAtPrice > unitPrice) {
      discount = variant.compareAtPrice - unitPrice;
    }

    return {
      unitPrice,
      compareAtPrice: variant.compareAtPrice,
      total,
      discount,
      ...(negotiated
        ? {
          negotiated: {
            lockRef: command.negotiation!.lockRef,
            floorPrice: negotiated.floorSnapshot,
          },
        }
        : {}),
    };
  }

  /**
   * Ask the port, and turn a refusal into the right code.
   *
   * `consume` with no session is an INTERNAL error rather than a silent
   * downgrade to `peek`: spending a single-use lock outside the order's
   * transaction means a checkout that fails afterwards has still burned it, and
   * the customer is then told their agreed price was already used on an order
   * that does not exist.
   */
  private async resolveNegotiatedPrice(
    negotiation: NegotiationLockCommand,
    variantId: string,
    quantity: number,
  ): Promise<Extract<LockVerdict, { ok: true }>> {
    const context: NegotiatedPriceContext = {
      customerId: negotiation.customerId,
      variantId,
      quantity,
    };

    const resolver = getNegotiatedPriceResolver();

    let verdict: LockVerdict;
    if (negotiation.mode === 'consume') {
      if (!negotiation.session) {
        throw createAppError(
          ERROR_CODES.INTERNAL_SERVER_ERROR,
          500,
          'Consuming a negotiated price requires the order-creation transaction',
          { lockRef: negotiation.lockRef },
        );
      }
      verdict = await resolver.consume(negotiation.lockRef, context, negotiation.session);
    } else {
      verdict = await resolver.peek(negotiation.lockRef, context);
    }

    if (verdict.ok) return verdict;

    throw createAppError(
      LOCK_REFUSAL_CODES[verdict.reason] ?? ERROR_CODES.NEGOTIATION_LOCK_INVALID,
      LOCK_REFUSAL_STATUSES[verdict.reason] ?? 404,
      undefined,
      { lockRef: negotiation.lockRef, variantId, quantity, reason: verdict.reason },
    );
  }
}

/**
 * `LockVerdict.reason` to the code the client sees. This mapping is the whole of
 * what `catalog` decides about a lock.
 *
 * ⚠ An unrecognised reason falls through to `NEGOTIATION_LOCK_INVALID` at the
 * call site above — a refusal, never permission. The resolver lives in another
 * module and may grow a reason before this table does.
 */
const LOCK_REFUSAL_CODES = {
  not_found: ERROR_CODES.NEGOTIATION_LOCK_INVALID,
  expired: ERROR_CODES.NEGOTIATION_LOCK_EXPIRED,
  consumed: ERROR_CODES.NEGOTIATION_LOCK_CONSUMED,
  mismatch: ERROR_CODES.NEGOTIATION_LOCK_VARIANT_MISMATCH,
  window_moved: ERROR_CODES.NEGOTIATION_LOCK_WINDOW_MOVED,
} as const;

/**
 * Each code is raised at exactly ONE status, everywhere. `test:errors` censuses
 * every `createAppError` site and fails a code whose two statuses disagree on
 * category, and the category is what decides whether the message survives the
 * Phase-16 boundary filter. All five here are client-safe on purpose — the chat
 * has to be able to explain the refusal and reopen the negotiation.
 *
 * 409 for `consumed` and `window_moved`, because both are "the state moved under
 * you"; 422 for `expired` and `mismatch`, because the request was well-formed
 * and a rule refused it; 404 for `not_found`, because there is no such lock.
 */
const LOCK_REFUSAL_STATUSES = {
  not_found: 404,
  expired: 422,
  consumed: 409,
  mismatch: 422,
  window_moved: 409,
} as const;
