import { FilterQuery, Model, Types } from 'mongoose';
import { BaseRepository, RepositoryOptions } from '../../../../core/repositories/base.repository';
import { IProductVariant, ProductVariantModel } from '../../models';
import { IVariantRepository } from '../interfaces/variant.repository.interface';
import { Variant, VariantMapper } from '../mappers/variant.mapper';
import { COLLECTIONS } from '../../../../core/database/collections';

/**
 * Translate a domain patch into MongoDB update operators.
 *
 * Extracted from `update()` and exported so it can be tested without Mongo, the
 * way every other pure derivation here is (`npm run test:bargain-price` group 7).
 */
export function buildVariantUpdateOps(
  updates: Partial<Variant>,
): { $set?: Record<string, unknown>; $unset?: Record<string, 1> } {
  // Translate domain camelCase fields to the snake_case names used in MongoDB
  const set: Record<string, any> = { ...updates };
  const unset: Record<string, 1> = {};

  if ('lowStockThreshold' in updates) {
    set.low_stock_threshold = updates.lowStockThreshold;
    delete set.lowStockThreshold;
  }
  if ('allowOversell' in updates) {
    set.allow_oversell = updates.allowOversell;
    delete set.allowOversell;
  }

  // For partial digitalConfig updates, expand into dotted paths so we don't
  // overwrite untouched sub-fields (e.g. assetId when only limits change).
  // If callers want to replace the whole sub-doc (incl. clearing), they should
  // pass digitalConfig: undefined or use a separate $unset path elsewhere.
  if ('digitalConfig' in updates && updates.digitalConfig && typeof updates.digitalConfig === 'object') {
    const dc = updates.digitalConfig as { assetId?: string; maxDownloads?: number | null; expiresAfterDays?: number | null };
    if (dc.assetId !== undefined) set['digitalConfig.assetId'] = dc.assetId;
    if ('maxDownloads' in dc) set['digitalConfig.maxDownloads'] = dc.maxDownloads;
    if ('expiresAfterDays' in dc) set['digitalConfig.expiresAfterDays'] = dc.expiresAfterDays;
    delete set.digitalConfig;
  }

  // An explicit `bargain: null` CLEARS the range, and it must be $unset. The
  // schema path is `default: undefined`, so `$set: null` would store a literal
  // null — after which "never configured" and "configured then cleared" are two
  // different documents meaning the same thing, and `{ bargain: { $exists: true } }`
  // matches a variant with no range. $unset restores the exact state a variant
  // that never had one is already in.
  //
  // Nothing else needs dotted-path expansion here: `resolveBargainWrite` always
  // returns a COMPLETE { minPrice, maxPrice } pair, so a whole-object $set can
  // never drop a sub-field the way a half-filled digitalConfig would.
  if ('bargain' in updates && updates.bargain === null) {
    delete set.bargain;
    unset.bargain = 1;
  }

  return {
    // `$set: {}` is rejected by MongoDB ("'$set' is empty"). Already reachable
    // today via `PATCH /variants/:id {}` — UpdateVariantSchema is neither
    // .strict() nor requires a field — and a bargain-only clear is a new way in.
    ...(Object.keys(set).length > 0 ? { $set: set } : {}),
    ...(Object.keys(unset).length > 0 ? { $unset: unset } : {}),
  };
}

export class VariantRepositoryMongo extends BaseRepository<IProductVariant, Variant> implements IVariantRepository {
  constructor() {
    super(ProductVariantModel, new VariantMapper());
  }

  async findByProduct(productId: string, options?: RepositoryOptions): Promise<Variant[]> {
    const docs = await this.model.find({ productId, deletedAt: null }).session(options?.session || null).exec();
    return docs.map(doc => this.mapper.toDomain(doc));
  }

  // Override to ensure public access if needed, or rely on finding by product mostly.
  // Interface requires it:
  async findById(id: string, options?: RepositoryOptions): Promise<Variant | null> {
    return super.findById(id, options);
  }

  async create(variant: Omit<Variant, 'id' | 'createdAt' | 'updatedAt'>, options?: RepositoryOptions): Promise<Variant> {
    const doc = await this.model.create(
      [variant],
      options?.session ? { session: options.session } : {}
    );
    return this.mapper.toDomain(doc[0]);
  }

  async createMany(variants: Omit<Variant, 'id' | 'createdAt' | 'updatedAt'>[], options?: RepositoryOptions): Promise<Variant[]> {
    const docs = await this.model.create(
      variants as any[],
      options?.session ? { session: options.session } : {}
    );
    return docs.map(doc => this.mapper.toDomain(doc));
  }

  async findBySku(sku: string, options?: RepositoryOptions): Promise<Variant | null> {
    const doc = await this.model.findOne({ sku, deletedAt: null }).session(options?.session || null).exec();
    return doc ? this.mapper.toDomain(doc) : null;
  }

  async findByOptionSignature(productId: string, signature: string, options?: RepositoryOptions): Promise<Variant | null> {
    const doc = await this.model.findOne({ productId, optionSignature: signature, deletedAt: null })
      .session(options?.session || null)
      .exec();
    return doc ? this.mapper.toDomain(doc) : null;
  }

  async update(id: string, updates: Partial<Variant>, options?: RepositoryOptions): Promise<Variant | null> {
    if (!Types.ObjectId.isValid(id)) return null;

    const doc = await this.model.findOneAndUpdate(
      { _id: id, deletedAt: null },
      buildVariantUpdateOps(updates),
      { new: true, session: options?.session }
    );
    return doc ? this.mapper.toDomain(doc) : null;
  }

  /**
   * The one place `$inc` reaches `stock`. See the interface for why it is not
   * `update({ stock: { $inc: n } })` — that shape compiles, and does nothing.
   *
   * Deliberately NOT guarded at zero. A committed reservation may legitimately
   * drive the counter negative when the variant allows oversell, and the vendor
   * needs to see that number: it is exactly what they have to go and source.
   */
  async adjustStock(id: string, delta: number, options?: RepositoryOptions): Promise<Variant | null> {
    if (!Types.ObjectId.isValid(id)) return null;

    const doc = await this.model.findOneAndUpdate(
      { _id: id, deletedAt: null },
      { $inc: { stock: delta } },
      { new: true, session: options?.session }
    );
    return doc ? this.mapper.toDomain(doc) : null;
  }

  async delete(id: string, options?: RepositoryOptions): Promise<void> {
    return this.softDelete(id, options);
  }

  async deleteByProduct(productId: string, options?: RepositoryOptions): Promise<void> {
    await this.model.updateMany(
      { productId, deletedAt: null },
      { deletedAt: new Date() },
      options?.session ? { session: options.session } : {}
    ).exec();
  }

  async findByVendorWithThreshold(vendorId: string, options?: RepositoryOptions): Promise<Variant[]> {
    // Find all variants for vendor's products where low_stock_threshold is not null
    const docs = await this.model.aggregate([
      // Lookup product to get vendorId
      {
        $lookup: {
          from: COLLECTIONS.PRODUCT,
          localField: 'productId',
          foreignField: '_id',
          as: 'product'
        }
      },
      // Filter by vendor and threshold
      {
        $match: {
          'product.vendorId': new Types.ObjectId(vendorId),
          'status': 'active',
          'low_stock_threshold': { $ne: null },
          'deletedAt': null
        }
      },
      // Remove product array
      { $unset: 'product' }
    ]).session(options?.session || null).exec();

    return docs.map(doc => this.mapper.toDomain(doc as IProductVariant));
  }
}

