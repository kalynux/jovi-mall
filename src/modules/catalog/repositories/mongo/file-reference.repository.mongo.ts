import { Types } from 'mongoose';
import { RepositoryOptions } from '../../../../core/repositories/base.repository';
import { FileReferenceModel, IFileReference, FileReferenceEntityType } from '../../models/file-reference.model';
import { FileModel } from '../../models/file.model';
import {
  IFileReferenceRepository,
  AddFileReferenceInput,
  FileReferenceLink,
} from '../interfaces/file-reference.repository.interface';

/**
 * File Reference Repository - MongoDB implementation.
 *
 * All writes are session-aware so they join the same transaction as the entity
 * mutation that triggered them.
 */
export class FileReferenceRepositoryMongo implements IFileReferenceRepository {
  async add(input: AddFileReferenceInput, options?: RepositoryOptions): Promise<void> {
    if (!Types.ObjectId.isValid(input.fileId) || !Types.ObjectId.isValid(input.entityId)) {
      return;
    }
    const field = input.field ?? 'media';

    // Upsert on the live unique key. If a tombstoned row exists (deletedAt set),
    // revive it; otherwise insert. setOnInsert seeds immutable fields once.
    await FileReferenceModel.updateOne(
      {
        fileId: new Types.ObjectId(input.fileId),
        entityType: input.entityType,
        entityId: new Types.ObjectId(input.entityId),
        field,
      },
      {
        $set: {
          deletedAt: null,
          ownerType: input.ownerType,
          ownerId: input.ownerId ? new Types.ObjectId(input.ownerId) : undefined,
        },
      },
      { upsert: true, session: options?.session },
    ).exec();

    // The file is now referenced — clear any lonely clock.
    await this.clearOrphaned(input.fileId, options);
  }

  async remove(
    fileId: string,
    entityType: FileReferenceEntityType,
    entityId: string,
    field: string = 'media',
    options?: RepositoryOptions,
  ): Promise<void> {
    if (!Types.ObjectId.isValid(fileId) || !Types.ObjectId.isValid(entityId)) {
      return;
    }
    await FileReferenceModel.updateOne(
      {
        fileId: new Types.ObjectId(fileId),
        entityType,
        entityId: new Types.ObjectId(entityId),
        field,
        deletedAt: null,
      },
      { $set: { deletedAt: new Date() } },
      { session: options?.session },
    ).exec();

    // If that was the file's last reference, start the lonely clock.
    await this.stampOrphanedIfUnreferenced(fileId, options);
  }

  async removeAllForEntity(
    entityType: FileReferenceEntityType,
    entityId: string,
    options?: RepositoryOptions,
  ): Promise<string[]> {
    if (!Types.ObjectId.isValid(entityId)) {
      return [];
    }
    const filter = {
      entityType,
      entityId: new Types.ObjectId(entityId),
      deletedAt: null,
    };

    const detached = await FileReferenceModel.find(filter).distinct('fileId').session(options?.session ?? null).exec();

    await FileReferenceModel.updateMany(
      filter,
      { $set: { deletedAt: new Date() } },
      { session: options?.session },
    ).exec();

    const detachedIds = (detached as Types.ObjectId[]).map((id) => id.toString());

    // Start the lonely clock for any of these files that now have no references.
    for (const fileId of detachedIds) {
      await this.stampOrphanedIfUnreferenced(fileId, options);
    }

    return detachedIds;
  }

  async findByFile(fileId: string, options?: RepositoryOptions): Promise<FileReferenceLink[]> {
    if (!Types.ObjectId.isValid(fileId)) return [];
    const query = FileReferenceModel.find({
      fileId: new Types.ObjectId(fileId),
      deletedAt: null,
    }).lean();
    if (options?.session) query.session(options.session);

    const docs = await query.exec();
    return docs.map((d) => this.toLink(d as any));
  }

  async findByEntity(
    entityType: FileReferenceEntityType,
    entityId: string,
    options?: RepositoryOptions,
  ): Promise<FileReferenceLink[]> {
    if (!Types.ObjectId.isValid(entityId)) return [];
    const query = FileReferenceModel.find({
      entityType,
      entityId: new Types.ObjectId(entityId),
      deletedAt: null,
    }).lean();
    if (options?.session) query.session(options.session);

    const docs = await query.exec();
    return docs.map((d) => this.toLink(d as any));
  }

  async countByFile(fileId: string, options?: RepositoryOptions): Promise<number> {
    if (!Types.ObjectId.isValid(fileId)) return 0;
    const query = FileReferenceModel.countDocuments({
      fileId: new Types.ObjectId(fileId),
      deletedAt: null,
    });
    if (options?.session) query.session(options.session);
    return query.exec();
  }

  async listReferencedFileIds(options?: RepositoryOptions): Promise<string[]> {
    const ids = await FileReferenceModel.find({ deletedAt: null })
      .distinct('fileId')
      .session(options?.session ?? null)
      .exec();
    return (ids as Types.ObjectId[]).map((id) => id.toString());
  }

  /**
   * Stamp File.orphanedAt = now if the file has no live references left. Only
   * sets the clock when it is currently null, so an already-running grace period
   * is never reset. Single funnel for every detach path (product/variant/ticket
   * and the cleanup sweep), keeping loneliness deterministic.
   */
  private async stampOrphanedIfUnreferenced(fileId: string, options?: RepositoryOptions): Promise<void> {
    if (!Types.ObjectId.isValid(fileId)) return;
    const liveCount = await this.countByFile(fileId, options);
    if (liveCount > 0) return;
    await FileModel.updateOne(
      { _id: new Types.ObjectId(fileId), orphanedAt: null },
      { $set: { orphanedAt: new Date() } },
      { session: options?.session },
    ).exec();
  }

  /** Clear File.orphanedAt — the file is referenced again. */
  private async clearOrphaned(fileId: string, options?: RepositoryOptions): Promise<void> {
    if (!Types.ObjectId.isValid(fileId)) return;
    await FileModel.updateOne(
      { _id: new Types.ObjectId(fileId), orphanedAt: { $ne: null } },
      { $set: { orphanedAt: null } },
      { session: options?.session },
    ).exec();
  }

  private toLink(doc: IFileReference & { _id: Types.ObjectId }): FileReferenceLink {
    return {
      id: doc._id.toString(),
      fileId: doc.fileId.toString(),
      entityType: doc.entityType,
      entityId: doc.entityId.toString(),
      field: doc.field,
      ownerType: doc.ownerType,
      ownerId: doc.ownerId?.toString(),
    };
  }
}
