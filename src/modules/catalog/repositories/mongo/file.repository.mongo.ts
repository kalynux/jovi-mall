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

  async findLonely(cutoff: Date, limit: number, options?: RepositoryOptions): Promise<File[]> {
    // Lonely = no live references. Compute the referenced set first, then take
    // its complement among files whose lonely clock has elapsed. The clock is
    // orphanedAt (stamped when the last reference was removed) and falls back to
    // createdAt for files that were uploaded but never attached.
    const referencedIds = await FileReferenceModel.find({ deletedAt: null })
      .distinct('fileId')
      .session(options?.session ?? null)
      .exec();

    const query = this.model.find({
      _id: { $nin: referencedIds },
      deletedAt: null,
      $or: [
        { orphanedAt: { $ne: null, $lt: cutoff } },
        { orphanedAt: null, createdAt: { $lt: cutoff } },
      ],
    }).limit(limit);

    if (options?.session) {
      query.session(options.session);
    }

    const docs = await query.exec();
    return docs.map(doc => this.mapper.toDomain(doc));
  }

  /**
   * Every one of an owner's live files, **oldest first** — the order the plan-quota
   * sweep fills the storage allowance in, and therefore the order it blocks against.
   *
   * Projected deliberately narrow (`size`, `createdAt`, `quotaBlockedAt`, `mimeType`)
   * rather than mapped to the domain entity: this runs over an owner's entire library,
   * which for a 100 GB plan is tens of thousands of rows, and hydrating Mongoose
   * documents for all of them to read three fields is the difference between a sweep
   * that finishes and one that does not.
   *
   * ⚠ **`createdAt` ASC then `_id` ASC.** The `_id` tie-break is load-bearing for the
   * same reason as on products: a multi-file upload lands several rows in one
   * millisecond, an unstable sort would move the cut-off between runs, and the files
   * either side of it would flip between visible and blocked on every sweep.
   *
   * ⚠ Digital-product assets are NOT excluded here — the caller does that, because
   * "which files are metered" is `MediaStorageService`'s rule (vendors have their
   * digital assets subtracted; agencies and agents do not) and it must not be
   * reimplemented at a second site.
   */
  async listOwnedOldestFirst(
    ownerType: string,
    ownerId: string,
    options?: RepositoryOptions,
  ): Promise<Array<{ id: string; size: number; mimeType: string; createdAt: Date; quotaBlockedAt: Date | null }>> {
    if (!Types.ObjectId.isValid(ownerId)) return [];

    const docs = await this.model
      .find({ ownerType, ownerId: new Types.ObjectId(ownerId), deletedAt: null })
      .select('size mimeType createdAt quotaBlockedAt')
      .sort({ createdAt: 1, _id: 1 })
      .session(options?.session ?? null)
      .lean()
      .exec();

    return (docs as any[]).map(d => ({
      id: d._id.toString(),
      size: d.size ?? 0,
      mimeType: d.mimeType ?? '',
      createdAt: d.createdAt as Date,
      quotaBlockedAt: (d.quotaBlockedAt ?? null) as Date | null,
    }));
  }

  /**
   * Stamp or clear `quotaBlockedAt` on a set of files in one write.
   *
   * ⚠ **This is not a delete and must never become one.** The row, the bytes and the
   * file's contribution to the owner's used-bytes total all survive — that is the whole
   * promise the feature makes ("we do not delete your data, we stop serving it"), and it
   * is what lets an upgrade restore the identical set. Nothing here touches `deletedAt`
   * or `orphanedAt`; in particular the lonely-file cleanup clock is untouched, so a
   * blocked file is not one day silently swept.
   */
  async setQuotaBlocked(fileIds: string[], blocked: boolean, options?: RepositoryOptions): Promise<number> {
    const ids = fileIds.filter(id => Types.ObjectId.isValid(id)).map(id => new Types.ObjectId(id));
    if (ids.length === 0) return 0;

    const result = await this.model.updateMany(
      { _id: { $in: ids }, deletedAt: null },
      { $set: { quotaBlockedAt: blocked ? new Date() : null } },
      options?.session ? { session: options.session } : {},
    ).exec();

    return result.modifiedCount ?? 0;
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
