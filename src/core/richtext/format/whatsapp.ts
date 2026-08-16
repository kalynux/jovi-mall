import { flattenLink } from '../doc';
import { CHAT_LIMITS } from '../limits';
import { INLINE_MARKS, type InlineMark, type InlineNode, type RichDoc } from '../types';
import { fitFormatted, renderDoc, wrapPreservingEdges } from './shared';

/**
 * WhatsApp message formatter.
 *
 * WhatsApp has no markup language. It has four in-band markers that the client
 * interprets while rendering, and no way to escape them — which drives every
 * decision below:
 *
 * | Intent        | Emitted   |
 * |---------------|-----------|
 * | bold          | `*text*`  |
 * | italic        | `_text_`  |
 * | strikethrough | `~text~`  |
 * | link          | bare URL — there is no anchor syntax |
 *
 * The output of this function is meant to be sent as a Cloud API `text.body`
 * (or a media caption). It is NOT markdown and must never be handed to a
 * markdown renderer.
 */

const MARKER: Record<InlineMark, string> = {
  bold: '*',
  italic: '_',
  strike: '~',
};

/**
 * Wrap a span in its marker pairs, innermost mark first.
 *
 * `INLINE_MARKS` is ordered outermost-first (strike, bold, italic), so applying
 * it reversed produces `~*_text_*~` — the nesting order WhatsApp parses most
 * reliably.
 *
 * The `includes` check is the collision guard. WhatsApp offers no escape
 * character, so a span reading `Toile 5*7` that the vendor also marked bold
 * cannot be expressed: emitting `*Toile 5*7*` makes the client bold the words
 * "Toile 5" and leave a stray marker. Dropping the marker loses the emphasis but
 * keeps the sentence, which is the better failure — and the dashboard's own lint
 * warns the vendor at authoring time rather than letting them discover it in a
 * customer's chat.
 */
function applyMarkers(core: string, node: InlineNode): string {
  let out = core;
  for (const mark of [...INLINE_MARKS].reverse()) {
    if (!node[mark]) continue;
    const marker = MARKER[mark];
    if (out.includes(marker)) continue;
    out = `${marker}${out}${marker}`;
  }
  return out;
}

function renderInline(node: InlineNode): string {
  if (node.type === 'link') {
    // Marks are deliberately dropped on links. WhatsApp auto-links a bare URL by
    // scanning the raw text, and a leading `*` or `_` gets absorbed into the
    // detected URL often enough to produce a dead link — a formatting nicety is
    // not worth a link the customer cannot tap.
    return flattenLink(node.text, node.href);
  }
  return wrapPreservingEdges(node.text, (core) => applyMarkers(core, node));
}

export type WhatsAppFormatOptions = {
  /** Character budget for the message. Defaults to the Cloud API text cap. */
  maxLength?: number;
};

/**
 * Render a description as a WhatsApp message body.
 *
 * Fitting happens on the document, never on the formatted string — see
 * `fitFormatted`. An unclosed `*` makes the WhatsApp client swallow everything
 * after it into one bold run.
 *
 * Pass `{ maxLength: CHAT_LIMITS.CAPTION }` when the description rides along as
 * an image caption rather than a standalone body.
 */
export function toWhatsApp(doc: RichDoc, options: WhatsAppFormatOptions = {}): string {
  const max = options.maxLength ?? CHAT_LIMITS.MAX;
  return fitFormatted(doc, max, (fitted) => renderDoc(fitted, renderInline));
}
