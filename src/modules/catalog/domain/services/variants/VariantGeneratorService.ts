import { NotFoundError, ForbiddenError, ValidationError } from '../../../../../core/errors';
import { TransactionManager } from '../../../../../core/database/transaction.manager';
import { IProductRepository } from '../../../repositories/interfaces/product.repository.interface';
import { IOptionRepository } from '../../../repositories/interfaces/option.repository.interface';
import { IOptionValueRepository } from '../../../repositories/interfaces/option-value.repository.interface';
import { IVariantRepository } from '../../../repositories/interfaces/variant.repository.interface';
import { Variant } from '../../../repositories/mappers/variant.mapper';
import { ProductOption } from '../../../repositories/mappers/option.mapper';
import { ProductOptionValue } from '../../../repositories/mappers/option-value.mapper';
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
 * 
 * Business Rules:
 * - MAX_VARIANTS_PER_PRODUCT validation (prevents cartesian explosion)
 * - Generates deterministic optionSignature
 * - Generates deterministic SKU
 * - All variants created with status='active'
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

  /**
   * Generate all variants from current option matrix
   * Throws ValidationError if cartesian product exceeds maxVariantsPerProduct
   */
  async execute(command: GenerateVariantsCommand): Promise<Variant[]> {
    return this.transactionManager.runInTransaction(async (session) => {
      // 1. Load and validate product
      const product = await this.productRepository.findById(command.productId, command.vendorId, { session });

      if (!product) {
        throw new NotFoundError('Product not found');
      }

      if (product.vendorId !== command.vendorId) {
        throw new ForbiddenError('You do not have permission to generate variants for this product');
      }

      // 2. Load options (sorted by position)
      const options = await this.optionRepository.findByProduct(command.productId, { session });

      if (options.length === 0) {
        throw new ValidationError('Product has no options. Use DefaultVariantService for products without options.');
      }

      // 3. Load all option values
      const optionIds = options.map(opt => opt.id);
      const allValues = await this.optionValueRepository.findByOptions(optionIds, { session });

      // Group values by option
      const valuesByOption = new Map<string, ProductOptionValue[]>();
      for (const value of allValues) {
        if (!valuesByOption.has(value.optionId)) {
          valuesByOption.set(value.optionId, []);
        }
        valuesByOption.get(value.optionId)!.push(value);
      }

      // 4. Validate all options have values
      for (const option of options) {
        const values = valuesByOption.get(option.id) || [];
        if (values.length === 0) {
          throw new ValidationError(`Option "${option.name}" has no values`);
        }
      }

      // 5. Calculate cartesian product count
      const valueCounts = options.map(opt => (valuesByOption.get(opt.id) || []).length);
      const totalCombinations = calculateCartesianProductCount(valueCounts);

      if (totalCombinations > this.maxVariantsPerProduct) {
        throw new ValidationError(
          `Cannot generate ${totalCombinations} variants (exceeds limit of ${this.maxVariantsPerProduct}). ` +
          `Calculation: ${valueCounts.join(' × ')} = ${totalCombinations}`
        );
      }

      // 6. Generate cartesian product
      const valueArrays = options.map(opt => valuesByOption.get(opt.id) || []);
      const combinations = cartesianProduct(valueArrays);

      // 7. Build variant objects
      const variants: Omit<Variant, 'id' | 'createdAt' | 'updatedAt'>[] = combinations.map(combination => {
        // Build option signature
        const optionValuePairs = combination.map((value, index) => ({
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
          optionValueIds: combination.map(v => v.id),
          mediaIds: [],
          deletedAt: null,
          purgeAt: null,
        };
      });

      // 8. Batch create variants
      const createdVariants = await this.variantRepository.createMany(variants, { session });

      return createdVariants;
    });
  }
}
