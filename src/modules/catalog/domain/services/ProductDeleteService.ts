import { createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import { TransactionManager } from '../../../../core/database/transaction.manager';
import { IProductRepository } from '../../repositories/interfaces/product.repository.interface';
import { IFileReferenceRepository } from '../../repositories/interfaces/file-reference.repository.interface';

/**
 * ProductDeleteService: Soft delete products with configurable retention policy
 */
export class ProductDeleteService {
  constructor(
    private readonly productRepository: IProductRepository,
    private readonly transactionManager: TransactionManager,
    private readonly retentionDays: number,
    private readonly fileReferenceRepository: IFileReferenceRepository
  ) { }

  async execute(productId: string, vendorId: string): Promise<void> {
    await this.transactionManager.runInTransaction(async (session) => {
      const product = await this.productRepository.findById(productId, vendorId, { session });

      if (!product) {
        throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);
      }

      if (product.vendorId !== vendorId) {
        throw createAppError(ERROR_CODES.CATALOG_PRODUCT_ACCESS_DENIED, 403);
      }

      const deletedAt = new Date();
      const purgeAt = new Date(deletedAt);
      purgeAt.setDate(purgeAt.getDate() + this.retentionDays);

      await this.productRepository.softDelete(productId, vendorId, { session }, purgeAt);

      // Release the product's file references so its media can be reclaimed by
      // the orphan collector. (Variant-level references are cleaned by their own
      // delete path.)
      await this.fileReferenceRepository.removeAllForEntity('product', productId, { session });
    });
  }
}
