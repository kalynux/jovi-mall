import { IDigitalAssetRepository } from '../../../repositories/interfaces/digital-asset.repository.interface';
import { IStockReservationRepository } from '../../../repositories/interfaces/stock-reservation.repository.interface';
import { ValidationError } from '../../../../../core/errors';

/**
 * DigitalStockLimiterService: Enforce digital product sales/download limits
 * 
 * Integration: Works through StockReservationService
 * 
 * Business Rules:
 * - DigitalAsset has optional maxSales or maxDownloads
 * - Track count of active + committed reservations
 * - Prevent exceeding limit during reservation
 */
export class DigitalStockLimiterService {
  constructor(
    private readonly digitalAssetRepository: IDigitalAssetRepository,
    private readonly reservationRepository: IStockReservationRepository
  ) {}

  /**
   * Check if digital product can accommodate additional quantity
   * 
   * NOTE: Simplified version - full implementation would:
   * 1. Check DigitalAsset maxSales limit
   * 2. Count active + committed reservations
   * 3. Enforce limit
   * 
   * Current schema doesn't have maxSales field, so always allow
   */
  async canReserve(
    digitalAssetId: string,
    requestedQuantity: number,
    session?: any
  ): Promise<void> {
    // Load digital asset
    const asset = await this.digitalAssetRepository.findById(digitalAssetId, { session });

    if (!asset) {
      throw new ValidationError('Digital asset not found');
    }

    // Simplified: Always allow (no maxSales enforcement in current schema)
    // Full implementation would check asset.maxSales here
  }
}
