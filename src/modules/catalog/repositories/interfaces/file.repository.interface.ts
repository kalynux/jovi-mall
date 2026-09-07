import { File } from '../mappers/file.mapper';
import { RepositoryOptions } from '../types';

/**
 * File Repository Interface
 * 
 * Data access layer for File entities.
 * All file database operations go through this interface.
 */
export interface IFileRepository {
  /**
   * Create a new file record
   */
  create(file: Omit<File, 'id' | 'createdAt' | 'updatedAt'>, options?: RepositoryOptions): Promise<File>;

  /**
   * Find file by ID
   */
  findById(id: string, options?: RepositoryOptions): Promise<File | null>;

  /**
   * Batch-fetch files by their IDs in a single query.
   * Invalid or missing IDs are silently dropped.
   */
  findManyByIds(ids: string[], options?: RepositoryOptions): Promise<File[]>;

  /**
   * Find file by provider key
   */
  findByKey(key: string, provider: string, options?: RepositoryOptions): Promise<File | null>;

  /**
   * Find an existing file with the same content checksum owned by the given
   * vendor. Scoped per-vendor so duplicate detection never matches files
   * uploaded by other owners. Returns null when no live (non-deleted) match
   * exists.
   */
  findByChecksum(checksum: string, ownerId: string, options?: RepositoryOptions): Promise<File | null>;

  /**
   * Find files with no live references older than a given date (for garbage
   * collection). "No references" is derived from the file_references collection.
   */
  findOrphans(olderThan: Date, options?: RepositoryOptions): Promise<File[]>;

  /**
   * Find "lonely" files eligible for permanent deletion: those with no live
   * references whose lonely clock (orphanedAt, falling back to createdAt for
   * never-attached uploads) is older than `cutoff`. Capped at `limit`.
   */
  findLonely(cutoff: Date, limit: number, options?: RepositoryOptions): Promise<File[]>;

  /**
   * Every one of an owner's live files, oldest first — the order the plan-quota sweep
   * fills the storage allowance in, and so the order it blocks against. Narrowly
   * projected: this walks an owner's whole library.
   *
   * Digital-product assets are deliberately NOT filtered out here; deciding what is
   * metered is `MediaStorageService`'s rule and belongs to the caller.
   */
  listOwnedOldestFirst(
    ownerType: string,
    ownerId: string,
    options?: RepositoryOptions,
  ): Promise<Array<{ id: string; size: number; mimeType: string; createdAt: Date; quotaBlockedAt: Date | null }>>;

  /**
   * Stamp or clear `quotaBlockedAt` on a set of files. Reversible and lossless — it
   * touches neither `deletedAt` nor `orphanedAt`, so a blocked file is never swept and
   * comes back unchanged when the owner has room again.
   */
  setQuotaBlocked(fileIds: string[], blocked: boolean, options?: RepositoryOptions): Promise<number>;

  /**
   * Update file metadata
   */
  update(id: string, updates: Partial<File>, options?: RepositoryOptions): Promise<File | null>;

  /**
   * Delete file record (soft delete)
   */
  softDelete(id: string, options?: RepositoryOptions): Promise<void>;

  /**
   * Permanently delete file record (hard delete)
   */
  hardDelete(id: string, options?: RepositoryOptions): Promise<void>;
}
