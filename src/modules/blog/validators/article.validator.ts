import { z } from 'zod';
import { BLOG_CATEGORY_KEYS, BLOG_AUTHOR_TYPES, BLOG_LOCALES } from '../blog.types';
import { ArticleBodySchema } from './article-body.validator';

/**
 * Request schemas for both halves of the blog: the public reader and the editor.
 *
 * Reserved-slug and cross-article uniqueness checks are **not** here — they need the
 * database, so they live in `ArticleService`. Everything expressible without a query is
 * here, so a malformed body never reaches a service.
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

const CoverSchema = z
  .object({
    url: z
      .string()
      .trim()
      .min(1)
      .max(2048)
      .refine(
        (url) => /^https?:\/\//i.test(url) || (url.startsWith('/') && !url.startsWith('//')),
        'A cover url must be an http(s):// URL or an internal path starting with "/"',
      ),
    alt: z.string().trim().min(1).max(300),
    // Required for the same reason an inline image's are: they reserve the box. A cover is
    // also the `og:image`, so 16:9 at ≥1200px wide is the recommendation (1200×630 is the
    // social-card floor) — a recommendation, not a rule, so it is not enforced here.
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict();

/**
 * One language of an article.
 *
 * `published` defaults to true: adding a translation normally means shipping it. Set it
 * false to draft a language on a live article — that locale then 404s, which is the correct
 * behaviour for a missing translation and the reason there is no fallback anywhere else.
 */
export const ArticleTranslationSchema = z
  .object({
    locale: LocaleSchema,
    slug: ArticleSlugSchema,
    title: z.string().trim().min(1).max(200),
    metaTitle: z.string().trim().min(1).max(200).optional(),
    excerpt: z.string().trim().min(1).max(400),
    body: ArticleBodySchema,
    published: z.boolean().optional().default(true),
  })
  .strict();

/** The translations array, with the one rule that spans its elements: one row per language. */
const TranslationsSchema = z
  .array(ArticleTranslationSchema)
  .min(1, 'An article needs at least one translation')
  .max(BLOG_LOCALES.length)
  .superRefine((translations, ctx) => {
    const seen = new Map<string, number>();
    translations.forEach((translation, index) => {
      const first = seen.get(translation.locale);
      if (first !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'locale'],
          message: `Duplicate translation for "${translation.locale}" (already given at index ${first})`,
        });
        return;
      }
      seen.set(translation.locale, index);
    });
  });

/**
 * Create an article. Always lands as a **draft** — `status` is not settable here, because
 * "created" and "published" are different decisions and the second one has a checklist
 * (`POST /:id/publish`) that a create body could quietly skip.
 */
export const CreateArticleSchema = z
  .object({
    id: ArticleKeySchema,
    categoryKey: z.enum(BLOG_CATEGORY_KEYS),
    authorId: ArticleKeySchema,
    featured: z.boolean().optional().default(false),
    cover: CoverSchema.nullable().optional(),
    translations: TranslationsSchema,
  })
  .strict();

export type CreateArticleInput = z.infer<typeof CreateArticleSchema>;

/**
 * Update an article. `id` is absent on purpose — it is stable across edits by contract, and
 * the frontend derives an article's generated cover art from it.
 *
 * `translations`, when given, is a **full-array replace**, not a merge: a partial merge has
 * no way to express "remove the Spanish translation", and a per-locale endpoint would leave
 * the array's one cross-element rule (unique locales) unenforceable. Omit the key to leave
 * every translation untouched.
 */
export const UpdateArticleSchema = z
  .object({
    categoryKey: z.enum(BLOG_CATEGORY_KEYS).optional(),
    authorId: ArticleKeySchema.optional(),
    featured: z.boolean().optional(),
    cover: CoverSchema.nullable().optional(),
    translations: TranslationsSchema.optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, 'Nothing to update');

export type UpdateArticleInput = z.infer<typeof UpdateArticleSchema>;

/**
 * `POST /:id/publish`.
 *
 * `publishedAt` exists for one case: importing an article that was published elsewhere and
 * needs to keep its date. Left out, first publish stamps now — and a *re*-publish never
 * re-stamps, because `published_at` is the sort key the index, the sitemap and the prev/next
 * links share.
 */
export const PublishArticleSchema = z
  .object({
    publishedAt: z.coerce.date().optional(),
  })
  .strict();

export type PublishArticleInput = z.infer<typeof PublishArticleSchema>;

export const ArticleKeyParamSchema = z.object({ id: ArticleKeySchema });

/** The editor's list. Every status by default — a draft inbox is the point of it. */
export const AdminArticleQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    status: z.enum(['draft', 'published', 'archived']).optional(),
    category: z.enum(BLOG_CATEGORY_KEYS).optional(),
    locale: LocaleSchema.optional(),
    author: ArticleKeySchema.optional(),
  })
  .strict();

export type AdminArticleQueryInput = z.infer<typeof AdminArticleQuerySchema>;

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

// ─── Authors ─────────────────────────────────────────────────────────────────

const AuthorTranslationsSchema = z.record(
  z.enum(BLOG_LOCALES),
  z
    .object({
      title: z.string().trim().min(1).max(120),
      bio: z.string().trim().min(1).max(1000),
    })
    .strict(),
);

export const CreateAuthorSchema = z
  .object({
    id: ArticleKeySchema,
    name: z.string().trim().min(1).max(200),
    type: z.enum(BLOG_AUTHOR_TYPES),
    avatarUrl: z.string().trim().url().max(2048).nullable().optional(),
    // English is required, and it is the only one: it is the fallback every other locale
    // resolves to, so an author without it can produce a blank byline in four languages.
    translations: AuthorTranslationsSchema.refine(
      (translations) => Boolean(translations.en),
      'An author needs at least an English title and bio — it is the fallback for every other language',
    ),
  })
  .strict();

export type CreateAuthorInput = z.infer<typeof CreateAuthorSchema>;

export const UpdateAuthorSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    type: z.enum(BLOG_AUTHOR_TYPES).optional(),
    avatarUrl: z.string().trim().url().max(2048).nullable().optional(),
    /** Full replace, same reasoning as an article's translations. */
    translations: AuthorTranslationsSchema.refine(
      (translations) => Boolean(translations.en),
      'An author needs at least an English title and bio — it is the fallback for every other language',
    ).optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, 'Nothing to update');

export type UpdateAuthorInput = z.infer<typeof UpdateAuthorSchema>;

export const AuthorKeyParamSchema = z.object({ id: ArticleKeySchema });
