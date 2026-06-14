import { Router } from 'express';
import { requireAuth, requireRole } from '../../../api/middlewares/auth.middleware';
import { TicketController } from '../controllers/ticket.controller';
import { TicketNoteController } from '../controllers/ticket-note.controller';
import { TicketAttachmentController } from '../controllers/ticket-attachment.controller';

/**
 * Admin Ticket Routes
 * 
 * Path: /api/admin/tickets
 * 
 * Admin-specific operations:
 * - Reopen closed tickets
 * - Remove followers
 * - Delete attachments
 * - Full access to all tickets (unless admin exclusivity active)
 */

const router = Router();

// Apply authentication and role restriction
router.use(requireAuth);
router.use(requireRole(['admin']));

// ==========================================
// TICKET MANAGEMENT
// ==========================================

/**
 * POST /api/admin/tickets
 * Create a ticket as admin
 */
router.post('/', TicketController.createTicket);

/**
 * GET /api/admin/tickets
 * List tickets with filters and pagination
 */
router.get('/', TicketController.listTickets);

/**
 * GET /api/admin/tickets/:id
 * Get ticket details
 */
router.get('/:id', TicketController.getTicketDetails);

/**
 * PATCH /api/admin/tickets/:id
 * Update ticket (subject, description)
 */
router.patch('/:id', TicketController.updateTicket);

/**
 * PATCH /api/admin/tickets/:id/status
 * Update ticket status
 */
router.patch('/:id/status', TicketController.updateStatus);

/**
 * PATCH /api/admin/tickets/:id/assign
 * Assign ticket
 */
router.patch('/:id/assign', TicketController.assignTicket);

/**
 * PATCH /api/admin/tickets/:id/priority
 * Update priority (and lock it permanently)
 */
router.patch('/:id/priority', TicketController.updatePriority);

/**
 * POST /api/admin/tickets/:id/close
 * Close a ticket
 */
router.post('/:id/close', TicketController.closeTicket);

/**
 * POST /api/admin/tickets/:id/reopen
 * Reopen a closed ticket (admin only)
 */
router.post('/:id/reopen', TicketController.reopenTicket);

// ==========================================
// FOLLOWER MANAGEMENT (Admin Only)
// ==========================================

/**
 * POST /api/admin/tickets/:id/followers
 * Add a follower to a ticket
 */
router.post('/:id/followers', TicketController.addFollower);

/**
 * DELETE /api/admin/tickets/:id/followers/:userId
 * Remove a follower from a ticket
 */
router.delete('/:id/followers/:userId', TicketController.removeFollower);

// ==========================================
// NOTES
// ==========================================

/**
 * POST /api/admin/tickets/:ticketId/notes
 * Create a note (public or private)
 */
router.post('/:ticketId/notes', TicketNoteController.createNote);

/**
 * GET /api/admin/tickets/:ticketId/notes
 * List notes (admins see all notes)
 */
router.get('/:ticketId/notes', TicketNoteController.listNotes);

// ==========================================
// ATTACHMENTS
// ==========================================

/**
 * POST /api/admin/tickets/:ticketId/attachments
 * Attach an already-uploaded file (by fileId) to a ticket
 */
router.post('/:ticketId/attachments', TicketAttachmentController.attachFile);

/**
 * GET /api/admin/tickets/:ticketId/attachments
 * List attachments
 */
router.get('/:ticketId/attachments', TicketAttachmentController.listAttachments);

/**
 * DELETE /api/admin/tickets/attachments/:id
 * Delete an attachment (admin only)
 */
router.delete('/attachments/:id', TicketAttachmentController.deleteAttachment);

export default router;
