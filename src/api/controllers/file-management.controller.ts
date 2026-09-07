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
import {
    MEDIA_CATEGORY_MATCHERS,
    MediaCategory,
} from '../../modules/catalog/domain/services/media/media-category';
import {
    mediaStorageService,
    StorageOwnerType,
} from '../../modules/catalog/domain/services/media/MediaStorageService';
import { entitlementService } from '../../modules/billing/services/entitlement.service';
import { eventBus } from '../../core/events/event-bus';
import { BILLING_OWNER_TYPES, BillingOwnerType } from '../../modules/billing/billing.types';

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
/**
 * Tell the plan-quota module that storage just came free for this owner.
 *
 * Only the three plan-metered owner types have a storage cap at all — a customer's or
 * an administrator's upload is counted against nothing, so there is nothing to release
 * and the event would be noise on every avatar change.
 *
 * See the call site for why this is an event rather than a direct call.
 */
function publishQuotaCapacityFreed(ownerType?: string, ownerId?: unknown): void {
    if (!ownerType || !ownerId) return;
    if (!BILLING_OWNER_TYPES.includes(ownerType as BillingOwnerType)) return;

    const id = ownerId.toString();
    void eventBus.publish('quota.capacity_freed', {
        eventType: 'quota.capacity_freed',
        aggregateId: id,
        occurredAt: new Date(),
        payload: { ownerType, ownerId: id },
    }).catch((err) => console.error('[FileManagementController] capacity_freed publish failed:', err));
}

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
            } else if (userRole === 'agency') {
                ownerFilter = {
                    ownerType: 'agency',
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
            } else {
                // Fail closed: an unrecognised non-admin role must NEVER fall
                // through to an empty filter (which would list every file in the
                // system). Deny access rather than leak.
                throw createAppError(
                    ERROR_CODES.AUTH_FORBIDDEN,
                    403,
                    'Your account type cannot list files',
                );
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
            filters.mimeType = MEDIA_CATEGORY_MATCHERS[query.category as MediaCategory];
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

        // Storage analytics for owner-scoped (non-admin) callers.
        const storage = await FileManagementController.buildStorageSummary(
            userRole,
            userId,
            userRoleEntity,
        );

        res.json({
            success: true,
            data: {
                files: domainFiles,
                storage,
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
     * GET /api/files/storage
     * Lightweight storage usage + limit summary for the authenticated owner
     * (vendor/agency/agent/customer). Same `storage` shape embedded in the file list.
     */
    static getStorageSummary = asyncHandler(async (req: Request, res: Response) => {
        const userRole = req.auth!.role;
        const userId = req.auth!.user._id.toString();
        const userRoleEntity = req.auth!.role_entity;

        const storage = await FileManagementController.buildStorageSummary(
            userRole,
            userId,
            userRoleEntity,
        );

        if (!storage) {
            throw createAppError(
                ERROR_CODES.AUTH_FORBIDDEN,
                403,
                'Storage analytics are only available for vendor, agency, agent or customer accounts',
            );
        }

        res.json({ success: true, data: storage });
    });

    /**
     * Build the per-owner storage summary: total used, per-category breakdown,
     * and (for vendor/agency/agent) the plan storage limit + remaining. Returns
     * `null` for admins (unscoped/global) and any role without an owner scope.
     */
    private static async buildStorageSummary(
        role: string,
        userId: string,
        roleEntity: any,
    ): Promise<{
        limitBytes: number | null;
        usedBytes: number;
        remainingBytes: number | null;
        byCategory: Record<string, { bytes: number; count: number }>;
    } | null> {
        let ownerType: StorageOwnerType;
        let ownerId: string;

        if (role === 'vendor') {
            ownerType = 'vendor';
            ownerId = roleEntity._id.toString();
        } else if (role === 'agency') {
            ownerType = 'agency';
            ownerId = roleEntity._id.toString();
        } else if (role === 'customer') {
            ownerType = 'customer';
            ownerId = userId;
        } else if (role === 'agent') {
            ownerType = 'agent';
            ownerId = roleEntity._id.toString();
        } else {
            // Admin (global scope) or any other role: no owner-scoped summary.
            return null;
        }

        const usage = await mediaStorageService.getUsageBreakdown(ownerType, ownerId);

        // Plan-driven storage cap for the metered owner types (vendor/agency/agent).
        // Customers have no plan → no limit (unlimited).
        let limitBytes: number | null = null;
        if (ownerType === 'vendor' || ownerType === 'agency' || ownerType === 'agent') {
            limitBytes = await entitlementService.resolveMaxStorageBytes(ownerType, ownerId);
        }
        const remainingBytes = limitBytes === null ? null : Math.max(0, limitBytes - usage.total);

        return { limitBytes, usedBytes: usage.total, remainingBytes, byCategory: usage.byCategory };
    }

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
     * brand-new entity type is counted automatically).
     *
     * `references[]` is the future-proof, UI-facing shape: one entry per live
     * reference with `{ entityType, entityId, field, label }`, where `label` is a
     * human-readable name resolved per entity type. Adding a new file-referencing
     * module means adding ONE entry to `LABEL_RESOLVERS` below — unknown types
     * still surface with a generic fallback label rather than disappearing.
     *
     * The `products`/`variants`/`digitalAssets` arrays are retained for backward
     * compatibility with existing consumers and carry a few extra type-specific
     * fields; new UI should prefer `references[]`.
     */
    private static async resolveFileUsage(fileId: string): Promise<{
        totalReferences: number;
        references: Array<{ entityType: string; entityId: string; field: string; label: string }>;
        products: Array<{ id: string; title: string; type: string; status: string }>;
        variants: Array<{ id: string; productId: string; sku: string; status: string }>;
        digitalAssets: Array<{ id: string; originalName: string }>;
    }> {
        const fileReferenceRepository = new FileReferenceRepositoryMongo();
        const links = await fileReferenceRepository.findByFile(fileId);

        // Build the labelled, entity-type-agnostic reference list.
        const references = await FileManagementController.buildReferenceLabels(links);

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
            references,
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
     * Resolve a human-readable label for each file reference. Groups ids by
     * entity type, runs the matching resolver (batched, one query per type), and
     * falls back to `"<entityType> <id>"` for any type without a resolver — so a
     * new file-referencing module surfaces in the UI even before it is added here.
     *
     * To support a new entity type's display name, add one resolver entry.
     * Dynamic import() keeps these off the module load graph (no import cycles).
     */
    private static async buildReferenceLabels(
        links: Array<{ entityType: string; entityId: string; field: string }>,
    ): Promise<Array<{ entityType: string; entityId: string; field: string; label: string }>> {
        const idsByType = new Map<string, string[]>();
        for (const l of links) {
            const list = idsByType.get(l.entityType) ?? [];
            list.push(l.entityId);
            idsByType.set(l.entityType, list);
        }

        const LABEL_RESOLVERS: Record<string, (ids: string[]) => Promise<Map<string, string>>> = {
            product: async (ids) => {
                const { ProductModel } = await import('../../modules/catalog/models/product.model');
                const docs = await ProductModel.find({ _id: { $in: ids } }).select('_id title').lean().exec();
                return new Map(docs.map((d: any) => [d._id.toString(), d.title || 'Product']));
            },
            variant: async (ids) => {
                const { ProductVariantModel } = await import('../../modules/catalog/models/product-variant.model');
                const docs = await ProductVariantModel.find({ _id: { $in: ids } }).select('_id sku').lean().exec();
                return new Map(docs.map((d: any) => [d._id.toString(), d.sku || 'Variant']));
            },
            digital_asset: async (ids) => {
                const { DigitalAssetModel } = await import('../../modules/digital-delivery/models/digital-asset.model');
                const docs = await DigitalAssetModel.find({ _id: { $in: ids } }).select('_id originalName').lean().exec();
                return new Map(docs.map((d: any) => [d._id.toString(), d.originalName || 'Digital asset']));
            },
            ticket: async (ids) => {
                const { TicketModel } = await import('../../modules/tickets/models/ticket.model');
                const docs = await TicketModel.find({ _id: { $in: ids } }).select('_id subject').lean().exec();
                return new Map(docs.map((d: any) => [d._id.toString(), d.subject || 'Ticket']));
            },
            vendor: async (ids) => {
                // The vendor's business name lives on the Store; this entity label
                // uses the vendor's personal display name (avatar owner).
                const { VendorModel } = await import('../../modules/vendors/vendor.model');
                const docs = await VendorModel.find({ _id: { $in: ids } }).select('_id display_name').lean().exec();
                return new Map(docs.map((d: any) => [d._id.toString(), d.display_name || 'Vendor']));
            },
            store: async (ids) => {
                const { StoreModel } = await import('../../modules/store/models/store.model');
                const docs = await StoreModel.find({ _id: { $in: ids } }).select('_id name').lean().exec();
                return new Map(docs.map((d: any) => [d._id.toString(), d.name || 'Store']));
            },
            agency: async (ids) => {
                // The agency's business name lives on the Magazin; this entity label
                // uses the agency's personal display name (avatar owner).
                const { DeliveryAgencyModel } = await import('../../modules/delivery/delivery-agency.model');
                const docs = await DeliveryAgencyModel.find({ _id: { $in: ids } }).select('_id display_name').lean().exec();
                return new Map(docs.map((d: any) => [d._id.toString(), d.display_name || 'Agency']));
            },
            agency_magazin: async (ids) => {
                const { AgencyMagazinModel } = await import('../../modules/magazin/models/magazin.model');
                const docs = await AgencyMagazinModel.find({ _id: { $in: ids } }).select('_id name').lean().exec();
                return new Map(docs.map((d: any) => [d._id.toString(), d.name || 'Magazin']));
            },
            customer: async (ids) => {
                const { CustomerModel } = await import('../../modules/customers/customer.model');
                const docs = await CustomerModel.find({ _id: { $in: ids } }).select('_id name').lean().exec();
                return new Map(docs.map((d: any) => [d._id.toString(), d.name || 'Customer']));
            },
            agent: async (ids) => {
                const { DeliveryAgentModel } = await import('../../modules/agents/models/agent.model');
                const docs = await DeliveryAgentModel.find({ _id: { $in: ids } }).select('_id name').lean().exec();
                return new Map(docs.map((d: any) => [d._id.toString(), d.name || 'Agent']));
            },
            admin: async (ids) => {
                const { AdminModel } = await import('../../modules/admins/admin.model');
                const docs = await AdminModel.find({ _id: { $in: ids } }).select('_id name').lean().exec();
                return new Map(docs.map((d: any) => [d._id.toString(), d.name || 'Admin']));
            },
            shipment: async (ids) => {
                // Delivery proofs attach to shipments; label by parent order number.
                const { ShipmentModel } = await import('../../modules/shipments/shipment.model');
                const { OrderModel } = await import('../../modules/orders/order.model');
                const docs = await ShipmentModel.find({ _id: { $in: ids } }).select('_id order_id').lean().exec();
                const orderIds = docs.map((d: any) => d.order_id).filter(Boolean);
                const orders = orderIds.length
                    ? await OrderModel.find({ _id: { $in: orderIds } }).select('_id order_number').lean().exec()
                    : [];
                const orderNumById = new Map(orders.map((o: any) => [o._id.toString(), o.order_number]));
                return new Map(docs.map((d: any) => {
                    const num = orderNumById.get(d.order_id?.toString());
                    return [d._id.toString(), num ? `Delivery proof — Order ${num}` : 'Delivery proof'];
                }));
            },
        };

        // Resolve labels for every present type in parallel, keyed "type:id".
        const labelByKey = new Map<string, string>();
        await Promise.all(
            [...idsByType.entries()].map(async ([type, ids]) => {
                const resolver = LABEL_RESOLVERS[type];
                if (!resolver) return;
                const map = await resolver(ids);
                for (const [id, label] of map) labelByKey.set(`${type}:${id}`, label);
            }),
        );

        return links.map((l) => ({
            entityType: l.entityType,
            entityId: l.entityId,
            field: l.field,
            label: labelByKey.get(`${l.entityType}:${l.entityId}`) ?? `${l.entityType} ${l.entityId}`,
        }));
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

        // Storage just came free — release the next-oldest quota-blocked file.
        //
        // Deleting is the remedy an owner over their storage cap is offered, and it
        // changes neither their plan nor its limits, so `plan.activated` does not fire
        // and nothing else would recompute. `PlanQuotaReconcileWorker` also sweeps
        // everyone currently holding blocks, so a dropped event costs latency rather than
        // correctness — this is what makes the release visible before tomorrow.
        //
        // An EVENT rather than a call into `plan-quota`: that module imports the file
        // repository, so importing it from here would close a cycle.
        publishQuotaCapacityFreed(file.ownerType, file.ownerId);
    });

    /**
     * DELETE /api/internal/admin/files/:id/permanent
     * Permanently delete file (administrators only)
     * Storage delete is best-effort - logs failure but doesn't rollback
     *
     * Moved off the public `/api/files` router at Phase 5 Part B; the handler is
     * unchanged. The `role !== 'admin'` check below is now a SECOND lock rather than
     * the only one — `requireAdminCaller` fabricates `req.auth.role = 'admin'`, so it
     * is satisfied rather than contradicted, and it stays deliberately.
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
     * GET /api/internal/admin/files/orphans
     * List orphaned files (administrators only)
     * Minimum 24 hours old to prevent accidental deletion
     *
     * Moved off the public `/api/files` router at Phase 5 Part B; the handler is
     * unchanged, including the `role !== 'admin'` check — see `hardDeleteFile` above.
     * ⚠ This answers the whole `File`, storage `key` included. wi-admin withholds the
     * key from its own projection (Phase 5 D-10); the two shapes are not the same.
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

        if (userRole === 'agency' && file.ownerType === 'agency') {
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
