/**
 * Storage Provider Configuration Types
 * 
 * Defines configuration for all supported storage providers.
 * Only one provider can be active at a time, selected via STORAGE_PROVIDER env var.
 */

export type StorageProviderType = 'local' | 'firebase' | 'cloudinary';

/**
 * Local filesystem storage configuration
 */
export interface LocalStorageConfig {
  basePath: string;      // absolute path to storage directory (e.g., './storage')
  baseUrl: string;       // base URL for public access (e.g., 'http://localhost:3000/storage')
}

/**
 * Firebase Storage configuration
 */
export interface FirebaseStorageConfig {
  projectId: string;
  clientEmail: string;
  privateKey: string;
  bucket: string;        // e.g., 'my-app.appspot.com'
  public: boolean;       // if true, files are publicly accessible; if false, use signed URLs
}

/**
 * Cloudinary storage configuration
 */
export interface CloudinaryStorageConfig {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
  folderPrefix: string;  // e.g., 'jovi' - prepended to all upload folders
}

/**
 * Unified storage configuration
 * 
 * Application should provide configuration for all providers,
 * but only the active provider (determined by `provider` field) will be used.
 */
export interface StorageConfig {
  provider: StorageProviderType;
  
  local?: LocalStorageConfig;
  firebase?: FirebaseStorageConfig;
  cloudinary?: CloudinaryStorageConfig;
}
