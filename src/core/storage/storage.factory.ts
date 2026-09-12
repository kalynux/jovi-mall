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
/**
 * ⚠ **READ THIS BEFORE ADDING OR CHANGING A PROVIDER — ADR-A01 D-2 × ADR-019 D-1a.**
 *
 * Three storage trees are **private**: `digital/`, `shipments/` and `ticket-attachments/`
 * (`core/storage/storage-trees.ts`). They left `express.static` because the raw path made the
 * download token's single-use consumption, its counter and its revocation advisory, and made a
 * delivery-proof photo — a place and a time about a real address — permanently fetchable by
 * anyone who saw its URL once.
 *
 * **The enforcement is `toFileDetail` returning `url: null` for those keys, plus the mount
 * list. Neither of those is inside a provider.** So a provider added here that hands back a
 * public CDN URL — which is exactly what an object-storage provider does by default — would
 * **reinstate the leak without touching either file, and without a single test failing.** The
 * `url` would simply be non-null again and every client would render it.
 *
 * Uploaded bytes are also destined to leave the container filesystem (ADR-019 D-1a: the volume
 * half is done, the `STORAGE_PROVIDER` half is not). **Whichever of the two lands second is the
 * one that has to remember this**, and it will be somebody who is thinking about buckets, not
 * about tickets. Concretely, a new provider must:
 *
 *   1. store the private trees with **no public read ACL** — the object itself must be
 *      unreadable without a credential, not merely un-linked; and
 *   2. serve them through the same authorized routes (`GET /api/digital/download/:token`,
 *      `GET /api/{agent,agency}/shipments/:id/delivery-proof/file`), streaming through
 *      `getDownloadStream`, or through a **short-lived signed URL minted inside those routes**
 *      — never one minted in `getPublicUrl`, which has no idea who is asking.
 *
 * ── `r2` is the first provider that actually satisfies both points ────────────
 * It meets (1) with **TWO BUCKETS** rather than a per-object flag, because **R2 has no
 * per-object ACL at all** — `ACL: 'public-read'` is accepted and silently discarded, so an
 * object is reachable iff its BUCKET carries a public binding. `bucketForKey` routes on
 * `isPrivateStorageKey`, and the private bucket has no custom domain and no r2.dev binding, so
 * its objects are unreachable without a signed request. It meets (2) by implementing
 * `getDownloadStream` for real — the first non-local provider to do so — and by making
 * `getPublicUrl` **throw** on a private key rather than return a string, so the leak this header
 * warns about cannot be reintroduced silently by a caller that forgets to guard.
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

    case 'r2':
      if (!config.r2) {
        throw createAppError(
          ERROR_CODES.CONFIG_MISSING_STORAGE_PROVIDER,
          500,
          'R2 storage configuration is required when provider is "r2"'
        );
      }
      // Lazy-load R2 provider to avoid importing the AWS SDK unless needed
      // eslint-disable-next-line @typescript-eslint/no-require-imports, no-case-declarations
      const { R2StorageProvider } = require('./providers/r2-storage.provider');
      return new R2StorageProvider(config.r2);

    default:
      throw createAppError(
        ERROR_CODES.CONFIG_INVALID_STORAGE_PROVIDER,
        500,
        `Unknown storage provider: ${provider}. Supported providers: local, firebase, cloudinary, r2`
      );
  }
}
