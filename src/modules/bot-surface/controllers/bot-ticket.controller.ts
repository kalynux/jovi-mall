import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { sendSuccess } from '../../../core/responses';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { TicketService } from '../../tickets/services/ticket.service';
import { TicketNoteService } from '../../tickets/services/ticket-note.service';
import { TicketFollowerService } from '../../tickets/services/ticket-follower.service';
import { TicketEnrichmentService } from '../../tickets/services/ticket-enrichment.service';
import {
    ActorRole,
    EntityType,
    NoteVisibility,
    TicketImportance,
    TicketStatus,
    TicketType,
} from '../../tickets/types/ticket.types';
import { botCallerOf } from '../middlewares/bot-identity.middleware';
import {
    BotNoArgsSchema,
    BotTicketCreateSchema,
    BotTicketListSchema,
    BotTicketNoteSchema,
    BotTicketParamSchema,
} from '../validators/bot.validators';

const ticketService = new TicketService();
const noteService = new TicketNoteService();
const followerService = new TicketFollowerService();
const enrichmentService = new TicketEnrichmentService();

/**
 * Support tickets, from a chat.
 *
 * ── THE ACTOR IS ALWAYS `customer`, AND IT COMES FROM THE MOUNT ─────────────
 * The customer ticket router derives `role` from `req.auth.role`, which is `customer`
 * because of `requireRole(['customer'])` above it. This surface has no `req.auth`, so the
 * role is the literal `ActorRole.CUSTOMER` — the same value, reached the same way it is on
 * every other mount in the ticket module: from where the request came in, never from what
 * it said.
 *
 * ⚠ **A customer cannot create an INTERNAL note**, here as anywhere. The customer API's
 * schema accepts a `visibility` and the service refuses a private one from a non-admin;
 * this surface does not offer the field at all, which is the same answer arrived at one
 * step earlier.
 *
 * ⚠ **`ticket_number` does not exist.** The catalogue's `important_fields` name it for
 * three of these tools and `api-doc/{customer,agent}/tickets.md` show it in their example
 * bodies — but `TicketSchema` has no such path and no code in `src/` writes one, verified
 * by source scan. It is a documentation defect inherited by the catalogue, not a field
 * this surface declined to project. Tickets are addressed by `_id`, and
 * `api-doc/n8n/bot-surface.md` records the finding.
 */
export class BotTicketController {
    /**
     * `POST /tickets/list` — the sender's own tickets.
     *
     * ⚠ Answers `{ success, data, pagination }`, not `meta`. That is the ticket module's
     * existing shape on every role's mount, and the catalogue tells callers to read both
     * keys because of it. Renaming it here to match the rest of the surface would make the
     * bot the one door that disagrees with `api-doc/customer/tickets.md`.
     */
    static list = asyncHandler(async (req: Request, res: Response) => {
        const query = BotTicketListSchema.parse(req.body ?? {});
        const caller = botCallerOf(req);

        const result = await ticketService.listTicketsForUser(
            caller.userId,
            ActorRole.CUSTOMER,
            query.status ? { status: query.status as TicketStatus } : {},
            { page: query.page, limit: query.limit },
        );

        const enriched = await enrichmentService.enrichTickets(result.data);
        res.status(200).json({ success: true, data: enriched, pagination: result.pagination });
    });

    /**
     * `POST /tickets/:ticketId` — one ticket in detail.
     *
     * Access is the follower check the customer API applies, not an ownership field:
     * `TICKET_ACCESS_DENIED` for a ticket the sender is not on. Reproduced rather than
     * reached, because the service exposes the pieces and not the composite — and
     * reproducing it is what keeps a bot request from seeing a ticket a browser could not.
     */
    static get = asyncHandler(async (req: Request, res: Response) => {
        const { ticketId } = BotTicketParamSchema.parse(req.params);
        BotNoArgsSchema.parse(req.body ?? {});
        const caller = botCallerOf(req);

        const ticket = await ticketService.getTicketById(ticketId);
        if (!ticket) throw createAppError(ERROR_CODES.TICKET_NOT_FOUND, 404);

        const isFollower = await followerService.isFollower(ticketId, caller.userId);
        if (!isFollower) {
            throw createAppError(ERROR_CODES.TICKET_ACCESS_DENIED, 403, 'Access denied to this ticket');
        }

        const enriched = await enrichmentService.enrichTicket(ticket);
        sendSuccess(res, enriched);
    });

    /**
     * `POST /tickets` — open a ticket.
     *
     * ⚠ **Not idempotent underneath** — a retry opens a second ticket, and support then has
     * two records of one problem. `botIdempotency` is what makes the retry safe; there is
     * nothing in the ticket service that would.
     *
     * `entityType` defaults to `OTHER` anchored to the customer's own id, exactly as
     * `TicketController.createTicket` does for a general question. That is not a fallback
     * so much as the honest answer: a chat about a policy or a price has no related entity,
     * and the polymorphic reference has to point somewhere.
     */
    static create = asyncHandler(async (req: Request, res: Response) => {
        const input = BotTicketCreateSchema.parse(req.body ?? {});
        const caller = botCallerOf(req);

        const ticket = await ticketService.createTicket({
            subject: input.subject,
            description: input.description,
            type: input.type as TicketType,
            importance: input.importance as TicketImportance,
            entityType: (input.entityType ?? EntityType.OTHER) as EntityType,
            entityId: input.entityId ?? caller.customerId,
            createdByUserId: caller.userId,
            createdByRole: ActorRole.CUSTOMER,
            createdByEntityId: caller.customerId,
            createdByAdmin: null,
        });

        const enriched = await enrichmentService.enrichTicket(ticket);
        sendSuccess(res, enriched, { status: 201 });
    });

    /**
     * `POST /tickets/:ticketId/notes` — reply on a ticket.
     *
     * `PUBLIC` is hardcoded rather than accepted: a customer has no legitimate use for an
     * internal note, and the field's only effect here would be to give a caller a chance to
     * ask for one and be refused.
     *
     * `body` on the wire, `content` on the service — the catalogue's name wins at the door
     * and is translated here, in one place.
     */
    static addNote = asyncHandler(async (req: Request, res: Response) => {
        const { ticketId } = BotTicketParamSchema.parse(req.params);
        const { body } = BotTicketNoteSchema.parse(req.body ?? {});
        const caller = botCallerOf(req);

        const note = await noteService.createNote(
            ticketId,
            body,
            caller.userId,
            ActorRole.CUSTOMER,
            NoteVisibility.PUBLIC,
        );

        const [enriched] = await enrichmentService.enrichNotes([note]);
        sendSuccess(res, enriched, { status: 201 });
    });

    /**
     * `POST /tickets/:ticketId/close` — the customer says they are done.
     *
     * The service refuses anyone but the creator or an administrator, which is the check
     * that matters and is left where it is.
     */
    static close = asyncHandler(async (req: Request, res: Response) => {
        const { ticketId } = BotTicketParamSchema.parse(req.params);
        BotNoArgsSchema.parse(req.body ?? {});
        const caller = botCallerOf(req);

        const ticket = await ticketService.closeTicket(ticketId, caller.userId, ActorRole.CUSTOMER);
        sendSuccess(res, ticket);
    });
}
