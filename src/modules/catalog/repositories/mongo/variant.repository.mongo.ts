import { FilterQuery, Model, Types } from 'mongoose';
import { BaseRepository, RepositoryOptions } from '../../../../core/repositories/base.repository';
import { IProductVariant, ProductVariantModel } from '../../models';
import { IVariantRepository } from '../interfaces/variant.repository.interface';
import { Variant, VariantMapper } from '../mappers/variant.mapper';

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

    // Translate domain camelCase fields to the snake_case names used in MongoDB
    const persistenceUpdates: Record<string, any> = { ...updates };
    if ('lowStockThreshold' in updates) {
      persistenceUpdates.low_stock_threshold = updates.lowStockThreshold;
      delete persistenceUpdates.lowStockThreshold;
    }
    if ('allowOversell' in updates) {
      persistenceUpdates.allow_oversell = updates.allowOversell;
      delete persistenceUpdates.allowOversell;
    }

    // For partial digitalConfig updates, expand into dotted paths so we don't
    // overwrite untouched sub-fields (e.g. assetId when only limits change).
    // If callers want to replace the whole sub-doc (incl. clearing), they should
    // pass digitalConfig: undefined or use a separate $unset path elsewhere.
    if ('digitalConfig' in updates && updates.digitalConfig && typeof updates.digitalConfig === 'object') {
      const dc = updates.digitalConfig as { assetId?: string; maxDownloads?: number | null; expiresAfterDays?: number | null };
      if (dc.assetId !== undefined) persistenceUpdates['digitalConfig.assetId'] = dc.assetId;
      if ('maxDownloads' in dc) persistenceUpdates['digitalConfig.maxDownloads'] = dc.maxDownloads;
      if ('expiresAfterDays' in dc) persistenceUpdates['digitalConfig.expiresAfterDays'] = dc.expiresAfterDays;
      delete persistenceUpdates.digitalConfig;
    }

    const doc = await this.model.findOneAndUpdate(
      { _id: id, deletedAt: null },
      { $set: persistenceUpdates },
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
          from: 'products',
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

