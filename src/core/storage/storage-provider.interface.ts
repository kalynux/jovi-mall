/**
 * Result of a successful file upload to storage
 */
export interface StoragePutResult {
  key: string;           // provider-specific key (file path or object key)
  size: number;          // file size in bytes
  mimeType: string;      // MIME type of the file
  checksum?: string;     // optional checksum (e.g., MD5, SHA256)
}

/**
 * Options for putting a file into storage
 */
export interface StoragePutOptions {
  mimeType: string;      // MIME type of the file
  folder: string;        // logical folder/prefix (e.g., 'products', 'variants', 'digital')
  filename?: string;     // optional custom filename (will generate if not provided)
}

/**
 * Storage Provider Abstraction
 * 
 * Allows seamless switching between storage backends (local, S3, GCS, R2, CDN)
 * without modifying business logic.
 * 
 * All file operations in the application MUST go through this interface.
 */
export interface IStorageProvider {
  /**
   * Store a file in the storage backend
   * @param buffer - File contents as Buffer
   * @param options - Storage options (mimeType, folder, optional filename)
   * @returns Promise resolving to storage result with key and metadata
   */
  put(buffer: Buffer, options: StoragePutOptions): Promise<StoragePutResult>;

  /**
   * Delete a file from storage
   * @param key - Provider-specific key of the file to delete
   * @returns Promise resolving when deletion is complete
   */
  delete(key: string): Promise<void>;

  /**
   * Get public URL for a file
   * @param key - Provider-specific key of the file
   * @returns Public URL for accessing the file
   */
  getPublicUrl(key: string): string;

  /**
   * Get signed URL for temporary access (optional, for private files)
   * @param key - Provider-specific key of the file
   * @param expiresInSeconds - Expiration time in seconds
   * @returns Promise resolving to signed URL
   */
  getSignedUrl?(key: string, expiresInSeconds: number): Promise<string>;

  /**
   * Get a readable stream for downloading a file
   * Used for secure file streaming in digital product delivery
   * @param key - Provider-specific key of the file
   * @returns Promise resolving to a readable stream
   */
  getDownloadStream(key: string): Promise<NodeJS.ReadableStream>;

  /**
   * Get file contents as a buffer (for small files)
   * @param key - Provider-specific key of the file
   * @returns Promise resolving to file buffer
   */
  getBuffer(key: string): Promise<Buffer>;

  /**
   * Get the provider type identifier
   * Used to store provider type in database records
   * @returns Provider type ('local' | 's3' | 'gcs' | 'r2' | 'firebase' | 'cloudinary')
   */
  getProviderType(): 'local' | 's3' | 'gcs' | 'r2' | 'firebase' | 'cloudinary';
}
