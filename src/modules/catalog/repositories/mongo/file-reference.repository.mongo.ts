import { Types } from 'mongoose';
import { RepositoryOptions } from '../../../../core/repositories/base.repository';
import { FileReferenceModel, IFileReference, FileReferenceEntityType } from '../../models/file-reference.model';
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

    return (detached as Types.ObjectId[]).map((id) => id.toString());
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
