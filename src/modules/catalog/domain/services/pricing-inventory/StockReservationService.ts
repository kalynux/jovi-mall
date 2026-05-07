import { createAppError } from '../../../../../core/errors';
import { ERROR_CODES } from '../../../../../core/error-codes';
import { TransactionManager } from '../../../../../core/database/transaction.manager';
import { IProductRepository } from '../../../repositories/interfaces/product.repository.interface';
import { IVariantRepository } from '../../../repositories/interfaces/variant.repository.interface';
import { IStockReservationRepository } from '../../../repositories/interfaces/stock-reservation.repository.interface';
import { IDigitalAssetRepository } from '../../../repositories/interfaces/digital-asset.repository.interface';
import { IAvailabilityRepository } from '../../../repositories/interfaces/availability.repository.interface';
import { StockReservation } from '../../../repositories/mappers/stock-reservation.mapper';
import { ReservationType } from '../../../models/stock-reservation.model';

export interface ReserveStockCommand {
  productId: string;
  variantId: string;
  vendorId: string;
  quantity: number;
  reservationId: string;
  ttlMinutes: number;
}

/**
 * StockReservationService: Atomically reserve stock before payment
 */
export class StockReservationService {
  constructor(
    private readonly productRepository: IProductRepository,
    private readonly variantRepository: IVariantRepository,
    private readonly reservationRepository: IStockReservationRepository,
    private readonly digitalAssetRepository: IDigitalAssetRepository,
    private readonly availabilityRepository: IAvailabilityRepository,
    private readonly transactionManager: TransactionManager
  ) { }

  async execute(command: ReserveStockCommand): Promise<StockReservation> {
    return this.transactionManager.runInTransaction(async (session) => {
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
        await this.reservePhysicalStock(variant.id, command.quantity, variant.isInfiniteStock, session);
      } else if (product.type === 'digital') {
        reservationType = 'digital';
        digitalAssetId = await this.reserveDigitalStock(command.productId, command.quantity, session);
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

  private async reservePhysicalStock(
    variantId: string,
    quantity: number,
    isInfiniteStock: boolean,
    session: any
  ): Promise<void> {
    if (isInfiniteStock) return;

    const updated = await this.variantRepository.update(
      variantId,
      { stock: { $inc: -quantity } as any },
      { session }
    );

    if (!updated) throw createAppError(ERROR_CODES.CATALOG_VARIANT_INSUFFICIENT_STOCK, 422);

    if (updated.stock < 0) {
      await this.variantRepository.update(variantId, { stock: { $inc: quantity } as any }, { session });
      throw createAppError(ERROR_CODES.CATALOG_VARIANT_INSUFFICIENT_STOCK, 422);
    }
  }

  private async reserveDigitalStock(productId: string, quantity: number, session: any): Promise<string | undefined> {
    const digitalAssets = await this.digitalAssetRepository.findByProduct(productId, { session });

    if (digitalAssets.length === 0) {
      throw createAppError(ERROR_CODES.CATALOG_VARIANT_NO_DIGITAL_ASSET, 422);
    }

    return digitalAssets[0].id;
  }

  private async reserveServiceCapacity(productId: string, quantity: number, session: any): Promise<string | undefined> {
    return undefined;
  }
}
