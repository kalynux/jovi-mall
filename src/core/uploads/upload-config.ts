/**
 * Upload Policy Configuration
 * 
 * Defines configuration model for upload security policies.
 * All limits, rules, and behaviors are config-driven.
 */

/**
 * Per-MIME-type policy configuration
 */
export interface MimeTypePolicy {
  allowed: boolean;
  maxSizeBytes: number;
  transforms?: {
    resize?: {
      maxWidth: number;
      maxHeight: number;
    };
    convertTo?: 'webp' | 'jpeg' | 'png';
    compress?: boolean;
  };
}

/**
 * Virus scanning configuration
 */
export interface VirusScanConfig {
  enabled: boolean;
  provider: 'mock' | 'clamav' | 'cloud';
  blockOnFailure: boolean;  // Block upload if scan fails (vs just log warning)
}

/**
 * User quota configuration
 */
export interface UserQuotaConfig {
  enabled: boolean;
  maxFilesTotal: number;  // Max total files per user/vendor
  maxStorageBytes: number;  // Max total storage per user/vendor
}

/**
 * File fingerprinting configuration
 */
export interface FingerprintingConfig {
  algorithm: 'sha256' | 'md5';
  enabled: boolean;
}

/**
 * Duplicate detection configuration
 */
export interface DuplicateDetectionConfig {
  enabled: boolean;
  blockDuplicates: boolean;  // If true, reject duplicates; if false, return existing file reference
}

/**
 * Observability configuration
 */
export interface ObservabilityConfig {
  enabled: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

/**
 * Main upload policy configuration
 */
export interface UploadPolicyConfig {
  // Request-level limits
  maxFilesPerRequest: number;
  maxTotalSizeBytes: number;
  
  // Per-MIME-type policies
  perMimeType: Record<string, MimeTypePolicy>;
  
  // Feature configs
  virusScan: VirusScanConfig;
  userQuotas: UserQuotaConfig;
  fingerprinting: FingerprintingConfig;
  duplicateDetection: DuplicateDetectionConfig;
  observability: ObservabilityConfig;
}

/**
 * Get default upload configuration
 * Sensible defaults for development/production
 */
export function getDefaultUploadConfig(): UploadPolicyConfig {
  return {
    maxFilesPerRequest: 10,
    maxTotalSizeBytes: 100 * 1024 * 1024, // 100MB
    
    perMimeType: {
      // Images
      'image/jpeg': {
        allowed: true,
        maxSizeBytes: 10 * 1024 * 1024, // 10MB
        transforms: {
          resize: { maxWidth: 2048, maxHeight: 2048 },
          compress: true,
        },
      },
      'image/png': {
        allowed: true,
        maxSizeBytes: 10 * 1024 * 1024,
        transforms: {
          resize: { maxWidth: 2048, maxHeight: 2048 },
          convertTo: 'webp',
          compress: true,
        },
      },
      'image/webp': {
        allowed: true,
        maxSizeBytes: 10 * 1024 * 1024,
        transforms: {
          resize: { maxWidth: 2048, maxHeight: 2048 },
          compress: true,
        },
      },
      'image/gif': {
        allowed: true,
        maxSizeBytes: 5 * 1024 * 1024, // 5MB
        transforms: {
          resize: { maxWidth: 1024, maxHeight: 1024 },
        },
      },
      
      // Documents
      'application/pdf': {
        allowed: true,
        maxSizeBytes: 25 * 1024 * 1024, // 25MB
      },
      'application/zip': {
        allowed: true,
        maxSizeBytes: 50 * 1024 * 1024, // 50MB
      },
      
      // Audio
      'audio/mpeg': {
        allowed: true,
        maxSizeBytes: 10 * 1024 * 1024,
      },
      'audio/wav': {
        allowed: true,
        maxSizeBytes: 25 * 1024 * 1024,
      },
      
      // Video (disabled by default - uncomment to enable)
      // 'video/mp4': {
      //   allowed: true,
      //   maxSizeBytes: 100 * 1024 * 1024, // 100MB
      // },
    },
    
    virusScan: {
      enabled: true,
      provider: 'mock',
      blockOnFailure: true,
    },
    
    userQuotas: {
      enabled: true,
      maxFilesTotal: 1000,
      maxStorageBytes: 5 * 1024 * 1024 * 1024, // 5GB
    },
    
    fingerprinting: {
      algorithm: 'sha256',
      enabled: true,
    },
    
    duplicateDetection: {
      enabled: true,
      blockDuplicates: false, // Return existing file reference instead of rejecting
    },
    
    observability: {
      enabled: true,
      logLevel: 'info',
    },
  };
}

/**
 * Upload configuration for vendor digital assets (downloadable goods).
 *
 * Differs from the product-media config in two deliberate ways:
 *  1. NO image transforms — a digital asset is the product the vendor sells, so
 *     it must be stored byte-for-byte (never resized/recompressed/converted).
 *  2. A broader, larger allowlist (pdf/zip/audio/video/images) with per-type
 *     size limits up to 500MB.
 *
 * Security note: every file still passes magic-byte sniffing, virus scanning and
 * fingerprinting. Because the pipeline rejects any file whose sniffed type is
 * undetectable or differs from the claimed type, formats that do not sniff to a
 * stable MIME (e.g. legacy Office binaries, raw `application/octet-stream`) are
 * intentionally NOT accepted here — that ambiguity is the executable-spoofing
 * vector this routing exists to close.
 */
export function getDigitalAssetUploadConfig(): UploadPolicyConfig {
  const noTransform = (maxSizeBytes: number): MimeTypePolicy => ({
    allowed: true,
    maxSizeBytes,
  });

  const MB = 1024 * 1024;

  // Single knob for the per-request size cap. The vendor digital-asset
  // controller derives its pre-upload size check from this same value, so the
  // controller gate and the pipeline's TotalSizeValidator can never disagree.
  const parsedMax = parseInt(process.env.MAX_DIGITAL_ASSET_SIZE || '', 10);
  const maxTotalSizeBytes = Number.isFinite(parsedMax) && parsedMax > 0 ? parsedMax : 500 * MB;

  return {
    maxFilesPerRequest: 1,
    maxTotalSizeBytes,

    perMimeType: {
      // Documents
      'application/pdf': noTransform(100 * MB),
      'application/epub+zip': noTransform(100 * MB),
      // Archives / bundles
      'application/zip': noTransform(500 * MB),
      'application/x-rar-compressed': noTransform(500 * MB),
      'application/vnd.rar': noTransform(500 * MB),
      'application/x-7z-compressed': noTransform(500 * MB),
      // Audio
      'audio/mpeg': noTransform(100 * MB),
      'audio/wav': noTransform(200 * MB),
      // Video
      'video/mp4': noTransform(500 * MB),
      'video/quicktime': noTransform(500 * MB),
      // Images (stored untouched — no transforms)
      'image/jpeg': noTransform(50 * MB),
      'image/png': noTransform(50 * MB),
      'image/webp': noTransform(50 * MB),
      'image/gif': noTransform(50 * MB),
    },

    virusScan: {
      enabled: true,
      provider: 'mock',
      blockOnFailure: true,
    },

    // Digital assets are not subject to the shared per-vendor media quota.
    userQuotas: {
      enabled: false,
      maxFilesTotal: 0,
      maxStorageBytes: 0,
    },

    fingerprinting: {
      algorithm: 'sha256',
      enabled: true,
    },

    // Each digital asset owns its own File record (deleting one asset must not
    // affect another), so duplicate collapsing is disabled here.
    duplicateDetection: {
      enabled: false,
      blockDuplicates: false,
    },

    observability: {
      enabled: true,
      logLevel: 'info',
    },
  };
}

/**
 * Upload configuration for video uploads (served by the dedicated
 * `POST /api/files/upload/video` route).
 *
 * Kept separate from the default image/doc config so enabling video never
 * loosens the general `/api/files/upload` allowlist. Like the digital-asset
 * config, videos carry NO transforms — they are stored byte-for-byte. Every
 * file still passes magic-byte sniffing, virus scanning and fingerprinting, so
 * a spoofed file fails the allowlist on its real sniffed type.
 *
 * Per-file cap is 70MB. The per-request total accommodates the largest allowed
 * batch (3 videos), with the per-actor count enforced in the controller.
 */
export function getVideoUploadConfig(): UploadPolicyConfig {
  const noTransform = (maxSizeBytes: number): MimeTypePolicy => ({
    allowed: true,
    maxSizeBytes,
  });

  const MB = 1024 * 1024;
  const PER_VIDEO_MAX = 70 * MB;

  return {
    maxFilesPerRequest: 3,
    maxTotalSizeBytes: 3 * PER_VIDEO_MAX, // 210MB — largest allowed batch (3 × 70MB)

    perMimeType: {
      'video/mp4': noTransform(PER_VIDEO_MAX),
      'video/quicktime': noTransform(PER_VIDEO_MAX), // .mov
      'video/webm': noTransform(PER_VIDEO_MAX),
    },

    virusScan: {
      enabled: true,
      provider: 'mock',
      blockOnFailure: true,
    },

    // Videos count against the same per-user media quota as images/docs.
    userQuotas: {
      enabled: true,
      maxFilesTotal: 1000,
      maxStorageBytes: 5 * 1024 * 1024 * 1024, // 5GB
    },

    fingerprinting: {
      algorithm: 'sha256',
      enabled: true,
    },

    duplicateDetection: {
      enabled: true,
      blockDuplicates: false, // Return existing file reference instead of rejecting
    },

    observability: {
      enabled: true,
      logLevel: 'info',
    },
  };
}

/**
 * Load upload configuration from environment variables
 * Falls back to defaults for missing values
 */
export function loadUploadConfig(): UploadPolicyConfig {
  const defaults = getDefaultUploadConfig();

  console.log("duplicateDectection.enabled", process.env.UPLOAD_DUPLICATE_DETECTION_ENABLED !== 'false',  process.env.UPLOAD_DUPLICATE_DETECTION_ENABLED);
  console.log("duplicateDectection.block", process.env.UPLOAD_DUPLICATE_BLOCK === 'true',  process.env.UPLOAD_DUPLICATE_BLOCK);
  
  return {
    maxFilesPerRequest: parseInt(process.env.UPLOAD_MAX_FILES_PER_REQUEST || String(defaults.maxFilesPerRequest)),
    maxTotalSizeBytes: parseInt(process.env.UPLOAD_MAX_TOTAL_SIZE_BYTES || String(defaults.maxTotalSizeBytes)),
    perMimeType: defaults.perMimeType, // TODO: Make configurable via env if needed
    virusScan: {
      enabled: process.env.UPLOAD_VIRUS_SCAN_ENABLED !== 'false',
      provider: (process.env.UPLOAD_VIRUS_SCAN_PROVIDER as any) || defaults.virusScan.provider,
      blockOnFailure: process.env.UPLOAD_VIRUS_SCAN_BLOCK_ON_FAILURE !== 'false',
    },
    userQuotas: {
      enabled: process.env.UPLOAD_USER_QUOTAS_ENABLED !== 'false',
      maxFilesTotal: parseInt(process.env.UPLOAD_USER_QUOTA_MAX_FILES || String(defaults.userQuotas.maxFilesTotal)),
      maxStorageBytes: parseInt(process.env.UPLOAD_USER_QUOTA_MAX_BYTES || String(defaults.userQuotas.maxStorageBytes)),
    },
    fingerprinting: {
      algorithm: (process.env.UPLOAD_FINGERPRINT_ALGORITHM as any) || defaults.fingerprinting.algorithm,
      enabled: process.env.UPLOAD_FINGERPRINTING_ENABLED !== 'false',
    },
    duplicateDetection: {
      enabled: process.env.UPLOAD_DUPLICATE_DETECTION_ENABLED !== 'false',
      blockDuplicates: process.env.UPLOAD_DUPLICATE_BLOCK === 'true',
    },
    observability: {
      enabled: process.env.UPLOAD_OBSERVABILITY_ENABLED !== 'false',
      logLevel: (process.env.UPLOAD_LOG_LEVEL as any) || defaults.observability.logLevel,
    },
  };
}
