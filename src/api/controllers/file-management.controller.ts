import { Request, Response } from 'express';
import { ZodError } from 'zod';
import { FileRepositoryMongo } from '../../modules/catalog/repositories/mongo/file.repository.mongo';
import { getStorageProvider } from '../../core/storage';
import {
    ListFilesQuerySchema,
    UpdateFileSchema,
    OrphansQuerySchema,
} from '../validators/file-management.validator';

/**
 * File Management Controller
 * 
 * CRUD operations for uploaded files with ownership validation.
 * Users can only manage files they own, except admins who have global access.
 */
export class FileManagementController {
    /**
     * GET /api/files
     * List user's uploaded files with pagination and filtering
     */
    static async listFiles(req: Request, res: Response): Promise<void> {
        try {
            const userRole = req.auth!.role;
            const userId = req.auth!.user._id.toString();
            const userRoleEntity = req.auth!.role_entity;

            // Validate query params
            const query = ListFilesQuerySchema.parse(req.query);

            // Build owner filter
            const fileRepository = new FileRepositoryMongo();
            let ownerFilter: any = {};

            if (userRole !== 'admin') {
                // Non-admins can only see their own files
                if (userRole === 'vendor') {
                    ownerFilter = {
                        ownerType: 'vendor',
                        ownerId: userRoleEntity._id.toString(),
                    };
                } else if (userRole === 'customer') {
                    ownerFilter = {
                        ownerType: 'customer',
                        ownerId: userId,
                    };
                } else if (userRole === 'agent') {
                    ownerFilter = {
                        ownerType: 'agent',
                        ownerId: userRoleEntity._id.toString(),
                    };
                }
            }
            // Admins: no owner filter (see all files)

            // Build additional filters
            const filters: any = { ...ownerFilter };
            if (query.mimeType) {
                filters.mimeType = query.mimeType;
            }
            if (query.provider) {
                filters.provider = query.provider;
            }

            // Pagination
            const skip = (query.page - 1) * query.limit;

            // Fetch files (using repository's findMany with filters)
            // Note: The repository doesn't have a findMany method, so we'll use MongoDB directly
            const FileModel = await import('../../modules/catalog/models/file.model').then(m => m.FileModel);

            const [files, total] = await Promise.all([
                FileModel.find(filters)
                    .sort({ createdAt: -1 })
                    .skip(skip)
                    .limit(query.limit)
                    .lean()
                    .exec(),
                FileModel.countDocuments(filters),
            ]);

            // Map to domain
            const FileMapper = (await import('../../modules/catalog/repositories/mappers/file.mapper')).FileMapper;
            const mapper = new FileMapper();
            const domainFiles = files.map(f => mapper.toDomain(f as any));

            res.json({
                success: true,
                data: {
                    files: domainFiles,
                    pagination: {
                        page: query.page,
                        limit: query.limit,
                        total,
                        pages: Math.ceil(total / query.limit),
                    },
                },
            });
        } catch (error) {
            FileManagementController.handleError(error, res);
        }
    }

    /**
     * GET /api/files/:id
     * Get single file metadata by ID
     */
    static async getFile(req: Request, res: Response): Promise<void> {
        try {
            const { id } = req.params;
            const userRole = req.auth!.role;
            const userId = req.auth!.user._id.toString();
            const userRoleEntity = req.auth!.role_entity;

            const fileRepository = new FileRepositoryMongo();
            const file = await fileRepository.findById(id);

            if (!file) {
                res.status(404).json({
                    success: false,
                    error: {
                        code: 'NOT_FOUND',
                        message: 'File not found',
                    },
                });
                return;
            }

            // Ownership validation (non-admins)
            if (userRole !== 'admin') {
                const isOwner = FileManagementController.validateOwnership(
                    file,
                    userRole,
                    userId,
                    userRoleEntity?._id.toString()
                );

                if (!isOwner) {
                    res.status(403).json({
                        success: false,
                        error: {
                            code: 'FORBIDDEN',
                            message: 'You do not have access to this file',
                        },
                    });
                    return;
                }
            }

            res.json({
                success: true,
                data: file,
            });
        } catch (error) {
            FileManagementController.handleError(error, res);
        }
    }

    /**
     * PATCH /api/files/:id
     * Update file metadata (only originalName)
     */
    static async updateFile(req: Request, res: Response): Promise<void> {
        try {
            const { id } = req.params;
            const userRole = req.auth!.role;
            const userId = req.auth!.user._id.toString();
            const userRoleEntity = req.auth!.role_entity;

            // Validate body
            const input = UpdateFileSchema.parse(req.body);

            const fileRepository = new FileRepositoryMongo();
            const file = await fileRepository.findById(id);

            if (!file) {
                res.status(404).json({
                    success: false,
                    error: {
                        code: 'NOT_FOUND',
                        message: 'File not found',
                    },
                });
                return;
            }

            // Ownership validation (non-admins)
            if (userRole !== 'admin') {
                const isOwner = FileManagementController.validateOwnership(
                    file,
                    userRole,
                    userId,
                    userRoleEntity?._id.toString()
                );

                if (!isOwner) {
                    res.status(403).json({
                        success: false,
                        error: {
                            code: 'FORBIDDEN',
                            message: 'You do not have access to this file',
                        },
                    });
                    return;
                }
            }

            // Update file
            const updatedFile = await fileRepository.update(id, {
                originalName: input.originalName,
            });

            res.json({
                success: true,
                data: updatedFile,
                message: 'File updated successfully',
            });
        } catch (error) {
            FileManagementController.handleError(error, res);
        }
    }

    /**
     * DELETE /api/files/:id
     * Soft delete file (mark for garbage collection)
     */
    static async deleteFile(req: Request, res: Response): Promise<void> {
        try {
            const { id } = req.params;
            const userRole = req.auth!.role;
            const userId = req.auth!.user._id.toString();
            const userRoleEntity = req.auth!.role_entity;

            const fileRepository = new FileRepositoryMongo();
            const file = await fileRepository.findById(id);

            if (!file) {
                res.status(404).json({
                    success: false,
                    error: {
                        code: 'NOT_FOUND',
                        message: 'File not found',
                    },
                });
                return;
            }

            // Ownership validation (non-admins)
            if (userRole !== 'admin') {
                const isOwner = FileManagementController.validateOwnership(
                    file,
                    userRole,
                    userId,
                    userRoleEntity?._id.toString()
                );

                if (!isOwner) {
                    res.status(403).json({
                        success: false,
                        error: {
                            code: 'FORBIDDEN',
                            message: 'You do not have access to this file',
                        },
                    });
                    return;
                }
            }

            // Check usage count
            if (file.usageCount > 0) {
                res.status(409).json({
                    success: false,
                    error: {
                        code: 'FILE_IN_USE',
                        message: `Cannot delete file that is still in use (usageCount: ${file.usageCount})`,
                    },
                });
                return;
            }

            // Soft delete
            await fileRepository.softDelete(id);

            res.json({
                success: true,
                message: 'File deleted successfully',
            });
        } catch (error) {
            FileManagementController.handleError(error, res);
        }
    }

    /**
     * DELETE /api/files/:id/permanent
     * Permanently delete file (admin only)
     * Storage delete is best-effort - logs failure but doesn't rollback
     */
    static async hardDeleteFile(req: Request, res: Response): Promise<void> {
        try {
            const { id } = req.params;
            const userRole = req.auth!.role;

            // Admin-only check
            if (userRole !== 'admin') {
                res.status(403).json({
                    success: false,
                    error: {
                        code: 'FORBIDDEN',
                        message: 'Admin access required',
                    },
                });
                return;
            }

            const fileRepository = new FileRepositoryMongo();
            const file = await fileRepository.findById(id);

            if (!file) {
                res.status(404).json({
                    success: false,
                    error: {
                        code: 'NOT_FOUND',
                        message: 'File not found',
                    },
                });
                return;
            }

            // Hard delete from DB (source of truth)
            await fileRepository.hardDelete(id);

            // Best-effort storage delete
            try {
                const storageProvider = getStorageProvider();
                await storageProvider.delete(file.key);
            } catch (storageError) {
                // Log error but don't rollback DB delete
                console.error('[FileManagementController] Storage delete failed (file already deleted from DB):', {
                    fileId: id,
                    key: file.key,
                    error: storageError,
                });
                // Continue - DB is source of truth
            }

            res.json({
                success: true,
                message: 'File permanently deleted',
            });
        } catch (error) {
            FileManagementController.handleError(error, res);
        }
    }

    /**
     * GET /api/files/orphans
     * List orphaned files (admin only)
     * Minimum 24 hours old to prevent accidental deletion
     */
    static async listOrphans(req: Request, res: Response): Promise<void> {
        try {
            const userRole = req.auth!.role;

            // Admin-only check
            if (userRole !== 'admin') {
                res.status(403).json({
                    success: false,
                    error: {
                        code: 'FORBIDDEN',
                        message: 'Admin access required',
                    },
                });
                return;
            }

            // Validate query params (includes 24h guardrail)
            const query = OrphansQuerySchema.parse(req.query);

            // Default: 7 days ago
            const olderThan = query.olderThan || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

            const fileRepository = new FileRepositoryMongo();
            const orphans = await fileRepository.findOrphans(olderThan);

            res.json({
                success: true,
                data: orphans,
                meta: {
                    count: orphans.length,
                    olderThan: olderThan.toISOString(),
                },
            });
        } catch (error) {
            FileManagementController.handleError(error, res);
        }
    }

    /**
     * Helper: Validate file ownership
     */
    private static validateOwnership(
        file: any,
        userRole: string,
        userId: string,
        roleEntityId?: string
    ): boolean {
        if (userRole === 'vendor' && file.ownerType === 'vendor') {
            return file.ownerId === roleEntityId;
        }

        if (userRole === 'customer' && file.ownerType === 'customer') {
            return file.ownerId === userId;
        }

        if (userRole === 'agent' && file.ownerType === 'agent') {
            return file.ownerId === roleEntityId;
        }

        return false;
    }

    /**
     * Error handler
     */
    private static handleError(error: any, res: Response): void {
        if (error instanceof ZodError) {
            res.status(400).json({
                success: false,
                error: {
                    code: 'VALIDATION_ERROR',
                    message: 'Invalid input',
                    details: error.errors,
                },
            });
            return;
        }

        console.error('[FileManagementController] Error:', error);
        res.status(500).json({
            success: false,
            error: {
                code: 'INTERNAL_ERROR',
                message: 'An unexpected error occurred',
            },
        });
    }
}
