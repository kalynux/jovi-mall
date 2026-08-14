import { ClientSession } from 'mongoose';
import { createAppError } from '../../../../../core/errors';
import { ERROR_CODES } from '../../../../../core/error-codes';
import { TransactionManager } from '../../../../../core/database/transaction.manager';
import { IProductRepository } from '../../../repositories/interfaces/product.repository.interface';
import { IVariantRepository } from '../../../repositories/interfaces/variant.repository.interface';
import { IStockReservationRepository } from '../../../repositories/interfaces/stock-reservation.repository.interface';
import { IDigitalAssetRepository } from '../../../repositories/interfaces/digital-asset.repository.interface';
import { IAvailabilityRepository } from '../../../repositories/interfaces/availability.repository.interface';
import { StockReservation } from '../../../repositories/mappers/stock-reservation.mapper';
import { Variant } from '../../../repositories/mappers/variant.mapper';
import { ReservationType } from '../../../models/stock-reservation.model';

export interface ReserveStockCommand {
  productId: string;
  variantId: string;
  vendorId: string;
  quantity: number;
  reservationId: string;
  ttlMinutes: number;
  /**
   * Join the caller's transaction instead of opening a new one.
   *
   * Load-bearing at checkout. `TransactionManager` has no nesting support, so without this
   * the reservation would commit in a **separate** session from the order creation that
   * asked for it — and an order that then rolled back would leave its hold behind, holding
   * units nothing will ever release. Pass the checkout's session and the reservation lives
   * or dies with the order.
   */
  session?: ClientSession;
}

/**
 * StockReservationService: hold stock for a checkout, before payment.
 *
 * ── ⚠️ The semantics changed, and the old ones were unsafe ──────────────────
 *
 * This class used to **decrement `variant.stock` at reservation time**, with
 * `StockCommitService` doing no stock write at all ("already decremented during
 * reservation") and `StockReleaseService` incrementing it back. Nothing ever called any of
 * the three, so it had never run. Wiring it as written would have broken two things:
 *
 * 1. **`InventoryAvailabilityCalculator` would double-count.** It computes
 *    `allowOversell ? stock : stock − activeReservations`, which is only correct if `stock`
 *    means *physically on hand*. With decrement-at-reserve, the same units are subtracted
 *    twice — once from the counter, once again as an active reservation.
 *
 * 2. **An abandoned checkout would destroy inventory permanently.** The model carries
 *    `index({ expiresAt: 1 }, { expireAfterSeconds: 0 })`, so Mongo *deletes* an expired
 *    reservation row. Stock had already been decremented and only `StockReleaseService`
 *    put it back — and it can never run on a row that no longer exists. Every abandoned
 *    cart would have quietly eaten its quantity, with no record of why.
 *
 * The corrected model — which is also what `agency_stock_levels`' `quantity_on_hand` /
 * `quantity_reserved` split already assumes:
 *
 * | Stage | `variant.stock` | reservation row |
 * |---|---|---|
 * | **reserve** | untouched | created `active` with a TTL |
 * | **commit** | decremented ONCE | `committed`, TTL pushed out so the audit survives |
 * | **release** | untouched | `released` |
 * | **expiry** | untouched | TTL-deleted; availability self-heals |
 *
 * Availability is `stock − Σ active reservations`, so an expired row stops counting the
 * moment it expires — see `countActiveByVariant`, which excludes expired rows rather than
 * waiting for Mongo's 60-second TTL sweep. Expiry therefore needs no compensating write at
 * all, which is what makes it safe for the TTL to be the only thing that cleans up.
 */
export class StockReservationService {
  constructor(
    private readonly productRepository: IProductRepository,
    private readonly variantRepository: IVariantRepository,
    private readonly reservationRepository: IStockReservationRepository,
    // DEPRECATED: digital-asset reservation is now sourced from variant.digitalConfig.assetId.
    // Kept in constructor for backward compat with wiring; not read by reserveDigitalStock.
    private readonly _digitalAssetRepository: IDigitalAssetRepository,
    private readonly availabilityRepository: IAvailabilityRepository,
    private readonly transactionManager: TransactionManager
  ) { }

  async execute(command: ReserveStockCommand): Promise<StockReservation> {
    // Join the caller's transaction when given one — see `ReserveStockCommand.session`.
    const run = command.session
      ? (fn: (s: ClientSession) => Promise<StockReservation>) => fn(command.session!)
      : (fn: (s: ClientSession) => Promise<StockReservation>) => this.transactionManager.runInTransaction(fn);

    return run(async (session) => {
      const existing = await this.reservationRepository.findByReservationId(command.reservationId, { session });

      if (existing) {
        if (
          existing.variantId !== command.variantId ||
          existing.quantity !== command.quantity ||
          existing.vendorId !== command.vendorId
        ) {
          throw createAppError(ERROR_CODES.CATALOG_VARIANT_RESERVATION_CONFLICT, 409);
        }
        return existing;
      }

      const product = await this.productRepository.findById(command.productId, command.vendorId, { session });

      if (!product) throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);
      if (product.vendorId !== command.vendorId) throw createAppError(ERROR_CODES.CATALOG_PRODUCT_ACCESS_DENIED, 403);
      if (product.status !== 'active') throw createAppError(ERROR_CODES.CATALOG_PRODUCT_INVALID_STATE, 422, undefined, { status: product.status });

      const variant = await this.variantRepository.findById(command.variantId, { session });

      if (!variant) throw createAppError(ERROR_CODES.CATALOG_VARIANT_NOT_FOUND, 404);
      if (variant.productId !== command.productId) throw createAppError(ERROR_CODES.CATALOG_VARIANT_ACCESS_DENIED, 403);
      if (variant.status !== 'active') throw createAppError(ERROR_CODES.CATALOG_VARIANT_ARCHIVED, 422);

      if (command.quantity < 1) {
        throw createAppError(ERROR_CODES.CATALOG_VARIANT_INVALID_QUANTITY, 400, 'Quantity must be at least 1');
      }

      if (product.type === 'service' && command.quantity !== 1) {
        throw createAppError(ERROR_CODES.CATALOG_VARIANT_INVALID_QUANTITY, 400, 'Service products must have quantity of 1');
      }

      const expiresAt = new Date(Date.now() + command.ttlMinutes * 60 * 1000);

      let reservationType: ReservationType;
      let digitalAssetId: string | undefined;
      let availabilitySlotId: string | undefined;

      if (product.type === 'physical') {
        reservationType = 'physical';
        await this.assertPhysicalStockAvailable(variant, command.quantity, session);
      } else if (product.type === 'digital') {
        reservationType = 'digital';
        digitalAssetId = await this.reserveDigitalStock(variant);
      } else if (product.type === 'service') {
        reservationType = 'service';
        availabilitySlotId = await this.reserveServiceCapacity(command.productId, command.quantity, session);
      } else {
        throw createAppError(ERROR_CODES.CATALOG_VARIANT_UNSUPPORTED_TYPE, 400, undefined, { type: product.type });
      }

      return this.reservationRepository.create({
        reservationId: command.reservationId,
        productId: command.productId,
        variantId: command.variantId,
        quantity: command.quantity,
        type: reservationType,
        status: 'active',
        expiresAt,
        vendorId: command.vendorId,
        digitalAssetId,
        availabilitySlotId,
        deletedAt: null,
        purgeAt: null,
      }, { session });
    });
  }

  /**
   * Refuse the reservation if the units are not there — and write no stock.
   *
   * `variant.stock` stays the physical count; what this reserves against is
   * `stock − Σ other active reservations`, exactly as `InventoryAvailabilityCalculator`
   * defines it. The reservation row created by the caller is what holds the units.
   *
   * **Two escapes, both meaning "the counter does not bind":** `isInfiniteStock` (nothing
   * is being counted — a made-to-order or drop-shipped line) and `allowOversell` (the
   * vendor has said they will source it). Both are the vendor's own declaration, so
   * neither is second-guessed here.
   *
   * ⚠️ The read-then-check is safe only **inside the caller's transaction**, which is why
   * `session` is required rather than optional. Two concurrent checkouts for the last unit
   * both read `stock: 1`; the transaction is what makes one of them lose. Called outside
   * one, this is a race with a comforting error message.
   */
  private async assertPhysicalStockAvailable(
    variant: Variant,
    quantity: number,
    session: any
  ): Promise<void> {
    if (variant.isInfiniteStock || variant.allowOversell) return;

    const heldByOthers = await this.reservationRepository.countActiveByVariant(variant.id, { session });
    const available = variant.stock - heldByOthers;

    if (quantity > available) {
      throw createAppError(
        ERROR_CODES.CATALOG_INSUFFICIENT_STOCK,
        422,
        undefined,
        {
          variantId: variant.id,
          sku: variant.sku,
          requested: quantity,
          // What a shopper can actually buy right now — never the raw `stock`, which
          // would overstate it by whatever other people are holding.
          available: Math.max(0, available),
        },
      );
    }
  }

  private async reserveDigitalStock(variant: Variant): Promise<string> {
    if (!variant.digitalConfig?.assetId) {
      throw createAppError(ERROR_CODES.CATALOG_VARIANT_NO_DIGITAL_ASSET, 422);
    }
    return variant.digitalConfig.assetId;
  }

  private async reserveServiceCapacity(_productId: string, _quantity: number, _session: any): Promise<string | undefined> {
    return undefined;
  }
}
