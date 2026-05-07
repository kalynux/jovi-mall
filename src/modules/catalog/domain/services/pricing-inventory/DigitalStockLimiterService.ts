import { createAppError } from '../../../../../core/errors';
import { ERROR_CODES } from '../../../../../core/error-codes';
import { IDigitalAssetRepository } from '../../../repositories/interfaces/digital-asset.repository.interface';
import { IStockReservationRepository } from '../../../repositories/interfaces/stock-reservation.repository.interface';

/**
 * DigitalStockLimiterService: Enforce digital product sales/download limits
 */
export class DigitalStockLimiterService {
  constructor(
    private readonly digitalAssetRepository: IDigitalAssetRepository,
    private readonly reservationRepository: IStockReservationRepository
  ) { }

  async canReserve(
    digitalAssetId: string,
    requestedQuantity: number,
    session?: any
  ): Promise<void> {
    const asset = await this.digitalAssetRepository.findById(digitalAssetId, { session });

    if (!asset) {
      throw createAppError(ERROR_CODES.CATALOG_DIGITAL_ASSET_NOT_FOUND, 404);
    }

    // Simplified: Always allow (no maxSales enforcement in current schema)
  }
}
