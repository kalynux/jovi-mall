import { createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
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
  ) { }

  async execute(productId: string, vendorId: string): Promise<Product> {
    return this.transactionManager.runInTransaction(async (session) => {
      const product = await this.productRepository.findById(productId, vendorId, { session });

      if (!product) {
        throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);
      }

      if (product.vendorId !== vendorId) {
        throw createAppError(ERROR_CODES.CATALOG_PRODUCT_ACCESS_DENIED, 403);
      }

      if (!product.deletedAt) {
        throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);
      }

      await this.productRepository.restore(productId, vendorId, { session });

      const restoredProduct = await this.productRepository.update(
        productId,
        vendorId,
        { status: 'draft' },
        { session }
      );

      if (!restoredProduct) {
        throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);
      }

      return restoredProduct;
    });
  }
}
