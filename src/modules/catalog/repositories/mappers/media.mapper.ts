import { IMapper } from '../../../../core/database/mapper.interface';
import { IProductMedia } from '../../models';

export interface Media {
  id: string;
  ownerType: 'product' | 'variant';
  ownerId: string;
  provider: string;
  path: string;
  mimeType: string;
  size: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
}

export class MediaMapper implements IMapper<Media, IProductMedia> {
  toDomain(persistence: IProductMedia): Media {
    const doc = persistence.toObject ? persistence.toObject() : persistence;
    return {
      id: doc._id.toString(),
      ownerType: doc.ownerType,
      ownerId: doc.ownerId.toString(),
      provider: doc.provider,
      path: doc.path,
      mimeType: doc.mimeType,
      size: doc.size,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      deletedAt: doc.deletedAt,
    };
  }

  toPersistence(domain: Media): IProductMedia {
    return {
      _id: domain.id,
      ownerType: domain.ownerType,
      ownerId: domain.ownerId,
      provider: domain.provider,
      path: domain.path,
      mimeType: domain.mimeType,
      size: domain.size,
    } as any;
  }
}
