import { Variant } from '../mappers/variant.mapper';
import { RepositoryOptions } from '../types';

export interface IVariantRepository {
  create(variant: Omit<Variant, 'id' | 'createdAt' | 'updatedAt'>, options?: RepositoryOptions): Promise<Variant>;
  createMany(variants: Omit<Variant, 'id' | 'createdAt' | 'updatedAt'>[], options?: RepositoryOptions): Promise<Variant[]>;

  findByProduct(productId: string, options?: RepositoryOptions): Promise<Variant[]>;
  findById(id: string, options?: RepositoryOptions): Promise<Variant | null>;
  findBySku(sku: string, options?: RepositoryOptions): Promise<Variant | null>;
  findByOptionSignature(productId: string, signature: string, options?: RepositoryOptions): Promise<Variant | null>;

  update(id: string, updates: Partial<Variant>, options?: RepositoryOptions): Promise<Variant | null>;
  delete(id: string, options?: RepositoryOptions): Promise<void>;
  deleteByProduct(productId: string, options?: RepositoryOptions): Promise<void>;

  // Inventory management queries
  findByVendorWithThreshold(vendorId: string, options?: RepositoryOptions): Promise<Variant[]>;
}
