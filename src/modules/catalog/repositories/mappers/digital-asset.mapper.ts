import { IMapper } from '../../../../core/database/mapper.interface';
import { IDigitalAsset } from '../../models';

export interface DigitalAsset {
  id: string;
  productId: string;
  mediaId: string;
  downloadLimit?: number;
  isUnlimited: boolean;
  expiresAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
}

export class DigitalAssetMapper implements IMapper<DigitalAsset, IDigitalAsset> {
  toDomain(persistence: IDigitalAsset): DigitalAsset {
    const doc = persistence.toObject ? persistence.toObject() : persistence;
    return {
      id: doc._id.toString(),
      productId: doc.productId.toString(),
      mediaId: doc.mediaId.toString(),
      downloadLimit: doc.downloadLimit,
      isUnlimited: doc.isUnlimited,
      expiresAt: doc.expiresAt,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      deletedAt: doc.deletedAt,
    };
  }

  toPersistence(domain: DigitalAsset): IDigitalAsset {
    return {
      _id: domain.id,
      productId: domain.productId,
      mediaId: domain.mediaId,
      downloadLimit: domain.downloadLimit,
      isUnlimited: domain.isUnlimited,
      expiresAt: domain.expiresAt,
    } as any;
  }
}
