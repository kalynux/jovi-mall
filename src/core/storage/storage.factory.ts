import { IStorageProvider } from './storage-provider.interface';
import { StorageConfig, StorageProviderType } from './storage.config';
import { LocalStorageProvider } from './providers/local-storage.provider';
import { createAppError } from '../errors';
import { ERROR_CODES } from '../error-codes';

/**
 * Storage Provider Factory
 * 
 * This is the ONLY place where provider selection happens.
 * Creates and configures the appropriate storage provider based on configuration.
 * 
 * @param config - Storage configuration with provider type and provider-specific settings
 * @returns Configured storage provider instance
 * @throws Error if provider type is invalid or required configuration is missing
 */
export function createStorageProvider(config: StorageConfig): IStorageProvider {
  const { provider } = config;

  switch (provider) {
    case 'local':
      if (!config.local) {
        throw createAppError(
          ERROR_CODES.CONFIG_MISSING_STORAGE_PROVIDER,
          500,
          'Local storage configuration is required when provider is "local"'
        );
      }
      return new LocalStorageProvider(config.local);

    case 'firebase':
      if (!config.firebase) {
        throw createAppError(
          ERROR_CODES.CONFIG_MISSING_STORAGE_PROVIDER,
          500,
          'Firebase storage configuration is required when provider is "firebase"'
        );
      }
      // Lazy-load Firebase provider to avoid importing SDK unless needed
      // eslint-disable-next-line @typescript-eslint/no-require-imports, no-case-declarations
      const { FirebaseStorageProvider } = require('./providers/firebase-storage.provider');
      return new FirebaseStorageProvider(config.firebase);

    case 'cloudinary':
      if (!config.cloudinary) {
        throw createAppError(
          ERROR_CODES.CONFIG_MISSING_STORAGE_PROVIDER,
          500,
          'Cloudinary storage configuration is required when provider is "cloudinary"'
        );
      }
      // Lazy-load Cloudinary provider to avoid importing SDK unless needed
      // eslint-disable-next-line @typescript-eslint/no-require-imports, no-case-declarations
      const { CloudinaryStorageProvider } = require('./providers/cloudinary-storage.provider');
      return new CloudinaryStorageProvider(config.cloudinary);

    default:
      throw createAppError(
        ERROR_CODES.CONFIG_INVALID_STORAGE_PROVIDER,
        500,
        `Unknown storage provider: ${provider}. Supported providers: local, firebase, cloudinary`
      );
  }
}
