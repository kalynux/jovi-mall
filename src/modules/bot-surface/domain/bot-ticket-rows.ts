import { BotReplyOption } from './channel-reply';
import { botTicketCopy, botTicketStateLabel } from './bot-ticket-copy';
import { ticketCardActionId } from './bot-ticket-actions';

/**
 * ⭐ **ONE SUPPORT REQUEST AS A PICKER ROW — and the reason it is a file of its own.**
 *
 * ── ⚠ THE DEFECT THIS EXISTS TO FIX, FOUND BY RENDERING IT IN FRENCH ────────
 * The first version used the customer's own subject as the row TITLE and put only the state in the
 * description. On WhatsApp a list-row title is cut at 24 characters, so two requests read:
 *
 *     "Ma commande est arrivée…"   Ouverte
 *     "Ma commande est arrivée…"   Ouverte
 *
 * — one "…abîmée" and one "…incomplète", indistinguishable, and the customer taps at random. It was
 * invisible in English, where the same two subjects fit inside 24 characters and read differently.
 *
 * ⭐ **The rule it establishes: a row title built from DATA needs a short, distinguishing label, and
 * its test case must be French or Arabic.** English is the one language in which this class of defect
 * hides.
 *
 * ── SO THE TITLE IS A REFERENCE AND THE WORDS GO IN THE DESCRIPTION ─────────
 * The pattern already on this surface: an order row is titled by its order number — short and unique
 * — with the state and the money underneath. A support request has no such number (`ticket_number`
 * does not exist on `Ticket`, verified by source scan and recorded in `bot-ticket.controller.ts`), so
 * the reference is derived from the request's own id, exactly as `TicketEnrichmentService` labels an
 * entity with `id.slice(-6)`.
 *
 * ── ⚠ PURE, BECAUSE IT HAS TO BE TESTABLE IN FIVE LANGUAGES ─────────────────
 * It lives here rather than in the controller so a suite can build rows from long French subjects and
 * assert that two of them are still told apart. Nothing in this file reads a request from anywhere:
 * the caller passes what it already has.
 */

/** What a row needs from a request. Both the document and the enriched projection supply it. */
export interface RequestRowFacts {
    id: string;
    subject: string;
    status: string;
}

/**
 * A short, stable, unique handle for one request: `#` and the last six characters of its id.
 *
 * ⚠ **Presentational only, and deliberately not an identifier a caller may send back.** Every token
 * carries the whole id; this is the string a customer reads and can quote to support. Uppercased
 * because a reference is read aloud and typed by hand, where `#A1B2C3` survives worse handwriting
 * than `#a1b2c3` — the id itself is matched case-sensitively and is never taken from here.
 *
 * ⚠ **Six hex characters is not globally unique and does not need to be.** It distinguishes the
 * handful of requests one customer has open, which is the only place it is ever shown.
 */
export function shortRequestReference(id: string): string {
    const tail = id.trim().slice(-6).toUpperCase();
    return tail.length > 0 ? `#${tail}` : '#';
}

/**
 * One request as a row.
 *
 * ⚠ **The DESCRIPTION leads with the customer's words, not the state.** A 72-character description
 * holds an ordinary subject and the state together; when a subject is long enough to be cut, the part
 * that survives must be the part that tells two requests apart. The state is on the card they reach
 * by tapping, and the reference is in the title either way.
 */
export function requestRow(request: RequestRowFacts, language: string | null): BotReplyOption {
    const subject = request.subject.trim() || botTicketCopy('newRequestRow', language);
    const state = botTicketStateLabel(request.status, language);
    const reference = shortRequestReference(request.id);

    return {
        id: ticketCardActionId(request.id),
        // Telegram shows one line and has room for all three.
        label: `${reference} · ${subject} · ${state}`,
        // WhatsApp's 24-character title: short, and unique per request.
        shortLabel: reference,
        description: `${subject} · ${state}`,
    };
}
