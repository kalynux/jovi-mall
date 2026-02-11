import { NotFoundError, ForbiddenError } from '../../../../core/errors';
import { IProductRepository } from '../../repositories/interfaces/product.repository.interface';
import { Product } from '../../repositories/mappers/product.mapper';

/**
 * ProductArchiveService: Archive products (hide from public view)
 */
export class ProductArchiveService {
  constructor(private readonly productRepository: IProductRepository) {}

  /**
   * Archive a product
   * @param productId - Product ID
   * @param vendorId - Vendor ID for ownership check
   * @returns Archived product domain entity
   */
  async execute(productId: string, vendorId: string): Promise<Product> {
    // Load product
    const product = await this.productRepository.findById(productId, vendorId);

    if (!product) {
      throw new NotFoundError('Product not found');
    }

    // Vendor ownership check
    if (product.vendorId !== vendorId) {
      throw new ForbiddenError('You do not have permission to archive this product');
    }

    // State validation: only ACTIVE or DRAFT can be archived
    if (product.status !== 'active' && product.status !== 'draft') {
      throw new ForbiddenError(
        `Cannot archive product in ${product.status.toUpperCase()} state. Only ACTIVE or DRAFT products can be archived.`
      );
    }

    // Update status to ARCHIVED
    const updatedProduct = await this.productRepository.update(productId, vendorId, {
      status: 'archived',
    });

    if (!updatedProduct) {
      throw new NotFoundError('Product not found after update');
    }

    return updatedProduct;
  }
}
