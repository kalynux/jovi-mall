import { RepositoryOptions } from '../types';
import { FileReferenceEntityType } from '../../models/file-reference.model';
import { FileOwnerType } from '../../models/file.model';

/**
 * A single live link between a file and an entity that references it.
 */
export interface FileReferenceLink {
  id: string;
  fileId: string;
  entityType: FileReferenceEntityType;
  entityId: string;
  field: string;
  ownerType?: FileOwnerType;
  ownerId?: string;
}

export interface AddFileReferenceInput {
  fileId: string;
  entityType: FileReferenceEntityType;
  entityId: string;
  field?: string; // defaults to 'media'
  ownerType?: FileOwnerType;
  ownerId?: string;
}

/**
 * File Reference Repository
 *
 * Source of truth for which entities reference which files. Replaces the old
 * File.usageCount counter — a file is "in use" iff it has at least one live row.
 */
export interface IFileReferenceRepository {
  /**
   * Create (or revive) a live reference. Idempotent on
   * (fileId, entityType, entityId, field) — re-attaching is a no-op.
   */
  add(input: AddFileReferenceInput, options?: RepositoryOptions): Promise<void>;

  /**
   * Soft-delete a single reference. No-op if it does not exist.
   */
  remove(
    fileId: string,
    entityType: FileReferenceEntityType,
    entityId: string,
    field?: string,
    options?: RepositoryOptions,
  ): Promise<void>;

  /**
   * Soft-delete every live reference held by an entity (cascade on entity delete).
   * Returns the fileIds that were detached so callers can react if needed.
   */
  removeAllForEntity(
    entityType: FileReferenceEntityType,
    entityId: string,
    options?: RepositoryOptions,
  ): Promise<string[]>;

  /**
   * All live references to a file (what would break if it were deleted).
   */
  findByFile(fileId: string, options?: RepositoryOptions): Promise<FileReferenceLink[]>;

  /**
   * All live references held by a single entity (e.g. one product or ticket).
   * Used by the cleanup sweep to detach each reference individually while
   * honoring per-file guards.
   */
  findByEntity(
    entityType: FileReferenceEntityType,
    entityId: string,
    options?: RepositoryOptions,
  ): Promise<FileReferenceLink[]>;

  /**
   * Number of live references to a file (the derived replacement for usageCount).
   */
  countByFile(fileId: string, options?: RepositoryOptions): Promise<number>;

  /**
   * Distinct fileIds that have at least one live reference — used to compute the
   * complement (orphaned files) for garbage collection.
   */
  listReferencedFileIds(options?: RepositoryOptions): Promise<string[]>;
}
