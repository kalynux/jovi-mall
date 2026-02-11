import { NotFoundError, ForbiddenError } from '../../../../core/errors';
import { TransactionManager } from '../../../../core/database/transaction.manager';
import { IProductRepository } from '../../repositories/interfaces/product.repository.interface';

/**
 * ProductDeleteService: Soft delete products with configurable retention policy
 */
export class ProductDeleteService {
  constructor(
    private readonly productRepository: IProductRepository,
    private readonly transactionManager: TransactionManager,
    private readonly retentionDays: number
  ) {}

  /**
   * Soft delete a product
   * @param productId - Product ID
   * @param vendorId - Vendor ID for ownership check
   */
  async execute(productId: string, vendorId: string): Promise<void> {
    await this.transactionManager.runInTransaction(async (session) => {
      // Load product
      const product = await this.productRepository.findById(productId, vendorId, { session });

      if (!product) {
        throw new NotFoundError('Product not found');
      }

      // Vendor ownership check
      if (product.vendorId !== vendorId) {
        throw new ForbiddenError('You do not have permission to delete this product');
      }

      // Calculate purge date
      const deletedAt = new Date();
      const purgeAt = new Date(deletedAt);
      purgeAt.setDate(purgeAt.getDate() + this.retentionDays);

      // Soft delete via repository with purgeAt
      await this.productRepository.softDelete(productId, vendorId, { session }, purgeAt);
    });
  }
}
