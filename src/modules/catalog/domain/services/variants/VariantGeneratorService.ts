import { createAppError } from '../../../../../core/errors';
import { ERROR_CODES } from '../../../../../core/error-codes';
import { TransactionManager } from '../../../../../core/database/transaction.manager';
import { IProductRepository } from '../../../repositories/interfaces/product.repository.interface';
import { IOptionRepository } from '../../../repositories/interfaces/option.repository.interface';
import { IOptionValueRepository } from '../../../repositories/interfaces/option-value.repository.interface';
import { IVariantRepository } from '../../../repositories/interfaces/variant.repository.interface';
import { Variant } from '../../../repositories/mappers/variant.mapper';
import { MAX_VARIANTS_PER_PRODUCT } from './constants';
import { generateOptionSignature, generateSKU, cartesianProduct, calculateCartesianProductCount } from './utils';

export interface GenerateVariantsCommand {
  productId: string;
  vendorId: string;
  defaultPrice?: number;
  defaultStock?: number;
}

/**
 * VariantGeneratorService: Generate cartesian product of option values
 */
export class VariantGeneratorService {
  constructor(
    private readonly productRepository: IProductRepository,
    private readonly optionRepository: IOptionRepository,
    private readonly optionValueRepository: IOptionValueRepository,
    private readonly variantRepository: IVariantRepository,
    private readonly transactionManager: TransactionManager,
    private readonly maxVariantsPerProduct: number = MAX_VARIANTS_PER_PRODUCT
  ) { }

  async execute(command: GenerateVariantsCommand): Promise<Variant[]> {
    return this.transactionManager.runInTransaction(async (session) => {
      const product = await this.productRepository.findById(command.productId, command.vendorId, { session });

      if (!product) throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);
      if (product.vendorId !== command.vendorId) throw createAppError(ERROR_CODES.CATALOG_PRODUCT_ACCESS_DENIED, 403);

      const options = await this.optionRepository.findByProduct(command.productId, { session });

      if (options.length === 0) throw createAppError(ERROR_CODES.CATALOG_VARIANT_NO_OPTIONS, 422);

      const optionIds = options.map(opt => opt.id);
      const allValues = await this.optionValueRepository.findByOptions(optionIds, { session });

      const valuesByOption = new Map<string, any[]>();
      for (const value of allValues) {
        if (!valuesByOption.has(value.optionId)) valuesByOption.set(value.optionId, []);
        valuesByOption.get(value.optionId)!.push(value);
      }

      for (const option of options) {
        const values = valuesByOption.get(option.id) || [];
        if (values.length === 0) {
          throw createAppError(ERROR_CODES.CATALOG_VARIANT_OPTION_EMPTY, 422, undefined, { option: option.name });
        }
      }

      const valueCounts = options.map(opt => (valuesByOption.get(opt.id) || []).length);
      const totalCombinations = calculateCartesianProductCount(valueCounts);

      if (totalCombinations > this.maxVariantsPerProduct) {
        throw createAppError(ERROR_CODES.CATALOG_VARIANT_LIMIT_EXCEEDED, 422, undefined, {
          total: totalCombinations,
          max: this.maxVariantsPerProduct,
        });
      }

      const valueArrays = options.map(opt => valuesByOption.get(opt.id) || []);
      const combinations = cartesianProduct(valueArrays);

      const variants: Omit<Variant, 'id' | 'createdAt' | 'updatedAt'>[] = combinations.map(combination => {
        const optionValuePairs = combination.map((value: any, index: number) => ({
          optionName: options[index].name,
          value: value.value,
        }));
        const signature = generateOptionSignature(optionValuePairs);
        const sku = generateSKU(command.productId, signature);

        return {
          productId: command.productId,
          sku,
          status: 'active' as const,
          optionSignature: signature,
          price: command.defaultPrice ?? 0,
          compareAtPrice: undefined,
          stock: command.defaultStock ?? 0,
          isInfiniteStock: false,
          lowStockThreshold: null,
          allowOversell: false,
          weight: undefined,
          optionValueIds: combination.map((v: any) => v.id),
          fileIds: [],
          deletedAt: null,
          purgeAt: null,
        };
      });

      return this.variantRepository.createMany(variants, { session });
    });
  }
}
