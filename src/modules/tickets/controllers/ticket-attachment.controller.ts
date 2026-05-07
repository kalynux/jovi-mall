import { Request, Response, NextFunction } from 'express';
import { TicketAttachmentService } from '../services/ticket-attachment.service';
import { ActorRole } from '../types/ticket.types';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';

const attachmentService = new TicketAttachmentService();

export class TicketAttachmentController {

    static uploadAttachment = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
        const ticketId = req.params.ticketId;
        const userId = req.auth!.user.id;
        const role = req.auth!.role as ActorRole;

        if (!req.file) {
            return next(createAppError(ERROR_CODES.TICKET_ATTACHMENT_MISSING, 400));
        }

        const visibility = (req.body.visibility || 'PUBLIC') as 'PUBLIC' | 'PRIVATE';
        const visibleToUserIds = req.body.visibleToUserIds
            ? JSON.parse(req.body.visibleToUserIds)
            : undefined;

        const attachment = await attachmentService.uploadAttachment(
            ticketId, req.file, userId, role, visibility, visibleToUserIds
        );

        const url = await attachmentService.getAttachmentUrl(attachment);

        res.status(201).json({
            success: true,
            data: {
                id: attachment.id,
                fileName: attachment.file_name,
                fileSize: attachment.file_size,
                mimeType: attachment.mime_type,
                url,
                uploadedBy: attachment.uploaded_by_user_id,
                uploadedByRole: attachment.uploaded_by_role,
                createdAt: attachment.createdAt
            }
        });
    });

    static listAttachments = asyncHandler(async (req: Request, res: Response) => {
        const ticketId = req.params.ticketId;
        const userId = req.auth!.user.id;
        const role = req.auth!.role as ActorRole;

        const attachments = await attachmentService.listAttachments(ticketId, userId, role);

        const attachmentsWithUrls = await Promise.all(
            attachments.map(async (att) => ({
                id: att.id,
                fileName: att.file_name,
                fileSize: att.file_size,
                mimeType: att.mime_type,
                url: await attachmentService.getAttachmentUrl(att),
                uploadedBy: att.uploaded_by_user_id,
                uploadedByRole: att.uploaded_by_role,
                createdAt: att.createdAt
            }))
        );

        res.status(200).json({ success: true, data: attachmentsWithUrls });
    });

    static deleteAttachment = asyncHandler(async (req: Request, res: Response) => {
        const attachmentId = req.params.id;
        const userId = req.auth!.user.id;
        const role = req.auth!.role as ActorRole;

        await attachmentService.deleteAttachment(attachmentId, userId, role);

        res.status(200).json({ success: true, message: 'Attachment deleted successfully' });
    });
}
