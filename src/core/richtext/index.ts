/**
 * Structured product descriptions — the `descriptionRich` document model, its
 * validator, and the per-channel formatters.
 *
 * Consume the feature through this barrel. Three things live here rather than in
 * `modules/catalog/` because three modules need them and none owns them:
 * catalog persists and validates the document, and the whatsapp and telegram
 * modules render it.
 *
 * ⚠️ `description` (the plain-text projection) remains authoritative for
 * everything except chat formatting — it is what the storefront renders, what
 * `product_storefront_text` tokenises and what the vectoriser embeds. Nothing
 * here indexes `descriptionRich`, sends it to the vectoriser, or derives
 * `description` from it server-side. See `api-doc/vendor/product-description-rich.md`.
 */

export {
  ALLOWED_LINK_SCHEMES,
  EMPTY_DOC,
  INLINE_MARKS,
  MAX_RICH_DOC_BLOCKS,
  RICH_DOC_VERSION,
  type Block,
  type BlockType,
  type InlineMark,
  type InlineNode,
  type RichDoc,
} from './types';

export { CHAT_LIMITS, truncate } from './limits';

export {
  docCharCount,
  flattenLink,
  isEmptyDoc,
  listPrefix,
  normalizeDoc,
  toPlainText,
  truncateDoc,
} from './doc';

export {
  blockSchema,
  inlineNodeSchema,
  isAllowedHref,
  parseRichDoc,
  richDocSchema,
} from './schema';

export { renderDoc, wrapPreservingEdges, fitFormatted, type InlineRenderer } from './format/shared';
export { toWhatsApp, type WhatsAppFormatOptions } from './format/whatsapp';
export {
  escapeTelegramHtml,
  toTelegramHtml,
  toTelegramPlain,
  type TelegramFormatOptions,
} from './format/telegram';
