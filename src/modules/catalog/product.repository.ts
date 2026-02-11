import { ProductRepositoryMongo } from './repositories/mongo/product.repository.mongo';
import { Product } from './repositories/mappers/product.mapper';

/**
 * Legacy ProductRepository wrapper for backward compatibility
 * Wraps ProductRepositoryMongo to provide simpler interface for non-domain services
 */
export class ProductRepository {
  private repo: ProductRepositoryMongo;

  constructor() {
    this.repo = new ProductRepositoryMongo();
  }

  /**
   * Find products by array of IDs (unscoped - no vendor filtering)
   * Used by Order service where products may be from multiple vendors
   */
  async findByIds(ids: string[]): Promise<any[]> {
    const products = await Promise.all(
      ids.map(id => this.repo.findByIdUnscoped(id))
    );
    
    // Filter out nulls and return as any[] for compatibility
    return products.filter(p => p !== null) as any[];
  }
}
