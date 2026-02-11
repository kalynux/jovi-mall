import { Types } from 'mongoose';
import { BaseRepository, RepositoryOptions } from '../../../../core/repositories/base.repository';
import { IProductOptionValue, ProductOptionValueModel } from '../../models';
import { IOptionValueRepository } from '../interfaces/option-value.repository.interface';
import { ProductOptionValue, ProductOptionValueMapper } from '../mappers/option-value.mapper';

export class OptionValueRepositoryMongo extends BaseRepository<IProductOptionValue, ProductOptionValue> implements IOptionValueRepository {
  constructor() {
    super(ProductOptionValueModel, new ProductOptionValueMapper());
  }

  async create(value: Omit<ProductOptionValue, 'id' | 'createdAt' | 'updatedAt'>, options?: RepositoryOptions): Promise<ProductOptionValue> {
    const [doc] = await this.model.create([value as any], options?.session ? { session: options.session } : {});
    return this.mapper.toDomain(doc);
  }

  async createMany(values: Omit<ProductOptionValue, 'id' | 'createdAt' | 'updatedAt'>[], options?: RepositoryOptions): Promise<ProductOptionValue[]> {
    const docs = await this.model.create(values as any[], options?.session ? { session: options.session } : {});
    return docs.map(doc => this.mapper.toDomain(doc));
  }

  async findById(id: string, options?: RepositoryOptions): Promise<ProductOptionValue | null> {
    return super.findById(id, options);
  }

  async findByOption(optionId: string, options?: RepositoryOptions): Promise<ProductOptionValue[]> {
    const docs = await this.model
      .find({ optionId, deletedAt: null })
      .session(options?.session || null)
      .exec();
    return docs.map(doc => this.mapper.toDomain(doc));
  }

  async findByOptions(optionIds: string[], options?: RepositoryOptions): Promise<ProductOptionValue[]> {
    const docs = await this.model
      .find({ optionId: { $in: optionIds }, deletedAt: null })
      .session(options?.session || null)
      .exec();
    return docs.map(doc => this.mapper.toDomain(doc));
  }

  async update(id: string, updates: Partial<ProductOptionValue>, options?: RepositoryOptions): Promise<ProductOptionValue | null> {
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

  async deleteByOption(optionId: string, options?: RepositoryOptions): Promise<void> {
    await this.model.updateMany(
      { optionId, deletedAt: null },
      { deletedAt: new Date() },
      options?.session ? { session: options.session } : {}
    ).exec();
  }
}
