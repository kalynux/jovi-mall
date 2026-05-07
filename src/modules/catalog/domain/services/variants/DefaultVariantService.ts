import { createAppError } from '../../../../../core/errors';
import { ERROR_CODES } from '../../../../../core/error-codes';
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
 */
export class DefaultVariantService {
  constructor(
    private readonly productRepository: IProductRepository,
    private readonly optionRepository: IOptionRepository,
    private readonly variantRepository: IVariantRepository,
    private readonly transactionManager: TransactionManager
  ) { }

  async execute(command: EnsureDefaultVariantCommand): Promise<Variant> {
    return this.transactionManager.runInTransaction(async (session) => {
      const product = await this.productRepository.findById(command.productId, command.vendorId, { session });

      if (!product) throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);
      if (product.vendorId !== command.vendorId) throw createAppError(ERROR_CODES.CATALOG_PRODUCT_ACCESS_DENIED, 403);

      const optionCount = await this.optionRepository.countByProduct(command.productId, { session });

      if (optionCount > 0) throw createAppError(ERROR_CODES.CATALOG_OPTION_REQUIRES_NO_OPTIONS, 422);

      const existingDefault = await this.variantRepository.findByOptionSignature(
        command.productId,
        DEFAULT_VARIANT_SIGNATURE,
        { session }
      );

      if (existingDefault) return existingDefault;

      const defaultVariant = await this.variantRepository.create({
        productId: command.productId,
        sku: command.productId,
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
        fileIds: [],
        deletedAt: null,
        purgeAt: null,
      }, { session });

      return defaultVariant;
    });
  }
}
