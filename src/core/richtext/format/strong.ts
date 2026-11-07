/**
 * "Make this phrase bold", carried through channel-neutral copy and resolved per channel.
 *
 * ── WHY A MARKER AND NOT `*text*` ───────────────────────────────────────────
 * Copy on this platform is composed once, in the customer's language, before anyone knows which
 * channel it is going to — a notification's `{{reasonLine}}` is filled for in-app, email, Telegram
 * and WhatsApp from one context, and a bot reply intent is rendered for either chat. The four
 * channels disagree about emphasis completely:
 *
 * | Channel                  | Bold is…                                                     |
 * |--------------------------|--------------------------------------------------------------|
 * | WhatsApp                 | `*text*`, in-band, with no escape character                  |
 * | Telegram, `parse_mode: HTML` | `<b>text</b>`, and the text around it is HTML-escaped    |
 * | Telegram, no `parse_mode`| an `entities` array of UTF-16 offsets beside the text         |
 * | in-app, email, a prompt  | nothing — a literal `*` would be printed                      |
 *
 * So the copy carries two private-use code points around the phrase, and the one place that
 * knows the channel turns them into that channel's form — or removes them. A private-use code
 * point never occurs in a name, a price or a sentence anybody typed, so it cannot collide with
 * real text the way a `*` in "Toile 5*7" does.
 *
 * ⚠ **A marker that reaches a screen is a visible defect** (most fonts draw a box), so every
 * consumer of marked copy must pass it through one of the functions below. Today the marked
 * copy is the delivery-fee REASON only; the consumers are `channel-reply.ts`, the notification
 * renderers in `message-renderer.ts` / `customer-notification-catalog.ts`, and the recently-sent
 * recorder (`compactSentText`).
 */

export const STRONG_OPEN = '';
export const STRONG_CLOSE = '';

const ANY_MARKER = /[]/g;
const RUN = /([^]*)/g;

/** WhatsApp's four in-band formatting characters. None can be escaped. */
const WHATSAPP_MARKERS = /[*_~`]/;

/** Mark a phrase bold. An empty phrase stays empty, so an absent optional line adds nothing. */
export function strong(text: string): string {
    const inner = stripStrong(text);
    return inner.trim() ? `${STRONG_OPEN}${inner}${STRONG_CLOSE}` : inner;
}

/** Remove every marker — for in-app, email, push, and anything a model will read. */
export function stripStrong(text: string): string {
    return text.replace(ANY_MARKER, '');
}

/** True when the text carries at least one marker. Cheap guard for the renderers. */
export function hasStrong(text: string): boolean {
    ANY_MARKER.lastIndex = 0;
    return ANY_MARKER.test(text);
}

/**
 * Leading and trailing whitespace moved OUTSIDE the run. Both chats only recognise emphasis
 * whose markers touch a visible character — WhatsApp shows `* Reason *` literally.
 */
function splitEdges(inner: string): [string, string, string] {
    const lead = inner.match(/^\s*/)![0];
    const trail = inner.slice(lead.length).match(/\s*$/)![0];
    return [lead, inner.slice(lead.length, inner.length - trail.length), trail];
}

/**
 * WhatsApp: each run becomes `*run*`.
 *
 * ⚠ **A run that itself contains `*`, `_`, `~` or a backtick is sent UNBOLDED, never edited.**
 * The bold phrase is often someone else's words (an agency's reason), and WhatsApp has no escape:
 * the only honest choices are to mangle their text or to drop the styling, and this file drops the
 * styling — the rule `toWhatsAppNotificationBody` already keeps for headings.
 */
export function strongToWhatsApp(text: string): string {
    return stripStrong(text.replace(RUN, (_m, inner: string) => {
        const [lead, core, trail] = splitEdges(inner);
        if (!core || WHATSAPP_MARKERS.test(core)) return inner;
        return `${lead}*${core}*${trail}`;
    }));
}

/**
 * Telegram with `parse_mode: 'HTML'`: each run becomes `<b>run</b>`.
 *
 * ⚠ Call it on text that is ALREADY escaped. The markers are not HTML-special, so they survive
 * `escapeTelegramHtml` untouched, and the tags this adds must not be escaped after it.
 */
export function strongToTelegramHtml(escaped: string): string {
    return stripStrong(escaped.replace(RUN, (_m, inner: string) => {
        const [lead, core, trail] = splitEdges(inner);
        return core ? `${lead}<b>${core}</b>${trail}` : inner;
    }));
}

export interface TelegramBoldEntity {
    type: 'bold';
    offset: number;
    length: number;
}

/**
 * Telegram with NO `parse_mode`: the plain text, plus a `bold` entity per run.
 *
 * Telegram measures `offset` and `length` in UTF-16 code units, which is exactly what a JavaScript
 * string index counts — so an emoji or an Arabic letter before the run needs no special handling.
 * Using entities rather than switching the message to HTML is what keeps every other character of
 * a plain reply exactly as it was: no escaping pass over text that was never escaped before.
 */
export function strongToTelegramEntities(text: string): { text: string; entities: TelegramBoldEntity[] } {
    const entities: TelegramBoldEntity[] = [];
    let out = '';
    let last = 0;
    RUN.lastIndex = 0;
    for (let m = RUN.exec(text); m; m = RUN.exec(text)) {
        out += stripStrong(text.slice(last, m.index));
        const [lead, core, trail] = splitEdges(m[1]);
        out += lead;
        if (core) entities.push({ type: 'bold', offset: out.length, length: core.length });
        out += core + trail;
        last = m.index + m[0].length;
    }
    out += stripStrong(text.slice(last));
    return { text: out, entities };
}
