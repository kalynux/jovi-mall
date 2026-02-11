import { Types } from 'mongoose';
import { BaseRepository, RepositoryOptions } from '../../../../core/repositories/base.repository';
import { IProductOption, ProductOptionModel } from '../../models';
import { IOptionRepository } from '../interfaces/option.repository.interface';
import { ProductOption, ProductOptionMapper } from '../mappers/option.mapper';

export class OptionRepositoryMongo extends BaseRepository<IProductOption, ProductOption> implements IOptionRepository {
  constructor() {
    super(ProductOptionModel, new ProductOptionMapper());
  }

  async create(option: Omit<ProductOption, 'id' | 'createdAt' | 'updatedAt'>, options?: RepositoryOptions): Promise<ProductOption> {
    const [doc] = await this.model.create([option as any], options?.session ? { session: options.session } : {});
    return this.mapper.toDomain(doc);
  }

  async findById(id: string, options?: RepositoryOptions): Promise<ProductOption | null> {
    return super.findById(id, options);
  }

  async findByProduct(productId: string, options?: RepositoryOptions): Promise<ProductOption[]> {
    const docs = await this.model
      .find({ productId, deletedAt: null })
      .sort({ position: 1 }) // Always return sorted by position
      .session(options?.session || null)
      .exec();
    return docs.map(doc => this.mapper.toDomain(doc));
  }

  async update(id: string, updates: Partial<ProductOption>, options?: RepositoryOptions): Promise<ProductOption | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    const doc = await this.model.findOneAndUpdate(
      { _id: id, deletedAt: null },
      { $set: updates },
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

  async countByProduct(productId: string, options?: RepositoryOptions): Promise<number> {
    return this.model.countDocuments({ productId, deletedAt: null }).session(options?.session || null);
  }
}
