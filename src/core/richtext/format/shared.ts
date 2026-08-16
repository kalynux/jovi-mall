import { listPrefix, toPlainText, truncateDoc } from '../doc';
import { truncate } from '../limits';
import type { InlineNode, RichDoc } from '../types';

/**
 * The block layout both channels share.
 *
 * Neither WhatsApp nor Telegram has list markup, headings, or indentation — a
 * "list" in a chat message is literally a line that starts with a bullet
 * character. So the block structure is identical across channels and only the
 * *inline* rendering differs. That is the whole reason this file exists: it
 * keeps the two formatters from drifting apart on spacing, which is the kind of
 * difference nobody notices until a vendor reports that Telegram "adds a blank
 * line".
 */
export type InlineRenderer = (node: InlineNode) => string;

export function renderDoc(doc: RichDoc, renderInline: InlineRenderer): string {
  return doc.blocks
    .map((block) => {
      if (block.type === 'paragraph') return block.text.map(renderInline).join('');
      return block.items
        .map((item, i) => `${listPrefix(block.ordered, i)}${item.map(renderInline).join('')}`)
        .join('\n');
    })
    .join('\n\n')
    .trim();
}

/**
 * Apply a wrapper to text without letting whitespace fall inside it.
 *
 * WhatsApp only renders a marker pair when both markers touch a non-whitespace
 * character: `* bold *` renders as three literal characters and a space, while
 * `*bold*` renders bold. Since a vendor selecting a word with a double-click
 * very often catches the trailing space, this is not an edge case — it is the
 * common case, and getting it wrong makes the feature look broken in exactly the
 * place the vendor was checking.
 *
 * Markers are also applied per line, because neither platform reliably carries a
 * marker pair across a hard line break.
 */
export function wrapPreservingEdges(text: string, wrap: (core: string) => string): string {
  return text
    .split('\n')
    .map((line) => {
      const lead = /^\s*/.exec(line)?.[0] ?? '';
      const core = line.slice(lead.length).replace(/\s*$/, '');
      if (!core) return line;
      const trail = line.slice(lead.length + core.length);
      return `${lead}${wrap(core)}${trail}`;
    })
    .join('\n');
}

/**
 * Format a document so the result fits a hard character budget.
 *
 * The naive version of this — format, then `slice()` the string — is a bug in
 * both channels. Cutting WhatsApp output can drop a closing `*`, and the client
 * then renders everything after it as one bold run; cutting Telegram HTML can
 * drop a `</b>`, and the Bot API rejects the whole send with
 * `400 can't parse entities` — which `telegram-bot.service.ts` logs and
 * discards, so the message simply never arrives.
 *
 * So the budget is applied to the **document**, and the formatted length is
 * measured afterwards. Markers and tags cost characters the document budget did
 * not count, so overflow is fed back as a smaller document budget and retried. A
 * handful of passes converges — the overhead is bounded by a few characters per
 * span — and the loop is capped anyway.
 *
 * The last resort deliberately abandons formatting rather than the limit: plain
 * text has no markers to sever, so a hard cut on it is always well-formed. A
 * message that arrives unformatted is a disappointment; one that arrives
 * truncated mid-marker is a rendering bug in the customer's chat, and one that
 * exceeds 4096 is not delivered at all.
 */
export function fitFormatted(
  doc: RichDoc,
  max: number,
  format: (fitted: RichDoc) => string,
  escapePlain: (text: string) => string = (t) => t,
): string {
  let budget = max;
  let out = format(truncateDoc(doc, budget).doc);

  for (let pass = 0; pass < 6 && out.length > max; pass += 1) {
    budget -= Math.max(8, out.length - max);
    if (budget <= 16) break;
    out = format(truncateDoc(doc, budget).doc);
  }

  if (out.length <= max) return out;
  return truncate(escapePlain(toPlainText(truncateDoc(doc, max).doc)), max);
}
