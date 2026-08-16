import { flattenLink, toPlainText, truncateDoc } from '../doc';
import { CHAT_LIMITS, truncate } from '../limits';
import { INLINE_MARKS, type InlineMark, type InlineNode, type RichDoc } from '../types';
import { fitFormatted, renderDoc } from './shared';

/**
 * Telegram message formatters.
 *
 * Telegram is not "WhatsApp with different characters", and treating it that way
 * is the mistake this module exists to prevent. Two differences are structural:
 *
 * **1. Telegram keeps link labels; WhatsApp cannot.** `<a href="…">Guide des
 * tailles</a>` renders as tappable text. The same document therefore produces
 * genuinely different output per channel — which is the point of storing a
 * document rather than a rendered string.
 *
 * **2. Telegram parses a real markup language, chosen per send via `parse_mode`.**
 * We emit **HTML**, not MarkdownV2. MarkdownV2 requires escaping eighteen
 * characters — ``_ * [ ] ( ) ~ ` > # + - = | { } . !`` — and a product
 * description is a minefield of them: every price (`12.500 FCFA`), every French
 * dash, every `(x2)`, every `!`. A single missed escape does not degrade the
 * formatting, it makes the Bot API reject the entire send with
 * `400 Bad Request: can't parse entities`, which `telegram-bot.service.ts` logs
 * and discards — so the message silently never arrives. HTML's escape set is
 * three characters that never appear in prose by accident.
 */

const TAG: Record<InlineMark, string> = {
  bold: 'b',
  italic: 'i',
  strike: 's',
};

/**
 * Escape the only three characters Telegram's HTML parser treats as markup.
 *
 * `&` must be replaced first, or the ampersands introduced by the other two
 * replacements would be escaped a second time and arrive as `&amp;lt;`.
 *
 * Exported because every `parse_mode: 'HTML'` send needs it, not just the ones
 * that carry a description — any interpolated title, vendor name or order
 * reference has to go through it too.
 */
export function escapeTelegramHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function wrapTags(inner: string, node: InlineNode): string {
  let out = inner;
  for (const mark of [...INLINE_MARKS].reverse()) {
    if (!node[mark]) continue;
    out = `<${TAG[mark]}>${out}</${TAG[mark]}>`;
  }
  return out;
}

function renderInlineHtml(node: InlineNode): string {
  if (node.type === 'link') {
    const label = node.text.trim() || node.href;
    // Telegram requires the href to be attribute-escaped too. It is a URL, so
    // `<` and `>` cannot legally appear, but `&` routinely does in query strings
    // — an unescaped `?a=1&b=2` is exactly how a link breaks in practice.
    return wrapTags(
      `<a href="${escapeTelegramHtml(node.href)}">${escapeTelegramHtml(label)}</a>`,
      node,
    );
  }
  // Marks wrap the escaped text as a whole. Unlike WhatsApp there is no
  // whitespace-hugging rule and no in-band collision to guard against: a literal
  // asterisk inside `<b>` is just an asterisk.
  return wrapTags(escapeTelegramHtml(node.text), node);
}

export type TelegramFormatOptions = {
  maxLength?: number;
};

/**
 * Render a description for `sendMessage` with **`parse_mode: 'HTML'`**.
 *
 * Sending this string with any other `parse_mode` — or with none — puts literal
 * `<b>` tags in the customer's chat.
 */
export function toTelegramHtml(doc: RichDoc, options: TelegramFormatOptions = {}): string {
  const max = options.maxLength ?? CHAT_LIMITS.MAX;
  return fitFormatted(doc, max, (fitted) => renderDoc(fitted, renderInlineHtml), escapeTelegramHtml);
}

/**
 * Render a description as unformatted Telegram text.
 *
 * Needed because `https://t.me/share/url?...&text=` — the share deep link the
 * vendor dashboard opens — has no `parse_mode`. Whatever goes in the query
 * string is shown verbatim, so passing `toTelegramHtml` output there would put
 * raw `<b>` tags in front of a customer. Bot API sends use the HTML formatter;
 * share links use this one.
 */
export function toTelegramPlain(doc: RichDoc, options: TelegramFormatOptions = {}): string {
  const max = options.maxLength ?? CHAT_LIMITS.MAX;
  const { doc: fitted } = truncateDoc(doc, max);
  return truncate(toPlainText(fitted), max);
}

/** Re-exported so a share composer flattens links the same way the body does. */
export { flattenLink };
