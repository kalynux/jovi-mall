import { Request, Response } from 'express';
import { asyncHandler } from '../middlewares/async-handler';
import { createAppError } from '../../core/errors';
import { ERROR_CODES } from '../../core/error-codes';
import { FileRepositoryMongo } from '../../modules/catalog/repositories/mongo/file.repository.mongo';
import { FileReferenceRepositoryMongo } from '../../modules/catalog/repositories/mongo/file-reference.repository.mongo';
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
 *
 * Errors follow the project convention: throw `createAppError(...)` and let the
 * global error handler normalise the response. ZodError from `.parse()` is also
 * normalised by the global handler, so validation is not caught here.
 */
export class FileManagementController {
    /**
     * GET /api/files
     * List user's uploaded files with pagination and filtering
     */
    static listFiles = asyncHandler(async (req: Request, res: Response) => {
        const userRole = req.auth!.role;
        const userId = req.auth!.user._id.toString();
        const userRoleEntity = req.auth!.role_entity;

        // Validate query params
        const query = ListFilesQuerySchema.parse(req.query);

        // Build owner filter
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

        // Build characteristic filters on top of the ownership scope.
        const filters: any = { ...ownerFilter };

        // Name search: case-insensitive substring match on originalName.
        if (query.search) {
            filters.originalName = {
                $regex: FileManagementController.escapeRegex(query.search),
                $options: 'i',
            };
        }

        // MIME filtering: explicit mimeType wins; otherwise a broad category maps
        // onto a set of MIME types / prefixes.
        if (query.mimeType) {
            filters.mimeType = query.mimeType;
        } else if (query.category) {
            filters.mimeType = FileManagementController.MEDIA_CATEGORY_MATCHERS[query.category];
        }

        if (query.provider) {
            filters.provider = query.provider;
        }

        // ownerType is only meaningful for admins (non-admins are already scoped
        // to a single owner type via ownerFilter), but applying it is harmless
        // and lets admins narrow by uploader kind.
        if (query.ownerType) {
            filters.ownerType = query.ownerType;
        }

        // Size range (bytes).
        if (query.minSize !== undefined || query.maxSize !== undefined) {
            filters.size = {};
            if (query.minSize !== undefined) filters.size.$gte = query.minSize;
            if (query.maxSize !== undefined) filters.size.$lte = query.maxSize;
        }

        // Upload date range.
        if (query.createdAfter || query.createdBefore) {
            filters.createdAt = {};
            if (query.createdAfter) filters.createdAt.$gte = query.createdAfter;
            if (query.createdBefore) filters.createdAt.$lte = query.createdBefore;
        }

        // Pagination
        const skip = (query.page - 1) * query.limit;

        // Sorting: validated against an allow-list in the schema.
        const sort: Record<string, 1 | -1> = {
            [query.sortBy]: query.sortOrder === 'asc' ? 1 : -1,
        };

        // Fetch files (using repository's findMany with filters)
        // Note: The repository doesn't have a findMany method, so we'll use MongoDB directly
        const FileModel = await import('../../modules/catalog/models/file.model').then(m => m.FileModel);

        const [files, total] = await Promise.all([
            FileModel.find(filters)
                .sort(sort)
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
    });

    /**
     * GET /api/files/:id
     * Get single file metadata by ID
     */
    static getFile = asyncHandler(async (req: Request, res: Response) => {
        const { id } = req.params;
        const userRole = req.auth!.role;
        const userId = req.auth!.user._id.toString();
        const userRoleEntity = req.auth!.role_entity;

        const fileRepository = new FileRepositoryMongo();
        const file = await fileRepository.findById(id);

        if (!file) {
            throw createAppError(ERROR_CODES.CATALOG_FILE_NOT_FOUND, 404, 'File not found');
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
                throw createAppError(ERROR_CODES.AUTH_FORBIDDEN, 403, 'You do not have access to this file');
            }
        }

        // Resolve where this file is referenced so callers can see what would
        // break before deleting it.
        const usage = await FileManagementController.resolveFileUsage(id);

        res.json({
            success: true,
            data: { ...file, usage },
        });
    });

    /**
     * Resolve where a file is referenced, using the `file_references` collection
     * as the source of truth. `totalReferences` counts every live reference (so a
     * brand-new entity type is counted automatically); the per-type arrays enrich
     * the known types with display fields for the UI.
     */
    private static async resolveFileUsage(fileId: string): Promise<{
        totalReferences: number;
        products: Array<{ id: string; title: string; type: string; status: string }>;
        variants: Array<{ id: string; productId: string; sku: string; status: string }>;
        digitalAssets: Array<{ id: string; originalName: string }>;
    }> {
        const fileReferenceRepository = new FileReferenceRepositoryMongo();
        const links = await fileReferenceRepository.findByFile(fileId);

        // Group the referenced entity ids by type so we can batch-enrich each.
        const productIds = links.filter(l => l.entityType === 'product').map(l => l.entityId);
        const variantIds = links.filter(l => l.entityType === 'variant').map(l => l.entityId);
        const digitalAssetIds = links.filter(l => l.entityType === 'digital_asset').map(l => l.entityId);

        const [{ ProductModel }, { ProductVariantModel }, { DigitalAssetModel }] = await Promise.all([
            import('../../modules/catalog/models/product.model'),
            import('../../modules/catalog/models/product-variant.model'),
            import('../../modules/digital-delivery/models/digital-asset.model'),
        ]);

        const [products, variants, digitalAssets] = await Promise.all([
            productIds.length
                ? ProductModel.find({ _id: { $in: productIds } }).select('_id title type status').lean().exec()
                : [],
            variantIds.length
                ? ProductVariantModel.find({ _id: { $in: variantIds } }).select('_id productId sku status').lean().exec()
                : [],
            digitalAssetIds.length
                ? DigitalAssetModel.find({ _id: { $in: digitalAssetIds } }).select('_id originalName').lean().exec()
                : [],
        ]);

        return {
            totalReferences: links.length,
            products: products.map((p: any) => ({
                id: p._id.toString(),
                title: p.title,
                type: p.type,
                status: p.status,
            })),
            variants: variants.map((v: any) => ({
                id: v._id.toString(),
                productId: v.productId?.toString(),
                sku: v.sku,
                status: v.status,
            })),
            digitalAssets: digitalAssets.map((a: any) => ({
                id: a._id.toString(),
                originalName: a.originalName,
            })),
        };
    }

    /**
     * PATCH /api/files/:id
     * Update file metadata (only originalName)
     */
    static updateFile = asyncHandler(async (req: Request, res: Response) => {
        const { id } = req.params;
        const userRole = req.auth!.role;
        const userId = req.auth!.user._id.toString();
        const userRoleEntity = req.auth!.role_entity;

        // Validate body
        const input = UpdateFileSchema.parse(req.body);

        const fileRepository = new FileRepositoryMongo();
        const file = await fileRepository.findById(id);

        if (!file) {
            throw createAppError(ERROR_CODES.CATALOG_FILE_NOT_FOUND, 404, 'File not found');
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
                throw createAppError(ERROR_CODES.AUTH_FORBIDDEN, 403, 'You do not have access to this file');
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
    });

    /**
     * DELETE /api/files/:id
     * Soft delete file (mark for garbage collection).
     *
     * Blocked while the file still has live references in `file_references`
     * (attached to any product / variant / digital asset). The offending
     * entities are returned so the caller can detach them first.
     */
    static deleteFile = asyncHandler(async (req: Request, res: Response) => {
        const { id } = req.params;
        const userRole = req.auth!.role;
        const userId = req.auth!.user._id.toString();
        const userRoleEntity = req.auth!.role_entity;

        const fileRepository = new FileRepositoryMongo();
        const file = await fileRepository.findById(id);

        if (!file) {
            throw createAppError(ERROR_CODES.CATALOG_FILE_NOT_FOUND, 404, 'File not found');
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
                throw createAppError(ERROR_CODES.AUTH_FORBIDDEN, 403, 'You do not have access to this file');
            }
        }

        // Block the delete if the file still has live references.
        const usage = await FileManagementController.resolveFileUsage(id);
        if (usage.totalReferences > 0) {
            throw createAppError(
                ERROR_CODES.CATALOG_FILE_STILL_REFERENCED,
                409,
                'Cannot delete a file that is still referenced. Detach it from the listed entities first.',
                { usage },
            );
        }

        // Soft delete
        await fileRepository.softDelete(id);

        res.json({
            success: true,
            message: 'File deleted successfully',
        });
    });

    /**
     * DELETE /api/files/:id/permanent
     * Permanently delete file (admin only)
     * Storage delete is best-effort - logs failure but doesn't rollback
     */
    static hardDeleteFile = asyncHandler(async (req: Request, res: Response) => {
        const { id } = req.params;

        // Admin-only (also enforced by requireRole at the route level)
        if (req.auth!.role !== 'admin') {
            throw createAppError(ERROR_CODES.ADMIN_FORBIDDEN, 403, 'Admin access required');
        }

        const fileRepository = new FileRepositoryMongo();
        const file = await fileRepository.findById(id);

        if (!file) {
            throw createAppError(ERROR_CODES.CATALOG_FILE_NOT_FOUND, 404, 'File not found');
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
    });

    /**
     * GET /api/files/orphans
     * List orphaned files (admin only)
     * Minimum 24 hours old to prevent accidental deletion
     */
    static listOrphans = asyncHandler(async (req: Request, res: Response) => {
        // Admin-only (also enforced by requireRole at the route level)
        if (req.auth!.role !== 'admin') {
            throw createAppError(ERROR_CODES.ADMIN_FORBIDDEN, 403, 'Admin access required');
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
    });

    /**
     * Maps a broad media category to a MongoDB MIME-type matcher. Image / video /
     * audio match on the MIME prefix; document / archive match a curated set of
     * common types; `other` is the negation of all the known prefixes/types so
     * it catches anything not covered above.
     */
    private static readonly MEDIA_CATEGORY_MATCHERS: Record<string, any> = {
        image: { $regex: '^image/', $options: 'i' },
        video: { $regex: '^video/', $options: 'i' },
        audio: { $regex: '^audio/', $options: 'i' },
        document: {
            $in: [
                'application/pdf',
                'application/msword',
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                'application/vnd.ms-excel',
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                'application/vnd.ms-powerpoint',
                'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                'application/rtf',
                'text/plain',
                'text/csv',
            ],
        },
        archive: {
            $in: [
                'application/zip',
                'application/x-zip-compressed',
                'application/x-rar-compressed',
                'application/vnd.rar',
                'application/x-7z-compressed',
                'application/x-tar',
                'application/gzip',
            ],
        },
        other: {
            $not: {
                $regex: '^(image|video|audio)/|^application/(pdf|msword|rtf|zip|x-zip-compressed|x-rar-compressed|vnd\\.rar|x-7z-compressed|x-tar|gzip|vnd\\.(ms-excel|ms-powerpoint|openxmlformats-officedocument\\.(wordprocessingml\\.document|spreadsheetml\\.sheet|presentationml\\.presentation)))$|^text/(plain|csv)$',
                $options: 'i',
            },
        },
    };

    /**
     * Escape user-supplied input so it is matched literally inside a MongoDB
     * `$regex` (prevents regex-injection / ReDoS from special characters).
     */
    private static escapeRegex(input: string): string {
        return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
}
