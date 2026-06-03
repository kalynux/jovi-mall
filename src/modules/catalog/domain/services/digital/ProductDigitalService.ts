import { Types } from 'mongoose';
import { ProductModel, IProduct } from '../../../models/product.model';
import { createAppError } from '../../../../../core/errors';
import { ERROR_CODES } from '../../../../../core/error-codes';

/**
 * ProductDigitalService — product-level helpers for digital products.
 *
 * Per-variant asset/limits live on ProductVariant.digitalConfig; see VariantDigitalService
 * for asset attach/replace/clear/config-update operations.
 */
export class ProductDigitalService {
  /**
   * Load a product by ID, asserting it exists and is digital.
   */
  async assertIsDigital(productId: string): Promise<IProduct> {
    if (!Types.ObjectId.isValid(productId)) {
      throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 400, 'Invalid product ID');
    }
    const product = await ProductModel.findById(productId);
    if (!product) {
      throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404, 'Product not found');
    }
    if (product.type !== 'digital') {
      throw createAppError(ERROR_CODES.CATALOG_PRODUCT_INVALID_TYPE, 400, 'Product is not a digital product');
    }
    return product;
  }
}
