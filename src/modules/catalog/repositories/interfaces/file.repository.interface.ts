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
   * Find file by provider key
   */
  findByKey(key: string, provider: string, options?: RepositoryOptions): Promise<File | null>;

  /**
   * Find files with zero usage count older than a given date (for garbage collection)
   */
  findOrphans(olderThan: Date, options?: RepositoryOptions): Promise<File[]>;

  /**
   * Atomically increment usageCount by 1
   * Uses MongoDB $inc operator for atomic updates
   * @throws Error if file not found
   */
  incrementUsageCount(fileId: string, options?: RepositoryOptions): Promise<void>;

  /**
   * Atomically decrement usageCount by 1
   * Guards against negative values (only decrements if usageCount >= 1)
   * @throws Error if file not found or usageCount < 1
   */
  decrementUsageCount(fileId: string, options?: RepositoryOptions): Promise<void>;

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
