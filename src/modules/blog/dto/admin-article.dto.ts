import { IArticle, IArticleCover } from '../models/article.model';
import { IArticleAuthor } from '../models/article-author.model';
import { ArticleBody } from '../validators/article-body.validator';
import { BlogArticleStatus, BlogAuthorType, BlogCategoryKey, BlogLocale } from '../blog.types';
import { availableLocalesOf } from './public-article.dto';

/**
 * The editor's view — everything the public projection hides.
 *
 * Deliberately a different shape from `PublicArticleSummaryDto` rather than "the public one
 * plus flags": drafts, retired slugs and per-locale publish state are the editor's whole
 * job and none of them belong on a public page. Keeping the two apart is also what stops a
 * "return drafts with a flag" preview from creeping into the public endpoints — the way §9
 * of the requirements asks it not to be solved.
 */

export interface AdminArticleTranslationDto {
  locale: BlogLocale;
  slug: string;
  title: string;
  metaTitle: string | null;
  excerpt: string;
  body: ArticleBody;
  wordCount: number;
  published: boolean;
  /** Retired slugs, oldest first. Each one answers `BLOG_ARTICLE_MOVED` on the public route. */
  previousSlugs: string[];
}

export interface AdminArticleDto {
  id: string;
  status: BlogArticleStatus;
  categoryKey: BlogCategoryKey;
  authorId: string;
  /** Resolved so the list does not need a second call; null if the byline was removed. */
  author: { id: string; name: string; type: BlogAuthorType } | null;
  featured: boolean;
  cover: IArticleCover | null;
  publishedAt: string | null;
  /** Content revisions only — a `featured` toggle does not move this. */
  updatedAt: string | null;
  archivedAt: string | null;
  availableLocales: BlogLocale[];
  translations: AdminArticleTranslationDto[];
  createdAt: string;
  lastSavedAt: string;
}

export function toAdminArticleDto(article: IArticle, author: IArticleAuthor | null): AdminArticleDto {
  return {
    id: article.key,
    status: article.status,
    categoryKey: article.category_key,
    authorId: article.author_key,
    author: author ? { id: author.key, name: author.name, type: author.type } : null,
    featured: article.featured,
    cover: article.cover ?? null,
    publishedAt: article.published_at ? article.published_at.toISOString() : null,
    updatedAt: article.content_updated_at ? article.content_updated_at.toISOString() : null,
    archivedAt: article.archived_at ? article.archived_at.toISOString() : null,
    availableLocales: availableLocalesOf(article),
    translations: article.translations.map((translation) => ({
      locale: translation.locale,
      slug: translation.slug,
      title: translation.title,
      metaTitle: translation.meta_title ?? null,
      excerpt: translation.excerpt,
      body: translation.body,
      wordCount: translation.word_count,
      published: translation.published,
      previousSlugs: [...translation.previous_slugs],
    })),
    createdAt: article.createdAt.toISOString(),
    // Mongoose's own `updatedAt`: when the row was last written, for any reason. Named
    // apart from the content `updatedAt` above because conflating "somebody saved this" with
    // "the prose changed" is what would put a wrong `dateModified` in the structured data.
    lastSavedAt: article.updatedAt.toISOString(),
  };
}

export interface AdminAuthorDto {
  id: string;
  name: string;
  type: BlogAuthorType;
  avatarUrl: string | null;
  translations: Record<string, { title: string; bio: string }>;
  articleCount?: number;
}

export function toAdminAuthorDto(author: IArticleAuthor, articleCount?: number): AdminAuthorDto {
  const translations: Record<string, { title: string; bio: string }> = {};
  for (const [locale, translation] of author.translations.entries()) {
    translations[locale] = { title: translation.title, bio: translation.bio };
  }

  return {
    id: author.key,
    name: author.name,
    type: author.type,
    avatarUrl: author.avatar_url ?? null,
    translations,
    ...(articleCount !== undefined ? { articleCount } : {}),
  };
}
