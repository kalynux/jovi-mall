import { NotFoundError, ForbiddenError } from '../../../../../core/errors';
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
  ) {}

  async execute(command: CommitStockCommand): Promise<StockReservation> {
    return this.transactionManager.runInTransaction(async (session) => {
      // 1. Load reservation
      const reservation = await this.reservationRepository.findByReservationId(command.reservationId, { session });

      if (!reservation) {
        throw new NotFoundError('Reservation not found');
      }

      // IDEMPOTENCY: If already committed, return success
      if (reservation.status === 'committed') {
        return reservation; // Already committed - idempotent
      }

      // 2. VENDOR OWNERSHIP CHECK: Load product and validate vendor
      const product = await this.productRepository.findById(reservation.productId, command.vendorId, { session });
      
      if (!product) {
        throw new NotFoundError('Product not found');
      }

      if (product.vendorId !== command.vendorId) {
        throw new ForbiddenError('You do not have permission to commit this reservation');
      }

      // Also check reservation vendorId matches
      if (reservation.vendorId !== command.vendorId) {
        throw new ForbiddenError('Reservation does not belong to this vendor');
      }

      // 3. Validate reservation status
      if (reservation.status !== 'active') {
        throw new ForbiddenError(`Cannot commit reservation with status: ${reservation.status.toUpperCase()}`);
      }

      // 4. Check expiration
      if (reservation.expiresAt < new Date()) {
        throw new ForbiddenError('Reservation has expired');
      }

      // 5. Update status to committed
      const committed = await this.reservationRepository.updateStatus(
        command.reservationId,
        'committed',
        { session }
      );

      if (!committed) {
        throw new NotFoundError('Failed to commit reservation');
      }

      // Stock is NOT restored - it was already decremented during reservation
      // This commit just finalizes the sale

      return committed;
    });
  }
}
