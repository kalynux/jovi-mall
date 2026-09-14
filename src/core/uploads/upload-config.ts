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
 * The virus-scan settings, resolved from the environment — for **every** upload config.
 *
 * ── Why this exists, and why no factory may write its own (plan step 4.A.4c / 25.1) ──────
 * `resolveVirusScanner(config)` reads `config.virusScan.provider`. Until this function
 * existed, **only `loadUploadConfig()` read `UPLOAD_VIRUS_SCAN_PROVIDER`** — the other four
 * factories hardcoded the literal `provider: 'mock'`. So three of the four sites step 8 wired
 * up were handed a config that named a TEST DOUBLE:
 *
 *   - in development they resolved `MockScanner` and scanned nothing, which left the
 *     **digital-products** path — the tree correction 4 exists for — exactly as unscanned as
 *     before the step that was supposed to fix it;
 *   - in production `resolveVirusScanner` refuses `mock`, so **every video, digital asset and
 *     delivery proof would have failed to upload**.
 *
 * ⚠ And `assertUploadScannerSafe()` could not see any of it, because it checks
 * `loadUploadConfig()` — the one config that was already right. The boot passed and the
 * failure waited for the first upload, which is the precise failure mode that boot assertion
 * was written to prevent, one level up.
 *
 * One resolver, spread by all five, makes the boot assertion cover every path **by
 * construction** rather than by coincidence. `test:uploads` asserts the structural rule that
 * keeps it true: **no config factory may contain a `provider:` literal.**
 */
export function resolveVirusScanConfig(): VirusScanConfig {
  return {
    // Default ON in both directions: scanning is opt-OUT, and a missing variable scans.
    enabled: process.env.UPLOAD_VIRUS_SCAN_ENABLED !== 'false',
    // `clamav` is the only value valid in production; `mock` (the historical default) and
    // `cloud` are refused at boot by `assertUploadScannerSafe`. Left as a plain read so an
    // unrecognised value reaches the factory's `default:` branch and is refused there rather
    // than being silently coerced here.
    provider: (process.env.UPLOAD_VIRUS_SCAN_PROVIDER as VirusScanConfig['provider']) || 'mock',
    // A scanner that fails OPEN is the configuration that produced S-2. Opt-out, never default.
    blockOnFailure: process.env.UPLOAD_VIRUS_SCAN_BLOCK_ON_FAILURE !== 'false',
  };
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
    
    // From the environment, never a literal — see `resolveVirusScanConfig`. A hardcoded
    // `provider: 'mock'` here is what made three of step 8's four scanner sites take a test
    // double in development and refuse every upload in production.
    virusScan: resolveVirusScanConfig(),
    
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
  //
  // ⚠ The 150 MB fallback is the CONTAINER's ceiling, not a storage limit. multer buffers the
  // whole file in memory (`api/middlewares/upload.middleware.ts`), Node Buffers live outside the
  // V8 heap, and the prod container is `mem_limit: 768m` — so the previous 500 MB default
  // OOM-killed it on a large asset regardless of provider. That middleware carries the same
  // fallback and the two must not drift. Raise both only with the container limit.
  const parsedMax = parseInt(process.env.MAX_DIGITAL_ASSET_SIZE || '', 10);
  const maxTotalSizeBytes = Number.isFinite(parsedMax) && parsedMax > 0 ? parsedMax : 150 * MB;

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

    // From the environment, never a literal — see `resolveVirusScanConfig`. A hardcoded
    // `provider: 'mock'` here is what made three of step 8's four scanner sites take a test
    // double in development and refuse every upload in production.
    virusScan: resolveVirusScanConfig(),

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

    // From the environment, never a literal — see `resolveVirusScanConfig`. A hardcoded
    // `provider: 'mock'` here is what made three of step 8's four scanner sites take a test
    // double in development and refuse every upload in production.
    virusScan: resolveVirusScanConfig(),

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
 * Upload configuration for an identity-verification document (served by the three
 * `POST /api/{vendor,agency,agent}/kyc/documents/:slot` routes).
 *
 * ── PDF sits beside the image types, and that is the point ───────────────────
 * Every other purpose-config on this platform is either images-only (delivery proof) or
 * PDF-only (policy documents). This one is both, because the thing being collected is "a
 * scan", and a scan arrives from a phone camera as a JPEG and from a scanner app or a
 * printer as a PDF. Refusing either half would push applicants into converting files, which
 * is the step at which a legible document becomes an illegible one.
 *
 * ⚠ **PDF carries NO transforms and that is deliberate, not an oversight.** `transforms` is
 * absent from the PDF policy so the bytes are stored as received. The image types keep
 * resize + compress, capped at 3000px rather than the delivery proof's 2048 — an identity
 * card's number and an address sketch's street names are small features, and a reviewer who
 * cannot read the digits has been handed a file that satisfies the checklist and proves
 * nothing. ⚠ **`convertTo: 'webp'` is deliberately NOT set on PNG either**, unlike the proof
 * config: this is evidence somebody may have to produce later, and re-encoding evidence
 * through a lossy format to save a few kilobytes is a bad trade at this size.
 *
 * `userQuotas.enabled` is true — the documents count against the APPLICANT's own plan media
 * cap (vendor, agency or agent; the route injects that owner's limit and usage). Duplicate
 * collapsing is OFF for the reason the two configs above give: two applicants must never
 * share one File record, or deleting one person's identity document deletes another's.
 *
 * ⚠ The virus scan matters more here than anywhere else on the platform. These files are
 * opened, by a human, inside the administration dashboard — the one audience whose browser
 * session is the most valuable on the system.
 */
export function getKycDocumentUploadConfig(): UploadPolicyConfig {
  const MB = 1024 * 1024;

  const image = (): MimeTypePolicy => ({
    allowed: true,
    maxSizeBytes: 10 * MB,
    transforms: { resize: { maxWidth: 3000, maxHeight: 3000 }, compress: true },
  });

  return {
    /**
     * Ten, matching `KYC_MULTI_SLOT_MAX_FILES` — a sketch slot's whole allowance can arrive
     * in one request. The single-value slots are held to one file by the service, not here:
     * this config is shared by all six slots, so the narrower limit belongs where the slot's
     * cardinality is known.
     */
    maxFilesPerRequest: 10,
    maxTotalSizeBytes: 100 * MB,

    perMimeType: {
      'image/jpeg': image(),
      'image/png': image(),
      'image/webp': image(),
      'application/pdf': {
        allowed: true,
        maxSizeBytes: 10 * MB,
      },
    },

    virusScan: resolveVirusScanConfig(),

    userQuotas: {
      enabled: true,
      maxFilesTotal: 1000,
      maxStorageBytes: 5 * 1024 * 1024 * 1024, // fallback only; real cap injected per-owner
    },

    fingerprinting: {
      algorithm: 'sha256',
      enabled: true,
    },

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
 * Upload configuration for a STAFF identity document — an administrator's own evidence,
 * served by `POST /api/internal/admin/identity-documents` and stored in the private
 * `admin-identity/` tree.
 *
 * ── Why this is not `getKycDocumentUploadConfig()` ───────────────────────────
 * The two collect the same KIND of thing and differ in exactly one respect that matters, so
 * sharing the function would have meant threading a boolean through it: **there is no
 * storage quota to charge.** An administrator holds no plan, no entitlement and no
 * `media_storage` usage row — the three things `userQuotas` is computed from — because an
 * administrator is not a platform account. Passing a fabricated limit through the KYC config
 * would put a number nobody chose in front of a staff member's employment record, and the
 * first time somebody hit it the failure would read as a broken upload rather than a policy.
 * So quotas are OFF and the ceilings below are the whole policy.
 *
 * Everything else is deliberately identical to the KYC config, for the reasons its own header
 * gives: PDF sits beside the image types because "a scan" arrives from a phone as a JPEG and
 * from a scanner app as a PDF; PDF carries no transforms; PNG is not converted to WebP,
 * because this is evidence somebody may have to produce later and re-encoding it through a
 * lossy format to save a few kilobytes is a bad trade at this size. Change one of those and
 * change it in both, or write down why not.
 *
 * ⚠ The virus scan matters here for the reason it matters most on the KYC path, and slightly
 * more: these files are opened, by a human, inside the administration dashboard — and on this
 * path the person opening them and the person who uploaded them are BOTH staff.
 */
export function getAdminIdentityDocumentUploadConfig(): UploadPolicyConfig {
  const MB = 1024 * 1024;

  const image = (): MimeTypePolicy => ({
    allowed: true,
    maxSizeBytes: 10 * MB,
    transforms: { resize: { maxWidth: 3000, maxHeight: 3000 }, compress: true },
  });

  return {
    /**
     * ONE, deliberately — the one number here that differs from the KYC config.
     *
     * wi-admin owns the slot and CANNOT count the parts in a multipart body: it pipes the body
     * across unread and holds no multer, by ADR-021 D-2. So its pre-flight "does this slot have
     * room" check has to assume a count, and capping at one is what makes that assumption exact
     * rather than a guess that is wrong precisely when the slot is nearly full — three sketches
     * posted into a slot holding eight would pass a check written for one.
     *
     * A multi-value slot is therefore filled one file at a time, which is what a picker does
     * anyway. See the ⚠ on `modules/staff-identity/routes/admin-staff-identity.routes.ts`.
     */
    maxFilesPerRequest: 1,
    maxTotalSizeBytes: 10 * MB,

    perMimeType: {
      'image/jpeg': image(),
      'image/png': image(),
      'image/webp': image(),
      'application/pdf': {
        allowed: true,
        maxSizeBytes: 10 * MB,
      },
    },

    virusScan: resolveVirusScanConfig(),

    /**
     * OFF — the only config on this platform where it is, and see the header for why: there
     * is no owner to charge, because `ownerType: 'admin'` names a row in a database this
     * service cannot read.
     */
    userQuotas: {
      enabled: false,
      maxFilesTotal: 0,
      maxStorageBytes: 0,
    },

    fingerprinting: {
      algorithm: 'sha256',
      enabled: true,
    },

    /**
     * OFF, for the reason the KYC config gives and which applies with more force here: two
     * people must never share one File record, or removing one staff member's identity
     * document removes another's.
     */
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
 * Upload configuration for an agent's delivery-proof image (served by the
 * dedicated `POST /api/agent/shipments/:id/delivery-proof` route).
 *
 * Deliberately narrow: exactly ONE image per request (jpeg/png/webp), so an
 * agent can attach a single photo as proof of a delivery. Image transforms stay
 * on (a proof photo may be resized/compressed to save the agency's storage).
 * `userQuotas.enabled` is true so the proof counts against the AGENCY's media
 * cap — the api layer stamps the file `ownerType: 'agency'` and injects that
 * owner's limit + usage. Duplicate collapsing is OFF: each shipment's proof is
 * its own File and must never be merged with another shipment's identical photo.
 */
export function getDeliveryProofUploadConfig(): UploadPolicyConfig {
  const MB = 1024 * 1024;

  return {
    maxFilesPerRequest: 1,
    maxTotalSizeBytes: 10 * MB,

    perMimeType: {
      'image/jpeg': {
        allowed: true,
        maxSizeBytes: 10 * MB,
        transforms: { resize: { maxWidth: 2048, maxHeight: 2048 }, compress: true },
      },
      'image/png': {
        allowed: true,
        maxSizeBytes: 10 * MB,
        transforms: { resize: { maxWidth: 2048, maxHeight: 2048 }, convertTo: 'webp', compress: true },
      },
      'image/webp': {
        allowed: true,
        maxSizeBytes: 10 * MB,
        transforms: { resize: { maxWidth: 2048, maxHeight: 2048 }, compress: true },
      },
    },

    // From the environment, never a literal — see `resolveVirusScanConfig`. A hardcoded
    // `provider: 'mock'` here is what made three of step 8's four scanner sites take a test
    // double in development and refuse every upload in production.
    virusScan: resolveVirusScanConfig(),

    // Counts against the agency's plan-driven media cap (limit + usage injected
    // by the api layer for the agency owner).
    userQuotas: {
      enabled: true,
      maxFilesTotal: 1000,
      maxStorageBytes: 5 * 1024 * 1024 * 1024, // fallback only; real cap injected per-agency
    },

    fingerprinting: {
      algorithm: 'sha256',
      enabled: true,
    },

    // Each shipment's proof is its own File — never collapse two shipments'
    // identical photos into one shared record.
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
 * Policy documents — the vendor's and the agency's `policies.documents` addenda.
 *
 * ── Why this config exists at all (plan step 4.A.4c / 25.2) ───────────────────
 * Both endpoints used to call `storageProvider.put(...)` **directly**, bypassing
 * `UploadIntakeService` entirely: no virus scan, no magic-byte sniffing, no fingerprint, no
 * quota. The only gate was `file.mimetype !== 'application/pdf'` — the **client-claimed**
 * type, a string the uploader chose, which a `.pdf`-named executable satisfies for free.
 *
 * They were invisible to step 8's source scan because they construct no scanner: they reach no
 * pipeline to need one. The bytes then come back as a public URL the owner submits into
 * `policies.documents`, where counterparties read them — so these were the last two surfaces
 * of S-2, and the finding is not closed without them.
 *
 * ── Shared by BOTH roles, deliberately ────────────────────────────────────────
 * The vendor's and the agency's endpoints had byte-identical limits written out twice. One
 * config means a limit changed for one role cannot silently stay old for the other.
 */
export function getPolicyDocumentUploadConfig(): UploadPolicyConfig {
  const MB = 1024 * 1024;

  return {
    // The same 2 × 5 MB the two multer instances already enforce. Multer's ceiling protects
    // process memory and answers with its own error shape; this one is the policy, and it is
    // what produces a documented `UPLOAD_POLICY_VIOLATION`.
    maxFilesPerRequest: 2,
    maxTotalSizeBytes: 10 * MB,

    // PDF only, and now checked against the SNIFFED type rather than the claimed one —
    // `FileSniffingProcessor` runs before this in the pipeline.
    perMimeType: {
      'application/pdf': {
        allowed: true,
        maxSizeBytes: 5 * MB,
      },
    },

    virusScan: resolveVirusScanConfig(),

    // Counts against the owner's plan-driven media cap, like every other upload they make.
    // Two 5 MB PDFs are not the reason anyone hits a cap, but a document path with no quota
    // is a document path somebody can fill a disk through.
    userQuotas: {
      enabled: true,
      maxFilesTotal: 1000,
      maxStorageBytes: 5 * 1024 * 1024 * 1024, // fallback only; real cap injected per-owner
    },

    fingerprinting: {
      algorithm: 'sha256',
      enabled: true,
    },

    // Two owners uploading the same boilerplate policy PDF must get their own File records:
    // one is not entitled to the other's document, and a shared record would make deleting
    // one delete both. Same reasoning as the delivery proof above.
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
    // The same resolver every other factory uses. This block used to be the ONLY one that
    // read the environment at all, which is exactly what made the other four dangerous.
    virusScan: resolveVirusScanConfig(),
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
