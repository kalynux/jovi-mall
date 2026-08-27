import { Schema, model } from 'mongoose';
import { IBaseDocument, BaseSchemaFields, BaseSchemaOptions } from '../../../core/base.schema';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';
import { SUPPORTED_LANGUAGES } from '../../../core/constants/languages';
import {
  BLOG_ARTICLE_STATUSES,
  BLOG_CATEGORY_KEYS,
  BlogArticleStatus,
  BlogCategoryKey,
  BlogLocale,
} from '../blog.types';
import { ArticleBody } from '../validators/article-body.validator';

/**
 * A cover image. Optional — see the note on generated cover art in `api-doc/public/articles.md`.
 *
 * ⚠ **The alt text is NOT here — it is per-locale, on the translation as `cover_alt`.** One
 * article is published in up to five languages off this one image, and a single shared `alt`
 * put English words into a French screen reader and onto the French page's `og:image`. The
 * image itself stays shared: `url`, `width` and `height` are properties of the file rather
 * than of the prose.
 *
 * **The PUBLIC shape did not change.** `PublicArticleSummaryDto.cover` still carries
 * `{ url, alt, width, height }` — `dto/public-article.dto.ts` reassembles it from whichever
 * translation is being served, so this migration was invisible to the marketing frontend.
 *
 * ⚠ Written by **wi-admin**, not here (ADR-004 D-4). Changing this interface is half a
 * change: `admin/src/modules/content/domain/article.document.ts` holds the writer's copy and
 * both suites pin the pair.
 */
export interface IArticleCover {
  url: string;
  /** Required, both of them: they reserve the box so a loading image does not shift the page. */
  width: number;
  height: number;
}

export interface IArticleTranslation {
  locale: BlogLocale;
  /**
   * Localized and **unique within its locale**. Not the English slug under a French prefix:
   * the keyword in the path is a meaningful part of why the page ranks, and French is where
   * the competition is thinnest.
   */
  slug: string;
  title: string;
  meta_title: string | null;
  excerpt: string;
  body: ArticleBody;
  /**
   * Alt text for the article's shared cover image, in **this** language.
   *
   * `null` while unwritten, which is legal on a draft and refused at publish by wi-admin's
   * `collectPublishBlockers` — so on any article this public reader can serve, every
   * published translation with a cover has one.
   *
   * Inline images inside `body` carry their own `alt` and always have: `body` is
   * per-translation, so those were never the problem this field fixes.
   */
  cover_alt: string | null;
  /** Words in `body`, derived on write — never accepted from the editor. */
  word_count: number;
  /**
   * Whether this language is live. An article can be published while one of its
   * translations is still being written; that language simply 404s until this flips.
   */
  published: boolean;
  /**
   * Slugs this translation used to have, oldest first.
   *
   * A published slug is immutable in practice — changing one throws away whatever ranking
   * the URL had. When one must change anyway, the old path still has inbound links, so it
   * is kept here and `GET /api/public/articles/{slug}` answers `BLOG_ARTICLE_MOVED` with
   * the current slug rather than a bare 404. They are also indexed for uniqueness, so no
   * other article can claim a retired slug and make the redirect ambiguous.
   */
  previous_slugs: string[];
}

export interface IArticle extends IBaseDocument {
  /**
   * The article's stable public id — `getting-paid-on-whatsapp`, not an ObjectId.
   *
   * Stable across translations AND across edits: the frontend derives its generated cover
   * art deterministically from it, so a change would repaint an article the reader has
   * already seen. Immutable once created.
   */
  key: string;
  category_key: BlogCategoryKey;
  /** `ArticleAuthor.key`, not an ObjectId — authors are addressed by their stable id too. */
  author_key: string;

  status: BlogArticleStatus;
  featured: boolean;
  cover: IArticleCover | null;

  /**
   * When the article first went live. Set on first publish (or backdated by the editor on
   * import) and **kept** across an unpublish/republish cycle, because it is the sort key
   * the index, the sitemap and the prev/next links at the foot of an article all share —
   * re-stamping it would silently reorder pages that link to each other.
   */
  published_at: Date | null;
  /**
   * When the prose last changed. Null until a published article is revised — a `featured`
   * toggle or a category move is not a revision, so this is stamped from an actual content
   * comparison rather than from Mongoose's `updatedAt`, which moves on every save.
   */
  content_updated_at: Date | null;
  archived_at: Date | null;

  translations: IArticleTranslation[];

  /**
   * `"<locale>:<slug>"` for every current **and** retired slug — the lookup key for
   * `GET /api/public/articles/{slug}?locale=…` and the only place slug uniqueness is
   * enforced.
   *
   * It exists because MongoDB cannot build a compound unique index on two fields of the
   * same array (`translations.locale` + `translations.slug` are parallel array paths and
   * are refused at write time). Flattening the pair into one string turns it into an
   * ordinary unique multikey index. Derived on every write by `buildSlugKeys` — never set
   * by hand.
   */
  slug_keys: string[];
}

const ArticleCoverSchema = new Schema<IArticleCover>(
  {
    url: { type: String, required: true, trim: true },
    width: { type: Number, required: true, min: 1 },
    height: { type: Number, required: true, min: 1 },
  },
  { _id: false },
);

const ArticleTranslationSchema = new Schema<IArticleTranslation>(
  {
    locale: { type: String, enum: SUPPORTED_LANGUAGES, required: true },
    slug: { type: String, required: true, trim: true, maxlength: 200 },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    meta_title: { type: String, default: null, trim: true, maxlength: 200 },
    excerpt: { type: String, required: true, trim: true, maxlength: 400 },
    // Mixed, on purpose: the block union is 9 types deep and `ArticleBodySchema` is its one
    // authority. A parallel Mongoose declaration would be a second copy nothing keeps in
    // step. The rule that makes this safe: no write path may set a body that did not come
    // through that Zod schema.
    body: { type: Schema.Types.Mixed, required: true },
    cover_alt: { type: String, default: null, trim: true, maxlength: 300 },
    word_count: { type: Number, required: true, default: 0, min: 0 },
    published: { type: Boolean, required: true, default: true },
    previous_slugs: { type: [String], default: [] },
  },
  { _id: false },
);

/**
 * One article, in every language it exists in — **not one document per language**.
 *
 * The English and French versions of a post are the same document. The pages need to know
 * they are related in order to emit `hreflang` linking them, and the sitemap submits one row
 * per article carrying its language alternates; storing them as unrelated documents makes
 * that impossible to reconstruct after the fact.
 *
 * The corollary is that a **missing translation is a 404, not a fallback**. Serving English
 * prose at a Portuguese URL publishes a page whose content contradicts its own `lang`
 * attribute and competes with its own original. Nothing in this module substitutes a default
 * language for a missing one — the single deliberate exception is the author *bio*, which
 * falls back to English, because a blank byline where the structured data expects an author
 * is worse than a bio in the wrong language.
 */
const ArticleSchema = new Schema<IArticle>({
  key: { type: String, required: true, trim: true, maxlength: 200 },
  category_key: { type: String, enum: BLOG_CATEGORY_KEYS, required: true },
  author_key: { type: String, required: true, trim: true, maxlength: 200 },

  status: { type: String, enum: BLOG_ARTICLE_STATUSES, required: true, default: 'draft' },
  featured: { type: Boolean, required: true, default: false },
  cover: { type: ArticleCoverSchema, default: null },

  published_at: { type: Date, default: null },
  content_updated_at: { type: Date, default: null },
  archived_at: { type: Date, default: null },

  translations: { type: [ArticleTranslationSchema], default: [] },
  slug_keys: { type: [String], default: [] },

  ...BaseSchemaFields,
}, BaseSchemaOptions);

/** The public id. Unique across every article, draft ones included. */
ArticleSchema.index({ key: 1 }, { unique: true });

/**
 * Slug uniqueness, per locale, across current and retired slugs.
 *
 * Sparse so a draft with no translations yet does not collide with every other draft on an
 * empty array. Duplicate entries *within* one document are fine — Mongo de-duplicates before
 * checking a multikey unique index — which is what lets a translation keep a slug it had,
 * lost, and took back.
 */
ArticleSchema.index({ slug_keys: 1 }, { unique: true, sparse: true });

/**
 * The index and the category hubs: published articles that have a live translation in one
 * locale, newest first. `_id` is in the sort key as a tie-break — two articles published in
 * the same second must order identically in the list, the sitemap and the prev/next links,
 * or prev/next stops matching what the index showed.
 */
ArticleSchema.index({ status: 1, 'translations.locale': 1, published_at: -1, _id: -1 });
ArticleSchema.index({ status: 1, category_key: 1, published_at: -1, _id: -1 });

/** The editor's inbox, and the "which articles use this author?" check before a delete. */
ArticleSchema.index({ author_key: 1 });

export const ArticleModel = model<IArticle>(MODELS.ARTICLE, ArticleSchema, COLLECTIONS.ARTICLE);

// ─── Derivations shared by every write path ──────────────────────────────────

/** The lookup key for one `(locale, slug)` pair. */
export function slugKey(locale: string, slug: string): string {
  return `${locale}:${slug}`;
}

/**
 * Every `(locale, slug)` this article answers to — current slugs and retired ones.
 *
 * Retired slugs are included so that no *other* article can claim one: a reused slug turns
 * a permanent redirect into a wrong answer, which is worse than the 404 it was avoiding.
 */
export function buildSlugKeys(translations: IArticleTranslation[]): string[] {
  const keys = new Set<string>();
  for (const translation of translations) {
    keys.add(slugKey(translation.locale, translation.slug));
    for (const previous of translation.previous_slugs) {
      keys.add(slugKey(translation.locale, previous));
    }
  }
  return [...keys];
}
