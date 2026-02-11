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
 * Load upload configuration from environment variables
 * Falls back to defaults for missing values
 */
export function loadUploadConfig(): UploadPolicyConfig {
  const defaults = getDefaultUploadConfig();
  
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
