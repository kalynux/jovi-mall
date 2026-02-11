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
   * Find orphaned files older than a given date (for garbage collection)
   */
  findOrphans(olderThan: Date, options?: RepositoryOptions): Promise<File[]>;
  
  /**
   * Update orphan status for a file
   */
  updateOrphanStatus(id: string, isOrphan: boolean, options?: RepositoryOptions): Promise<void>;
  
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
