/**
 * Storage Provider Configuration Types
 * 
 * Defines configuration for all supported storage providers.
 * Only one provider can be active at a time, selected via STORAGE_PROVIDER env var.
 */

export type StorageProviderType = 'local' | 'firebase' | 'cloudinary' | 'r2';

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
 * Cloudflare R2 storage configuration — TWO BUCKETS, and that is the mechanism.
 *
 * ⚠ **R2 has no per-object ACL.** `PutObjectCommand({ ACL: 'public-read' })` is accepted and
 * silently discarded; an object is reachable if and only if its BUCKET carries a public binding
 * (a Cloudflare custom domain, or the `r2.dev` development URL). So the ADR-A01 D-2 requirement
 * that `storage.factory.ts` spells out — "the object itself must be unreadable without a
 * credential, not merely un-linked" — **cannot be met with one bucket and a per-object flag.**
 *
 * It is met by routing every operation on `isPrivateStorageKey(key)` into one of two buckets,
 * only one of which has a public binding at all. `digital/`, `shipments/` and
 * `ticket-attachments/` go to `privateBucket`; everything else to `bucket`.
 *
 * `privateBucket` is REQUIRED and must DIFFER from `bucket`. Both conditions are refused twice —
 * at boot in `config/env.ts`, and again in the provider constructor before the S3 client is
 * built — because a single bucket serving both trees would put every paid digital product and
 * every delivery-proof photograph on a public CDN, permanently, fetchable by anyone who saw the
 * key once. That is the exact defect the private-tree classification exists to close.
 *
 * ⚠ One thing no code here can check: that `privateBucket` has **no custom domain and its r2.dev
 * development URL disabled** in the Cloudflare dashboard. Verify it by hand before deploying.
 */
export interface R2StorageConfig {
  accountId: string;       // the S3 endpoint is DERIVED from this — there is no endpoint variable
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;          // PUBLIC bucket — carries the Cloudflare custom domain below
  privateBucket: string;   // PRIVATE bucket — NO public binding of any kind. Must differ.
  publicUrl: string;       // custom-domain base, NO trailing slash (e.g. 'https://cdn.example.com')
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
  r2?: R2StorageConfig;
}
