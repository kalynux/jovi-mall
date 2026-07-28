import { createAppError } from '../../../../../core/errors';
import { ERROR_CODES } from '../../../../../core/error-codes';
import { IFileRepository } from '../../../repositories/interfaces/file.repository.interface';
import { IFileReferenceRepository } from '../../../repositories/interfaces/file-reference.repository.interface';
import { FileReferenceEntityType } from '../../../models/file-reference.model';
import { FileOwnerType } from '../../../models/file.model';
import { File } from '../../../repositories/mappers/file.mapper';
import { RepositoryOptions } from '../../../repositories/types';

/**
 * The party performing the attach — used to authorize newly-attached files. A
 * file may be attached by its owner, by an admin, or when it is a shared system
 * file. See {@link FileReferenceService.assertAttachable}.
 */
export interface FileReferenceActor {
    type: FileOwnerType;
    id: string;
}

export interface ReconcileFileReferencesCommand {
    /** The fileIds currently persisted on the owner (product/store/…) before the change. */
    previousFileIds: string[];
    /** The full desired fileIds array after the change. */
    nextFileIds: string[];
    /** Who is performing the change — used to authorize newly-attached files. */
    actor: FileReferenceActor;
    /** The entity the files attach to (e.g. the product, store or ticket being edited). */
    entityType: FileReferenceEntityType;
    /** Id of that entity. */
    entityId: string;
    /** Which slot on the entity holds the files. Defaults to 'media'. */
    field?: string;
}

/**
 * FileReferenceService
 *
 * The reusable primitive for recording "this file is in use". Maintains the
 * `file_references` collection when a single- or multi-file slot on an entity is
 * replaced wholesale. It is entity-agnostic: any module (product, ticket, store,
 * agency, or a new one) records file usage by calling {@link reconcile} with the
 * relevant `entityType` + `field` — no change to the file layer is needed.
 *
 * Given the previous and next fileId arrays it:
 *   1. Authorizes every newly-attached file — the actor must own it, it must be a
 *      shared system file, or the actor must be an admin. Closes the IDOR where an
 *      actor could reference another owner's file by id.
 *   2. Adds a reference row for each added file (owner denormalized from the File's
 *      original uploader, per the file_references contract).
 *   3. Removes the reference row for each removed file.
 *
 * Reference rows are the source of truth for "is this file in use" (there is no
 * usageCount counter). `add`/`remove` are idempotent, so reconciling the same
 * arrays twice is harmless.
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
            const files = await this.resolveAttachable(added, command.actor, options);
            for (const fileId of added) {
                const file = files.get(fileId)!;
                await this.fileReferenceRepository.add({
                    fileId,
                    entityType: command.entityType,
                    entityId: command.entityId,
                    field,
                    // Denormalize from the File's original uploader, not the actor.
                    ownerType: file.ownerType,
                    ownerId: file.ownerId,
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
     * Fetch and authorize every newly-attached file. Each must exist and be
     * attachable by the actor. Returns the files keyed by id so the caller can
     * denormalize their owner onto the reference.
     */
    private async resolveAttachable(
        fileIds: string[],
        actor: FileReferenceActor,
        options?: RepositoryOptions,
    ): Promise<Map<string, File>> {
        const files = await this.fileRepository.findManyByIds(fileIds, options);
        const byId = new Map(files.map((file) => [file.id, file]));

        for (const fileId of fileIds) {
            const file = byId.get(fileId);
            if (!file) {
                throw createAppError(ERROR_CODES.CATALOG_FILE_NOT_FOUND, 404, `File not found: ${fileId}`);
            }
            this.assertAttachable(file, actor);
        }

        return byId;
    }

    /**
     * A file is attachable when the actor owns it, it is a shared system file, or
     * the actor is an admin. Prevents referencing files the actor does not own.
     */
    private assertAttachable(file: File, actor: FileReferenceActor): void {
        if (actor.type === 'admin') return;
        if (file.ownerType === 'system') return;
        if (file.ownerType === actor.type && file.ownerId === actor.id) return;

        throw createAppError(
            ERROR_CODES.CATALOG_PRODUCT_ACCESS_DENIED,
            403,
            `Cannot attach file ${file.id}: it is not owned by this ${actor.type}`,
        );
    }
}
