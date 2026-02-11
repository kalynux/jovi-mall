import { NotFoundError, ForbiddenError } from '../../../../../core/errors';
import { TransactionManager } from '../../../../../core/database/transaction.manager';
import { IProductRepository } from '../../../repositories/interfaces/product.repository.interface';
import { IOptionRepository } from '../../../repositories/interfaces/option.repository.interface';
import { IVariantRepository } from '../../../repositories/interfaces/variant.repository.interface';
import { Variant } from '../../../repositories/mappers/variant.mapper';
import { DEFAULT_VARIANT_SIGNATURE } from './constants';

export interface EnsureDefaultVariantCommand {
  productId: string;
  vendorId: string;
}

/**
 * DefaultVariantService: Ensure products without options have exactly one default variant
 * 
 * Business Rules:
 * - If product has 0 options AND 0 active variants → create default variant
 * - Default variant has signature="default", sku=productId
 * - Idempotent: returns existing default if present
 */
export class DefaultVariantService {
  constructor(
    private readonly productRepository: IProductRepository,
    private readonly optionRepository: IOptionRepository,
    private readonly variantRepository: IVariantRepository,
    private readonly transactionManager: TransactionManager
  ) { }

  /**
   * Ensure default variant exists for option-less products
   * Returns existing default or creates new one
   */
  async execute(command: EnsureDefaultVariantCommand): Promise<Variant> {
    return this.transactionManager.runInTransaction(async (session) => {
      // 1. Load and validate product
      const product = await this.productRepository.findById(command.productId, command.vendorId, { session });

      if (!product) {
        throw new NotFoundError('Product not found');
      }

      if (product.vendorId !== command.vendorId) {
        throw new ForbiddenError('You do not have permission to modify this product');
      }

      // 2. Check if product has options
      const optionCount = await this.optionRepository.countByProduct(command.productId, { session });

      if (optionCount > 0) {
        throw new ForbiddenError('Cannot create default variant for product with options');
      }

      // 3. Check if default variant already exists
      const existingDefault = await this.variantRepository.findByOptionSignature(
        command.productId,
        DEFAULT_VARIANT_SIGNATURE,
        { session }
      );

      if (existingDefault) {
        // Idempotent: return existing
        return existingDefault;
      }

      // 4. Create default variant
      const defaultVariant = await this.variantRepository.create({
        productId: command.productId,
        sku: command.productId, // SKU = productId for default variant
        status: 'active',
        optionSignature: DEFAULT_VARIANT_SIGNATURE,
        price: 0,
        compareAtPrice: undefined,
        stock: 0,
        isInfiniteStock: false,
        lowStockThreshold: null,
        allowOversell: false,
        weight: undefined,
        optionValueIds: [],
        mediaIds: [],
        deletedAt: null,
        purgeAt: null,
      }, { session });

      return defaultVariant;
    });
  }
}
