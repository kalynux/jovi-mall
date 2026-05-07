import { createAppError } from '../../../../../core/errors';
import { ERROR_CODES } from '../../../../../core/error-codes';
import { TransactionManager } from '../../../../../core/database/transaction.manager';
import { IProductRepository } from '../../../repositories/interfaces/product.repository.interface';
import { IStockReservationRepository } from '../../../repositories/interfaces/stock-reservation.repository.interface';
import { StockReservation } from '../../../repositories/mappers/stock-reservation.mapper';

export interface CommitStockCommand {
  reservationId: string;
  vendorId: string; // For vendor ownership check
}

/**
 * StockCommitService: Finalize stock after successful payment
 * 
 * Business Rules:
 * - IDEMPOTENT - if already committed → no-op
 * - EXPLICIT vendor ownership check via product
 * - Validates reservation not expired
 * - Does NOT restore stock (already decremented during reservation)
 * - Immutable after commit
 */
export class StockCommitService {
  constructor(
    private readonly productRepository: IProductRepository,
    private readonly reservationRepository: IStockReservationRepository,
    private readonly transactionManager: TransactionManager
  ) { }

  async execute(command: CommitStockCommand): Promise<StockReservation> {
    return this.transactionManager.runInTransaction(async (session) => {
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

      // 5. Update status to committed
      const committed = await this.reservationRepository.updateStatus(
        command.reservationId,
        'committed',
        { session }
      );

      if (!committed) {
        throw createAppError(ERROR_CODES.CATALOG_VARIANT_RESERVATION_NOT_FOUND, 404, 'Failed to commit reservation');
      }

      // Stock is NOT restored - it was already decremented during reservation
      // This commit just finalizes the sale

      return committed;
    });
  }
}
