import { NotFoundError, ForbiddenError, ValidationError } from '../../../../../core/errors';
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
  adjustment: number; // Positive or negative
}

/**
 * VariantStockService: Handle stock management for physical product variants
 * 
 * Business Rules:
 * - Only for type='physical' products
 * - Stock cannot go below 0
 * - Supports isInfiniteStock flag
 * - Transaction-safe for future order reservations
 */
export class VariantStockService {
  constructor(
    private readonly productRepository: IProductRepository,
    private readonly variantRepository: IVariantRepository,
    private readonly transactionManager: TransactionManager
  ) {}

  /**
   * Set absolute stock value
   */
  async setStock(command: SetStockCommand): Promise<Variant> {
    return this.transactionManager.runInTransaction(async (session) => {
      // 1. Load and validate product
      const product = await this.productRepository.findById(command.productId, command.vendorId, { session });
      
      if (!product) {
        throw new NotFoundError('Product not found');
      }

      if (product.vendorId !== command.vendorId) {
        throw new ForbiddenError('You do not have permission to modify this product');
      }

      // Type validation
      if (product.type !== 'physical') {
        throw new ForbiddenError('Stock management is only available for physical products');
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
        throw new ForbiddenError('Cannot set stock for archived variant');
      }

      // 3. Validate stock
      if (command.stock < 0) {
        throw new ValidationError('Stock cannot be negative');
      }

      // 4. Update variant
      const updated = await this.variantRepository.update(
        command.variantId,
        { stock: command.stock },
        { session }
      );

      if (!updated) {
        throw new NotFoundError('Variant not found after update');
      }

      return updated;
    });
  }

  /**
   * Adjust stock by a delta (positive or negative)
   */
  async adjustStock(command: AdjustStockCommand): Promise<Variant> {
    return this.transactionManager.runInTransaction(async (session) => {
      // 1. Load and validate product
      const product = await this.productRepository.findById(command.productId, command.vendorId, { session });
      
      if (!product) {
        throw new NotFoundError('Product not found');
      }

      if (product.vendorId !== command.vendorId) {
        throw new ForbiddenError('You do not have permission to modify this product');
      }

      if (product.type !== 'physical') {
        throw new ForbiddenError('Stock management is only available for physical products');
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
        throw new ForbiddenError('Cannot adjust stock for archived variant');
      }

      // 3. Calculate new stock
      const newStock = variant.stock + command.adjustment;

      if (newStock < 0) {
        throw new ValidationError(
          `Cannot adjust stock by ${command.adjustment}. Would result in negative stock (current: ${variant.stock})`
        );
      }

      // 4. Update variant
      const updated = await this.variantRepository.update(
        command.variantId,
        { stock: newStock },
        { session }
      );

      if (!updated) {
        throw new NotFoundError('Variant not found after update');
      }

      return updated;
    });
  }
}
