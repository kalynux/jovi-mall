import { TicketAttachmentRepository } from '../repositories/ticket-attachment.repository';
import { ActorRole } from '../types/ticket.types';
import { AttachmentLimitExceededError, ForbiddenError, NotFoundError } from '../../../core/errors';
import { ITicketAttachment } from '../models/ticket-attachment.model';
import { eventBus } from '../../../core/events/event-bus';
import { createStorageProvider, IStorageProvider } from "../../../core/storage";
import { FileModel } from '../../catalog/models/file.model';
import mongoose from 'mongoose';

/**
 * TicketAttachmentService
 * 
 * Manages file attachments for tickets using the storage factory pattern.
 * 
 * DOMAIN RULES:
 * - Max 5 files per ticket
 * - Only admins can delete attachments
 * - Files are immutable after upload
 * - File keys are stored in File model, URLs generated at runtime
 */

const storageProvider = createStorageProvider({
    provider: 'local',
    local: {
        basePath: './storage',      // absolute path to storage directory (e.g., './storage')
        baseUrl: 'http://localhost:3000/storage',       // base URL for public access (e.g., 'http://localhost:3000/storage')
    },
});

export class TicketAttachmentService {
    private attachmentRepo: TicketAttachmentRepository;
    private storageService: IStorageProvider;

    constructor() {
        this.attachmentRepo = new TicketAttachmentRepository();
        this.storageService = storageProvider;
    }

    /**
     * Upload a file attachment to a ticket
     * 
     * @param ticketId - Ticket ID
     * @param file - Multer file object
     * @param uploaderUserId - User ID uploading the file
     * @param uploaderRole - User's role
     */
    async uploadAttachment(
        ticketId: string,
        file: Express.Multer.File,
        uploaderUserId: string,
        uploaderRole: ActorRole
    ): Promise<ITicketAttachment> {
        // Check attachment count
        const currentCount = await this.attachmentRepo.countByTicket(ticketId);
        if (currentCount >= 5) {
            throw new AttachmentLimitExceededError();
        }

        // Upload to storage provider
        const uploadResult = await this.storageService.put(file.buffer, {
            folder: 'ticket-attachments',
            mimeType: file.mimetype,
            filename: file.originalname,
        });

        // Create File record
        const fileRecord = await FileModel.create({
            key: uploadResult.key,
            provider: 'local', // Match the storageProvider config
            mimeType: file.mimetype,
            size: uploadResult.size,
            checksum: uploadResult.checksum,
            originalName: file.originalname,
            isOrphan: false, // Linked to ticket attachment
            ownerType: 'system', // Not vendor-owned
            ownerId: new mongoose.Types.ObjectId(uploaderUserId),
        });

        // Create attachment record
        const attachment = await this.attachmentRepo.create({
            ticket_id: new mongoose.Types.ObjectId(ticketId),
            uploaded_by_user_id: new mongoose.Types.ObjectId(uploaderUserId),
            uploaded_by_role: uploaderRole,
            file_id: fileRecord._id,
            file_name: file.originalname,
            file_size: file.size,
            mime_type: file.mimetype,
        });

        // Emit event
        await eventBus.publish('ticket.attachment_uploaded', {
            eventType: 'ticket.attachment_uploaded',
            aggregateId: ticketId,
            payload: {
                ticketId,
                attachmentId: attachment.id,
                fileName: file.originalname
            },
            occurredAt: new Date()
        });

        return attachment;
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
            throw new ForbiddenError('Only admins can delete attachments');
        }

        // Get attachment
        const attachment = await this.attachmentRepo.findById(attachmentId);
        if (!attachment) {
            throw new NotFoundError('Attachment not found');
        }

        // Get file record
        const fileRecord = await FileModel.findById(attachment.file_id);
        if (!fileRecord) {
            throw new NotFoundError('File record not found');
        }

        // Delete from storage
        await this.storageService.delete(fileRecord.key);

        // Delete file record
        await FileModel.deleteOne({ _id: attachment.file_id });

        // Delete attachment record
        await this.attachmentRepo.deleteById(attachmentId);

        // Emit event
        await eventBus.publish('ticket.attachment_deleted', {
            eventType: 'ticket.attachment_deleted',
            aggregateId: attachment.ticket_id.toString(),
            payload: {
                ticketId: attachment.ticket_id.toString(),
                attachmentId,
                deletedBy: userId
            },
            occurredAt: new Date()
        });
    }

    /**
     * List attachments for a ticket
     */
    async listAttachments(ticketId: string): Promise<ITicketAttachment[]> {
        return await this.attachmentRepo.findByTicket(ticketId);
    }

    /**
     * Get attachment count for a ticket
     */
    async getAttachmentCount(ticketId: string): Promise<number> {
        return await this.attachmentRepo.countByTicket(ticketId);
    }

    /**
     * Get the URL for an attachment file
     * Generates the URL at runtime from the stored key
     * 
     * @param attachment - Ticket attachment
     * @returns Public URL for the file
     */
    async getAttachmentUrl(attachment: ITicketAttachment): Promise<string> {
        const fileRecord = await FileModel.findById(attachment.file_id);
        if (!fileRecord) {
            throw new NotFoundError('File record not found');
        }
        return this.storageService.getPublicUrl(fileRecord.key);
    }
}
