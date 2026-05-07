import { createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import { IProductRepository } from '../../repositories/interfaces/product.repository.interface';
import { Product } from '../../repositories/mappers/product.mapper';

export interface VendorContext {
  legitVerified: boolean;
}

/**
 * ProductPublishService: Publish products with moderation based on vendor verification
 */
export class ProductPublishService {
  constructor(private readonly productRepository: IProductRepository) { }

  async execute(
    productId: string,
    vendorId: string,
    vendorContext: VendorContext
  ): Promise<Product> {
    const product = await this.productRepository.findById(productId, vendorId);

    if (!product) {
      throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);
    }

    if (product.vendorId !== vendorId) {
      throw createAppError(ERROR_CODES.CATALOG_PRODUCT_ACCESS_DENIED, 403);
    }

    if (product.status === 'active' || product.status === 'pending_review') {
      throw createAppError(ERROR_CODES.CATALOG_PRODUCT_ALREADY_PUBLISHED, 409, undefined, { status: product.status });
    }

    if (product.status !== 'draft' && product.status !== 'archived') {
      throw createAppError(ERROR_CODES.CATALOG_PRODUCT_INVALID_STATE, 422, undefined, { status: product.status });
    }

    if (!product.title || product.title.trim().length === 0) {
      throw createAppError(ERROR_CODES.CATALOG_PRODUCT_INVALID_TITLE, 422);
    }

    const newStatus = vendorContext.legitVerified ? 'active' : 'pending_review';

    const updatedProduct = await this.productRepository.update(productId, vendorId, {
      status: newStatus,
    });

    if (!updatedProduct) {
      throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);
    }

    return updatedProduct;
  }
}
