import { Router } from 'express';
import { requireAuth, requireRole } from '../../../api/middlewares/auth.middleware';
import { uploadDigitalAsset } from '../../../api/middlewares/upload.middleware';
import { TicketController } from '../controllers/ticket.controller';
import { TicketNoteController } from '../controllers/ticket-note.controller';
import { TicketAttachmentController } from '../controllers/ticket-attachment.controller';

/**
 * Vendor Ticket Routes
 * 
 * Path: /api/vendor/tickets
 */

const router = Router();

router.use(requireAuth);
router.use(requireRole(['vendor']));

// Ticket Management
router.post('/', TicketController.createTicket);
router.get('/', TicketController.listTickets);
router.get('/:id', TicketController.getTicketDetails);
router.patch('/:id', TicketController.updateTicket);
router.patch('/:id/status', TicketController.updateStatus);
router.patch('/:id/assign', TicketController.assignTicket);
router.patch('/:id/priority', TicketController.updatePriority);
router.post('/:id/close', TicketController.closeTicket);

// Notes
router.post('/:ticketId/notes', TicketNoteController.createNote);
router.get('/:ticketId/notes', TicketNoteController.listNotes);

// Attachments
router.post('/:ticketId/attachments', uploadDigitalAsset.single('file'), TicketAttachmentController.uploadAttachment);
router.get('/:ticketId/attachments', TicketAttachmentController.listAttachments);

export default router;
