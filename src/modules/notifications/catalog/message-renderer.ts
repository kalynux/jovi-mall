import { escapeTelegramHtml } from '../../../core/richtext';

/**
 * Message Renderer
 *
 * Fills `{{placeholder}}` tokens in a preformatted catalog string with real
 * values from a flat context object. Missing/nullish values render as empty
 * strings so a partial payload never produces a literal `{{key}}` in output.
 */
export type RenderContext = Record<string, unknown>;

const PLACEHOLDER = /\{\{\s*(\w+)\s*\}\}/g;
/** Runs of spaces/tabs. Deliberately NOT `\s`, which would eat newlines. */
const REPEATED_SPACES = /[ \t]{2,}/g;
/** A space or tab sitting immediately before sentence punctuation. */
const SPACE_BEFORE_PUNCTUATION = /[ \t]+([.,;:!?])/g;

/**
 * Render a template, then tidy the whitespace an empty placeholder leaves behind.
 *
 * WHY THE TIDY: several situations end with an optional sentence — `{{codLine}}`
 * on out-for-delivery, `{{reasonLine}}` on a balance request. When that value is
 * legitimately empty the surrounding spaces survive, giving either a trailing
 * space ("…can receive it. ") or a double space mid-sentence ("…today.  We will
 * try again"). Both reach push notifications and emails un-trimmed; only the
 * in-app copy is saved through a `trim: true` Mongoose path.
 *
 * Runs of spaces are collapsed rather than newlines preserved-by-accident: no
 * catalog template currently contains a newline, but one added later (a
 * multi-paragraph email body) must not be flattened into a single line.
 */
export function renderTemplate(template: string, ctx: RenderContext): string {
    const filled = template.replace(PLACEHOLDER, (_match, key: string) => {
        const value = ctx[key];
        return value === undefined || value === null ? '' : String(value);
    });

    return filled
        .replace(SPACE_BEFORE_PUNCTUATION, '$1')
        .replace(REPEATED_SPACES, ' ')
        .trim();
}

/**
 * Compose a rendered catalog subject + body into a Telegram message.
 *
 * Sent with `parse_mode: 'HTML'`, which is why both halves are escaped rather
 * than interpolated raw. This is the ONE shared thing across the four otherwise
 * deliberately-separate notification stacks, and it is shared precisely because
 * it is a correctness boundary rather than copy: all four build the identical
 * `<b>subject</b>\n\nbody` shape, and a fifth stack added later must not have to
 * rediscover the escaping.
 *
 * WHY IT MATTERS: this used to emit legacy Markdown (`*subject*`), and every
 * template here interpolates user-authored values — product titles, vendor and
 * agency names, order references, agent notes. A single `_`, `*`, `[` or
 * backtick in any of them made the Bot API answer `400 can't parse entities`,
 * `sendMessage` return `false`, and the notification vanish with only a log
 * line. A vendor whose shop is called "Chez L_Artisan" was simply never told
 * anything, and nothing in the system said so.
 */
export function toTelegramNotificationBody(subject: string, body: string): string {
    return `<b>${escapeTelegramHtml(subject)}</b>\n\n${escapeTelegramHtml(body)}`;
}

/**
 * WhatsApp's four formatting markers. There is no escape sequence for any of them — WhatsApp
 * has no `parse_mode` and no backslash escaping — so the ONLY way to stop one toggling a run
 * is to not send it.
 */
const WHATSAPP_MARKERS = /[*_~`]/g;

/**
 * Compose a rendered catalog subject + body into an in-window WhatsApp message.
 *
 * The counterpart to {@link toTelegramNotificationBody}, shared across all four stacks for the
 * same reason: it is a correctness boundary rather than copy, and a fifth stack must not have
 * to rediscover it. Before this, every stack sent the bare `${subject}\n\n${body}` — correct,
 * and completely unstyled, so a notification arrived as a wall of text with nothing marking
 * what it was about.
 *
 * ── Why this is NOT just the Telegram function with different markers ────────
 *
 * Telegram fails LOUDLY: an unbalanced entity makes the Bot API answer `400 can't parse
 * entities` and the message does not arrive, which is how "Chez L_Artisan" was found. WhatsApp
 * fails QUIETLY — it has no parse errors. A stray `*` in an interpolated product title simply
 * swallows the bold run, and the customer receives a message where the heading is not bold and
 * a random later phrase is. Nothing errors, nothing logs, and the only way to notice is to
 * read one.
 *
 * ⚠ **So a subject containing a marker is sent UNBOLDED, rather than having the marker
 * stripped.** Stripping was the first implementation and it was wrong: it turns the vendor
 * "Chez L_Artisan" into "Chez LArtisan" — silently editing a business's own name to protect a
 * formatting run. Since there is no escape, the only two honest options are *mangle the text*
 * or *drop the styling*, and dropping the styling is the one that never lies about what
 * somebody is called. It costs a bold heading on a small minority of messages; the alternative
 * costs correctness on exactly the messages that quote a real name.
 *
 * ⚠ **The body is deliberately left untouched.** It is not wrapped in any marker, so a stray
 * character there can only affect the body's own rendering — and stripping punctuation out of
 * a message a human reads is a worse trade than the occasional odd italic. This is also
 * exactly today's behaviour for the body, so the change cannot regress anything.
 */
export function toWhatsAppNotificationBody(subject: string, body: string): string {
    const heading = subject.trim();
    if (!heading) return body;

    // Reset `lastIndex` — WHATSAPP_MARKERS is a module-level /g regex, and `.test()` on a
    // global regex is stateful, so a shared one returns alternating answers across calls.
    WHATSAPP_MARKERS.lastIndex = 0;
    const hasMarker = WHATSAPP_MARKERS.test(heading);

    return hasMarker ? `${heading}\n\n${body}` : `*${heading}*\n\n${body}`;
}
