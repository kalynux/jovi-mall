import { NotFoundError, ForbiddenError } from '../../../../core/errors';
import { TransactionManager } from '../../../../core/database/transaction.manager';
import { IProductRepository } from '../../repositories/interfaces/product.repository.interface';
import { Product } from '../../repositories/mappers/product.mapper';

/**
 * ProductRestoreService: Restore soft-deleted products
 */
export class ProductRestoreService {
  constructor(
    private readonly productRepository: IProductRepository,
    private readonly transactionManager: TransactionManager
  ) {}

  /**
   * Restore a soft-deleted product
   * @param productId - Product ID
   * @param vendorId - Vendor ID for ownership check
   * @returns Restored product domain entity
   */
  async execute(productId: string, vendorId: string): Promise<Product> {
    return this.transactionManager.runInTransaction(async (session) => {
      // Load product (including soft-deleted ones)
      // Note: We need to find the product even if deleted, so we use findById first
      // then check if it was deleted
      const product = await this.productRepository.findById(productId, vendorId, { session });

      if (!product) {
        throw new NotFoundError('Product not found or not deleted');
      }

      // Vendor ownership check
      if (product.vendorId !== vendorId) {
        throw new ForbiddenError('You do not have permission to restore this product');
      }

      // Check if product is soft-deleted
      if (!product.deletedAt) {
        throw new NotFoundError('Product is not deleted and cannot be restored');
      }

      // Restore product via repository (clears deletedAt and purgeAt)
      await this.productRepository.restore(productId, vendorId, { session });

      // Update status to DRAFT
      const restoredProduct = await this.productRepository.update(
        productId,
        vendorId,
        {
          status: 'draft',
        },
        { session }
      );

      if (!restoredProduct) {
        throw new NotFoundError('Product not found after restore');
      }

      return restoredProduct;
    });
  }
}
