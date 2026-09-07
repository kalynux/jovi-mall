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

  ownerType?: 'vendor' | 'admin' | 'customer' | 'agent' | 'agency' | 'system';
  ownerId?: string;

  orphanedAt?: Date | null;

  /**
   * Set while the owner is over their plan storage cap and this file falls outside it.
   * Read on the way out by `toFileDetail` — see `modules/plan-quota/`. Never a deletion.
   */
  quotaBlockedAt?: Date | null;

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
      ownerType: doc.ownerType,
      ownerId: doc.ownerId?.toString(),
      orphanedAt: doc.orphanedAt,
      quotaBlockedAt: doc.quotaBlockedAt ?? null,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      deletedAt: doc.deletedAt,
      purgeAt: doc.purgeAt,
    };
  }

  toPersistence(domain: File): IFile {
    return {
      _id: domain.id,
      key: domain.key,
      provider: domain.provider,
      mimeType: domain.mimeType,
      size: domain.size,
      checksum: domain.checksum,
      originalName: domain.originalName,
      ownerType: domain.ownerType,
      ownerId: domain.ownerId,
    } as any;
  }
}
