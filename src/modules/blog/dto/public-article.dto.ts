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
  cover: IArticleCover | null;
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
    cover: article.cover ?? null,
    wordCount: translation.word_count,
    availableLocales: availableLocalesOf(article),
  };
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
