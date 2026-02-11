import { ProductOption } from '../mappers/option.mapper';
import { RepositoryOptions } from '../types';

export interface IOptionRepository {
  create(option: Omit<ProductOption, 'id' | 'createdAt' | 'updatedAt'>, options?: RepositoryOptions): Promise<ProductOption>;
  findById(id: string, options?: RepositoryOptions): Promise<ProductOption | null>;
  findByProduct(productId: string, options?: RepositoryOptions): Promise<ProductOption[]>;
  update(id: string, updates: Partial<ProductOption>, options?: RepositoryOptions): Promise<ProductOption | null>;
  delete(id: string, options?: RepositoryOptions): Promise<void>;
  deleteByProduct(productId: string, options?: RepositoryOptions): Promise<void>;
  countByProduct(productId: string, options?: RepositoryOptions): Promise<number>;
}
