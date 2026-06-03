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
 * - STORAGE_PROVIDER: 'local' | 'firebase' | 'cloudinary' (default: 'local')
 * - STORAGE_LOCAL_PATH: Path for local storage (default: './storage')
 * - STORAGE_LOCAL_URL: Public URL for local storage (default: 'http://localhost:3000/storage')
 * - STORAGE_FIREBASE_*: Firebase configuration (only required if provider is 'firebase')
 * - STORAGE_CLOUDINARY_*: Cloudinary configuration (only required if provider is 'cloudinary')
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
