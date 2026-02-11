import { NotFoundError, ForbiddenError, ValidationError } from '../../../../../core/errors';
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
 * 
 * Business Rules:
 * - Compare existing variants with new option matrix by optionSignature
 * - Keep existing variants that still match (preserve price/stock)
 * - Create new variants for new combinations (stock=0, price from existing or 0)
 * - Archive variants that no longer match (NEVER delete)
 * - MAX_VARIANTS_PER_PRODUCT validation applies
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

  /**
   * Regenerate variants after option changes
   * Safely reconciles existing variants with new matrix
   */
  async execute(command: RegenerateVariantsCommand): Promise<RegenerationResult> {
    return this.transactionManager.runInTransaction(async (session) => {
      // 1. Load and validate product
      const product = await this.productRepository.findById(command.productId, command.vendorId, { session });

      if (!product) {
        throw new NotFoundError('Product not found');
      }

      if (product.vendorId !== command.vendorId) {
        throw new ForbiddenError('You do not have permission to regenerate variants for this product');
      }

      // 2. Load existing active variants
      const existingVariants = await this.variantRepository.findByProduct(command.productId, { session });
      const activeVariants = existingVariants.filter(v => v.status === 'active');

      // Build signature → variant map
      const existingBySignature = new Map<string, Variant>();
      for (const variant of activeVariants) {
        existingBySignature.set(variant.optionSignature, variant);
      }

      // 3. Load options and generate new matrix
      const options = await this.optionRepository.findByProduct(command.productId, { session });

      if (options.length === 0) {
        // No options: archive all existing variants
        const archived: Variant[] = [];
        for (const variant of activeVariants) {
          const updated = await this.variantRepository.update(
            variant.id,
            { status: 'archived' },
            { session }
          );
          if (updated) {
            archived.push(updated);
          }
        }

        return {
          created: [],
          archived,
          unchanged: [],
        };
      }

      // Load option values
      const optionIds = options.map(opt => opt.id);
      const allValues = await this.optionValueRepository.findByOptions(optionIds, { session });

      const valuesByOption = new Map();
      for (const value of allValues) {
        if (!valuesByOption.has(value.optionId)) {
          valuesByOption.set(value.optionId, []);
        }
        valuesByOption.get(value.optionId)!.push(value);
      }

      // Validate all options have values
      for (const option of options) {
        const values = valuesByOption.get(option.id) || [];
        if (values.length === 0) {
          throw new ValidationError(`Option "${option.name}" has no values`);
        }
      }

      // Calculate new matrix size
      const valueCounts = options.map(opt => (valuesByOption.get(opt.id) || []).length);
      const totalCombinations = calculateCartesianProductCount(valueCounts);

      if (totalCombinations > this.maxVariantsPerProduct) {
        throw new ValidationError(
          `Cannot generate ${totalCombinations} variants (exceeds limit of ${this.maxVariantsPerProduct}). ` +
          `Calculation: ${valueCounts.join(' × ')} = ${totalCombinations}`
        );
      }

      // Generate new combinations
      const valueArrays = options.map(opt => valuesByOption.get(opt.id) || []);
      const combinations = cartesianProduct(valueArrays);

      // 4. Reconcile
      const newSignatures = new Set<string>();
      const unchanged: Variant[] = [];
      const toCreate: Omit<Variant, 'id' | 'createdAt' | 'updatedAt'>[] = [];

      for (const combination of combinations) {
        // Build signature
        const optionValuePairs = combination.map((value: any, index: number) => ({
          optionName: options[index].name,
          value: value.value,
        }));

        const signature = generateOptionSignature(optionValuePairs);
        newSignatures.add(signature);

        if (existingBySignature.has(signature)) {
          // Exists: unchanged
          unchanged.push(existingBySignature.get(signature)!);
        } else {
          // New: create
          const sku = generateSKU(command.productId, signature);

          // Use average price from existing variants or 0
          const avgPrice = activeVariants.length > 0
            ? activeVariants.reduce((sum, v) => sum + v.price, 0) / activeVariants.length
            : 0;

          toCreate.push({
            productId: command.productId,
            sku,
            status: 'active',
            optionSignature: signature,
            price: Math.round(avgPrice), // Use average or 0
            compareAtPrice: undefined,
            stock: 0, // New variants start with 0 stock
            isInfiniteStock: false,
            lowStockThreshold: null,
            allowOversell: false,
            weight: undefined,
            optionValueIds: combination.map((v: any) => v.id),
            mediaIds: [],
            deletedAt: null,
            purgeAt: null,
          });
        }
      }

      // 5. Archive disappeared variants
      const archived: Variant[] = [];
      for (const variant of activeVariants) {
        if (!newSignatures.has(variant.optionSignature)) {
          const updated = await this.variantRepository.update(
            variant.id,
            { status: 'archived' },
            { session }
          );
          if (updated) {
            archived.push(updated);
          }
        }
      }

      // 6. Create new variants
      const created = toCreate.length > 0
        ? await this.variantRepository.createMany(toCreate, { session })
        : [];

      return {
        created,
        archived,
        unchanged,
      };
    });
  }
}
