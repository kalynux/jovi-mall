import { Types } from 'mongoose';
import { BaseRepository, RepositoryOptions } from '../../../../core/repositories/base.repository';
import { FileModel, IFile } from '../../models/file.model';
import { IFileRepository } from '../interfaces/file.repository.interface';
import { File, FileMapper } from '../mappers/file.mapper';
import { createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';

/**
 * File Repository - MongoDB Implementation
 * 
 * Implements file data access with soft delete support and transaction handling.
 */
export class FileRepositoryMongo extends BaseRepository<IFile, File> implements IFileRepository {
  constructor() {
    super(FileModel, new FileMapper());
  }

  async create(file: Omit<File, 'id' | 'createdAt' | 'updatedAt'>, options?: RepositoryOptions): Promise<File> {
    const persistence = {
      ...file,
    } as any;

    const [doc] = await this.model.create([persistence], options?.session ? { session: options.session } : {});
    return this.mapper.toDomain(doc);
  }

  async findById(id: string, options?: RepositoryOptions): Promise<File | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    return this.findOne({ _id: id }, options);
  }

  async findByKey(key: string, provider: string, options?: RepositoryOptions): Promise<File | null> {
    return this.findOne({ key, provider }, options);
  }

  async findOrphans(olderThan: Date, options?: RepositoryOptions): Promise<File[]> {
    const query = this.model.find({
      usageCount: 0,  // Files with no references
      createdAt: { $lt: olderThan },
      deletedAt: null,
    });

    if (options?.session) {
      query.session(options.session);
    }

    const docs = await query.exec();
    return docs.map(doc => this.mapper.toDomain(doc));
  }

  async incrementUsageCount(fileId: string, options?: RepositoryOptions): Promise<void> {
    if (!Types.ObjectId.isValid(fileId)) {
      throw createAppError(ERROR_CODES.CATALOG_FILE_NOT_FOUND, 400, 'Invalid file ID');
    }

    const result = await this.model.findByIdAndUpdate(
      fileId,
      { $inc: { usageCount: 1 } },
      { session: options?.session }
    ).exec();

    if (!result) {
      throw createAppError(ERROR_CODES.CATALOG_FILE_NOT_FOUND, 404, 'File not found');
    }
  }

  async decrementUsageCount(fileId: string, options?: RepositoryOptions): Promise<void> {
    if (!Types.ObjectId.isValid(fileId)) {
      throw createAppError(ERROR_CODES.CATALOG_FILE_NOT_FOUND, 400, 'Invalid file ID');
    }

    // Guard: only decrement if usageCount >= 1
    const result = await this.model.findOneAndUpdate(
      { _id: fileId, usageCount: { $gte: 1 } },
      { $inc: { usageCount: -1 } },
      { session: options?.session }
    ).exec();

    if (!result) {
      throw createAppError(ERROR_CODES.CATALOG_FILE_NOT_FOUND, 404, 'Cannot decrement usageCount below 0 or file not found');
    }
  }

  async update(id: string, updates: Partial<File>, options?: RepositoryOptions): Promise<File | null> {
    if (!Types.ObjectId.isValid(id)) return null;

    const query = this.model.findOneAndUpdate(
      { _id: id, deletedAt: null },
      { $set: updates },
      { new: true, session: options?.session }
    );

    const doc = await query.exec();
    return doc ? this.mapper.toDomain(doc) : null;
  }

  async softDelete(id: string, options?: RepositoryOptions): Promise<void> {
    if (!Types.ObjectId.isValid(id)) return;

    await this.model.updateOne(
      { _id: id, deletedAt: null },
      { deletedAt: new Date() },
      options?.session ? { session: options.session } : {}
    ).exec();
  }

  async hardDelete(id: string, options?: RepositoryOptions): Promise<void> {
    if (!Types.ObjectId.isValid(id)) return;

    await this.model.deleteOne(
      { _id: id },
      options?.session ? { session: options.session } : {}
    ).exec();
  }
}
