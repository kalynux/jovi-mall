import { ClientSession } from 'mongoose';
import { createAppError } from '../../../../../core/errors';
import { ERROR_CODES } from '../../../../../core/error-codes';
import { TransactionManager } from '../../../../../core/database/transaction.manager';
import { IProductRepository } from '../../../repositories/interfaces/product.repository.interface';
import { IStockReservationRepository } from '../../../repositories/interfaces/stock-reservation.repository.interface';
import { IVariantRepository } from '../../../repositories/interfaces/variant.repository.interface';
import { StockReservation } from '../../../repositories/mappers/stock-reservation.mapper';

export interface CommitStockCommand {
  reservationId: string;
  vendorId: string; // For vendor ownership check
  /** Join the caller's transaction instead of opening one — see ReserveStockCommand. */
  session?: ClientSession;
}

/**
 * How long a committed reservation is kept before the TTL sweeps it.
 *
 * It is an audit trail of what was sold and when, not a live hold, so the only requirement
 * is that it outlive the windows that might need to read it — the 7-day escrow hold, the
 * unpaid-order sweep, and a refund investigation. 90 days covers all three with room, and
 * bounds a collection that would otherwise grow forever.
 */
const COMMITTED_RESERVATION_RETENTION_DAYS = 90;

/**
 * StockCommitService: the sale is real — take the units off the shelf.
 *
 * ⚠️ **This is the ONLY place `variant.stock` moves on the order path**, and that changed:
 * the decrement used to happen at *reservation* time, with this class doing no stock write
 * at all. See the long note on `StockReservationService` for why that was unsafe (an
 * expired reservation is TTL-deleted, so nothing could ever put the units back).
 *
 * Business rules:
 * - **IDEMPOTENT** — an already-committed reservation is a no-op. Load-bearing: payment
 *   webhooks are re-delivered, and committing twice would decrement twice.
 * - EXPLICIT vendor ownership check via the product.
 * - Validates the reservation has not expired.
 * - Decrements `variant.stock` exactly once, atomically.
 * - Pushes `expiresAt` beyond the TTL so the committed row survives as an audit record.
 * - Immutable after commit.
 */
export class StockCommitService {
  constructor(
    private readonly productRepository: IProductRepository,
    private readonly reservationRepository: IStockReservationRepository,
    private readonly variantRepository: IVariantRepository,
    private readonly transactionManager: TransactionManager
  ) { }

  async execute(command: CommitStockCommand): Promise<StockReservation> {
    const run = command.session
      ? (fn: (s: ClientSession) => Promise<StockReservation>) => fn(command.session!)
      : (fn: (s: ClientSession) => Promise<StockReservation>) => this.transactionManager.runInTransaction(fn);

    return run(async (session) => {
      // 1. Load reservation
      const reservation = await this.reservationRepository.findByReservationId(command.reservationId, { session });

      if (!reservation) {
        throw createAppError(ERROR_CODES.CATALOG_VARIANT_RESERVATION_NOT_FOUND, 404, 'Reservation not found');
      }

      // IDEMPOTENCY: If already committed, return success
      if (reservation.status === 'committed') {
        return reservation; // Already committed - idempotent
      }

      // 2. VENDOR OWNERSHIP CHECK: Load product and validate vendor
      const product = await this.productRepository.findById(reservation.productId, command.vendorId, { session });

      if (!product) {
        throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);
      }

      if (product.vendorId !== command.vendorId) {
        throw createAppError(ERROR_CODES.CATALOG_PRODUCT_ACCESS_DENIED, 403, 'You do not have permission to commit this reservation');
      }

      // Also check reservation vendorId matches
      if (reservation.vendorId !== command.vendorId) {
        throw createAppError(ERROR_CODES.CATALOG_PRODUCT_ACCESS_DENIED, 403, 'Reservation does not belong to this vendor');
      }

      // 3. Validate reservation status
      if (reservation.status !== 'active') {
        throw createAppError(ERROR_CODES.CATALOG_VARIANT_RESERVATION_CONFLICT, 409, `Cannot commit reservation with status: ${reservation.status.toUpperCase()}`);
      }

      // 4. Check expiration
      if (reservation.expiresAt < new Date()) {
        throw createAppError(ERROR_CODES.CATALOG_VARIANT_RESERVATION_CONFLICT, 409, 'Reservation has expired');
      }

      // 5. Take the units off the shelf — the one and only stock write on this path.
      //
      // Skipped for `isInfiniteStock` (nothing is counted) and for non-physical types
      // (a digital licence and a service booking have no shelf). `allowOversell` is NOT
      // skipped: oversell means the reservation was allowed to exceed the counter, not
      // that the counter stops tracking — the vendor still needs to see it go negative,
      // because that number is exactly what they have to go and source.
      if (reservation.type === 'physical') {
        const variant = await this.variantRepository.findById(reservation.variantId, { session });
        if (!variant) {
          throw createAppError(ERROR_CODES.CATALOG_VARIANT_NOT_FOUND, 404);
        }
        if (!variant.isInfiniteStock) {
          await this.variantRepository.adjustStock(
            reservation.variantId,
            -reservation.quantity,
            { session },
          );
        }
      }

      // 6. Mark committed, and push `expiresAt` out of the TTL's reach.
      //
      // The model's `{ expiresAt: 1 }, { expireAfterSeconds: 0 }` index deletes on that
      // field regardless of status, so a committed row would be swept the moment its
      // original hold window elapsed — taking the record of a completed sale with it.
      // The status is what stops it counting against availability; the date is only a
      // cleanup clock, and a committed reservation is no longer waiting for anything.
      const committed = await this.reservationRepository.commit(
        command.reservationId,
        COMMITTED_RESERVATION_RETENTION_DAYS,
        { session },
      );

      if (!committed) {
        throw createAppError(ERROR_CODES.CATALOG_VARIANT_RESERVATION_NOT_FOUND, 404, 'Failed to commit reservation');
      }

      return committed;
    });
  }
}
