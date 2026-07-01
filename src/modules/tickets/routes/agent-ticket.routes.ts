import { Router } from 'express';
import { requireAuth, requireRole } from '../../../api/middlewares/auth.middleware';
import { TicketController } from '../controllers/ticket.controller';
import { TicketNoteController } from '../controllers/ticket-note.controller';
import { TicketAttachmentController } from '../controllers/ticket-attachment.controller';
import { TicketReferenceController } from '../controllers/ticket-reference.controller';

/**
 * Agent Ticket Routes
 * 
 * Path: /api/agent/tickets
 */

const router = Router();

router.use(requireAuth);
router.use(requireRole(['agent']));

// Ticket Management
router.post('/', TicketController.createTicket);
router.get('/', TicketController.listTickets);

// Reference lookups for the ticket-creation form (declared before `/:id`).
router.get('/reference/orders', TicketReferenceController.listOrders);
router.get('/reference/products', TicketReferenceController.listProducts);

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
router.post('/:ticketId/attachments', TicketAttachmentController.attachFile);
router.get('/:ticketId/attachments', TicketAttachmentController.listAttachments);

export default router;
