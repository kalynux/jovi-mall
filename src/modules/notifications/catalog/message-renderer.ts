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
