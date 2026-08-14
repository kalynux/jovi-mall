import { ClientSession } from 'mongoose';
import { createAppError } from '../../../../../core/errors';
import { ERROR_CODES } from '../../../../../core/error-codes';
import { TransactionManager } from '../../../../../core/database/transaction.manager';
import { IProductRepository } from '../../../repositories/interfaces/product.repository.interface';
import { IStockReservationRepository } from '../../../repositories/interfaces/stock-reservation.repository.interface';
import { IVariantRepository } from '../../../repositories/interfaces/variant.repository.interface';
import { IDigitalAssetRepository } from '../../../repositories/interfaces/digital-asset.repository.interface';
import { IAvailabilityRepository } from '../../../repositories/interfaces/availability.repository.interface';

export interface ReleaseStockCommand {
  reservationId: string;
  vendorId: string; // For vendor ownership check
  /** Join the caller's transaction instead of opening one — see ReserveStockCommand. */
  session?: ClientSession;
}

/**
 * StockReleaseService: give up a hold (payment failed, timeout, cancel).
 *
 * ⚠️ **It writes no stock, and that is the fix rather than an omission.**
 *
 * It used to `$inc` the quantity back onto `variant.stock`, because reservation used to
 * `$inc` it off. Both halves are gone: `StockReservationService` now leaves the counter
 * alone and only `StockCommitService` moves it. Releasing a hold therefore has nothing to
 * restore — flipping the row to `released` is the whole operation, because availability is
 * `stock − Σ active reservations` and a released row stops being active.
 *
 * The property that buys is the one the old design could not have: **expiry needs no
 * compensating write.** The model TTL-deletes an expired row, and under the old semantics
 * that silently destroyed the units it had decremented, since the release could never run
 * on a row that no longer existed. Now a deleted row simply stops counting, and
 * availability recovers on its own.
 *
 * Business rules:
 * - IDEMPOTENT — already released or expired → no-op.
 * - EXPLICIT vendor ownership check via the product.
 * - A **committed** reservation cannot be released: the units are sold. Reversing that is
 *   a refund or a return, which restock through their own paths.
 * - Transaction-safe.
 */
export class StockReleaseService {
  constructor(
    private readonly productRepository: IProductRepository,
    private readonly reservationRepository: IStockReservationRepository,
    private readonly variantRepository: IVariantRepository,
    private readonly digitalAssetRepository: IDigitalAssetRepository,
    private readonly availabilityRepository: IAvailabilityRepository,
    private readonly transactionManager: TransactionManager
  ) { }

  async execute(command: ReleaseStockCommand): Promise<void> {
    const run = command.session
      ? (fn: (s: ClientSession) => Promise<void>) => fn(command.session!)
      : (fn: (s: ClientSession) => Promise<void>) => this.transactionManager.runInTransaction(fn);

    await run(async (session) => {
      // 1. Load reservation
      const reservation = await this.reservationRepository.findByReservationId(command.reservationId, { session });

      if (!reservation) {
        throw createAppError(ERROR_CODES.CATALOG_VARIANT_RESERVATION_NOT_FOUND, 404, 'Reservation not found');
      }

      // IDEMPOTENCY: If already released, return success
      if (reservation.status === 'released' || reservation.status === 'expired') {
        return; // Already released - idempotent no-op
      }

      // Cannot release committed reservation
      if (reservation.status === 'committed') {
        throw createAppError(ERROR_CODES.CATALOG_VARIANT_RESERVATION_CONFLICT, 409, 'Cannot release committed reservation');
      }

      // 2. VENDOR OWNERSHIP CHECK: Load product and validate vendor
      const product = await this.productRepository.findById(reservation.productId, command.vendorId, { session });

      if (!product) {
        throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);
      }

      if (product.vendorId !== command.vendorId) {
        throw createAppError(ERROR_CODES.CATALOG_PRODUCT_ACCESS_DENIED, 403, 'You do not have permission to release this reservation');
      }

      // Also check reservation vendorId matches
      if (reservation.vendorId !== command.vendorId) {
        throw createAppError(ERROR_CODES.CATALOG_PRODUCT_ACCESS_DENIED, 403, 'Reservation does not belong to this vendor');
      }

      // 3. Flip the row. That IS the release — for every reservation type.
      //
      // Physical needs no restore because the reservation never decremented (see the class
      // header); digital and service were already counted from the rows themselves rather
      // than from a counter. All three converge on the same one-line operation, which is
      // what the corrected model buys.
      await this.reservationRepository.updateStatus(command.reservationId, 'released', { session });
    });
  }
}
