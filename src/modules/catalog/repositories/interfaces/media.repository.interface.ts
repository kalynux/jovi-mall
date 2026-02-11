import { Media } from '../mappers/media.mapper';
import { RepositoryOptions } from '../types';

export interface IMediaRepository {
  create(media: Omit<Media, 'id' | 'createdAt' | 'updatedAt'>, options?: RepositoryOptions): Promise<Media>;
  
  findByOwner(ownerType: 'product' | 'variant', ownerId: string, options?: RepositoryOptions): Promise<Media[]>;
  findById(id: string, options?: RepositoryOptions): Promise<Media | null>;
  
  delete(id: string, options?: RepositoryOptions): Promise<void>;
  deleteByOwner(ownerType: 'product' | 'variant', ownerId: string, options?: RepositoryOptions): Promise<void>;
}
