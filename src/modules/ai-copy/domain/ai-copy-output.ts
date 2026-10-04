import {
  Block,
  InlineNode,
  RICH_DOC_VERSION,
  RichDoc,
  normalizeDoc,
  richDocSchema,
  toPlainText,
  truncateDoc,
} from '../../../core/richtext';
import { matchCategory, cleanCategoryName, CategoryCandidate } from '../../categories/domain/category-match';
import { AiCopyField, AiCopyResults, AiCopyCategorySuggestion } from '../ai-copy.types';

/**
 * What survives of a model's answer. PURE — no I/O — so `test:ai-copy` can drive it.
 *
 * Everything the workflow returns is untrusted: the model was ASKED for a shape, and a
 * cheap model asked for a shape returns roughly that shape. This is the line between
 * "roughly" and what a vendor pays for. A field either comes out meeting its rule or it
 * goes into `failed` and is refunded — never half-broken, because the dashboard would
 * then show a field the vendor paid for and cannot use.
 *
 * Where a value is fixable without changing what it says (an SEO title three characters
 * long, a `#` on a tag, a bare URL in a sentence) it is fixed. Where it is not, it fails.
 */

export const DESCRIPTION_MAX_CHARS = 3776; // 4096 minus the share header
export const DESCRIPTION_MAX_LIST_ITEMS = 12;
export const SEO_TITLE_MAX = 60;
export const SEO_DESCRIPTION_MAX = 160;
export const TAGS_MIN = 3;
export const TAGS_MAX = 10;
export const TAG_MAX_WORDS = 3;
export const TAG_MAX_CHARS = 40;
export const CATEGORY_SUGGESTIONS_MAX = 3;

const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu;
const URL = /\b(?:https?:\/\/|www\.)\S+/gi;

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Cut at the last word boundary that fits. A hard cut only when one word is longer than the budget. */
export function clampAtWord(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max + 1);
  const space = cut.lastIndexOf(' ');
  const out = space > max * 0.5 ? cut.slice(0, space) : value.slice(0, max);
  return out.replace(/[\s,;:–—-]+$/u, '');
}

function cleanLine(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null;
  const text = collapse(raw.replace(EMOJI, '').replace(URL, ''));
  if (!text) return null;
  return clampAtWord(text, max);
}

// ─── description ─────────────────────────────────────────────────────────────

function cleanInline(raw: unknown): InlineNode[] {
  if (!Array.isArray(raw)) return [];
  const out: InlineNode[] = [];
  for (const node of raw) {
    // Links are dropped whole, label included: the model has no URL it could know, so any
    // it returns is invented, and a label without its target is a sentence about nothing.
    if (!node || typeof node !== 'object' || (node as any).type !== 'text') continue;
    const text = String((node as any).text ?? '').replace(URL, '');
    if (!text) continue;
    const n: InlineNode = { type: 'text', text };
    if ((node as any).bold === true) n.bold = true;
    if ((node as any).italic === true) n.italic = true;
    if ((node as any).strike === true) n.strike = true;
    out.push(n);
  }
  return out;
}

/** Accepts `{ blocks }` or `{ descriptionRich: { blocks } }` — the workflow may send either. */
export function sanitizeDescription(raw: unknown): RichDoc | null {
  if (!raw || typeof raw !== 'object') return null;
  const source: any = (raw as any).descriptionRich ?? raw;
  if (!Array.isArray(source.blocks)) return null;

  const blocks: Block[] = [];
  let listItems = 0;
  for (const block of source.blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'paragraph') {
      blocks.push({ type: 'paragraph', text: cleanInline(block.text) });
    } else if (block.type === 'list' && Array.isArray(block.items)) {
      const room = DESCRIPTION_MAX_LIST_ITEMS - listItems;
      if (room <= 0) continue;
      const items = block.items.map(cleanInline).filter((i: InlineNode[]) => i.length > 0).slice(0, room);
      listItems += items.length;
      blocks.push(block.ordered === true ? { type: 'list', ordered: true, items } : { type: 'list', items });
    }
    // Anything else (a "heading", an image) is not in the vocabulary and is dropped.
  }

  let doc = normalizeDoc({ version: RICH_DOC_VERSION, blocks });
  if (doc.blocks.length === 0) return null;
  doc = truncateDoc(doc, DESCRIPTION_MAX_CHARS).doc;

  // The same validator every product write runs. If this refuses, so would the save.
  const parsed = richDocSchema.safeParse(doc);
  if (!parsed.success) return null;
  if (toPlainText(doc).length === 0) return null;
  return doc;
}

// ─── tags ────────────────────────────────────────────────────────────────────

export function sanitizeTags(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of raw) {
    if (typeof t !== 'string') continue;
    const tag = collapse(t.replace(EMOJI, '').replace(/#/g, '').replace(/[,;]+/g, ' '));
    if (!tag || tag.length > TAG_MAX_CHARS || tag.split(' ').length > TAG_MAX_WORDS) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length === TAGS_MAX) break;
  }
  return out.length >= TAGS_MIN ? out : null;
}

// ─── categories ──────────────────────────────────────────────────────────────

/**
 * Ids are checked against the CANDIDATES that were sent — not merely against the whole
 * list — because an id the model was never shown is one it made up, even when it happens to
 * be real. Names come from the catalogue, never from the model.
 *
 * A name-only proposal is allowed once, and only when no candidate was picked. One that is
 * an exact spelling (or merged alias) of an existing category is turned into that category,
 * so the vendor is not offered a "new" one that is already there.
 */
export function sanitizeCategories(
  raw: unknown,
  candidates: readonly CategoryCandidate[],
  catalog: readonly CategoryCandidate[],
): AiCopyCategorySuggestion[] | null {
  if (!Array.isArray(raw)) return null;
  const allowed = new Map(candidates.map((c) => [c.id, c]));
  const picked: AiCopyCategorySuggestion[] = [];
  const seen = new Set<string>();
  let proposal: AiCopyCategorySuggestion | null = null;

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const id = typeof (entry as any).id === 'string' ? (entry as any).id.trim() : '';
    if (id) {
      const hit = allowed.get(id);
      if (hit && !seen.has(hit.id)) {
        seen.add(hit.id);
        picked.push({ id: hit.id, name: hit.name });
      }
      continue;
    }
    if (proposal) continue;
    const name = typeof (entry as any).name === 'string' ? cleanCategoryName((entry as any).name) : null;
    if (!name) continue;
    const verdict = matchCategory(name, catalog);
    proposal = verdict.kind === 'exact' ? { id: verdict.category.id, name: verdict.category.name } : { name };
  }

  if (picked.length > 0) return picked.slice(0, CATEGORY_SUGGESTIONS_MAX);
  return proposal ? [proposal] : null;
}

// ─── all of it ───────────────────────────────────────────────────────────────

export interface SanitizeContext {
  candidates: readonly CategoryCandidate[];
  catalog: readonly CategoryCandidate[];
}

/**
 * Keep only the REQUESTED fields that survive. Anything the model returned and was not asked
 * for is ignored — the vendor pays per requested field, and an unrequested one is unpaid.
 */
export function sanitizeOutput(
  fields: readonly AiCopyField[],
  output: Record<string, unknown> | undefined,
  ctx: SanitizeContext,
): { results: AiCopyResults; failed: AiCopyField[] } {
  const results: AiCopyResults = {};
  const failed: AiCopyField[] = [];
  const o = output ?? {};

  for (const field of fields) {
    switch (field) {
      case 'description': {
        const doc = sanitizeDescription(o.description);
        if (doc) results.description = { descriptionRich: doc };
        else failed.push(field);
        break;
      }
      case 'tags': {
        const tags = sanitizeTags(o.tags);
        if (tags) results.tags = tags;
        else failed.push(field);
        break;
      }
      case 'seoTitle': {
        const v = cleanLine(o.seoTitle, SEO_TITLE_MAX);
        if (v) results.seoTitle = v;
        else failed.push(field);
        break;
      }
      case 'seoDescription': {
        const v = cleanLine(o.seoDescription, SEO_DESCRIPTION_MAX);
        if (v) results.seoDescription = v;
        else failed.push(field);
        break;
      }
      case 'categories': {
        const c = sanitizeCategories(o.categories, ctx.candidates, ctx.catalog);
        if (c) results.categories = c;
        else failed.push(field);
        break;
      }
    }
  }
  return { results, failed };
}
