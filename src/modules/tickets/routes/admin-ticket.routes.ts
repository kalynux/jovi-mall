import { Router, RequestHandler } from 'express';
import { TicketController } from '../controllers/ticket.controller';
import { TicketNoteController } from '../controllers/ticket-note.controller';
import { TicketAttachmentController } from '../controllers/ticket-attachment.controller';
import { TicketReferenceController } from '../controllers/ticket-reference.controller';

/**
 * The ticket surface the **wi-admin** backend calls, at `/api/internal/admin/tickets`.
 *
 * ── There is no public twin, and that is the change ───────────────────────────
 * Every other ported domain kept its `/api/admin/*` mount alive until cutover. This one
 * could not: the only admin access control the old mount had was the `assigned_admin_id`
 * exclusivity lock, and that lock is gone — it was auto-set on an administrator's first
 * action and then answered 403 to everybody else, Developers included, which is the exact
 * inverse of the tier model wi-admin enforces. Leaving the mount running without it would
 * have left a second admin ticket surface with **no** access rules at all, reachable by any
 * platform `users` row holding the legacy `admin` role.
 *
 * It also could not have been fixed in place: the tier rules need an administrator's TIER,
 * and a legacy admin is a platform user who has none.
 *
 * ── This file enforces authentication, not authorization ──────────────────────
 * `requireAdminCaller` proves the caller is wi-admin. WHICH administrator may do WHAT — the
 * tier matrix, the read scope, who may hand a ticket to whom — is resolved in wi-admin
 * against the administrator records only it holds, before the call is made. That is the
 * same single-sided trust the COD, agents and vendors routers already run on: the service
 * token is a full-privilege credential, so a second opinion computed here would be theatre.
 *
 * ── Route order ──────────────────────────────────────────────────────────────
 * `/reference/*` and `/attachments/:id` are literals that would otherwise be read as an
 * `:id`, so they are declared before the parameterised routes. Keep it that way.
 *
 * @param guards run before every route — `[requireAdminCaller]` in practice. A parameter
 *        rather than a `router.use`, matching `buildAdminCodRouter` and its siblings: a
 *        Router instance cannot be mounted twice without its guards re-running.
 */
export function buildAdminTicketRouter(guards: RequestHandler[]): Router {
    const router = Router();

    router.use(...guards);

    // ── Reference lookups for the ticket-creation form ───────────────────────
    // Declared before `/:id`.
    router.get('/reference/orders', TicketReferenceController.listOrders);
    router.get('/reference/products', TicketReferenceController.listProducts);

    // ── Attachments by their own id — literal, so before `/:ticketId/...` ────
    router.delete('/attachments/:id', TicketAttachmentController.deleteAttachment);

    // ── Tickets ──────────────────────────────────────────────────────────────
    router.post('/', TicketController.createTicket);
    router.get('/', TicketController.listTickets);
    router.get('/:id', TicketController.getTicketDetails);
    router.patch('/:id', TicketController.updateTicket);
    router.patch('/:id/status', TicketController.updateStatus);
    router.patch('/:id/priority', TicketController.updatePriority);
    router.post('/:id/close', TicketController.closeTicket);
    router.post('/:id/reopen', TicketController.reopenTicket);

    /**
     * Assignment — an administrator, not a platform actor.
     *
     * `PATCH /:id/assign` on the old mount named its target with a `users` id. An
     * administrator has no `users` row, so this takes the wi-admin id plus the profile
     * snapshot that makes the person renderable to a ticket follower. See
     * `TicketService.assignToAdministrator`.
     */
    router.patch('/:id/assign', TicketController.assignToAdministrator);

    /**
     * Re-stamp the assignee's profile without changing the assignee.
     *
     * Separate from `/assign` on purpose — see the controller. wi-admin calls this on every
     * mutation, so the snapshot a customer reads never goes stale behind a rename.
     */
    router.patch('/:id/admin-snapshot', TicketController.refreshAdminSnapshot);

    // ── Followers ────────────────────────────────────────────────────────────
    router.post('/:id/followers', TicketController.addFollower);
    router.delete('/:id/followers/:userId', TicketController.removeFollower);

    // ── Notes ────────────────────────────────────────────────────────────────
    router.post('/:ticketId/notes', TicketNoteController.createNote);
    router.get('/:ticketId/notes', TicketNoteController.listNotes);

    // ── Attachments ──────────────────────────────────────────────────────────
    router.post('/:ticketId/attachments', TicketAttachmentController.attachFile);
    router.get('/:ticketId/attachments', TicketAttachmentController.listAttachments);

    return router;
}
