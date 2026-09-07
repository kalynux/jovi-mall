import { TicketAttachmentRepository } from '../repositories/ticket-attachment.repository';
import { ActorRole } from '../types/ticket.types';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { ITicketAttachment } from '../models/ticket-attachment.model';
import { eventBus } from '../../../core/events/event-bus';
import { getStorageProvider, IStorageProvider } from "../../../core/storage";
import { FileModel, IFile } from '../../catalog/models/file.model';
import { toFileDetail } from '../../catalog/read-models/file-detail.resolver';
import { FileReferenceRepositoryMongo } from '../../catalog/repositories/mongo/file-reference.repository.mongo';
import { IFileReferenceRepository } from '../../catalog/repositories/interfaces/file-reference.repository.interface';
import mongoose from 'mongoose';

/**
 * TicketAttachmentService
 *
 * Manages file attachments for tickets.
 *
 * The file itself is uploaded separately via POST /api/files/upload (the global
 * upload pipeline); only the resulting `fileId` is attached here — the same
 * pattern used for product images. We never receive raw file bytes.
 *
 * DOMAIN RULES:
 * - Max 5 files per ticket
 * - Only admins can delete attachments
 * - Files are immutable after upload
 * - A `file_references` row (entityType 'ticket') keeps the file from being
 *   reclaimed by orphan garbage collection while it is attached.
 */

/**
 * The per-ticket ceiling, exported because a SECOND caller now reports it.
 *
 * ⚠ It was a bare `5` in `attachFile` and nowhere else. The bot surface tells a customer
 * how many attachments a ticket now holds out of how many it may hold, and a chat that
 * says "4 of 5" while the service refuses at 3 is worse than saying nothing. One
 * constant, so the sentence and the refusal cannot disagree.
 */
export const TICKET_ATTACHMENT_LIMIT = 5;

const TICKET_FILE_REFERENCE_FIELD = 'attachment';

export class TicketAttachmentService {
    private attachmentRepo: TicketAttachmentRepository;
    private fileReferenceRepo: IFileReferenceRepository;
    private storageService: IStorageProvider;

    constructor() {
        this.attachmentRepo = new TicketAttachmentRepository();
        this.fileReferenceRepo = new FileReferenceRepositoryMongo();
        this.storageService = getStorageProvider();
    }

    /**
     * Attach an already-uploaded file to a ticket.
     *
     * @param ticketId - Ticket ID
     * @param fileId - ID of a File previously uploaded via /api/files/upload
     * @param uploaderUserId - User ID attaching the file (stored on the attachment)
     * @param uploaderRole - Attacher's role
     * @param actorEntityId - Attacher's role-entity ID (used for file-ownership check)
     * @param visibility - PUBLIC or PRIVATE (default PUBLIC)
     * @param visibleToUserIds - User IDs for private attachment visibility
     */
    async attachFile(
        ticketId: string,
        fileId: string,
        uploaderUserId: string,
        uploaderRole: ActorRole,
        actorEntityId: string,
        visibility: 'PUBLIC' | 'PRIVATE' = 'PUBLIC',
        visibleToUserIds?: string[]
    ): Promise<ITicketAttachment> {
        // Check attachment count
        const currentCount = await this.attachmentRepo.countByTicket(ticketId);
        if (currentCount >= TICKET_ATTACHMENT_LIMIT) {
            throw createAppError(ERROR_CODES.TICKET_ATTACHMENT_LIMIT_EXCEEDED, 422);
        }

        // Resolve the previously-uploaded file
        if (!mongoose.Types.ObjectId.isValid(fileId)) {
            throw createAppError(ERROR_CODES.TICKET_ATTACHMENT_MISSING, 404, 'File not found');
        }
        const fileRecord = await FileModel.findOne({ _id: fileId, deletedAt: null });
        if (!fileRecord) {
            throw createAppError(ERROR_CODES.TICKET_ATTACHMENT_MISSING, 404, 'File not found');
        }

        // Authorization: attacher must own the file, or it is system-owned, or admin
        this.enforceFileAttachmentAuthorization(fileRecord, uploaderRole, actorEntityId);

        // If private, auto-include uploader and admins in visibility list
        let finalVisibleToUserIds: mongoose.Types.ObjectId[] | undefined;
        if (visibility === 'PRIVATE') {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const TicketFollowerRepository = require('../repositories/ticket-follower.repository').TicketFollowerRepository;
            const followerRepo = new TicketFollowerRepository();

            // Get admin followers
            const adminFollowers = await followerRepo.getAdminFollowers(ticketId);
            const adminIds = adminFollowers.map((f: any) => f.user_id.toString());

            // Combine uploader + admins + explicit list
            const allIds = [
                uploaderUserId,
                ...adminIds,
                ...(visibleToUserIds || [])
            ];

            // Deduplicate and convert to ObjectIds
            const uniqueIds = [...new Set(allIds)];
            finalVisibleToUserIds = uniqueIds.map(id => new mongoose.Types.ObjectId(id));
        }

        // Create attachment record (metadata copied from the File)
        const attachment = await this.attachmentRepo.create({
            ticket_id: new mongoose.Types.ObjectId(ticketId),
            uploaded_by_user_id: new mongoose.Types.ObjectId(uploaderUserId),
            uploaded_by_role: uploaderRole,
            file_id: fileRecord._id,
            file_name: fileRecord.originalName || 'file',
            file_size: fileRecord.size,
            mime_type: fileRecord.mimeType,
            visibility,
            visible_to_user_ids: finalVisibleToUserIds
        });

        // Register a live reference so the file isn't garbage-collected as an orphan
        await this.fileReferenceRepo.add({
            fileId: fileRecord._id.toString(),
            entityType: 'ticket',
            entityId: ticketId,
            field: TICKET_FILE_REFERENCE_FIELD,
            ownerType: fileRecord.ownerType,
            ownerId: fileRecord.ownerId?.toString(),
        });

        // Emit event
        await eventBus.publish('ticket.attachment_uploaded', {
            eventType: 'ticket.attachment_uploaded',
            aggregateId: ticketId,
            payload: {
                ticketId,
                attachmentId: attachment.id,
                fileName: attachment.file_name,
                visibility
            },
            occurredAt: new Date()
        });

        return attachment;
    }

    /**
     * Enforce that the attacher may use this file.
     *
     * Mirrors the product image rule (FileAttachService):
     * 1. Admins can attach any file.
     * 2. System-owned files can be attached by anyone.
     * 3. Otherwise the attacher must be the file's owner.
     */
    private enforceFileAttachmentAuthorization(
        file: IFile,
        actorRole: ActorRole,
        actorEntityId: string
    ): void {
        if (actorRole === ActorRole.ADMIN) {
            return;
        }
        if (file.ownerType === 'system') {
            return;
        }
        if (file.ownerType === actorRole && file.ownerId?.toString() === actorEntityId) {
            return;
        }
        throw createAppError(
            ERROR_CODES.TICKET_ACCESS_DENIED,
            403,
            `Cannot attach a file uploaded by ${file.ownerType ?? 'another user'}. Only the file owner or an admin can attach it.`
        );
    }

    /**
     * Delete an attachment
     * 
     * Only admins can delete attachments.
     * 
     * @param attachmentId - Attachment ID
     * @param userId - User ID requesting deletion
     * @param role - User's role
     */
    async deleteAttachment(
        attachmentId: string,
        userId: string,
        role: ActorRole
    ): Promise<void> {
        // Only admins can delete
        if (role !== ActorRole.ADMIN) {
            throw createAppError(ERROR_CODES.TICKET_ACCESS_DENIED, 403, 'Only admins can delete attachments');
        }

        // Get attachment
        const attachment = await this.attachmentRepo.findById(attachmentId);
        if (!attachment) {
            throw createAppError(ERROR_CODES.TICKET_ATTACHMENT_MISSING, 404, 'Attachment not found');
        }

        // Release the file reference. The underlying File is left intact and is
        // reclaimed by orphan garbage collection only once it has no live
        // references anywhere (it may still be used elsewhere).
        await this.fileReferenceRepo.remove(
            attachment.file_id.toString(),
            'ticket',
            attachment.ticket_id.toString(),
            TICKET_FILE_REFERENCE_FIELD
        );

        // Delete attachment record
        await this.attachmentRepo.deleteById(attachmentId);

        // Emit event
        await eventBus.publish('ticket.attachment_deleted', {
            eventType: 'ticket.attachment_deleted',
            aggregateId: attachment.ticket_id.toString(),
            payload: {
                createdAt: (attachment.createdAt as Date).toISOString(),
                attachmentId,
                deletedBy: userId
            },
            occurredAt: new Date()
        });
    }

    /**
     * List attachments for a ticket with visibility filtering
     * 
     * @param ticketId - Ticket ID
     * @param viewerUserId - User viewing the attachments
     * @param viewerRole - Viewer's role
     */
    async listAttachments(
        ticketId: string,
        viewerUserId: string,
        viewerRole: ActorRole
    ): Promise<ITicketAttachment[]> {
        return await this.attachmentRepo.findByTicket(ticketId, viewerRole, viewerUserId);
    }

    /**
     * Get attachment count for a ticket
     */
    async getAttachmentCount(ticketId: string): Promise<number> {
        return await this.attachmentRepo.countByTicket(ticketId);
    }

    /**
     * The URL for an attachment file, or `null` when there is no servable one.
     *
     * ⚠ **This used to return `getPublicUrl(key)` unconditionally, bypassing the
     * `toFileDetail` choke point entirely** — and `test:uploads`' guard scan could not
     * see it, because that regex anchors on a bare `url: storage.getPublicUrl(`. Two
     * rules were therefore missing here:
     *
     *  - **privacy** (ADR-A01 D-2): a key in a private tree is off `express.static`, so
     *    the URL is a link that 404s. Benign today only because ticket attachments land
     *    in `documents/`/`images/` rather than `ticket-attachments/` — an accident of
     *    the upload path, not a guarantee, and the one legacy file in that tree is
     *    exactly the case this got wrong.
     *  - **plan quota**: a file outside the owner's storage allowance must not be served
     *    from here when it is served from nowhere else.
     *
     * The return type widened from `string` to `string | null` deliberately, for the
     * reason `FileDetail.url` is nullable: a caller must be made to handle "there is no
     * URL" by the compiler rather than render an empty `<img>`.
     *
     * @param attachment - Ticket attachment
     * @returns Public URL, or null when private or quota-blocked
     */
    async getAttachmentUrl(attachment: ITicketAttachment): Promise<string | null> {
        const fileRecord = await FileModel.findById(attachment.file_id);
        if (!fileRecord) {
            throw createAppError(ERROR_CODES.TICKET_ATTACHMENT_MISSING, 404, 'File record not found');
        }
        return toFileDetail(
            {
                id: fileRecord._id.toString(),
                key: fileRecord.key,
                mimeType: fileRecord.mimeType,
                size: fileRecord.size,
                originalName: fileRecord.originalName,
                quotaBlockedAt: fileRecord.quotaBlockedAt,
            },
            this.storageService,
        ).url;
    }
}
