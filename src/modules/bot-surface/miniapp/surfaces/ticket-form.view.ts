import {
    BotTicketFormCopyKey,
    BotTicketSubjectKey,
    BOT_TICKET_TYPE_OF,
    BOT_TICKET_TYPE_OF_TOPIC,
    botTicketFormCopy,
    botTicketSubjectChoices,
    botTicketSubjectLabel,
} from '../../domain/bot-ticket-copy';
import type { SupportTopicCode } from '../../domain/bot-ticket-actions';

/**
 * ⭐ **WHAT THE SUPPORT FORM SHOWS, and what a submission becomes — pure, with no I/O at all.**
 *
 * ── WHY THIS IS A FILE OF ITS OWN ───────────────────────────────────────────
 * The form is drawn twice: as a page inside Telegram, and as a WhatsApp Flow. Round 1 taught this
 * effort what happens when a screen's projection lives inline in its Express handler — serving the
 * second channel means either copying the rules, which then drift on the channel nobody can open in a
 * browser to compare, or going back and extracting them. So: **one read, one set of rules, two
 * renderings**, and the rules are here, where a suite can import them with no database, no Redis and
 * no Express.
 *
 * ── ⚠ THE CONTACTS ARE THE SUPPORT LADDER'S, AND NOTHING MORE ───────────────
 * `buildContacts` may only carry what `POST /support/context` already returns to a customer: a party's
 * name and the contact details that party has PUBLISHED. No vendor id, no store slug, and above all no
 * address — a shop's ship-from address is private (the store screens show a city and no more), and a
 * support form is exactly the sort of screen where somebody would helpfully add one. The suite asserts
 * the projection against a ladder answer stuffed with extra fields.
 */

/** A party the customer may contact directly instead of opening a request. */
export interface TicketFormContact {
    party: 'shop' | 'carrier';
    name: string;
    /** Each is null when that party has published none — every one of them is optional upstream. */
    whatsapp: string | null;
    phone: string | null;
    email: string | null;
}

export interface TicketFormChoice {
    key: BotTicketSubjectKey;
    label: string;
}

/** Everything a rendering needs. Nothing here is channel-specific. */
export interface TicketFormView {
    copy: Record<BotTicketFormCopyKey, string>;
    /**
     * What the request will be about, worded by the support ladder — or null for a general question.
     *
     * ⚠ **Non-null only when the form was opened FOR something.** The ladder also guesses, from the
     * customer's most recent order, and a guess is fine for choosing who to contact but not for
     * labelling what a complaint is about: "About: your order ORD-2026-000123" on a form somebody
     * opened from a Help button is a sentence the platform made up.
     */
    about: string | null;
    contacts: TicketFormContact[];
    choices: TicketFormChoice[];
    /** Pre-chosen when a delivery button opened the form; null when the customer must pick. */
    selectedKey: BotTicketSubjectKey | null;
    /**
     * That a file the customer already sent will be attached — and nothing about the file.
     *
     * ⚠ **No name, no bytes, no URL, deliberately.** A WhatsApp Flow can only show an image as base64
     * inside its response, and the handle is single-use, so naming the file would mean either spending
     * it to read its name or keeping a second copy of the record. The customer sent the photo one
     * message ago; a line saying it is attached is the whole of what they need.
     */
    attachment: { present: true } | null;
    limits: { description: number };
}

/**
 * The longest description the form accepts.
 *
 * ⚠ **The same 700 as `BotTicketCreateSchema`**, deliberately: the form and the model-facing tool open
 * the same kind of request, and a form that accepted more would fail at the service with a validation
 * error the customer cannot act on. Stated here because the page shows a counter from it.
 */
export const TICKET_FORM_DESCRIPTION_MAX = 700;

/** The eight subjects, in the order they are shown, with the delivery topics already mapped. */
export function ticketFormChoices(language: string | null): TicketFormChoice[] {
    return botTicketSubjectChoices(language).map((choice) => ({ ...choice }));
}

/**
 * Which subject a pre-filling topic corresponds to. All three delivery buttons land on `delivery`.
 */
export function subjectKeyOfTopic(topic: SupportTopicCode | null): BotTicketSubjectKey | null {
    return topic ? 'delivery' : null;
}

/**
 * The ticket TYPE a submission becomes.
 *
 * ⚠ **The topic refines the type, and only while the customer keeps the delivery subject.** "Ask to
 * redeliver" and "Address is wrong" are distinct asks, and support reads the type before anybody reads
 * the words; collapsing both into `SHIPPING_ISSUE` throws away the one structured thing the platform
 * knows. But a customer who opened the form from a delivery button and then chose "Payment" has
 * changed the subject, and the topic must not survive that.
 */
export function ticketTypeFor(key: BotTicketSubjectKey, topic: SupportTopicCode | null): string {
    if (topic && key === 'delivery') return BOT_TICKET_TYPE_OF_TOPIC[topic];
    return BOT_TICKET_TYPE_OF[key];
}

/**
 * The subject line support reads first.
 *
 * ⚠ **Generated, never typed.** A form with a subject field asks a customer to name their problem
 * before describing it, and what comes back is "Help" or "Problem" — which is what support then sees
 * in a queue. The chosen subject plus what the request is about says more than either, in the
 * customer's own language.
 */
export function ticketSubjectFor(
    key: BotTicketSubjectKey,
    topic: SupportTopicCode | null,
    about: string | null,
    language: string | null,
): string {
    const head = topic && key === 'delivery'
        ? botTicketSubjectLabel('delivery', language)
        : botTicketSubjectLabel(key, language);
    const tail = about ?? botTicketFormCopy(language).aboutNothing;
    return `${head}: ${tail}`.slice(0, 200);
}

/** The ladder's two parties, projected to what a form may show. */
export function buildContacts(input: {
    vendor: { name: string; supportWhatsapp: string | null; supportPhone: string | null; supportEmail: string | null } | null;
    agency: { name: string; supportWhatsapp: string | null; supportPhone: string | null; supportEmail: string | null } | null;
}): TicketFormContact[] {
    const parties: TicketFormContact[] = [];

    /**
     * ⚠ **A party with nothing published is left out entirely**, rather than rendered as a heading
     * with no way to reach it. Plenty of shops and delivery companies have published none, and the
     * form's own purpose — open a request with the platform — is the fall-through in that case.
     */
    if (input.vendor && hasAnyContact(input.vendor)) {
        parties.push({
            party: 'shop',
            name: input.vendor.name,
            whatsapp: input.vendor.supportWhatsapp,
            phone: input.vendor.supportPhone,
            email: input.vendor.supportEmail,
        });
    }

    if (input.agency && hasAnyContact(input.agency)) {
        parties.push({
            party: 'carrier',
            name: input.agency.name,
            whatsapp: input.agency.supportWhatsapp,
            phone: input.agency.supportPhone,
            email: input.agency.supportEmail,
        });
    }

    return parties;
}

function hasAnyContact(party: {
    supportWhatsapp: string | null;
    supportPhone: string | null;
    supportEmail: string | null;
}): boolean {
    return Boolean(party.supportWhatsapp || party.supportPhone || party.supportEmail);
}

/** Assemble the view. Every argument is already resolved — this reads nothing. */
export function buildTicketFormView(input: {
    language: string | null;
    about: string | null;
    contacts: TicketFormContact[];
    topic: SupportTopicCode | null;
    hasAttachment: boolean;
}): TicketFormView {
    return {
        copy: botTicketFormCopy(input.language),
        about: input.about,
        contacts: input.contacts,
        choices: ticketFormChoices(input.language),
        selectedKey: subjectKeyOfTopic(input.topic),
        attachment: input.hasAttachment ? { present: true } : null,
        limits: { description: TICKET_FORM_DESCRIPTION_MAX },
    };
}
