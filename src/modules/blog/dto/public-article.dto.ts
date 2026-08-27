import { IArticle, IArticleCover, IArticleTranslation } from '../models/article.model';
import { IArticleAuthor } from '../models/article-author.model';
import { ArticleBody } from '../validators/article-body.validator';
import { BLOG_LOCALES, BlogAuthorType, BlogCategoryKey, BlogLocale } from '../blog.types';
import { DEFAULT_LANGUAGE } from '../../../core/constants/languages';

/**
 * The article shape a logged-out reader gets.
 *
 * A **projection**, like `public-plan.dto.ts` — `_id`, `deletedAt`, `__v`, the audit
 * timestamps and every draft-only field are internal bookkeeping with no business on a
 * public page. Adding a field to `Article` does not publish it; that is an edit here, on
 * purpose.
 *
 * Two shapes, one flattening rule: the *summary* is everything except `body`, and the
 * *detail* is the summary plus `body`. Both flatten the requested translation onto the
 * article, because the reader is on one page in one language and re-implementing "find my
 * locale in this array" in the frontend for every card is work the API can do once.
 *
 * ### Optional keys are omitted, not nulled
 *
 * `metaTitle` and `updatedAt` are **absent** when unset rather than `null`, matching the
 * frontend's `blog.types.ts` where both are `?:`. `cover` is the exception — it is emitted
 * as an explicit `null`, because "this article has no cover" is a state the card renders
 * (generated cover art) rather than a field it skips.
 */

/**
 * The cover as a **reader** receives it: the shared image, plus the alt text for the one
 * language being served.
 *
 * ⚠ **This shape is unchanged on the wire, and that is the point.** The stored
 * `IArticleCover` lost its `alt` when alt text became per-locale, but a public consumer
 * still gets exactly `{ url, alt, width, height }` — this projection reassembles it from the
 * resolved translation. So the marketing frontend needed no change for that migration.
 */
export interface PublicArticleCover extends IArticleCover {
  alt: string;
}

export interface PublicAuthorDto {
  id: string;
  name: string;
  type: BlogAuthorType;
  /** Job title, in the requested locale — English if that language has no bio. */
  title: string;
  bio: string;
  avatarUrl: string | null;
}

export interface PublicArticleSummaryDto {
  id: string;
  locale: BlogLocale;
  slug: string;
  title: string;
  metaTitle?: string;
  excerpt: string;
  categoryKey: BlogCategoryKey;
  author: PublicAuthorDto | null;
  publishedAt: string;
  updatedAt?: string;
  featured: boolean;
  cover: PublicArticleCover | null;
  wordCount: number;
  /**
   * Exactly the locales this article is **published** in — what the frontend turns into
   * `pathByLocale` for `hreflang`. A locale whose translation exists but is still drafted
   * is not in here, because its URL 404s.
   */
  availableLocales: BlogLocale[];
}

export interface PublicArticleDetailDto extends PublicArticleSummaryDto {
  body: ArticleBody;
}

/** One row of `GET /api/public/articles/index` — enough to enumerate a route, nothing else. */
export interface PublicArticleIndexRowDto {
  id: string;
  categoryKey: BlogCategoryKey;
  publishedAt: string;
  updatedAt?: string;
  translations: Array<{ locale: BlogLocale; slug: string }>;
}

/**
 * Resolve a byline into one language.
 *
 * **The one deliberate fallback in this module.** Article prose never falls back — serving
 * English at a Portuguese URL publishes a page that contradicts its own `lang` attribute and
 * competes with its own original. A bio is different: a blank byline where the structured
 * data expects an author is worse than a bio in the wrong language.
 */
export function toPublicAuthorDto(author: IArticleAuthor, locale: BlogLocale): PublicAuthorDto {
  const translation = author.translations.get(locale) ?? author.translations.get(DEFAULT_LANGUAGE);

  return {
    id: author.key,
    name: author.name,
    type: author.type,
    title: translation?.title ?? '',
    bio: translation?.bio ?? '',
    avatarUrl: author.avatar_url ?? null,
  };
}

/** Published locales, in the platform's canonical language order so the list is stable. */
export function availableLocalesOf(article: IArticle): BlogLocale[] {
  const published = new Set(
    article.translations.filter((translation) => translation.published).map((t) => t.locale),
  );
  return BLOG_LOCALES.filter((locale) => published.has(locale));
}

function baseSummary(
  article: IArticle,
  translation: IArticleTranslation,
  author: IArticleAuthor | null,
): PublicArticleSummaryDto {
  return {
    id: article.key,
    locale: translation.locale,
    slug: translation.slug,
    title: translation.title,
    ...(translation.meta_title ? { metaTitle: translation.meta_title } : {}),
    excerpt: translation.excerpt,
    categoryKey: article.category_key,
    author: author ? toPublicAuthorDto(author, translation.locale) : null,
    // Non-null by construction: `published_at` is stamped before `status` becomes
    // `published`, and nothing without that status reaches a public DTO.
    publishedAt: (article.published_at ?? article.createdAt).toISOString(),
    ...(article.content_updated_at ? { updatedAt: article.content_updated_at.toISOString() } : {}),
    featured: article.featured,
    cover: coverFor(article, translation),
    wordCount: translation.word_count,
    availableLocales: availableLocalesOf(article),
  };
}

/**
 * The shared cover image, described in the language being served.
 *
 * ── Why `title` stands in when `cover_alt` is unset ───────────────────────────
 * On this public route it cannot be: wi-admin's `collectPublishBlockers` refuses to publish a
 * translation going live with a cover and no alt text for it, so every published locale has
 * one. The branch is defensive only — it exists so that an article written before alt text
 * became per-locale renders a real description rather than `alt: ""`, which is not "missing"
 * but the HTML for *this image is decorative, skip it*, and that is a lie about a cover.
 *
 * The stand-in is the article's own title in that **same** language, so it is never blank and
 * never the wrong language — this is not the cross-locale fallback the module rules out.
 */
function coverFor(article: IArticle, translation: IArticleTranslation): PublicArticleCover | null {
  if (!article.cover) return null;
  return { ...article.cover, alt: translation.cover_alt ?? translation.title };
}

export function toPublicArticleSummaryDto(
  article: IArticle,
  translation: IArticleTranslation,
  author: IArticleAuthor | null,
): PublicArticleSummaryDto {
  return baseSummary(article, translation, author);
}

export function toPublicArticleDetailDto(
  article: IArticle,
  translation: IArticleTranslation,
  author: IArticleAuthor | null,
): PublicArticleDetailDto {
  return { ...baseSummary(article, translation, author), body: translation.body };
}

export function toPublicArticleIndexRowDto(article: IArticle): PublicArticleIndexRowDto {
  return {
    id: article.key,
    categoryKey: article.category_key,
    publishedAt: (article.published_at ?? article.createdAt).toISOString(),
    ...(article.content_updated_at ? { updatedAt: article.content_updated_at.toISOString() } : {}),
    translations: article.translations
      .filter((translation) => translation.published)
      .map((translation) => ({ locale: translation.locale, slug: translation.slug })),
  };
}
