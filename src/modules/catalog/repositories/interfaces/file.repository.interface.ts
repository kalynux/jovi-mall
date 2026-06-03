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
