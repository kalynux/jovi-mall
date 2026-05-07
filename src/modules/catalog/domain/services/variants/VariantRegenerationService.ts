import { createAppError } from '../../../../../core/errors';
import { ERROR_CODES } from '../../../../../core/error-codes';
import { TransactionManager } from '../../../../../core/database/transaction.manager';
import { IProductRepository } from '../../../repositories/interfaces/product.repository.interface';
import { IOptionRepository } from '../../../repositories/interfaces/option.repository.interface';
import { IOptionValueRepository } from '../../../repositories/interfaces/option-value.repository.interface';
import { IVariantRepository } from '../../../repositories/interfaces/variant.repository.interface';
import { Variant } from '../../../repositories/mappers/variant.mapper';
import { MAX_VARIANTS_PER_PRODUCT } from './constants';
import { generateOptionSignature, generateSKU, cartesianProduct, calculateCartesianProductCount } from '../variants/utils';

export interface RegenerateVariantsCommand {
  productId: string;
  vendorId: string;
}

export interface RegenerationResult {
  created: Variant[];
  archived: Variant[];
  unchanged: Variant[];
}

/**
 * VariantRegenerationService: Reconcile existing variants with new option matrix
 */
export class VariantRegenerationService {
  constructor(
    private readonly productRepository: IProductRepository,
    private readonly optionRepository: IOptionRepository,
    private readonly optionValueRepository: IOptionValueRepository,
    private readonly variantRepository: IVariantRepository,
    private readonly transactionManager: TransactionManager,
    private readonly maxVariantsPerProduct: number = MAX_VARIANTS_PER_PRODUCT
  ) { }

  async execute(command: RegenerateVariantsCommand): Promise<RegenerationResult> {
    return this.transactionManager.runInTransaction(async (session) => {
      const product = await this.productRepository.findById(command.productId, command.vendorId, { session });

      if (!product) throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);
      if (product.vendorId !== command.vendorId) throw createAppError(ERROR_CODES.CATALOG_PRODUCT_ACCESS_DENIED, 403);

      const existingVariants = await this.variantRepository.findByProduct(command.productId, { session });
      const activeVariants = existingVariants.filter(v => v.status === 'active');

      const existingBySignature = new Map<string, Variant>();
      for (const variant of activeVariants) {
        existingBySignature.set(variant.optionSignature, variant);
      }

      const options = await this.optionRepository.findByProduct(command.productId, { session });

      if (options.length === 0) {
        const archived: Variant[] = [];
        for (const variant of activeVariants) {
          const updated = await this.variantRepository.update(variant.id, { status: 'archived' }, { session });
          if (updated) archived.push(updated);
        }
        return { created: [], archived, unchanged: [] };
      }

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

      const newSignatures = new Set<string>();
      const unchanged: Variant[] = [];
      const toCreate: Omit<Variant, 'id' | 'createdAt' | 'updatedAt'>[] = [];

      for (const combination of combinations) {
        const optionValuePairs = combination.map((value: any, index: number) => ({
          optionName: options[index].name,
          value: value.value,
        }));
        const signature = generateOptionSignature(optionValuePairs);
        newSignatures.add(signature);

        if (existingBySignature.has(signature)) {
          unchanged.push(existingBySignature.get(signature)!);
        } else {
          const sku = generateSKU(command.productId, signature);
          const avgPrice = activeVariants.length > 0
            ? activeVariants.reduce((sum, v) => sum + v.price, 0) / activeVariants.length
            : 0;

          toCreate.push({
            productId: command.productId,
            sku,
            status: 'active',
            optionSignature: signature,
            price: Math.round(avgPrice),
            compareAtPrice: undefined,
            stock: 0,
            isInfiniteStock: false,
            lowStockThreshold: null,
            allowOversell: false,
            weight: undefined,
            optionValueIds: combination.map((v: any) => v.id),
            fileIds: [],
            deletedAt: null,
            purgeAt: null,
          });
        }
      }

      const archived: Variant[] = [];
      for (const variant of activeVariants) {
        if (!newSignatures.has(variant.optionSignature)) {
          const updated = await this.variantRepository.update(variant.id, { status: 'archived' }, { session });
          if (updated) archived.push(updated);
        }
      }

      const created = toCreate.length > 0
        ? await this.variantRepository.createMany(toCreate, { session })
        : [];

      return { created, archived, unchanged };
    });
  }
}
