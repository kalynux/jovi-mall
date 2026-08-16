import { z } from 'zod';
import {
  ALLOWED_LINK_SCHEMES,
  MAX_RICH_DOC_BLOCKS,
  RICH_DOC_VERSION,
  type RichDoc,
} from './types';

/**
 * Runtime validation for a `RichDoc`, and the security boundary for links.
 *
 * This is the executable half of the contract: the vendor dashboard's
 * `lib/richtext/schema.ts` is this file, so the two sides accept and reject
 * exactly the same documents.
 *
 * It sits in the same position `blog/validators/article-body.validator.ts` does
 * for article bodies — what this union accepts is what a formatter will later be
 * asked to render, and Mongoose stores the value as `Mixed`, so nothing below
 * this schema re-checks the shape.
 */

/**
 * Scheme allowlist, checked HERE rather than at render time.
 *
 * A `javascript:` href caught only by a renderer is one missed call site away
 * from being live; one rejected at the boundary cannot reach a renderer at all.
 * Relative hrefs are rejected too — a product description is read inside
 * WhatsApp, where there is no origin for a relative URL to resolve against.
 */
export function isAllowedHref(href: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(href);
  } catch {
    return false;
  }
  return (ALLOWED_LINK_SCHEMES as readonly string[]).includes(parsed.protocol);
}

const marks = {
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  strike: z.boolean().optional(),
};

const textNodeSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
  ...marks,
});

const linkNodeSchema = z.object({
  type: z.literal('link'),
  text: z.string(),
  href: z.string().refine(isAllowedHref, {
    message: 'Unsupported link scheme — use https, http, mailto or tel',
  }),
  ...marks,
});

export const inlineNodeSchema = z.discriminatedUnion('type', [textNodeSchema, linkNodeSchema]);

const paragraphSchema = z.object({
  type: z.literal('paragraph'),
  text: z.array(inlineNodeSchema),
});

const listSchema = z.object({
  type: z.literal('list'),
  ordered: z.boolean().optional(),
  items: z.array(z.array(inlineNodeSchema)),
});

export const blockSchema = z.discriminatedUnion('type', [paragraphSchema, listSchema]);

export const richDocSchema = z.object({
  version: z.literal(RICH_DOC_VERSION),
  blocks: z.array(blockSchema).max(MAX_RICH_DOC_BLOCKS, 'Description has too many blocks'),
});

/**
 * Parse an untrusted value into a `RichDoc`, or return `null`.
 *
 * Null rather than throwing, because every reader's fallback is the same and it
 * is a good one: fall back to the plain-text `description` the product also
 * carries. Use this when READING a stored document — `descriptionRich` is a
 * `Mixed` column, so a row written before a vocabulary change, or by an older
 * client, can be anything at all. Write paths use `richDocSchema` through the
 * request validators instead, where a rejection is the correct answer.
 */
export function parseRichDoc(value: unknown): RichDoc | null {
  if (value == null) return null;
  const result = richDocSchema.safeParse(value);
  return result.success ? (result.data as RichDoc) : null;
}
