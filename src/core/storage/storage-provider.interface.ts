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
   *
   * ⚠ **Not every provider implements this** — `firebase` and `cloudinary` both throw a
   * 501 from it today. Ask `supportsDownloadStream()` FIRST on any path where the absence
   * is a state to report rather than a fault; see that method's note.
   */
  getDownloadStream(key: string): Promise<NodeJS.ReadableStream>;

  /**
   * Can this provider actually serve bytes through `getDownloadStream`?
   *
   * ── Why a declared capability rather than a try/catch ─────────────────────
   * `getDownloadStream` is a REQUIRED interface member that two of the three providers
   * implement by throwing `501`, so its presence proves nothing and `typeof` feature
   * detection cannot see the difference. The two alternatives are both worse:
   *
   *   - **catch the 501 and translate it** — fragile in the dangerous direction, because
   *     any unrelated 501 raised deeper in a provider becomes "this deployment cannot
   *     show private files", which is a *configuration* verdict drawn from an incident;
   *   - **keep a list of provider names at the call site** — a census that lives away from
   *     the thing it describes, and that a new provider silently falls off.
   *
   * Declaring it here makes it a compile error for a provider to omit an answer, which is
   * the same enforcement `storage-trees.ts` gets from its exhaustive table: an
   * unclassified case fails the build rather than surprising somebody in production.
   *
   * ── This answers "can it", never "may it" ─────────────────────────────────
   * Authorization is the caller's business. A `true` here says only that bytes are
   * obtainable; it says nothing about whether the requester is allowed them.
   *
   * @returns `true` when `getDownloadStream` is genuinely implemented
   */
  supportsDownloadStream(): boolean;

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
