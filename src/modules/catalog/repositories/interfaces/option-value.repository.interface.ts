import { ProductOptionValue } from '../mappers/option-value.mapper';
import { RepositoryOptions } from '../types';

export interface IOptionValueRepository {
  create(value: Omit<ProductOptionValue, 'id' | 'createdAt' | 'updatedAt'>, options?: RepositoryOptions): Promise<ProductOptionValue>;
  createMany(values: Omit<ProductOptionValue, 'id' | 'createdAt' | 'updatedAt'>[], options?: RepositoryOptions): Promise<ProductOptionValue[]>;
  findById(id: string, options?: RepositoryOptions): Promise<ProductOptionValue | null>;
  findByOption(optionId: string, options?: RepositoryOptions): Promise<ProductOptionValue[]>;
  findByOptions(optionIds: string[], options?: RepositoryOptions): Promise<ProductOptionValue[]>;
  update(id: string, updates: Partial<ProductOptionValue>, options?: RepositoryOptions): Promise<ProductOptionValue | null>;
  delete(id: string, options?: RepositoryOptions): Promise<void>;
  deleteByOption(optionId: string, options?: RepositoryOptions): Promise<void>;
}
