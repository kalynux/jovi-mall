import { Router } from 'express';
import { requireAuth, requireRole } from '../middlewares/auth.middleware';
import { FileUploadController, uploadMultiple } from '../controllers/file-upload.controller';
import { FileManagementController } from '../controllers/file-management.controller';

const router = Router();

/**
 * File Routes
 * 
 * Provides file upload and management endpoints for authenticated users.
 * - Upload: Role-based file size limits (100MB-2GB)
 * - Management: List, retrieve, update, delete files
 * - Admin: Hard delete, orphan listing
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

// === CRUD MANAGEMENT ===

/**
 * GET /api/files/orphans
 * List orphaned files (no live references, older than specified date)
 * Admin only
 * MUST be before /:id route to avoid routing conflict
 */
router.get('/orphans', requireRole(['admin']), FileManagementController.listOrphans);

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

/**
 * DELETE /api/files/:id/permanent
 * Permanently delete file (admin only)
 * Best-effort storage delete - logs failure but doesn't rollback DB delete
 */
router.delete('/:id/permanent', requireRole(['admin']), FileManagementController.hardDeleteFile);

export default router;
