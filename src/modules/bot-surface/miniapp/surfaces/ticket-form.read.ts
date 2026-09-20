import { z } from 'zod';
import { AppError, createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import { TicketService } from '../../../tickets/services/ticket.service';
import { TicketAttachmentService } from '../../../tickets/services/ticket-attachment.service';
import {
    ActorRole,
    EntityType,
    TicketImportance,
    TicketType,
} from '../../../tickets/types/ticket.types';
import { MessagingChannel } from '../../../channel-connections';
import { InAppSurfaceSession, inAppSurfaceStore } from '../../services/inapp-surface.store';
import { inboundFileStore } from '../../services/inbound-file.store';
import { supportContextService } from '../../services/support-context.service';
import { BotTicketSubjectKey } from '../../domain/bot-ticket-copy';
import {
    TICKET_FORM_DESCRIPTION_MAX,
    TicketFormView,
    buildContacts,
    buildTicketFormView,
    ticketSubjectFor,
    ticketTypeFor,
} from './ticket-form.view';

/**
 * ⭐ **THE SUPPORT FORM'S TWO OPERATIONS — transport-neutral, and the only place a `tf` handle is
 * spent.**
 *
 * ── ONE READ, ONE SET OF RULES, TWO RENDERINGS ──────────────────────────────
 * The Telegram page (`ticket-form.controller.ts` → `public/tf.html`) and the WhatsApp Flow
 * (`whatsapp/flows/**`, another stream) both call these two functions. Neither may copy the
 * projection or re-derive a rule: `submitTicketForm` is what makes "a `tf` handle authorises ONE
 * submit" true, and a second implementation is one that eventually spends it twice.
 *
 * Nothing here touches `req` or `res`. A refusal is an `AppError` carrying a status and
 * `details.spent`; each transport maps that to its own answer.
 *
 * ── ⚠ `details.spent` IS ON EVERY REFUSAL, AND ABSENT MEANS SPENT ────────────
 * The convention `placeCheckout` established, and it matters for the same reason: a caller deciding
 * whether a retry is honest cannot tell from the status code alone. A 400 comes from the submitted
 * words (before the spend); a failure after `consume` means the request may already exist. Over HTTP
 * the platform strips `details` from internal and external-service errors, so **treat a missing flag
 * as `true`** and send the customer back to the chat, which knows the truth.
 */

const ticketService = new TicketService();
const attachmentService = new TicketAttachmentService();

/** What a rendering submits. Shape only; the rules are below. */
const SubmissionSchema = z
    .object({
        subject: z.enum([
            'order',
            'delivery',
            'payment',
            'refund',
            'product',
            'booking',
            'account',
            'other',
        ]),
        description: z.string().trim().min(1).max(TICKET_FORM_DESCRIPTION_MAX),
    })
    .strict();

export interface TicketFormOpened {
    ticketId: string;
    subject: string;
    /**
     * ⚠ **False when a photo was carried in and could not be attached.** The request is opened
     * either way — a failed attach must never cost the customer the request they just described —
     * and the handle is put back, so the picker in the chat still works.
     */
    attachmentAttached: boolean;
    /**
     * The conversation the form was opened from, so a transport can answer in the chat.
     *
     * ⚠ **Read from the SESSION, never from the submission.** It is how a confirmation can only ever
     * be sent to the conversation that opened the form.
     */
    conversation: { channel: MessagingChannel; externalId: string; language: string | null };
}

/**
 * The form a handle opens, read live.
 *
 * ⚠ **Repeatable — `read`, never `consume`.** A page reads on every open and every refresh, and a
 * Flow's data exchange may be retried by Meta on its own schedule. Only the submit spends.
 */
export async function readTicketForm(handle: string): Promise<TicketFormView> {
    const session = await readSession(handle);
    return buildViewFor(session);
}

/**
 * Spend the handle, open the request, attach the photo if there was one.
 *
 * ── THE ORDER OF THE WORK IS THE PROTECTION ─────────────────────────────────
 *   1. **Validate the submission**, which needs no session and must not cost the customer their form.
 *   2. **`consume`** — before anything that takes time, so a double tap, a refreshed tab, a forwarded
 *      URL and a Meta retry all find the handle gone. There is no `Idempotency-Key` on either
 *      transport (a browser sends what the page sends), so the store's Lua read-and-delete is the
 *      only thing between a second tap and a second request in support's queue.
 *   3. **Everything else**, with every refusal marked spent.
 */
export async function submitTicketForm(handle: string, input: unknown): Promise<TicketFormOpened> {
    const submission = validate(input);

    const session = await inAppSurfaceStore.consume('tf', plausibleHandle(handle));
    if (!session) throw handleGone(false);

    try {
        const about = await aboutForSubject(session);
        const language = session.language;
        const subjectKey = submission.subject as BotTicketSubjectKey;
        const subject = ticketSubjectFor(subjectKey, session.form.topic, about, language);

        /**
         * ⚠ **The entity is the ORDER only when the form was opened for one.** `entityType` anchors
         * the request to something support can open; anchoring it to an order the ladder merely
         * guessed would file a general question against an unrelated purchase.
         */
        const ticket = await ticketService.createTicket({
            subject,
            description: submission.description,
            type: ticketTypeFor(subjectKey, session.form.topic) as TicketType,
            importance: TicketImportance.MEDIUM,
            entityType: session.form.orderId ? EntityType.ORDER : EntityType.OTHER,
            entityId: session.form.orderId ?? session.customerId,
            createdByUserId: session.owner,
            createdByRole: ActorRole.CUSTOMER,
            createdByEntityId: session.customerId,
            createdByAdmin: null,
        });

        const ticketId = String((ticket as unknown as Record<string, unknown>).id ?? ticket._id);

        return {
            ticketId,
            subject,
            attachmentAttached: await attachCarriedFile(session, ticketId),
            conversation: {
                channel: session.channel,
                externalId: session.externalId,
                language,
            },
        };
    } catch (error) {
        throw markedSpent(error);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  The rules
// ─────────────────────────────────────────────────────────────────────────────

type TicketFormSession = Extract<InAppSurfaceSession, { kind: 'tf' }>;

async function readSession(handle: string): Promise<TicketFormSession> {
    const session = await inAppSurfaceStore.read('tf', plausibleHandle(handle));
    if (!session) throw handleGone(false);
    return session;
}

async function buildViewFor(session: TicketFormSession): Promise<TicketFormView> {
    const { about, contacts } = await resolveSubject(session);

    return buildTicketFormView({
        language: session.language,
        about,
        contacts,
        topic: session.form.topic,
        hasAttachment: Boolean(session.form.attachmentRef),
    });
}

/**
 * Who to contact, and what the request is about — both from the support ladder, in one call.
 *
 * ⚠ **`about` is filled ONLY from the session's own order.** The ladder answers `resolvedFrom`, and
 * its recency rungs are a guess: right for offering a shop's phone number, wrong for labelling what a
 * complaint is about. So a form opened from a delivery button says which order it is about, and a form
 * opened from a Help button says "a general question" while still offering the contacts the ladder
 * found.
 *
 * ⚠ **A ladder refusal is NOT caught.** An order that is not this customer's is a refusal the customer
 * must see; swallowing it would draw a form about somebody else's purchase.
 */
async function resolveSubject(
    session: TicketFormSession,
): Promise<{ about: string | null; contacts: ReturnType<typeof buildContacts> }> {
    const context = await supportContextService.resolve(session.customerId, {
        scope: 'auto',
        ...(session.form.orderId ? { hintOrderId: session.form.orderId } : {}),
    });

    return {
        about: session.form.orderId ? context.subject.label : null,
        contacts: buildContacts({ vendor: context.vendor, agency: context.agency }),
    };
}

/**
 * What the request is about, for its subject line — and **never a reason to lose a submission.**
 *
 * ⚠ **The handle is already spent by the time this runs, so it MUST NOT throw.** On the read path a
 * ladder refusal is the honest answer and is not caught: the customer has typed nothing yet, and a
 * form about somebody else's order must not be drawn. Here they have just described their problem, and
 * losing that to a lookup — an order deleted in the meantime, a database wobble — would send them back
 * to the chat to retype it, for a decoration on a subject line. So a failure degrades to "a general
 * question" and the words reach support either way.
 */
async function aboutForSubject(session: TicketFormSession): Promise<string | null> {
    if (!session.form.orderId) return null;

    try {
        return (await resolveSubject(session)).about;
    } catch (error) {
        console.error('[BotSurface] a support form could not name its subject; filing it generally', error);
        return null;
    }
}

/**
 * Attach the photo the customer sent before opening the form, if there was one.
 *
 * ⚠ **A failure here is reported, never thrown.** By this point the request exists and the customer
 * has described their problem; turning "the photo did not attach" into a failed submission would throw
 * that away. The handle is restored, so the "which request is this file for?" picker in the chat still
 * works — and `restore` is best-effort, so even that cannot fail this.
 */
async function attachCarriedFile(session: TicketFormSession, ticketId: string): Promise<boolean> {
    const ref = session.form.attachmentRef;
    if (!ref) return false;

    const file = await inboundFileStore.consume(session.owner, ref);
    if (!file) return false;

    try {
        await attachmentService.attachFile(
            ticketId,
            file.fileId,
            session.owner,
            ActorRole.CUSTOMER,
            session.customerId,
            'PUBLIC',
        );
        return true;
    } catch (error) {
        console.error('[BotSurface] a support form could not attach its carried file', error);
        await inboundFileStore.restore(session.owner, ref, file);
        return false;
    }
}

function validate(input: unknown): z.infer<typeof SubmissionSchema> {
    const parsed = SubmissionSchema.safeParse(input ?? {});
    if (!parsed.success) {
        /**
         * ⚠ **An `AppError` with `spent: false`, never a raw `ZodError`.** A `ZodError` carries no
         * `details` a caller could read, and this is the one refusal after which a retry is both
         * honest and useful: the handle is still alive, so the page can ask again.
         */
        throw createAppError(
            ERROR_CODES.VALIDATION_ERROR,
            400,
            'Choose what the request is about and describe what happened',
            { spent: false, field: parsed.error.issues[0]?.path.join('.') || 'description' },
        );
    }
    return parsed.data;
}

/**
 * A handle, or a value that cannot match one.
 *
 * ⚠ **Not a refusal of its own.** An absurd value is simply absent — the store answers null for
 * anything without its prefix — so a malformed handle and a lapsed one are the same 404, which is the
 * position every handle on this surface takes.
 */
function plausibleHandle(handle: string): string {
    return typeof handle === 'string' && handle.length <= 128 ? handle.trim() : '';
}

/**
 * ⚠ **`BOT_PRODUCT_LIST_EXPIRED` is a STAND-IN, and the page depends on the status rather than the
 * code.** Three streams raise it for non-product screens because the switchboard's screen-session code
 * is not landed yet; `tf.html` maps 404 and 410 to its own "ask me again in the chat" copy, in the
 * customer's language, which is the only remedy that works for any of these. Swap the code when it
 * lands — nothing about the behaviour changes.
 */
function handleGone(spent: boolean): AppError {
    return createAppError(
        ERROR_CODES.BOT_PRODUCT_LIST_EXPIRED,
        404,
        'That support form is no longer open',
        { spent },
    );
}

/**
 * Mark anything thrown after the spend, so a transport never invites a retry that duplicates.
 *
 * ⚠ **A NEW error rather than a mutated one** — `AppError.details` is read-only, and the same helper
 * in `checkout.controller.ts` is built this way for the same reason. Anything that is not an
 * `AppError` is passed through untouched: it never had a flag, and the callers are told to read a
 * missing flag as "spent".
 */
function markedSpent(error: unknown): unknown {
    if (!(error instanceof AppError)) return error;
    if (error.details?.spent === true) return error;
    return new AppError(
        error.message,
        error.statusCode,
        error.code,
        error.isOperational,
        { ...(error.details ?? {}), spent: true },
    );
}
