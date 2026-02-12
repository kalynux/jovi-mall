import { IMapper } from '../../../../core/database/mapper.interface';
import { IFile } from '../../models/file.model';

/**
 * File Domain Entity
 * 
 * Clean domain representation with string IDs, decoupled from MongoDB.
 */
export interface File {
  id: string;
  key: string;
  provider: 'local' | 's3' | 'gcs' | 'r2' | 'firebase' | 'cloudinary';
  mimeType: string;
  size: number;
  checksum?: string;
  originalName?: string;

  usageCount: number;  // Reference count for safe cleanup

  ownerType?: 'vendor' | 'admin' | 'customer' | 'agent' | 'agency' | 'system';
  ownerId?: string;

  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
  purgeAt?: Date | null;
}

/**
 * File Mapper
 * 
 * Bidirectional mapping between File domain entity and MongoDB persistence model.
 */
export class FileMapper implements IMapper<File, IFile> {
  toDomain(persistence: IFile): File {
    const doc = persistence.toObject ? persistence.toObject() : persistence;
    return {
      id: doc._id.toString(),
      key: doc.key,
      provider: doc.provider,
      mimeType: doc.mimeType,
      size: doc.size,
      checksum: doc.checksum,
      originalName: doc.originalName,
      usageCount: doc.usageCount || 0,
      ownerType: doc.ownerType,
      ownerId: doc.ownerId?.toString(),
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      deletedAt: doc.deletedAt,
      purgeAt: doc.purgeAt,
    };
  }

  toPersistence(domain: File): IFile {
    return {
      // @ts-ignore: _id is optional in creation, handled by Mongoose
      _id: domain.id,
      key: domain.key,
      provider: domain.provider,
      mimeType: domain.mimeType,
      size: domain.size,
      checksum: domain.checksum,
      originalName: domain.originalName,
      usageCount: domain.usageCount,
      ownerType: domain.ownerType,
      ownerId: domain.ownerId,
    } as any;
  }
}
