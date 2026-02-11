import { NotFoundError, ForbiddenError, ValidationError } from '../../../../../core/errors';
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
 * 
 * Business Rules:
 * - price >= 0 (required)
 * - compareAtPrice >= price (if provided)
 * - Only active variants can have prices set
 * - Vendor ownership validated via product
 */
export class VariantPricingService {
  constructor(
    private readonly productRepository: IProductRepository,
    private readonly variantRepository: IVariantRepository,
    private readonly transactionManager: TransactionManager
  ) {}

  /**
   * Set price for a single variant
   */
  async setPrice(command: SetVariantPriceCommand): Promise<Variant> {
    return this.transactionManager.runInTransaction(async (session) => {
      // 1. Load and validate product
      const product = await this.productRepository.findById(command.productId, command.vendorId, { session });
      
      if (!product) {
        throw new NotFoundError('Product not found');
      }

      if (product.vendorId !== command.vendorId) {
        throw new ForbiddenError('You do not have permission to modify this product');
      }

      // 2. Load variant
      const variant = await this.variantRepository.findById(command.variantId, { session });
      
      if (!variant) {
        throw new NotFoundError('Variant not found');
      }

      if (variant.productId !== command.productId) {
        throw new ForbiddenError('Variant does not belong to this product');
      }

      if (variant.status !== 'active') {
        throw new ForbiddenError('Cannot set price for archived variant');
      }

      // 3. Validate pricing
      if (command.price < 0) {
        throw new ValidationError('Price cannot be negative');
      }

      if (command.compareAtPrice !== undefined && command.compareAtPrice < command.price) {
        throw new ValidationError('Compare-at price must be greater than or equal to price');
      }

      // 4. Update variant
      const updated = await this.variantRepository.update(
        command.variantId,
        {
          price: command.price,
          compareAtPrice: command.compareAtPrice,
        },
        { session }
      );

      if (!updated) {
        throw new NotFoundError('Variant not found after update');
      }

      return updated;
    });
  }

  /**
   * Set prices for multiple variants in a single transaction
   */
  async bulkSetPrices(command: BulkSetPricesCommand): Promise<Variant[]> {
    return this.transactionManager.runInTransaction(async (session) => {
      // 1. Load and validate product
      const product = await this.productRepository.findById(command.productId, command.vendorId, { session });
      
      if (!product) {
        throw new NotFoundError('Product not found');
      }

      if (product.vendorId !== command.vendorId) {
        throw new ForbiddenError('You do not have permission to modify this product');
      }

      if (command.pricings.length === 0) {
        throw new ValidationError('Must provide at least one pricing update');
      }

      // 2. Validate all pricings
      for (const pricing of command.pricings) {
        if (pricing.price < 0) {
          throw new ValidationError(`Price cannot be negative for variant ${pricing.variantId}`);
        }

        if (pricing.compareAtPrice !== undefined && pricing.compareAtPrice < pricing.price) {
          throw new ValidationError(
            `Compare-at price must be >= price for variant ${pricing.variantId}`
          );
        }
      }

      // 3. Update all variants
      const updated: Variant[] = [];
      
      for (const pricing of command.pricings) {
        const variant = await this.variantRepository.findById(pricing.variantId, { session });
        
        if (!variant) {
          throw new NotFoundError(`Variant ${pricing.variantId} not found`);
        }

        if (variant.productId !== command.productId) {
          throw new ForbiddenError(`Variant ${pricing.variantId} does not belong to this product`);
        }

        if (variant.status !== 'active') {
          throw new ForbiddenError(`Cannot set price for archived variant ${pricing.variantId}`);
        }

        const updatedVariant = await this.variantRepository.update(
          pricing.variantId,
          {
            price: pricing.price,
            compareAtPrice: pricing.compareAtPrice,
          },
          { session }
        );

        if (updatedVariant) {
          updated.push(updatedVariant);
        }
      }

      return updated;
    });
  }
}
