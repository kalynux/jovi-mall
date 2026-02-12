import { ConflictError, NotFoundError, ForbiddenError } from '../../../../../core/errors';
import { IFileRepository } from '../../../repositories/interfaces/file.repository.interface';
import { IProductRepository } from '../../../repositories/interfaces/product.repository.interface';
import { IVariantRepository } from '../../../repositories/interfaces/variant.repository.interface';
import { RepositoryOptions } from '../../../repositories/types';
import { IFile } from '../../../models/file.model';

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
 * Atomically increments usageCount on the file.
 * Enforces authorization: actor must own file, OR file is system-owned, OR actor is admin.
 * 
 * DOES NOT mutate owner fields (those represent original uploader).
 */
export class FileAttachService {
    constructor(
        private readonly fileRepository: IFileRepository,
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
            throw new NotFoundError('File not found');
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
                throw new NotFoundError('Product not found or access denied');
            }

            // Check if already attached
            if (product.fileIds && product.fileIds.includes(command.fileId)) {
                throw new ConflictError('File is already attached to this product');
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
                throw new NotFoundError('Variant not found');
            }

            // Verify actor owns the parent product (for vendors)
            if (command.actorType === 'vendor') {
                const product = await this.productRepository.findById(variant.productId, command.actorId, options);
                if (!product) {
                    throw new ForbiddenError('Vendor does not own this variant\'s product');
                }
            }

            // Check if already attached
            if (variant.fileIds && variant.fileIds.includes(command.fileId)) {
                throw new ConflictError('File is already attached to this variant');
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

        // 4. Atomically increment usageCount
        await this.fileRepository.incrementUsageCount(command.fileId, options);
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
        throw new ForbiddenError(
            `Cannot attach file uploaded by ${file.ownerType}. ` +
            `Only file owner or admins can attach files.`
        );
    }
}
