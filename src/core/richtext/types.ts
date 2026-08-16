/**
 * The product-description content model.
 *
 * This file is the backend half of a contract whose other half is
 * `frontend/vendor-dash/src/lib/richtext/types.ts`. The two are deliberately
 * the same file: the editor produces this shape, the formatters here and there
 * consume it, and `api-doc/vendor/product-description-rich.md` is its wire
 * documentation. Change one and the other needs the same edit in the same
 * change — there is no shared package.
 *
 * Three decisions are worth stating, because they are the ones that cost
 * something to change later.
 *
 * **1. A description is an array of typed blocks, not a markup string.** Storing
 * WhatsApp's own `*bold*` syntax would make WhatsApp the source of truth and
 * make every other channel a lossy translation of one messenger's quirks.
 * Storing HTML would mean sanitising on the way in and rendering through
 * `dangerouslySetInnerHTML` on the way out. This mirrors the decision already
 * made for article bodies in `modules/blog/validators/article-body.validator.ts`.
 *
 * **2. The vocabulary is the intersection of what WhatsApp and Telegram both
 * render** — bold, italic, strikethrough, links, bullet lists, numbered lists,
 * paragraphs. Headings, colours, tables and font sizes are absent because no
 * chat client renders them, so offering them would only let a vendor author
 * something that silently degrades in the one place a description gets read.
 *
 * **3. Inline spans are flat and carry their own marks.** A span is bold *and*
 * italic rather than nesting inside `<strong><em>`. Both formatters emit a flat
 * marker pair per span anyway, so a tree would be flattened again immediately.
 */

/**
 * The inline vocabulary inside a paragraph or a list item.
 *
 * `link` carries its own `text` because the two channels disagree about it:
 * Telegram renders `<a href>` with the label intact, WhatsApp has no anchor
 * syntax at all and can only show a bare URL. Keeping the label as data rather
 * than as markup is what lets each formatter make its own choice — see
 * `format/whatsapp.ts` and `format/telegram.ts`.
 */
export type InlineNode =
  | {
      type: 'text';
      text: string;
      bold?: boolean;
      italic?: boolean;
      strike?: boolean;
    }
  | {
      type: 'link';
      text: string;
      /** Absolute, scheme-checked at PARSE time by `schema.ts` — never at render time. */
      href: string;
      bold?: boolean;
      italic?: boolean;
      strike?: boolean;
    };

export type InlineMark = 'bold' | 'italic' | 'strike';

/** The three marks, in the order formatters nest them (outermost first). */
export const INLINE_MARKS: readonly InlineMark[] = ['strike', 'bold', 'italic'] as const;

/**
 * Blocks.
 *
 * A `paragraph` may contain hard line breaks inside its text (a `\n` inside a
 * text span), which is what Shift+Enter produces. That is deliberate: in chat a
 * two-line address is one thought, and forcing it into two paragraphs would put
 * a blank line through the middle of it.
 *
 * Lists are never nested. Neither WhatsApp nor Telegram has list markup — both
 * formatters emit a literal `• ` or `1. ` prefix — so a nested list would render
 * as an indent nobody can see.
 */
export type Block =
  | { type: 'paragraph'; text: InlineNode[] }
  | { type: 'list'; ordered?: boolean; items: InlineNode[][] };

export type BlockType = Block['type'];

/**
 * `version` exists so a future vocabulary change is a migration rather than a
 * guess. A reader that does not recognise the version must fall back to
 * `description` (the plain-text projection) instead of rendering blocks it does
 * not understand.
 */
export const RICH_DOC_VERSION = 1;

export type RichDoc = {
  version: typeof RICH_DOC_VERSION;
  blocks: Block[];
};

export const EMPTY_DOC: RichDoc = { version: RICH_DOC_VERSION, blocks: [] };

/** The only URL schemes a description may link to. */
export const ALLOWED_LINK_SCHEMES = ['https:', 'http:', 'mailto:', 'tel:'] as const;

/**
 * Ceiling on how many blocks one document may carry.
 *
 * `description` is unbounded in this schema (no `maxlength`, no `.max()`), which
 * was survivable for a string and is not for a nested document: a malformed
 * client could otherwise store megabytes of blocks that every product read then
 * has to load. Paired with `express.json({ limit })` in `app.ts`, which bounds
 * the request itself.
 */
export const MAX_RICH_DOC_BLOCKS = 200;
