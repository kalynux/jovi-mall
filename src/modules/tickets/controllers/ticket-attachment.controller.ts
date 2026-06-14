import { Request, Response } from 'express';
import { TicketAttachmentService } from '../services/ticket-attachment.service';
import { TicketEnrichmentService } from '../services/ticket-enrichment.service';
import { AttachFileSchema } from '../validators/ticket-attachment.validator';
import { ActorRole } from '../types/ticket.types';
import { asyncHandler } from '../../../api/middlewares/async-handler';

const attachmentService = new TicketAttachmentService();
const enrichmentService = new TicketEnrichmentService();

export class TicketAttachmentController {

    static attachFile = asyncHandler(async (req: Request, res: Response) => {
        const ticketId = req.params.ticketId;
        const userId = req.auth!.user.id;
        const role = req.auth!.role as ActorRole;
        const actorEntityId = req.auth!.role_entity?._id?.toString() ?? req.auth!.role_entity?.id;

        const { fileId, visibility, visibleToUserIds } = AttachFileSchema.parse(req.body);

        const attachment = await attachmentService.attachFile(
            ticketId, fileId, userId, role, actorEntityId, visibility, visibleToUserIds
        );

        const url = await attachmentService.getAttachmentUrl(attachment);

        const [enriched] = await enrichmentService.enrichAttachments([{
            id: attachment.id,
            fileName: attachment.file_name,
            fileSize: attachment.file_size,
            mimeType: attachment.mime_type,
            url,
            uploadedBy: attachment.uploaded_by_user_id,
            uploadedByRole: attachment.uploaded_by_role,
            createdAt: attachment.createdAt
        }]);

        res.status(201).json({ success: true, data: enriched });
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

        const enriched = await enrichmentService.enrichAttachments(attachmentsWithUrls);
        res.status(200).json({ success: true, data: enriched });
    });

    static deleteAttachment = asyncHandler(async (req: Request, res: Response) => {
        const attachmentId = req.params.id;
        const userId = req.auth!.user.id;
        const role = req.auth!.role as ActorRole;

        await attachmentService.deleteAttachment(attachmentId, userId, role);

        res.status(200).json({ success: true, message: 'Attachment deleted successfully' });
    });
}
