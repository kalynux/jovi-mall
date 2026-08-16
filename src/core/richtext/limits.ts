/**
 * Length budgets for a description that has to survive a chat message.
 *
 * The two hard numbers are the same numbers as `WA_LIMITS.TEXT_BODY` and
 * `WA_LIMITS.MEDIA_CAPTION` (`modules/whatsapp/constants/whatsapp-limits.ts`),
 * and Telegram's Bot API `sendMessage` cap happens to be the same 4096. They are
 * restated here rather than imported because `core/` must not depend on a
 * module — the same rule every other core file follows. `test:rich-description`
 * asserts the two sets agree, so the duplication cannot drift into a lie.
 */
export const CHAT_LIMITS = {
  /** WhatsApp `text.body` and Telegram `sendMessage.text` both cap here. */
  MAX: 4096,
  /**
   * WhatsApp interactive/caption bodies cap at 1024. A description under this
   * can also ride along as an image caption, which is how most product shares
   * actually go out.
   */
  CAPTION: 1024,
} as const;

/**
 * Hard-cap a string, appending an ellipsis only when it fits.
 *
 * Deliberately identical in behaviour to `truncate()` in `whatsapp-limits.ts`
 * and to the vendor dashboard's own copy in `lib/richtext/limits.ts`, so a
 * message clamped on either side of the wire comes out the same length with the
 * same marker. Note this is the LAST-RESORT clamp: a formatted message is fitted
 * by trimming the *document* (see `format/shared.ts`), never by cutting the
 * rendered string, because a severed `*` or `</b>` is a broken send rather than
 * a shorter one.
 */
export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 1) return value.slice(0, max);
  return `${value.slice(0, max - 1)}…`;
}
