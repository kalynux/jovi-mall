import { createAppError } from '../../../../../core/errors';
import { ERROR_CODES } from '../../../../../core/error-codes';
import { IFileRepository } from '../../../repositories/interfaces/file.repository.interface';
import { IFileReferenceRepository } from '../../../repositories/interfaces/file-reference.repository.interface';
import { FileReferenceEntityType } from '../../../models/file-reference.model';
import { RepositoryOptions } from '../../../repositories/types';

export interface ReconcileFileReferencesCommand {
    /** The fileIds currently persisted on the owner (product/variant) before the change. */
    previousFileIds: string[];
    /** The full desired fileIds array after the change. */
    nextFileIds: string[];
    /** Vendor performing the change — used to authorize newly-attached files. */
    vendorId: string;
    /** The entity the files attach to (e.g. the product or variant being edited). */
    entityType: FileReferenceEntityType;
    /** Id of that entity. */
    entityId: string;
    /** Which slot on the entity holds the files. Defaults to 'media'. */
    field?: string;
}

/**
 * FileReferenceService
 *
 * Maintains the `file_references` collection when a product/variant `fileIds`
 * array is replaced wholesale (the pattern used by the catalog endpoints).
 *
 * Given the previous and next arrays it:
 *   1. Authorizes every newly-attached file (must be owned by the vendor or be a
 *      system file) — closes the IDOR where a vendor could reference another
 *      vendor's file by id.
 *   2. Adds a reference row for each added file.
 *   3. Removes the reference row for each removed file.
 *
 * Reference rows are the source of truth for "is this file in use" (there is no
 * usageCount counter anymore). `add`/`remove` are idempotent, so reconciling the
 * same arrays twice is harmless.
 */
export class FileReferenceService {
    constructor(
        private readonly fileRepository: IFileRepository,
        private readonly fileReferenceRepository: IFileReferenceRepository,
    ) { }

    async reconcile(command: ReconcileFileReferencesCommand, options?: RepositoryOptions): Promise<void> {
        const previous = new Set(command.previousFileIds ?? []);
        const next = new Set(command.nextFileIds ?? []);
        const field = command.field ?? 'media';

        const added = [...next].filter((id) => !previous.has(id));
        const removed = [...previous].filter((id) => !next.has(id));

        if (added.length === 0 && removed.length === 0) return;

        if (added.length > 0) {
            await this.assertOwnership(added, command.vendorId, options);
            for (const fileId of added) {
                await this.fileReferenceRepository.add({
                    fileId,
                    entityType: command.entityType,
                    entityId: command.entityId,
                    field,
                    ownerType: 'vendor',
                    ownerId: command.vendorId,
                }, options);
            }
        }

        for (const fileId of removed) {
            await this.fileReferenceRepository.remove(
                fileId,
                command.entityType,
                command.entityId,
                field,
                options,
            );
        }
    }

    /**
     * Every newly-attached file must exist and be owned by the acting vendor
     * (or be a shared system file). Prevents referencing files the vendor does
     * not own.
     */
    private async assertOwnership(
        fileIds: string[],
        vendorId: string,
        options?: RepositoryOptions,
    ): Promise<void> {
        const files = await this.fileRepository.findManyByIds(fileIds, options);
        const byId = new Map(files.map((file) => [file.id, file]));

        for (const fileId of fileIds) {
            const file = byId.get(fileId);
            if (!file) {
                throw createAppError(ERROR_CODES.CATALOG_FILE_NOT_FOUND, 404, `File not found: ${fileId}`);
            }

            const ownedByVendor = file.ownerType === 'vendor' && file.ownerId === vendorId;
            const isSystemFile = file.ownerType === 'system';

            if (!ownedByVendor && !isSystemFile) {
                throw createAppError(
                    ERROR_CODES.CATALOG_PRODUCT_ACCESS_DENIED,
                    403,
                    `Cannot attach file ${fileId}: it is not owned by this vendor`,
                );
            }
        }
    }
}
