import { Types } from 'mongoose';
import { BaseRepository, RepositoryOptions } from '../../../../core/repositories/base.repository';
import { FileModel, IFile } from '../../models/file.model';
import { FileReferenceModel } from '../../models/file-reference.model';
import { IFileRepository } from '../interfaces/file.repository.interface';
import { File, FileMapper } from '../mappers/file.mapper';

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

  async findManyByIds(ids: string[], options?: RepositoryOptions): Promise<File[]> {
    if (ids.length === 0) return [];
    const validIds = ids.filter(id => Types.ObjectId.isValid(id));
    if (validIds.length === 0) return [];

    const query = this.model.find({
      _id: { $in: validIds.map(id => new Types.ObjectId(id)) },
      deletedAt: null,
    });
    if (options?.session) query.session(options.session);

    const docs = await query.exec();
    return docs.map(doc => this.mapper.toDomain(doc));
  }

  async findByKey(key: string, provider: string, options?: RepositoryOptions): Promise<File | null> {
    return this.findOne({ key, provider }, options);
  }

  async findByChecksum(checksum: string, ownerId: string, options?: RepositoryOptions): Promise<File | null> {
    if (!checksum || !Types.ObjectId.isValid(ownerId)) return null;
    return this.findOne(
      {
        checksum,
        ownerType: 'vendor',
        ownerId: new Types.ObjectId(ownerId),
      },
      options
    );
  }

  async findOrphans(olderThan: Date, options?: RepositoryOptions): Promise<File[]> {
    // A file is orphaned when nothing references it. References live in the
    // file_references collection, so the orphan set is the complement of the
    // distinct referenced fileIds.
    const referencedIds = await FileReferenceModel.find({ deletedAt: null })
      .distinct('fileId')
      .session(options?.session ?? null)
      .exec();

    const query = this.model.find({
      _id: { $nin: referencedIds },
      createdAt: { $lt: olderThan },
      deletedAt: null,
    });

    if (options?.session) {
      query.session(options.session);
    }

    const docs = await query.exec();
    return docs.map(doc => this.mapper.toDomain(doc));
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
