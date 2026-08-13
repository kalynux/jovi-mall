import { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { UploadIntakeService } from '../../core/uploads/upload-intake.service';
import { loadUploadConfig, getVideoUploadConfig } from '../../core/uploads/upload-config';
import { getAcceptableClaimedMimeTypes, isAcceptableClaimedMimeType } from '../../core/uploads/mime-aliases';
import { getStorageProvider } from '../../core/storage';
import { FileRepositoryMongo } from '../../modules/catalog/repositories/mongo/file.repository.mongo';
import { IUploadObserver, IVirusScanner } from '../../core/uploads/upload-policy.types';
import { FileOwnerType } from '../../modules/catalog/models/file.model';
import { entitlementService } from '../../modules/billing/services/entitlement.service';
import { mediaStorageService } from '../../modules/catalog/domain/services/media/MediaStorageService';
import { createAppError } from '../../core/errors';
import { ERROR_CODES } from '../../core/error-codes';

/**
 * A pre-pipeline upload refusal, in the shape the pipeline's own refusals already use.
 *
 * ── Why these are not their own codes ─────────────────────────────────────────
 * These four gates (no files, too many files, too large, wrong claimed type) used to
 * answer with hand-built bodies carrying `'NO_FILES_UPLOADED'`, `'TOO_MANY_FILES'`,
 * `'FILE_TOO_LARGE'` and `'FILE_TYPE_INVALID'` — strings in no registry, in an envelope
 * with no `requestId`. They were a second upload vocabulary sitting beside the documented
 * one, differing from it by a word (`FILE_TYPE_INVALID` where the pipeline says
 * `MIME_NOT_ALLOWED`), and a client had to know both.
 *
 * They are the same class of failure as the pipeline's, checked earlier and more cheaply,
 * so they now raise the same `UPLOAD_POLICY_VIOLATION` with the same `details.violations[]`
 * shape documented in `api-doc/errors/README.md` §7. One vocabulary, one envelope, and the
 * per-file codes are the ones already published.
 */
function uploadViolation(
    statusCode: number,
    violation: { code: string; message: string; fileIndex?: number; metadata?: Record<string, unknown> },
) {
    return createAppError(
        ERROR_CODES.UPLOAD_POLICY_VIOLATION,
        statusCode,
        'Upload policy violations found',
        { violations: [violation] },
    );
}

// Role-based file size limits (in bytes). Coarse per-request ceiling only — the
// per-MIME-type caps in the upload config (and the plan storage quota) are
// stricter and are what actually bind for images/documents.
const ROLE_UPLOAD_LIMITS = {
    vendor: 500 * 1024 * 1024,      // 500 MB
    agency: 200 * 1024 * 1024,      // 200 MB
    agent: 1024 * 1024 * 1024,      // 1 GB
    admin: 2 * 1024 * 1024 * 1024,  // 2 GB
    customer: 100 * 1024 * 1024,    // 100 MB
};

// Per-video size cap (70 MB) and the per-actor count limits for the video route.
const VIDEO_MAX_FILE_SIZE = 70 * 1024 * 1024;
const VIDEO_MAX_FILES_OTHER = 3;   // admin, vendor, agent, agency
const VIDEO_MAX_FILES_CUSTOMER = 1;

// Claimed-MIME pre-pipeline gate derived from the authoritative video allowlist.
// Keeps the cheap up-front check in sync with the pipeline (see mime-aliases.ts).
const ACCEPTABLE_VIDEO_CLAIMED_TYPES = getAcceptableClaimedMimeTypes(
    Object.keys(getVideoUploadConfig().perMimeType),
);

/** Owner types whose uploads are metered against a plan-driven storage cap. */
type MeteredOwnerType = 'vendor' | 'agency' | 'agent';

/**
 * Resolve the owner's plan-driven storage limit and current media usage so the
 * upload pipeline can enforce it. Returns an empty object for owner types that
 * are not plan-metered (their uploads fall back to the static config quota).
 * Kept here (api layer) so `core/uploads` stays decoupled from the billing module.
 */
async function resolveStorageContext(
    ownerType: string,
    ownerId?: string,
): Promise<{ storageLimitBytes?: number; currentUsageBytes?: number }> {
    if (!ownerId || (ownerType !== 'vendor' && ownerType !== 'agency' && ownerType !== 'agent')) {
        return {};
    }
    const metered = ownerType as MeteredOwnerType;
    const [storageLimitBytes, currentUsageBytes] = await Promise.all([
        entitlementService.resolveMaxStorageBytes(metered, ownerId),
        mediaStorageService.getUsedBytes(metered, ownerId),
    ]);
    return { storageLimitBytes, currentUsageBytes };
}

// No-op implementations for observer and scanner
class NoOpUploadObserver implements IUploadObserver { }

class NoOpVirusScanner implements IVirusScanner {
    async scan(buffer: Buffer, filename?: string): Promise<{ clean: boolean; reason?: string; virus?: string }> {
        return { clean: true };
    }
}

// Memory storage for multer
const storage = multer.memoryStorage();

// Multer instance for multi-file uploads (max 10 files)
export const uploadMultiple = multer({
    storage,
    limits: {
        files: 10, // Maximum 10 files per request
        fileSize: 2 * 1024 * 1024 * 1024, // 2 GB max (actual limit checked per-role)
    },
    fileFilter: (req, file, cb) => {
        // Accept all files - validation happens in controller
        cb(null, true);
    },
}).array('files', 10); // Field name: 'files', max 10 files

// Multer instance for video uploads (max 3 files, 70 MB each).
// The per-file ceiling here protects memory; per-actor count is enforced in the
// controller. Field name: 'videos'.
export const uploadVideos = multer({
    storage,
    limits: {
        files: VIDEO_MAX_FILES_OTHER,
        fileSize: VIDEO_MAX_FILE_SIZE,
    },
    fileFilter: (req, file, cb) => {
        // Accept all files - validation happens in the pipeline
        cb(null, true);
    },
}).array('videos', VIDEO_MAX_FILES_OTHER);

/**
 * FileUploadController
 * 
 * Global file upload endpoint with role-based limits.
 * Handles 1-10 files per request.
 */
export class FileUploadController {
    /**
     * POST /api/files/upload
     * Upload 1-10 files with role-based size limits
     */
    static async uploadFiles(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const userRole = req.auth!.role;
            const userId = req.auth!.user._id.toString();
            const vendorId = userRole === 'vendor' ? req.auth!.role_entity._id.toString() : undefined;

            // Validate files were uploaded
            if (!req.files || !Array.isArray(req.files) || req.files.length === 0) {
                next(uploadViolation(400, {
                    code: 'NO_FILES_UPLOADED',
                    message: 'At least one file is required',
                }));
                return;
            }

            // Validate file count
            if (req.files.length > 10) {
                next(uploadViolation(400, {
                    code: 'TOO_MANY_FILES',
                    message: 'Maximum 10 files per request',
                }));
                return;
            }

            // Get role-based size limit
            const maxFileSize = ROLE_UPLOAD_LIMITS[userRole as keyof typeof ROLE_UPLOAD_LIMITS] || ROLE_UPLOAD_LIMITS.customer;

            // Validate each file size against role limit
            for (const file of req.files) {
                if (file.size > maxFileSize) {
                    next(uploadViolation(413, {
                        code: 'FILE_TOO_LARGE',
                        message: `File "${file.originalname}" exceeds ${userRole} limit of ${maxFileSize / (1024 * 1024)} MB`,
                    }));
                    return;
                }
            }

            // Initialize services
            const config = loadUploadConfig();
            const storageProvider = getStorageProvider();
            const fileRepository = new FileRepositoryMongo();
            const observer = new NoOpUploadObserver();
            const virusScanner = new NoOpVirusScanner();

            const uploadIntakeService = new UploadIntakeService(
                config,
                storageProvider,
                fileRepository,
                observer,
                virusScanner
            );

            // Resolve plan-driven storage limit + current usage for the uploading
            // owner (vendor/agency/agent).
            const storageCtx = await resolveStorageContext(userRole, req.auth!.role_entity?._id?.toString());

            // Execute upload. This is general media intake for EVERY role: the
            // caller has not said what these files are for (avatar, branding,
            // product image, ticket attachment — decided later, when the
            // returned id is attached), so each file is stored under the folder
            // for its own media type. Labelling them all 'products' claimed a
            // purpose they don't have and tripped that folder's vendor-only
            // permission rule for every other role.
            const uploadedFiles = await uploadIntakeService.execute({
                folder: 'by-type',
                context: {
                    userId,
                    vendorId,
                    role: userRole === 'admin' ? 'admin' : userRole === 'vendor' ? 'vendor' : 'user',
                    // Stamp the real per-role uploader so the file is owned by (and
                    // only attachable by) this actor — see FileReferenceService.
                    ownerType: userRole as FileOwnerType,
                    ownerId: req.auth!.role_entity?._id?.toString(),
                    ...storageCtx,
                },
                files: req.files.map(file => ({
                    buffer: file.buffer,
                    originalName: file.originalname,
                    size: file.size,
                    mimeType: file.mimetype,
                })),
            });

            res.status(201).json({
                success: true,
                data: uploadedFiles,
                message: `Successfully uploaded ${uploadedFiles.length} file(s)`,
                meta: {
                    count: uploadedFiles.length,
                    roleLimit: `${maxFileSize / (1024 * 1024)} MB`,
                },
            });
        } catch (error) {
            // Forward to the global error handler, which normalises AppError
            // (including its `details`, e.g. the per-file policy violations) into
            // the standard response envelope. See error-handler.middleware.ts.
            next(error);
        }
    }

    /**
     * POST /api/files/upload/video
     * Upload 1-3 video files (mp4, mov, webm), 70 MB each.
     *
     * Per-actor count limits: customers max 1, all other actors max 3.
     * Dedicated to video so the general /upload allowlist stays unchanged.
     */
    static async uploadVideos(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const userRole = req.auth!.role;
            const userId = req.auth!.user._id.toString();
            const vendorId = userRole === 'vendor' ? req.auth!.role_entity._id.toString() : undefined;

            // Validate files were uploaded
            if (!req.files || !Array.isArray(req.files) || req.files.length === 0) {
                next(uploadViolation(400, {
                    code: 'NO_FILES_UPLOADED',
                    message: 'At least one video file is required (field name "videos")',
                }));
                return;
            }

            // Per-actor count limit: customers may upload 1 video, others up to 3
            const maxFiles = userRole === 'customer' ? VIDEO_MAX_FILES_CUSTOMER : VIDEO_MAX_FILES_OTHER;
            if (req.files.length > maxFiles) {
                next(uploadViolation(400, {
                    code: 'TOO_MANY_FILES',
                    message: `Maximum ${maxFiles} video(s) per request for ${userRole}`,
                }));
                return;
            }

            for (const file of req.files) {
                // Defensive per-file size gate (multer also caps at 70 MB)
                if (file.size > VIDEO_MAX_FILE_SIZE) {
                    next(uploadViolation(413, {
                        code: 'FILE_TOO_LARGE',
                        message: `Video "${file.originalname}" exceeds the ${VIDEO_MAX_FILE_SIZE / (1024 * 1024)} MB limit`,
                    }));
                    return;
                }

                // Claimed-MIME pre-pipeline gate (real type is re-verified by sniffing)
                if (!isAcceptableClaimedMimeType(file.mimetype, ACCEPTABLE_VIDEO_CLAIMED_TYPES)) {
                    // MIME_NOT_ALLOWED, not FILE_TYPE_INVALID: this is the same refusal the
                    // sniffing pipeline makes later, and api-doc publishes that spelling.
                    next(uploadViolation(400, {
                        code: 'MIME_NOT_ALLOWED',
                        message: `File "${file.originalname}" (${file.mimetype}) is not a supported video. Allowed: mp4, mov, webm`,
                        metadata: { claimedMimeType: file.mimetype, originalName: file.originalname },
                    }));
                    return;
                }
            }

            // Initialize services with the video-specific upload policy
            const config = getVideoUploadConfig();
            const storageProvider = getStorageProvider();
            const fileRepository = new FileRepositoryMongo();
            const observer = new NoOpUploadObserver();
            const virusScanner = new NoOpVirusScanner();

            const uploadIntakeService = new UploadIntakeService(
                config,
                storageProvider,
                fileRepository,
                observer,
                virusScanner
            );

            // Resolve plan-driven storage limit + current usage for the uploading
            // owner (vendor/agency/agent).
            const storageCtx = await resolveStorageContext(userRole, req.auth!.role_entity?._id?.toString());

            // Execute upload. Stated explicitly rather than via 'by-type' — this
            // route's allowlist is video-only, so the two agree, and the folder
            // holds even if a future config widens the allowlist.
            const uploadedFiles = await uploadIntakeService.execute({
                folder: 'videos',
                context: {
                    userId,
                    vendorId,
                    role: userRole === 'admin' ? 'admin' : userRole === 'vendor' ? 'vendor' : 'user',
                    // Stamp the real per-role uploader so the file is owned by (and
                    // only attachable by) this actor — see FileReferenceService.
                    ownerType: userRole as FileOwnerType,
                    ownerId: req.auth!.role_entity?._id?.toString(),
                    ...storageCtx,
                },
                files: req.files.map(file => ({
                    buffer: file.buffer,
                    originalName: file.originalname,
                    size: file.size,
                    mimeType: file.mimetype,
                })),
            });

            res.status(201).json({
                success: true,
                data: uploadedFiles,
                message: `Successfully uploaded ${uploadedFiles.length} video(s)`,
                meta: {
                    count: uploadedFiles.length,
                    perFileLimit: `${VIDEO_MAX_FILE_SIZE / (1024 * 1024)} MB`,
                },
            });
        } catch (error) {
            next(error);
        }
    }
}
