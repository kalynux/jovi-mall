import { createAppError } from '../../../../../core/errors';
import { ERROR_CODES } from '../../../../../core/error-codes';
import { TransactionManager } from '../../../../../core/database/transaction.manager';
import { IProductRepository } from '../../../repositories/interfaces/product.repository.interface';
import { IVariantRepository } from '../../../repositories/interfaces/variant.repository.interface';
import { Variant } from '../../../repositories/mappers/variant.mapper';

export interface SetVariantPriceCommand {
  variantId: string;
  productId: string;
  vendorId: string;
  price: number;
  compareAtPrice?: number;
}

export interface BulkSetPricesCommand {
  productId: string;
  vendorId: string;
  pricings: Array<{
    variantId: string;
    price: number;
    compareAtPrice?: number;
  }>;
}

/**
 * VariantPricingService: Handle all variant pricing logic
 */
export class VariantPricingService {
  constructor(
    private readonly productRepository: IProductRepository,
    private readonly variantRepository: IVariantRepository,
    private readonly transactionManager: TransactionManager
  ) { }

  async setPrice(command: SetVariantPriceCommand): Promise<Variant> {
    return this.transactionManager.runInTransaction(async (session) => {
      const product = await this.productRepository.findById(command.productId, command.vendorId, { session });

      if (!product) throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);
      if (product.vendorId !== command.vendorId) throw createAppError(ERROR_CODES.CATALOG_PRODUCT_ACCESS_DENIED, 403);

      const variant = await this.variantRepository.findById(command.variantId, { session });

      if (!variant) throw createAppError(ERROR_CODES.CATALOG_VARIANT_NOT_FOUND, 404);
      if (variant.productId !== command.productId) throw createAppError(ERROR_CODES.CATALOG_VARIANT_ACCESS_DENIED, 403);
      if (variant.status !== 'active') throw createAppError(ERROR_CODES.CATALOG_VARIANT_ARCHIVED, 422);
      if (command.price < 0) throw createAppError(ERROR_CODES.CATALOG_VARIANT_INVALID_PRICE, 400, 'Price cannot be negative');

      if (command.compareAtPrice !== undefined && command.compareAtPrice < command.price) {
        throw createAppError(ERROR_CODES.CATALOG_VARIANT_COMPARE_PRICE_INVALID, 400);
      }

      const updated = await this.variantRepository.update(
        command.variantId,
        { price: command.price, compareAtPrice: command.compareAtPrice },
        { session }
      );

      if (!updated) throw createAppError(ERROR_CODES.CATALOG_VARIANT_NOT_FOUND, 404);

      return updated;
    });
  }

  async bulkSetPrices(command: BulkSetPricesCommand): Promise<Variant[]> {
    return this.transactionManager.runInTransaction(async (session) => {
      const product = await this.productRepository.findById(command.productId, command.vendorId, { session });

      if (!product) throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);
      if (product.vendorId !== command.vendorId) throw createAppError(ERROR_CODES.CATALOG_PRODUCT_ACCESS_DENIED, 403);
      if (command.pricings.length === 0) throw createAppError(ERROR_CODES.CATALOG_VARIANT_INVALID_PRICE, 400, 'Must provide at least one pricing update');

      for (const pricing of command.pricings) {
        if (pricing.price < 0) throw createAppError(ERROR_CODES.CATALOG_VARIANT_INVALID_PRICE, 400, undefined, { variantId: pricing.variantId });
        if (pricing.compareAtPrice !== undefined && pricing.compareAtPrice < pricing.price) {
          throw createAppError(ERROR_CODES.CATALOG_VARIANT_COMPARE_PRICE_INVALID, 400, undefined, { variantId: pricing.variantId });
        }
      }

      const updated: Variant[] = [];

      for (const pricing of command.pricings) {
        const variant = await this.variantRepository.findById(pricing.variantId, { session });

        if (!variant) throw createAppError(ERROR_CODES.CATALOG_VARIANT_NOT_FOUND, 404, undefined, { variantId: pricing.variantId });
        if (variant.productId !== command.productId) throw createAppError(ERROR_CODES.CATALOG_VARIANT_ACCESS_DENIED, 403, undefined, { variantId: pricing.variantId });
        if (variant.status !== 'active') throw createAppError(ERROR_CODES.CATALOG_VARIANT_ARCHIVED, 422, undefined, { variantId: pricing.variantId });

        const updatedVariant = await this.variantRepository.update(
          pricing.variantId,
          { price: pricing.price, compareAtPrice: pricing.compareAtPrice },
          { session }
        );

        if (updatedVariant) updated.push(updatedVariant);
      }

      return updated;
    });
  }
}
