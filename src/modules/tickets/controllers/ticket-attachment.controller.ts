import { Request, Response } from 'express';
import { TicketAttachmentService } from '../services/ticket-attachment.service';
import { AppError } from '../../../core/errors';
import { ActorRole } from '../types/ticket.types';

/**
 * TicketAttachmentController
 * 
 * HTTP layer for ticket file attachments.
 */

export class TicketAttachmentController {
    private static attachmentService = new TicketAttachmentService();

    // * POST /api/*/tickets/:ticketId/attachments
    // * Upload a file attachment to a ticket
    // * Requires multer middleware for file upload
    static async uploadAttachment(req: Request, res: Response): Promise<void> {
        try {
            const ticketId = req.params.ticketId;
            const userId = req.auth!.user.id;
            const role = req.auth!.role as ActorRole;

            if (!req.file) {
                res.status(400).json({
                    success: false,
                    error: 'No file provided'
                });
                return;
            }

            const attachment = await TicketAttachmentController.attachmentService.uploadAttachment(
                ticketId,
                req.file,
                userId,
                role
            );

            // Generate URL for the uploaded attachment
            const url = await TicketAttachmentController.attachmentService.getAttachmentUrl(attachment);

            res.status(201).json({
                success: true,
                data: {
                    id: attachment.id,
                    fileName: attachment.file_name,
                    fileSize: attachment.file_size,
                    mimeType: attachment.mime_type,
                    url: url,
                    uploadedBy: attachment.uploaded_by_user_id,
                    uploadedByRole: attachment.uploaded_by_role,
                    createdAt: attachment.created_at
                }
            });
        } catch (error) {
            TicketAttachmentController.handleError(error, res);
        }
    }

    //   * GET /api/*/tickets /: ticketId / attachments
    // * List attachments for a ticket

    static async listAttachments(req: Request, res: Response): Promise<void> {
        try {
            const ticketId = req.params.ticketId;

            const attachments = await TicketAttachmentController.attachmentService.listAttachments(ticketId);

            // Generate URLs for all attachments
            const attachmentsWithUrls = await Promise.all(
                attachments.map(async (att) => ({
                    id: att.id,
                    fileName: att.file_name,
                    fileSize: att.file_size,
                    mimeType: att.mime_type,
                    url: await TicketAttachmentController.attachmentService.getAttachmentUrl(att),
                    uploadedBy: att.uploaded_by_user_id,
                    uploadedByRole: att.uploaded_by_role,
                    createdAt: att.created_at
                }))
            );

            res.status(200).json({
                success: true,
                data: attachmentsWithUrls
            });
        } catch (error) {
            TicketAttachmentController.handleError(error, res);
        }
    }

    /**
     * DELETE /api/admin/tickets/attachments/:id
     * Delete an attachment (admin only)
     */
    static async deleteAttachment(req: Request, res: Response): Promise<void> {
        try {
            const attachmentId = req.params.id;
            const userId = req.auth!.user.id;
            const role = req.auth!.role as ActorRole;

            await TicketAttachmentController.attachmentService.deleteAttachment(attachmentId, userId, role);

            res.status(200).json({
                success: true,
                message: 'Attachment deleted successfully'
            });
        } catch (error) {
            TicketAttachmentController.handleError(error, res);
        }
    }

    /**
     * Centralized error handler
     */
    private static handleError(error: any, res: Response): void {
        if (error instanceof AppError) {
            res.status(error.statusCode).json({
                success: false,
                error: error.message,
                code: error.code
            });
            return;
        }

        console.error('Unexpected error:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error'
        });
    }
}
