import { z } from 'zod';
import { BLOG_CATEGORY_KEYS, BLOG_LOCALES } from '../blog.types';

/**
 * Request schemas for the **public reader**.
 *
 * The editor's schemas — create, update, publish, the editor list query, and every author
 * schema — moved to wi-admin at Phase 5 Part A along with the service that enforced them
 * (`admin/src/modules/content/validators/article.validator.ts`). wi-admin is the only
 * writer now, so it is the authority on what a write may say.
 *
 * `ArticleKeySchema` and `ArticleSlugSchema` stay because the public surface still needs
 * both — the slug is half the `(locale, slug)` key a reader addresses an article by, and
 * the key is the stable id the frontend hashes for generated cover art. They are duplicated
 * in wi-admin rather than shared: there is no shared package, and `test:blog` asserts this
 * copy against the same fixture list wi-admin's `test:content` uses, so a drift on either
 * side turns both red.
 */

const LocaleSchema = z.enum(BLOG_LOCALES);

/**
 * A stable public id: `getting-paid-on-whatsapp`.
 *
 * ASCII-only, unlike a slug — it is never in a URL a reader sees, it is the key the
 * frontend hashes to generate an article's cover art, and keeping it ASCII means it reads
 * the same in a log line, a CSV export and a support conversation.
 */
export const ArticleKeySchema = z
  .string()
  .trim()
  .min(3)
  .max(200)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    'An id is lowercase letters, digits and single hyphens (e.g. "getting-paid-on-whatsapp")',
  );

/**
 * A localized slug.
 *
 * Deliberately wider than the id: Arabic and Portuguese slugs are legitimate, and forcing
 * ASCII would push `ar` articles onto transliterated paths that are worse for the reader
 * and worse for the keyword. Lowercase letters (any script), digits, single hyphens —
 * which still refuses spaces, slashes, uppercase and punctuation, i.e. everything that
 * makes a slug unsafe in a path.
 */
export const ArticleSlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(
    /^[\p{Ll}\p{Lo}\p{Nd}]+(?:-[\p{Ll}\p{Lo}\p{Nd}]+)*$/u,
    'A slug is lowercase letters, digits and single hyphens — no spaces, slashes or capitals',
  );

// ─── Public reads ────────────────────────────────────────────────────────────

/**
 * `GET /api/public/articles`.
 *
 * `locale` is required and has no default. A default would silently serve English to a
 * caller that forgot the parameter — on a multilingual blog that is a page of the wrong
 * language rather than an obvious failure.
 *
 * `limit`/`offset` are here before the frontend uses them: `/blog` renders every article on
 * one page today, which is fine for five and not fine past ~thirty, and the fix is
 * path-based pagination (`/blog/page/2`) rather than a "load more" button.
 */
export const PublicArticleListQuerySchema = z
  .object({
    locale: LocaleSchema,
    category: z.enum(BLOG_CATEGORY_KEYS).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(24),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

export type PublicArticleListQueryInput = z.infer<typeof PublicArticleListQuerySchema>;

/** `GET /api/public/articles/{slug}?locale=…` — the pair is the key. */
export const PublicArticleDetailQuerySchema = z.object({ locale: LocaleSchema }).strict();

export const PublicArticleSlugParamSchema = z.object({ slug: ArticleSlugSchema });
