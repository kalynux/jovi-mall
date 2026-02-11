import { NotFoundError, ForbiddenError } from '../../../../../core/errors';
import { TransactionManager } from '../../../../../core/database/transaction.manager';
import { IProductRepository } from '../../../repositories/interfaces/product.repository.interface';
import { IStockReservationRepository } from '../../../repositories/interfaces/stock-reservation.repository.interface';
import { IVariantRepository } from '../../../repositories/interfaces/variant.repository.interface';
import { IDigitalAssetRepository } from '../../../repositories/interfaces/digital-asset.repository.interface';
import { IAvailabilityRepository } from '../../../repositories/interfaces/availability.repository.interface';

export interface ReleaseStockCommand {
  reservationId: string;
  vendorId: string; // For vendor ownership check
}

/**
 * StockReleaseService: Release reservation (payment failed, timeout, cancel)
 * 
 * Business Rules:
 * - IDEMPOTENT - if already released → no-op
 * - EXPLICIT vendor ownership check via product
 * - Restores stock/capacity/quota
 * - Transaction-safe
 */
export class StockReleaseService {
  constructor(
    private readonly productRepository: IProductRepository,
    private readonly reservationRepository: IStockReservationRepository,
    private readonly variantRepository: IVariantRepository,
    private readonly digitalAssetRepository: IDigitalAssetRepository,
    private readonly availabilityRepository: IAvailabilityRepository,
    private readonly transactionManager: TransactionManager
  ) {}

  async execute(command: ReleaseStockCommand): Promise<void> {
    await this.transactionManager.runInTransaction(async (session) => {
      // 1. Load reservation
      const reservation = await this.reservationRepository.findByReservationId(command.reservationId, { session });

      if (!reservation) {
        throw new NotFoundError('Reservation not found');
      }

      // IDEMPOTENCY: If already released, return success
      if (reservation.status === 'released' || reservation.status === 'expired') {
        return; // Already released - idempotent no-op
      }

      // Cannot release committed reservation
      if (reservation.status === 'committed') {
        throw new ForbiddenError('Cannot release committed reservation');
      }

      // 2. VENDOR OWNERSHIP CHECK: Load product and validate vendor
      const product = await this.productRepository.findById(reservation.productId, command.vendorId, { session });
      
      if (!product) {
        throw new NotFoundError('Product not found');
      }

      if (product.vendorId !== command.vendorId) {
        throw new ForbiddenError('You do not have permission to release this reservation');
      }

      // Also check reservation vendorId matches
      if (reservation.vendorId !== command.vendorId) {
        throw new ForbiddenError('Reservation does not belong to this vendor');
      }

      // 3. Restore stock/capacity based on type
      if (reservation.type === 'physical') {
        await this.restorePhysicalStock(reservation.variantId, reservation.quantity, session);
      } else if (reservation.type === 'digital') {
        // Digital: No actual restoration needed, just mark as released
        // (counts are based on active/committed reservations)
      } else if (reservation.type === 'service') {
        // Service: No actual capacity restoration in this simplified version
        // (counts are based on active/committed reservations)
      }

      // 4. Update reservation status to released
      await this.reservationRepository.updateStatus(command.reservationId, 'released', { session });
    });
  }

  /**
   * Restore physical stock - ATOMIC increment
   */
  private async restorePhysicalStock(
    variantId: string,
    quantity: number,
    session: any
  ): Promise<void> {
    const variant = await this.variantRepository.findById(variantId, { session });

    if (!variant) {
      throw new NotFoundError('Variant not found');
    }

    // Skip restoration if infinite stock
    if (variant.isInfiniteStock) {
      return;
    }

    // ATOMIC: Increment stock back
    await this.variantRepository.update(
      variantId,
      { stock: { $inc: quantity } as any }, // Atomic increment
      { session }
    );
  }
}
