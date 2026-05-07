import { createAppError } from '../../../../../core/errors';
import { ERROR_CODES } from '../../../../../core/error-codes';
import { TransactionManager } from '../../../../../core/database/transaction.manager';
import { IProductRepository } from '../../../repositories/interfaces/product.repository.interface';
import { IVariantRepository } from '../../../repositories/interfaces/variant.repository.interface';
import { Variant } from '../../../repositories/mappers/variant.mapper';

export interface SetStockCommand {
  variantId: string;
  productId: string;
  vendorId: string;
  stock: number;
}

export interface AdjustStockCommand {
  variantId: string;
  productId: string;
  vendorId: string;
  adjustment: number;
}

/**
 * VariantStockService: Handle stock management for physical product variants
 */
export class VariantStockService {
  constructor(
    private readonly productRepository: IProductRepository,
    private readonly variantRepository: IVariantRepository,
    private readonly transactionManager: TransactionManager
  ) { }

  async setStock(command: SetStockCommand): Promise<Variant> {
    return this.transactionManager.runInTransaction(async (session) => {
      const product = await this.productRepository.findById(command.productId, command.vendorId, { session });

      if (!product) throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);
      if (product.vendorId !== command.vendorId) throw createAppError(ERROR_CODES.CATALOG_PRODUCT_ACCESS_DENIED, 403);
      if (product.type !== 'physical') throw createAppError(ERROR_CODES.CATALOG_VARIANT_STOCK_ONLY_PHYSICAL, 400);

      const variant = await this.variantRepository.findById(command.variantId, { session });

      if (!variant) throw createAppError(ERROR_CODES.CATALOG_VARIANT_NOT_FOUND, 404);
      if (variant.productId !== command.productId) throw createAppError(ERROR_CODES.CATALOG_VARIANT_ACCESS_DENIED, 403);
      if (variant.status !== 'active') throw createAppError(ERROR_CODES.CATALOG_VARIANT_ARCHIVED, 422);
      if (command.stock < 0) throw createAppError(ERROR_CODES.CATALOG_VARIANT_INVALID_STOCK, 400, 'Stock cannot be negative');

      const updated = await this.variantRepository.update(command.variantId, { stock: command.stock }, { session });

      if (!updated) throw createAppError(ERROR_CODES.CATALOG_VARIANT_NOT_FOUND, 404);

      return updated;
    });
  }

  async adjustStock(command: AdjustStockCommand): Promise<Variant> {
    return this.transactionManager.runInTransaction(async (session) => {
      const product = await this.productRepository.findById(command.productId, command.vendorId, { session });

      if (!product) throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);
      if (product.vendorId !== command.vendorId) throw createAppError(ERROR_CODES.CATALOG_PRODUCT_ACCESS_DENIED, 403);
      if (product.type !== 'physical') throw createAppError(ERROR_CODES.CATALOG_VARIANT_STOCK_ONLY_PHYSICAL, 400);

      const variant = await this.variantRepository.findById(command.variantId, { session });

      if (!variant) throw createAppError(ERROR_CODES.CATALOG_VARIANT_NOT_FOUND, 404);
      if (variant.productId !== command.productId) throw createAppError(ERROR_CODES.CATALOG_VARIANT_ACCESS_DENIED, 403);
      if (variant.status !== 'active') throw createAppError(ERROR_CODES.CATALOG_VARIANT_ARCHIVED, 422);

      const newStock = variant.stock + command.adjustment;

      if (newStock < 0) {
        throw createAppError(ERROR_CODES.CATALOG_VARIANT_INSUFFICIENT_STOCK, 422, undefined, {
          current: variant.stock,
          adjustment: command.adjustment,
        });
      }

      const updated = await this.variantRepository.update(command.variantId, { stock: newStock }, { session });

      if (!updated) throw createAppError(ERROR_CODES.CATALOG_VARIANT_NOT_FOUND, 404);

      return updated;
    });
  }
}
