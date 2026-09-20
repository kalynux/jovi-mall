import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { sendSuccess } from '../../../core/responses';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { TicketService } from '../../tickets/services/ticket.service';
import { TicketNoteService } from '../../tickets/services/ticket-note.service';
import { TicketFollowerService } from '../../tickets/services/ticket-follower.service';
import {
    TICKET_ATTACHMENT_LIMIT,
    TicketAttachmentService,
} from '../../tickets/services/ticket-attachment.service';
import { TicketEnrichmentService } from '../../tickets/services/ticket-enrichment.service';
import {
    ActorRole,
    EntityType,
    NoteVisibility,
    TicketImportance,
    TicketStatus,
    TicketType,
} from '../../tickets/types/ticket.types';
import { botCallerOf, botResponseLanguageOf } from '../middlewares/bot-identity.middleware';
import { setBotReply } from '../middlewares/bot-reply.middleware';
import { windowForChat } from '../domain/bot-list-window';
import { inboundFileStore, StoredInboundFile } from '../services/inbound-file.store';
import { toBotTicketAttachmentDto } from '../dto/bot-projections';
import { botChrome } from '../domain/bot-chrome-copy';
import { BotReplyIntent, BotReplyOption } from '../domain/channel-reply';
import { ParsedBotAction, unknownBotAction } from '../domain/bot-action-dispatch';
import { mintConfirmationRef, verifyConfirmationRef } from '../domain/bot-confirmation-ref';
import { openInAppScreen } from './bot-inapp.controller';
import { supportContextService } from '../services/support-context.service';
import {
    attachToTicketActionId,
    parseTicketTap,
    splitConfirmArgument,
    supportFormActionId,
    supportFormWithFileActionId,
    SupportTopicCode,
    ticketCardActionId,
    ticketCloseActionId,
    ticketCloseConfirmActionId,
    ticketCloseDeclineActionId,
    ticketPhotoActionId,
    ticketReplyActionId,
} from '../domain/bot-ticket-actions';
import {
    botTicketCopy,
    botTicketReplyButton,
    botTicketStateLabel,
    ticketAcceptsWriting,
} from '../domain/bot-ticket-copy';
import {
    BotNoArgsSchema,
    BotTicketCreateSchema,
    BotTicketListSchema,
    BotTicketNoteSchema,
    BotTicketAttachmentSchema,
    BotTicketParamSchema,
} from '../validators/bot.validators';

const ticketService = new TicketService();
const noteService = new TicketNoteService();
const followerService = new TicketFollowerService();
const enrichmentService = new TicketEnrichmentService();
const attachmentService = new TicketAttachmentService();

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
 * three of these tools — but `TicketSchema` has no such path and no code in `src/` writes
 * one, verified by source scan. It is a documentation defect inherited by the catalogue,
 * not a field this surface declined to project. The two api-doc pages that showed it were
 * corrected 2026-09-06; the catalogue is the remaining half.
 * `api-doc/n8n/bot-surface.md` records the finding.
 *
 * ⚠ **A ticket is addressed by `id`, NOT `_id`** — this comment used to say `_id`, and that
 * is wrong for `close`. `Ticket` is on `BaseSchemaOptions`, whose `toJSON` deletes `_id` and
 * exposes the `id` virtual. The four enriched responses here carry BOTH, because
 * `TicketEnrichmentService` uses `toObject({ virtuals: true })`, which applies no transform;
 * `close` returns the raw document and carries `id` alone. `id` is the only identifier
 * present on all five.
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
        await listOwnRequests(req, res, BotTicketListSchema.parse(req.body ?? {}));
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
        await showRequestCard(req, res, ticketId);
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

    /**
     * `POST /tickets/:ticketId/attachments` — put a file the customer sent onto a ticket.
     *
     * ── THE MODEL NAMES A HANDLE, NEVER A FILE ──────────────────────────────
     * The bytes arrived on `/files/inbound`, which stored them and answered with a
     * thirty-minute, owner-scoped, single-use `ref`. That is the only thing this accepts.
     * A `fileId` here would let a caller attach any file the customer has ever uploaded to
     * any ticket they follow, and nothing downstream would find it odd.
     *
     * ── ACCESS IS THE FOLLOWER CHECK, REPRODUCED ────────────────────────────
     * The same one `get` above applies, and for the same reason: the service exposes the
     * pieces and not the composite, and reproducing it is what keeps a bot request from
     * writing to a ticket a browser could not read. **It runs BEFORE the handle is spent** —
     * a wrong ticket id must not also cost the customer their photo.
     */
    static addAttachment = asyncHandler(async (req: Request, res: Response) => {
        const { ticketId } = BotTicketParamSchema.parse(req.params);
        const { ref } = BotTicketAttachmentSchema.parse(req.body ?? {});
        // No reply: a tool call is the model's, and the model says what it did.
        await attachInboundFile(req, res, ticketId, ref, { speak: false });
    });
}

// ─────────────────────────────────────────────────────────────────────────────
//  The work a route and a tap share
//
//  Every function below is reached BOTH from a tool call above and from a button in
//  `SUPPORT_ACTION_HANDLERS`. The route parses, the tap validates its token, and the work happens
//  once — the rule `bot-order.controller.ts` follows for the same reason: two copies of "may this
//  customer write to this request" is one copy that eventually forgets the follower check.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The request, if the sender is on it.
 *
 * ⚠ **The follower check, reproduced — and it is the whole access rule.** `TicketService` exposes the
 * pieces rather than the composite, so both doors ask it here: a bot request must never see or write
 * to a request a browser could not. Extracted because it was written twice and the second copy is the
 * one that goes stale.
 */
async function loadOwnRequest(
    ticketId: string,
    userId: string,
): Promise<NonNullable<Awaited<ReturnType<TicketService['getTicketById']>>>> {
    const ticket = await ticketService.getTicketById(ticketId);
    if (!ticket) throw createAppError(ERROR_CODES.TICKET_NOT_FOUND, 404);

    const isFollower = await followerService.isFollower(ticketId, userId);
    if (!isFollower) {
        throw createAppError(ERROR_CODES.TICKET_ACCESS_DENIED, 403, 'Access denied to this ticket');
    }

    return ticket;
}

/** The sender's own requests, as a picker — for `POST /tickets/list` and `tkt:list`. */
async function listOwnRequests(
    req: Request,
    res: Response,
    query: { status?: string; page: number; limit: number },
): Promise<void> {
    const caller = botCallerOf(req);
    const language = botResponseLanguageOf(req);

    const result = await ticketService.listTicketsForUser(
        caller.userId,
        ActorRole.CUSTOMER,
        query.status ? { status: query.status as TicketStatus } : {},
        { page: query.page, limit: query.limit },
    );

    const enriched = await enrichmentService.enrichTickets(result.data);

    const chat = windowForChat({
        items: enriched,
        total: result.pagination.total,
        offset: (query.page - 1) * query.limit,
        surface: 'tickets',
        language,
    });

    setBotReply(req, requestListReply(chat.items, query.status, language));

    /**
     * ⚠ **`pagination` STAYS, and `meta` is ADDED beside it rather than replacing it.**
     *
     * The three ticket tools answering `{ success, data, pagination }` instead of `meta` is a
     * deliberate, documented deviation — it is the ticket module's shape on every role's mount, and
     * `bot-surface.md` § 6 promises it. Renaming the key here would silently break a caller reading
     * the documented field.
     *
     * But a client should not have to know which lists put their window under which key, so the
     * window goes under `meta` exactly as it does on every other list. Both are present, `data` is
     * untouched, and nothing that reads either one breaks.
     */
    res.status(200).json({
        success: true,
        data: chat.items,
        pagination: result.pagination,
        meta: chat.window,
    });
}

/** One request in detail — for `POST /tickets/:ticketId`, `tkt:<id>` and every "back to it" path. */
async function showRequestCard(req: Request, res: Response, ticketId: string): Promise<void> {
    const caller = botCallerOf(req);
    const language = botResponseLanguageOf(req);

    const ticket = await loadOwnRequest(ticketId, caller.userId);

    /**
     * ⚠ **The notes come from the service's own visibility filter**, never from a hand-written
     * query: `listNotes` decides what a customer may read, and an internal note is exactly the thing
     * that must not reach a chat window.
     */
    const notes = await noteService.listNotes(ticketId, caller.userId, ActorRole.CUSTOMER);

    setBotReply(req, requestCardReply(asRow(ticket), notes.map(asRow), caller.userId, language));

    const enriched = await enrichmentService.enrichTicket(ticket);
    sendSuccess(res, enriched);
}

/** Close it — for `POST /tickets/:ticketId/close` and the confirmed `yes:tcl` tap. */
async function closeOwnRequest(
    req: Request,
    res: Response,
    ticketId: string,
    options: { speak: boolean },
): Promise<void> {
    const caller = botCallerOf(req);

    /**
     * ⚠ **The service refuses anyone but the creator or an administrator**, which is the check that
     * matters and is left where it is. This adds only the sentence the customer reads.
     */
    const ticket = await ticketService.closeTicket(ticketId, caller.userId, ActorRole.CUSTOMER);

    if (options.speak) {
        setBotReply(req, {
            kind: 'text',
            text: botTicketCopy('ticketClosed', botResponseLanguageOf(req)),
        });
    }

    sendSuccess(res, ticket);
}

/**
 * Put a file the customer sent onto a request — for the tool call and for a "which request?" row.
 *
 * ── THE ORDER OF THE WORK IS THE PROTECTION ─────────────────────────────────
 * The follower check runs BEFORE the handle is spent, so a wrong request id does not also cost the
 * customer their photo; and a failed attach puts the handle back, so the five-per-request limit does
 * not turn into "…and now send the photo again" for a file sitting in storage, correct and unused.
 */
async function attachInboundFile(
    req: Request,
    res: Response,
    ticketId: string,
    ref: string,
    options: { speak: boolean },
): Promise<void> {
    const caller = botCallerOf(req);

    await loadOwnRequest(ticketId, caller.userId);

    const file = await inboundFileStore.consume(caller.userId, ref);
    if (!file) throw createAppError(ERROR_CODES.BOT_INBOUND_FILE_EXPIRED, 404);

    const attachment = await attachOrRestore(ticketId, ref, file, caller);

    const count = await attachmentService.getAttachmentCount(ticketId);

    if (options.speak) {
        setBotReply(req, {
            kind: 'text',
            text: botTicketCopy('fileAttached', botResponseLanguageOf(req)),
        });
    }

    sendSuccess(
        res,
        toBotTicketAttachmentDto(attachment, { count, limit: TICKET_ATTACHMENT_LIMIT }),
        { status: 201 },
    );
}

async function attachOrRestore(
    ticketId: string,
    ref: string,
    file: StoredInboundFile,
    caller: { userId: string; customerId: string },
): Promise<Awaited<ReturnType<TicketAttachmentService['attachFile']>>> {
    try {
        return await attachmentService.attachFile(
            ticketId,
            file.fileId,
            caller.userId,
            // From the MOUNT, never from the body — the same rule the rest of this controller
            // follows. `customerId` is the actor entity the file's `ownerId` was stamped with at
            // intake, so the service's ownership check passes by construction rather than by luck.
            ActorRole.CUSTOMER,
            caller.customerId,
            // PUBLIC is hardcoded, as `addNote` hardcodes its visibility. A customer has no use for
            // an attachment support cannot see, and offering the field would only give a caller a
            // chance to ask for one and be refused.
            'PUBLIC',
        );
    } catch (error) {
        /**
         * ⚠ **Put the handle back**, byte for byte. Only the caller that WON `consume` reaches this,
         * so a concurrent second attempt has already been refused, and `restore` is best-effort so a
         * Redis failure cannot replace the real error with its own.
         */
        await inboundFileStore.restore(caller.userId, ref, file);
        throw error;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Rendering — what a customer sees of a support request
// ─────────────────────────────────────────────────────────────────────────────

/** How much of one reply a card shows before it becomes a wall of text. */
const REPLY_EXCERPT = 160;

const textOf = (value: unknown): string => (typeof value === 'string' ? value : '');

/** An id, from a document or from an enriched projection, both of which carry `id` and `_id`. */
const idOf = (row: Record<string, unknown>): string => textOf(row.id) || String(row._id ?? '');

/**
 * The list of requests as a picker, or a way in when there are none.
 *
 * ⚠ **The empty state speaks ONLY for an unfiltered list.** A model asking for "my resolved requests"
 * and getting none must not be told "you have no support requests yet" — that is a different
 * sentence, about a different thing, and it is the model's to word. So a filtered empty answer sets no
 * reply and hands the turn back.
 */
function requestListReply(
    items: ReadonlyArray<Record<string, unknown>>,
    statusFilter: string | undefined,
    language: string | null,
): BotReplyIntent | null {
    if (items.length === 0) {
        return statusFilter
            ? null
            : {
                  kind: 'text',
                  text: botTicketCopy('noTickets', language),
                  actions: [
                      {
                          id: supportFormActionId(),
                          label: botTicketCopy('newRequestRow', language),
                      },
                  ],
              };
    }

    return {
        kind: 'choice',
        text: botTicketCopy('whichTicket', language),
        options: [
            ...items.map((ticket) => requestRow(ticket, language)),
            {
                id: supportFormActionId(),
                label: botTicketCopy('newRequestRow', language),
                shortLabel: botTicketCopy('newRequestRow', language),
            },
        ],
        listButton: botChrome('chooseListButton', language),
        sectionTitle: botChrome('chooseSectionTitle', language),
    };
}

/**
 * One request as a row.
 *
 * ⚠ **The subject is the title and the STATE is the description**, which is the atlas's own wording
 * for this row — a customer picking between requests recognises them by what they are about, and
 * needs the state to know which one is waiting on them. A WhatsApp row title holds 24 characters, so
 * `shortLabel` carries the subject alone while Telegram gets the whole line.
 */
function requestRow(ticket: Record<string, unknown>, language: string | null): BotReplyOption {
    const subject = textOf(ticket.subject) || botTicketCopy('newRequestRow', language);
    const state = botTicketStateLabel(textOf(ticket.status), language);

    return {
        id: ticketCardActionId(idOf(ticket)),
        label: `${subject} · ${state}`,
        shortLabel: subject,
        description: state,
    };
}

/**
 * The request card: what it is about, where it has got to, the last few replies, and what can be
 * done to it.
 *
 * ⚠ **Exactly three actions, which is WhatsApp's hard cap**, and they are drawn only while the
 * request accepts writing. A closed request shows its history and nothing to press: the service
 * refuses a note on it, and a button that always refuses teaches a customer to stop reading the card.
 */
function requestCardReply(
    ticket: Record<string, unknown>,
    notes: ReadonlyArray<Record<string, unknown>>,
    viewerUserId: string,
    language: string | null,
): BotReplyIntent {
    const status = textOf(ticket.status);
    const head = `${textOf(ticket.subject)}\n${botTicketStateLabel(status, language)}`;
    const text = `${head}\n\n${replyLines(notes, viewerUserId, language)}`;

    if (!ticketAcceptsWriting(status)) return { kind: 'text', text };

    const ticketId = idOf(ticket);
    return {
        kind: 'text',
        text,
        actions: [
            { id: ticketReplyActionId(ticketId), label: botTicketReplyButton(status, language) },
            { id: ticketPhotoActionId(ticketId), label: botTicketCopy('attachPhotoButton', language) },
            { id: ticketCloseActionId(ticketId), label: botTicketCopy('closeTicketButton', language) },
        ],
    };
}

/**
 * The last three replies, oldest first, each said to be the customer's or support's.
 *
 * ⚠ **"Support" is deliberately not a staff member's name.** The notes carry an author id and the
 * enrichment service can resolve it to a person; naming an individual in a chat window makes them the
 * customer's contact for a request that belongs to a queue.
 */
function replyLines(
    notes: ReadonlyArray<Record<string, unknown>>,
    viewerUserId: string,
    language: string | null,
): string {
    if (notes.length === 0) return botTicketCopy('noRepliesYet', language);

    return notes
        .slice(-3)
        .map((note) => {
            const mine = String(note.author_user_id ?? '') === viewerUserId;
            const who = botTicketCopy(mine ? 'authorYou' : 'authorSupport', language);
            const body = textOf(note.content).trim();
            const said = body.length > REPLY_EXCERPT ? `${body.slice(0, REPLY_EXCERPT - 1)}…` : body;
            return `${who}: ${said}`;
        })
        .join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
//  Taps — registered by this stream's map in `bot-order.controller.ts`
//
//  ⚠ **Every handler THROWS and never calls `next`**, and none of them awaits another route's
//  `asyncHandler`-wrapped static: that resolves before the work finishes and its own `.catch(next)`
//  swallows the error, so the customer gets silence. The dispatch contract states it; this is where
//  it has to hold.
// ─────────────────────────────────────────────────────────────────────────────

/** `tkt:…` — every support button on this surface, told apart by `parseTicketTap`. */
export async function ticketTap(req: Request, res: Response, action: ParsedBotAction): Promise<void> {
    const tap = parseTicketTap(action.argument);
    if (!tap) throw unknownBotAction();

    switch (tap.kind) {
        case 'list':
            // The schema's own defaults, so the chat list and the tool agree on how many rows.
            await listOwnRequests(req, res, BotTicketListSchema.parse({}));
            return;
        case 'show':
            await showRequestCard(req, res, tap.ticketId);
            return;
        case 'reply':
            await askForReply(req, res, tap.ticketId);
            return;
        case 'photo':
            await askForPhoto(req, res, tap.ticketId);
            return;
        case 'close':
            await askToClose(req, res, tap.ticketId);
            return;
        case 'attach':
            await attachInboundFile(req, res, tap.ticketId, tap.attachmentRef, { speak: true });
            return;
        case 'new':
            await openSupportForm(req, res, tap);
            return;
    }
}

/**
 * `tkt:<id>:rp` — Reply, or Reply here.
 *
 * ⚠ **It writes nothing and sets NO reply, and both halves are the design.** Chat is stateless
 * between turns, so the customer's next message can only be filed by the assistant — which needs to
 * know that a reply is expected and for which request. So this answers with the request as `data` and
 * hands the turn over; the assistant asks for the words and files them with `tickets_add_note`.
 * ⛔ Until n8n passes a no-reply tap's data to the assistant, this tap reaches it with nothing.
 */
async function askForReply(req: Request, res: Response, ticketId: string): Promise<void> {
    const caller = botCallerOf(req);
    const ticket = asRow(await loadOwnRequest(ticketId, caller.userId));
    const status = textOf(ticket.status);

    /**
     * ⚠ **A stale button on a closed request shows the request rather than refusing.** The card is
     * the honest answer: it carries the closed state, the history, and no buttons — where a refusal
     * would only say no.
     */
    if (!ticketAcceptsWriting(status)) {
        await showRequestCard(req, res, ticketId);
        return;
    }

    setBotReply(req, null);
    sendSuccess(res, {
        ticketId,
        subject: textOf(ticket.subject),
        status,
        awaitingReply: true,
    });
}

/**
 * `tkt:<id>:ph` — Attach photo.
 *
 * ⚠ **It only asks.** The file arrives as its own inbound message, and `/files/inbound` answers that
 * with "which request is this for?" — which is where attaching happens, because a photo can arrive
 * minutes later or never.
 */
async function askForPhoto(req: Request, res: Response, ticketId: string): Promise<void> {
    const caller = botCallerOf(req);
    const ticket = asRow(await loadOwnRequest(ticketId, caller.userId));

    if (!ticketAcceptsWriting(textOf(ticket.status))) {
        await showRequestCard(req, res, ticketId);
        return;
    }

    setBotReply(req, {
        kind: 'text',
        text: botTicketCopy('sendPhotoPrompt', botResponseLanguageOf(req)),
    });
    sendSuccess(res, { ticketId, awaitingPhoto: true });
}

/**
 * `tkt:<id>:cl` — the are-you-sure before closing.
 *
 * ⚠ **It closes nothing.** The confirm carries a signed, ten-minute reference scoped to this request,
 * so a button scrolled past three weeks later cannot close anything; the decline carries none,
 * because declining is always safe. This is also the re-ask path for a stale confirmation.
 */
async function askToClose(req: Request, res: Response, ticketId: string): Promise<void> {
    const caller = botCallerOf(req);
    const language = botResponseLanguageOf(req);
    const ticket = asRow(await loadOwnRequest(ticketId, caller.userId));

    if (!ticketAcceptsWriting(textOf(ticket.status))) {
        await showRequestCard(req, res, ticketId);
        return;
    }

    const ref = mintConfirmationRef(
        'ticket-close',
        { userId: caller.userId, channel: caller.channel },
        ticketId,
    );

    setBotReply(req, {
        kind: 'choice',
        text: botTicketCopy('closeTicketPrompt', language),
        options: [
            { id: ticketCloseConfirmActionId(ticketId, ref), label: botChrome('confirmButton', language) },
            { id: ticketCloseDeclineActionId(ticketId), label: botChrome('declineButton', language) },
        ],
        listButton: botChrome('chooseListButton', language),
        sectionTitle: botChrome('chooseSectionTitle', language),
    });

    sendSuccess(res, { ticketId, awaitingConfirmation: true });
}

/**
 * `yes:tcl:<ticketId>:<ref>` — close it.
 *
 * ⚠ **A stale or unverifiable reference ASKS AGAIN rather than refusing**, exactly as the account
 * stream's close does: the customer who tapped is this conversation's own account, and they could get
 * a fresh confirm by asking — so re-stating what the tap would do is that, one step shorter.
 * The reference is verified against the SAME scope it was minted with, the request's own id, so a
 * confirmation for one request can never close another.
 */
export async function confirmTicketCloseTap(
    req: Request,
    res: Response,
    action: ParsedBotAction,
): Promise<void> {
    const split = splitConfirmArgument(action.argument);
    if (!split) throw unknownBotAction();

    const caller = botCallerOf(req);
    const verdict = verifyConfirmationRef(
        split.ref,
        'ticket-close',
        { userId: caller.userId, channel: caller.channel },
        split.id,
    );

    if (verdict !== 'valid') {
        await askToClose(req, res, split.id);
        return;
    }

    await closeOwnRequest(req, res, split.id, { speak: true });
}

/** `no:tcl:<ticketId>` — keep it. Changes nothing, whenever it is tapped. */
export async function declineTicketCloseTap(
    req: Request,
    res: Response,
    action: ParsedBotAction,
): Promise<void> {
    const tap = parseTicketTap(action.argument);
    if (!tap || tap.kind !== 'show') throw unknownBotAction();
    await showRequestCard(req, res, tap.ticketId);
}

/**
 * `tkt:new`, `tkt:new:<att_…>`, `tkt:new:<topic>:<orderId>` — open the one-screen support form.
 *
 * ⚠ **The order is resolved through the SUPPORT LADDER before a session is minted**, and the result
 * is thrown away. It is not a wasted read: it is the ownership and existence check. The ladder
 * refuses an order that is not this customer's, with a sentence they can read, in the chat — where a
 * check deferred to the form's own read would refuse on a web page instead, in English.
 *
 * ⚠ **`fallbackPath` is null, so a deployment with no screen sets NO reply** and the assistant takes
 * the turn with `supportRequest` in its data — which is exactly the behaviour these buttons had
 * before the form existed. `BOT_MINIAPP_BASE_URL` is unset in production, so that is the path running
 * today; the form is the improvement, not the precondition.
 */
async function openSupportForm(
    req: Request,
    res: Response,
    tap: { topic: SupportTopicCode | null; orderId: string | null; attachmentRef: string | null },
): Promise<void> {
    const caller = botCallerOf(req);

    if (tap.orderId) {
        await supportContextService.resolve(caller.customerId, {
            scope: 'auto',
            hintOrderId: tap.orderId,
        });
    }

    const handle = await openInAppScreen(req, {
        payload: {
            kind: 'tf',
            form: { orderId: tap.orderId, topic: tap.topic, attachmentRef: tap.attachmentRef },
        },
        fallbackPath: null,
        labelKey: 'getHelpButton',
        textKey: 'supportFormPrompt',
    });

    sendSuccess(res, {
        handle,
        opened: 'support',
        supportRequest: true,
        topic: tap.topic,
        orderId: tap.orderId,
        attachmentRef: tap.attachmentRef,
    });
}

/**
 * The picker a received file is answered with: the customer's open requests, then a new one.
 *
 * ⚠ **Exported for `bot-file.controller.ts`, and built HERE**, because the rows are request rows and
 * the request vocabulary is this file's. The file controller decides whether to ask; this decides
 * what asking looks like.
 *
 * ⚠ **Closed requests are left out** — a note cannot be added to one, so a row for it is a row that
 * refuses. Four rows plus "New request" keeps the list inside WhatsApp's ten.
 */
export function whichRequestForFileReply(
    tickets: ReadonlyArray<Record<string, unknown>>,
    attachmentRef: string,
    language: string | null,
): BotReplyIntent | null {
    const open = tickets.filter((ticket) => ticketAcceptsWriting(textOf(ticket.status))).slice(0, 4);
    if (open.length === 0) return null;

    return {
        kind: 'choice',
        text: botTicketCopy('whichTicketForFile', language),
        options: [
            ...open.map((ticket) => ({
                ...requestRow(ticket, language),
                id: attachToTicketActionId(idOf(ticket), attachmentRef),
            })),
            {
                id: supportFormWithFileActionId(attachmentRef),
                label: botTicketCopy('newRequestRow', language),
                shortLabel: botTicketCopy('newRequestRow', language),
                description: botTicketCopy('newRequestWithFile', language),
            },
        ],
        listButton: botChrome('chooseListButton', language),
        sectionTitle: botChrome('chooseSectionTitle', language),
    };
}

/**
 * A ticket document as a plain bag of fields.
 *
 * ⚠ **Read through this rather than off `ITicket` directly**, because the same rendering serves three
 * shapes: a Mongoose document from `getTicketById`, an enriched projection from `enrichTickets`, and
 * the raw document `closeTicket` returns. Naming the fields once is what keeps the card from
 * disagreeing with the row about which key holds the subject.
 */
function asRow(ticket: unknown): Record<string, unknown> {
    return ticket as Record<string, unknown>;
}
