import { Router } from 'express';
import { requireAuth, requireRole } from '../../../api/middlewares/auth.middleware';
import { uploadDigitalAsset } from '../../../api/middlewares/upload.middleware';
import { TicketController } from '../controllers/ticket.controller';
import { TicketNoteController } from '../controllers/ticket-note.controller';
import { TicketAttachmentController } from '../controllers/ticket-attachment.controller';

/**
 * Customer Ticket Routes
 * 
 * Path: /api/customer/tickets
 * 
 * Note: Customers can only create PUBLIC notes
 */

const router = Router();

router.use(requireAuth);
router.use(requireRole(['customer']));

// Ticket Management
router.post('/', TicketController.createTicket);
router.get('/', TicketController.listTickets);
router.get('/:id', TicketController.getTicketDetails);
router.patch('/:id', TicketController.updateTicket);
router.patch('/:id/status', TicketController.updateStatus);
router.post('/:id/close', TicketController.closeTicket);

// Notes (customers can only create public notes - enforced in service)
router.post('/:ticketId/notes', TicketNoteController.createNote);
router.get('/:ticketId/notes', TicketNoteController.listNotes);

// Attachments
router.post('/:ticketId/attachments', uploadDigitalAsset.single('file'), TicketAttachmentController.uploadAttachment);
router.get('/:ticketId/attachments', TicketAttachmentController.listAttachments);

export default router;
