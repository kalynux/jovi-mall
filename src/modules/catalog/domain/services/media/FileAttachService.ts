import { createAppError } from '../../../../../core/errors';
import { ERROR_CODES } from '../../../../../core/error-codes';
import { IFileRepository } from '../../../repositories/interfaces/file.repository.interface';
import { IFileReferenceRepository } from '../../../repositories/interfaces/file-reference.repository.interface';
import { IProductRepository } from '../../../repositories/interfaces/product.repository.interface';
import { IVariantRepository } from '../../../repositories/interfaces/variant.repository.interface';
import { RepositoryOptions } from '../../../repositories/types';

export type ActorType = 'vendor' | 'admin' | 'customer' | 'agent' | 'agency';

export interface AttachFileCommand {
    fileId: string;
    ownerType: 'product' | 'variant';
    ownerId: string;
    actorId: string;       // ID of actor performing attachment
    actorType: ActorType;  // Type of actor (vendor, admin, etc.)
}

/**
 * FileAttachService
 *
 * Attaches file to product or variant by adding fileId to fileIds array.
 * Registers a row in `file_references` so the file counts as in use.
 * Enforces authorization: actor must own file, OR file is system-owned, OR actor is admin.
 * 
 * DOES NOT mutate owner fields (those represent original uploader).
 */
export class FileAttachService {
    constructor(
        private readonly fileRepository: IFileRepository,
        private readonly fileReferenceRepository: IFileReferenceRepository,
        private readonly productRepository: IProductRepository,
        private readonly variantRepository: IVariantRepository
    ) { }

    /**
     * Attach file to product or variant
     * @param command - Attach command with file, owner, actor details
     * @throws NotFoundError if file or owner not found
     * @throws ForbiddenError if actor doesn't have permission
     * @throws ConflictError if file is already attached
     */
    async execute(command: AttachFileCommand, options?: RepositoryOptions): Promise<void> {
        // 1. Validate file exists
        const file = await this.fileRepository.findById(command.fileId, options);
        if (!file) {
            throw createAppError(ERROR_CODES.CATALOG_FILE_NOT_FOUND, 404);
        }

        // 2. AUTHORIZATION CHECK
        this.enforceFileAttachmentAuthorization(file, command.actorId, command.actorType);

        // 3. Validate owner exists and actor has permission
        if (command.ownerType === 'product') {
            let product;
            if (command.actorType === 'vendor') {
                product = await this.productRepository.findById(command.ownerId, command.actorId, options);
            } else {
                product = await this.productRepository.findByIdUnscoped(command.ownerId, options);
            }

            if (!product) {
                throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404, 'Product not found or access denied');
            }

            // Check if already attached
            if (product.fileIds && product.fileIds.includes(command.fileId)) {
                throw createAppError(ERROR_CODES.CATALOG_FILE_ALREADY_ATTACHED, 409, 'File is already attached to this product');
            }

            // Add fileId to product fileIds
            await this.productRepository.update(
                command.ownerId,
                product.vendorId,
                {
                    fileIds: [...(product.fileIds || []), command.fileId]
                } as any,
                options
            );

        } else if (command.ownerType === 'variant') {
            const variant = await this.variantRepository.findById(command.ownerId, options);
            if (!variant) {
                throw createAppError(ERROR_CODES.CATALOG_VARIANT_NOT_FOUND, 404);
            }

            // Verify actor owns the parent product (for vendors)
            if (command.actorType === 'vendor') {
                const product = await this.productRepository.findById(variant.productId, command.actorId, options);
                if (!product) {
                    throw createAppError(ERROR_CODES.CATALOG_PRODUCT_ACCESS_DENIED, 403, "Vendor does not own this variant's product");
                }
            }

            // Check if already attached
            if (variant.fileIds && variant.fileIds.includes(command.fileId)) {
                throw createAppError(ERROR_CODES.CATALOG_FILE_ALREADY_ATTACHED, 409, 'File is already attached to this variant');
            }

            // Add fileId to variant fileIds
            await this.variantRepository.update(
                command.ownerId,
                {
                    fileIds: [...(variant.fileIds || []), command.fileId]
                } as any,
                options
            );
        }

        // 4. Register the reference (replaces the old usageCount increment)
        await this.fileReferenceRepository.add({
            fileId: command.fileId,
            entityType: command.ownerType,
            entityId: command.ownerId,
            field: 'media',
            ownerType: command.actorType,
            ownerId: command.actorId,
        }, options);
    }

    /**
     * Enforce file attachment authorization
     * 
     * Rules:
     * 1. Admin can attach any file
     * 2. System files can be attached by anyone
     * 3. Actor must own the file
     * 
     * @throws ForbiddenError if actor is not authorized
     */
    private enforceFileAttachmentAuthorization(
        file: any,  // IFile from domain
        actorId: string,
        actorType: ActorType
    ): void {
        // Rule 1: Admin override (admins can attach any file)
        if (actorType === 'admin') {
            return; // ✅ Allowed
        }

        // Rule 2: System files can be attached by anyone
        if (file.ownerType === 'system') {
            return; // ✅ Allowed
        }

        // Rule 3: Actor must own the file
        if (file.ownerId === actorId && file.ownerType === actorType) {
            return; // ✅ Allowed
        }

        // ❌ Deny: Actor does not own file and is not admin
        throw createAppError(
            ERROR_CODES.CATALOG_PRODUCT_ACCESS_DENIED,
            403,
            `Cannot attach file uploaded by ${file.ownerType}. Only file owner or admins can attach files.`
        );
    }
}
