import { StorageConfig, StorageProviderType } from './storage.config';
import { IStorageProvider } from './storage-provider.interface';
import { createStorageProvider } from './storage.factory';

/**
 * Centralized Storage Configuration
 * 
 * Single source of truth for all storage provider configuration.
 * Configuration is loaded from environment variables with sensible defaults.
 * 
 * USAGE:
 * ```typescript
 * import { getStorageProvider } from '@/core/storage';
 * const storage = getStorageProvider();
 * ```
 * 
 * ENVIRONMENT VARIABLES:
 * - STORAGE_PROVIDER: 'local' | 'firebase' | 'cloudinary' | 'r2' (default: 'local')
 * - STORAGE_LOCAL_PATH: Path for local storage (default: './storage')
 * - STORAGE_LOCAL_URL: Public URL for local storage (default: 'http://localhost:3000/storage')
 * - STORAGE_FIREBASE_*: Firebase configuration (only required if provider is 'firebase')
 * - STORAGE_CLOUDINARY_*: Cloudinary configuration (only required if provider is 'cloudinary')
 * - STORAGE_R2_*: Cloudflare R2 configuration (only required if provider is 'r2')
 */

/**
 * Load storage configuration from environment variables
 */
function loadStorageConfig(): StorageConfig {
    const provider = (process.env.STORAGE_PROVIDER || 'local') as StorageProviderType;

    const config: StorageConfig = {
        provider,
    };

    // Load local storage config (always available as fallback)
    config.local = {
        basePath: process.env.STORAGE_LOCAL_PATH || './storage',
        baseUrl: process.env.STORAGE_LOCAL_URL || 'http://localhost:8022/api/files',
    };

    // Load Firebase config if available
    if (process.env.STORAGE_FIREBASE_PROJECT_ID) {
        config.firebase = {
            projectId: process.env.STORAGE_FIREBASE_PROJECT_ID,
            clientEmail: process.env.STORAGE_FIREBASE_CLIENT_EMAIL || '',
            privateKey: (process.env.STORAGE_FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
            bucket: process.env.STORAGE_FIREBASE_BUCKET || '',
            public: process.env.STORAGE_FIREBASE_PUBLIC === 'true',
        };
    }

    // Load Cloudinary config if available
    if (process.env.STORAGE_CLOUDINARY_CLOUD_NAME) {
        config.cloudinary = {
            cloudName: process.env.STORAGE_CLOUDINARY_CLOUD_NAME,
            apiKey: process.env.STORAGE_CLOUDINARY_API_KEY || '',
            apiSecret: process.env.STORAGE_CLOUDINARY_API_SECRET || '',
            folderPrefix: process.env.STORAGE_CLOUDINARY_FOLDER_PREFIX || 'jovi',
        };
    }

    // Load Cloudflare R2 config if available.
    //
    // ⚠ Keyed on ACCOUNT_ID, matching the firebase/cloudinary pattern above: a provider block is
    // attached only when its FIRST credential is present, so a half-configured `r2` reaches the
    // factory as `config.r2 === undefined` and gets a named 500 rather than an authentication
    // error on the first upload. `config/env.ts` refuses the boot before it gets that far.
    if (process.env.STORAGE_R2_ACCOUNT_ID) {
        config.r2 = {
            accountId: process.env.STORAGE_R2_ACCOUNT_ID,
            accessKeyId: process.env.STORAGE_R2_ACCESS_KEY_ID || '',
            secretAccessKey: process.env.STORAGE_R2_SECRET_ACCESS_KEY || '',
            bucket: process.env.STORAGE_R2_BUCKET || '',
            privateBucket: process.env.STORAGE_R2_PRIVATE_BUCKET || '',
            // ⚠ Trailing slash stripped here AND refused at boot AND stripped again in
            // wi-admin's copy. `getPublicUrl` concatenates as `${base}/${key}`, so a trailing
            // slash emits `//key`, which an R2 custom domain treats as a DIFFERENT key and 404s
            // — and it would be identically wrong on both sides, so the one check designed to
            // catch divergence (`verify:files` § 6) would pass while every image was broken.
            publicUrl: (process.env.STORAGE_R2_PUBLIC_URL || '').replace(/\/+$/, ''),
        };
    }

    return config;
}

/**
 * Global storage configuration (loaded once at startup)
 */
export const storageConfig = loadStorageConfig();

/**
 * Singleton storage provider instance (lazy-initialized)
 */
let storageProviderInstance: IStorageProvider | null = null;

/**
 * Get the singleton storage provider instance
 * 
 * This is the recommended way to access storage throughout the application.
 * The provider is created lazily on first access and reused for all subsequent calls.
 * 
 * @returns Configured storage provider instance
 */
export function getStorageProvider(): IStorageProvider {
    if (!storageProviderInstance) {
        storageProviderInstance = createStorageProvider(storageConfig);
        console.log(`[Storage] Initialized ${storageConfig.provider} storage provider`);
    }
    return storageProviderInstance;
}

/**
 * Get the current storage provider type
 * 
 * Useful for debugging or conditional logic based on the active provider.
 * 
 * @returns Current storage provider type
 */
export function getStorageProviderType(): StorageProviderType {
    return storageConfig.provider;
}

/**
 * Reset the storage provider instance (for testing only)
 * 
 * This forces the next call to getStorageProvider() to create a new instance.
 * Should only be used in test environments.
 */
export function resetStorageProvider(): void {
    storageProviderInstance = null;
}
