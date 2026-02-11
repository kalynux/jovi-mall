import { TicketAttachmentModel, ITicketAttachment } from '../models/ticket-attachment.model';

/**
 * TicketAttachmentRepository
 * 
 * Data access for ticket file attachments.
 * 
 * BUSINESS RULES:
 * - Max 5 attachments per ticket (enforced in service layer)
 * - Only admins can delete (enforced in service layer)
 * - Files immutable after upload
 */

export class TicketAttachmentRepository {
    /**
     * Create a new attachment
     */
    async create(attachmentData: Partial<ITicketAttachment>): Promise<ITicketAttachment> {
        const attachment = new TicketAttachmentModel(attachmentData);
        return await attachment.save();
    }

    /**
     * Find all attachments for a ticket
     */
    async findByTicket(ticketId: string): Promise<ITicketAttachment[]> {
        return await TicketAttachmentModel.find({ ticket_id: ticketId }).sort({ created_at: 1 });
    }

    /**
     * Count attachments for a ticket
     */
    async countByTicket(ticketId: string): Promise<number> {
        return await TicketAttachmentModel.countDocuments({ ticket_id: ticketId });
    }

    /**
     * Find attachment by ID
     */
    async findById(attachmentId: string): Promise<ITicketAttachment | null> {
        return await TicketAttachmentModel.findById(attachmentId);
    }

    /**
     * Delete attachment by ID
     */
    async deleteById(attachmentId: string): Promise<void> {
        await TicketAttachmentModel.findByIdAndDelete(attachmentId);
    }
}
