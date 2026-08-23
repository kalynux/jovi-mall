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

  /**
   * Move the stock counter by `delta`, atomically. Negative sells, positive restocks.
   *
   * ⚠ **This exists because `update()` structurally cannot do it, and the attempt
   * failed SILENTLY.** Every `update()` goes through `buildVariantUpdateOps`, which
   * puts what it is given under `$set` — so `update(id, { stock: { $inc: -1 } })`
   * reaches Mongo as `$set: { stock: { $inc: -1 } }`, throws a CastError, and is
   * swallowed by the caller's `catch` as a skipped line. Both stock write paths did
   * exactly that behind an `as any`, which is what let it compile: `variant.stock`
   * was never decremented on any sale, and the overselling protection documented in
   * CLAUDE.md never ran.
   *
   * It is a separate method rather than a special case inside `update()` so the next
   * author reaching for an atomic counter finds one instead of casting past the type
   * that was telling them the truth.
   */
  adjustStock(id: string, delta: number, options?: RepositoryOptions): Promise<Variant | null>;
  delete(id: string, options?: RepositoryOptions): Promise<void>;
  deleteByProduct(productId: string, options?: RepositoryOptions): Promise<void>;

  // Inventory management queries
  findByVendorWithThreshold(vendorId: string, options?: RepositoryOptions): Promise<Variant[]>;
}
