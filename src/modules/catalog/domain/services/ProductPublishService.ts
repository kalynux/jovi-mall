import { NotFoundError, ForbiddenError, ConflictError, ValidationError } from '../../../../core/errors';
import { IProductRepository } from '../../repositories/interfaces/product.repository.interface';
import { Product } from '../../repositories/mappers/product.mapper';

export interface VendorContext {
  legitVerified: boolean;
}

/**
 * ProductPublishService: Publish products with moderation based on vendor verification
 */
export class ProductPublishService {
  constructor(private readonly productRepository: IProductRepository) {}

  /**
   * Publish a product (with moderation if vendor not verified)
   * @param productId - Product ID
   * @param vendorId - Vendor ID for ownership check
   * @param vendorContext - Vendor verification context
   * @returns Published product domain entity
   */
  async execute(
    productId: string,
    vendorId: string,
    vendorContext: VendorContext
  ): Promise<Product> {
    // Load product
    const product = await this.productRepository.findById(productId, vendorId);

    if (!product) {
      throw new NotFoundError('Product not found');
    }

    // Vendor ownership check
    if (product.vendorId !== vendorId) {
      throw new ForbiddenError('You do not have permission to publish this product');
    }

    // Idempotency check: already published
    if (product.status === 'active' || product.status === 'pending_review') {
      throw new ConflictError(
        `Product is already ${product.status.toUpperCase()}. Cannot publish again.`
      );
    }

    // State validation: only DRAFT or ARCHIVED can be published
    if (product.status !== 'draft' && product.status !== 'archived') {
      throw new ForbiddenError(
        `Cannot publish product in ${product.status.toUpperCase()} state. Only DRAFT or ARCHIVED products can be published.`
      );
    }

    // Content validation
    if (!product.title || product.title.trim().length === 0) {
      throw new ValidationError('Product must have a valid title before publishing');
    }

    if (!product.slug || product.slug.trim().length === 0) {
      throw new ValidationError('Product must have a valid slug before publishing');
    }

    // Determine target status based on vendor verification
    const newStatus = vendorContext.legitVerified ? 'active' : 'pending_review';

    // Update status
    const updatedProduct = await this.productRepository.update(productId, vendorId, {
      status: newStatus,
    });

    if (!updatedProduct) {
      throw new NotFoundError('Product not found after update');
    }

    return updatedProduct;
  }
}
