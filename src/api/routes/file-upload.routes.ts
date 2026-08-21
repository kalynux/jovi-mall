import { Router } from 'express';
import { requireAuth } from '../middlewares/auth.middleware';
import { FileUploadController, uploadMultiple, uploadVideos } from '../controllers/file-upload.controller';
import { FileManagementController } from '../controllers/file-management.controller';

const router = Router();

/**
 * File Routes
 * 
 * Provides file upload and management endpoints for authenticated users.
 * - Upload: Role-based file size limits (100MB-2GB)
 * - Management: List, retrieve, update, delete files
 *
 * ⚠ There is no administrative half here any more. `GET /orphans` and
 * `DELETE /:id/permanent` were the only two `requireRole(['admin'])` routes on this
 * router, and Phase 5 Part B moved them onto the internal admin mount
 * (`/api/internal/admin/files`, `modules/catalog/routes/admin-file.routes.ts`) behind
 * `requireAdminCaller` and wi-admin's `files.orphans.read` / `files.delete`. The
 * handlers did not move — only the door. Do not re-add an admin-only route here: this
 * surface is the one a vendor, agency, agent or customer session reaches, and an
 * `admin` role can no longer arrive on it at all.
 */

// Apply authentication to all routes
router.use(requireAuth);

// === UPLOAD ===

/**
 * POST /api/files/upload
 * Upload 1-10 files
 * 
 * Role-based size limits:
 * - Vendor: 500 MB per file
 * - Agent: 1 GB per file
 * - Admin: 2 GB per file
 * - Customer: 100 MB per file
 * 
 * Form data:
 * - files: File[] (max 10 files)
 * 
 * Responses:
 * - 201: Files uploaded successfully
 * - 400: No files, validation error
 * - 413: File exceeds role limit
 */
router.post('/upload', uploadMultiple, FileUploadController.uploadFiles);

/**
 * POST /api/files/upload/video
 * Upload video files on a dedicated route (mp4, mov, webm).
 *
 * Per-file size limit: 70 MB.
 * Per-actor count limit: customers max 1, all other actors max 3.
 *
 * Form data:
 * - videos: File[] (field name "videos")
 *
 * Responses:
 * - 201: Videos uploaded successfully
 * - 400: No files, too many files, unsupported type
 * - 413: A video exceeds the 70 MB limit
 */
router.post('/upload/video', uploadVideos, FileUploadController.uploadVideos);

// === CRUD MANAGEMENT ===

/**
 * GET /api/files/storage
 * Storage usage + plan limit summary for the authenticated owner.
 * MUST be before /:id to avoid routing conflict.
 */
router.get('/storage', FileManagementController.getStorageSummary);

/**
 * GET /api/files
 * List user's uploaded files with pagination, name search, characteristic
 * filtering (mimeType/category, provider, ownerType, size & date ranges) and
 * sorting. See ListFilesQuerySchema for the supported query parameters.
 */
router.get('/', FileManagementController.listFiles);

/**
 * GET /api/files/:id
 * Get single file metadata by ID
 */
router.get('/:id', FileManagementController.getFile);

/**
 * PATCH /api/files/:id
 * Update file metadata (originalName only)
 */
router.patch('/:id', FileManagementController.updateFile);

/**
 * DELETE /api/files/:id
 * Soft delete file (mark for garbage collection)
 * Only works if the file has no live references
 */
router.delete('/:id', FileManagementController.deleteFile);

export default router;
