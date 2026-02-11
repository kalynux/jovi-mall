import { BaseRepository, RepositoryOptions } from '../../../../core/repositories/base.repository';
import { IProductMedia, ProductMediaModel } from '../../models';
import { IMediaRepository } from '../interfaces/media.repository.interface';
import { Media, MediaMapper } from '../mappers/media.mapper';

export class MediaRepositoryMongo extends BaseRepository<IProductMedia, Media> implements IMediaRepository {
  constructor() {
    super(ProductMediaModel, new MediaMapper());
  }

  async findByOwner(ownerType: 'product' | 'variant', ownerId: string, options?: RepositoryOptions): Promise<Media[]> {
    const docs = await this.model.find({ ownerType, ownerId, deletedAt: null }).session(options?.session || null).exec();
    return docs.map(doc => this.mapper.toDomain(doc));
  }
  
  async findById(id: string, options?: RepositoryOptions): Promise<Media | null> {
    return super.findById(id, options);
  }

  async delete(id: string, options?: RepositoryOptions): Promise<void> {
    return this.softDelete(id, options);
  }

  async deleteByOwner(ownerType: 'product' | 'variant', ownerId: string, options?: RepositoryOptions): Promise<void> {
     await this.model.updateMany(
         { ownerType, ownerId, deletedAt: null },
         { deletedAt: new Date() },
         options?.session ? { session: options.session } : {}
     ).exec();
  }
}
