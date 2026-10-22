import { Router } from 'express';
import { requireAuth, requireRole } from '../../../api/middlewares/auth.middleware';
import { requireVendorKind } from '../../../api/middlewares/vendor-kind.middleware';
import { TicketController } from '../controllers/ticket.controller';
import { TicketNoteController } from '../controllers/ticket-note.controller';
import { TicketAttachmentController } from '../controllers/ticket-attachment.controller';
import { TicketReferenceController } from '../controllers/ticket-reference.controller';

/**
 * Vendor Ticket Routes
 * 
 * Path: /api/vendor/tickets
 */

const router = Router();

router.use(requireAuth);
router.use(requireRole(['vendor']));
// Vendor kind (SERVICE-LISTINGS-PLAN § C-1): BOTH — providers need support too (lead reports, L-31); the order/product reference lookups below are seller-only per route.
router.use(requireVendorKind('both'));

// Ticket Management
router.post('/', TicketController.createTicket);
router.get('/', TicketController.listTickets);

// Reference lookups for the ticket-creation form (declared before `/:id`).
// Seller-only: a provider has no orders or products to reference (L-2). Their tickets about a
// lead are opened from the lead itself (`POST /vendor/leads/:leadId/report`).
router.get('/reference/orders', requireVendorKind('seller'), TicketReferenceController.listOrders);
router.get('/reference/products', requireVendorKind('seller'), TicketReferenceController.listProducts);

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
