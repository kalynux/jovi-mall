import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { articleRepository, ArticleRepository } from '../repositories/article.repository';
import { articleAuthorRepository, ArticleAuthorRepository } from '../repositories/article-author.repository';
import { IArticle } from '../models/article.model';
import { BlogLocale } from '../blog.types';
import {
  PublicArticleDetailDto,
  PublicArticleIndexRowDto,
  PublicArticleSummaryDto,
  toPublicArticleDetailDto,
  toPublicArticleIndexRowDto,
  toPublicArticleSummaryDto,
} from '../dto/public-article.dto';
import {
  PublicArticleListQueryInput,
} from '../validators/article.validator';

/**
 * Everything a logged-out reader can see.
 *
 * Two invariants hold across every method here, and both are load-bearing rather than
 * defensive:
 *
 * 1. **Only `status: 'published'` is ever returned.** A preview for editors is a separate,
 *    authenticated concern — deliberately *not* solved by returning drafts with a flag,
 *    which is one forgotten filter away from publishing unfinished prose.
 *
 *    ⚠ That preview lives in **wi-admin**, at `GET /api/v1/content/articles/:articleId/preview`.
 *    This comment named `GET /api/admin/articles/:id/preview` until 2026-08-25, a route
 *    deleted at the Phase 5 Part A cutover — see `modules/blog/index.ts`, which has said so
 *    correctly the whole time. wi-admin renders it through its own copy of the public DTO,
 *    verified field-for-field identical to `dto/public-article.dto.ts` here (BR-019 § 3) and
 *    now pinned by an assertion in wi-admin's `test:content` rather than by this sentence.
 * 2. **A missing translation is a 404, never a fallback.** `/pt/<english-slug>` must not
 *    exist. Substituting a default language publishes a page whose content contradicts its
 *    own `lang` attribute and competes with its own original.
 */
export class PublicArticleService {
  constructor(
    private readonly articles: ArticleRepository = articleRepository,
    private readonly authors: ArticleAuthorRepository = articleAuthorRepository,
  ) {}

  /**
   * The index and the category hubs, for one locale.
   *
   * Ordering is `publishedAt` descending — the same order the sitemap and the prev/next
   * links use, because they are three views of one sequence.
   */
  async list(query: PublicArticleListQueryInput): Promise<{
    items: PublicArticleSummaryDto[];
    total: number;
  }> {
    const { items, total } = await this.articles.listPublished(
      { locale: query.locale, category: query.category },
      query.limit,
      query.offset,
    );

    const authorMap = await this.authors.findByKeys(items.map((article) => article.author_key));

    const summaries = items
      .map((article) => {
        const translation = this.publishedTranslation(article, query.locale);
        // Unreachable: the query already matched on a published translation in this locale.
        // Filtered rather than asserted so a hand-edited document degrades to one missing
        // card instead of a 500 on the whole index.
        if (!translation) return null;
        return toPublicArticleSummaryDto(
          article,
          translation,
          authorMap.get(article.author_key) ?? null,
        );
      })
      .filter((summary): summary is PublicArticleSummaryDto => summary !== null);

    return { items: summaries, total };
  }

  /**
   * One article with its body, keyed by `(locale, slug)`.
   *
   * The four outcomes, in the order they are checked:
   *
   * | Situation | Answer |
   * |---|---|
   * | no article answers to this pair | `404 BLOG_ARTICLE_NOT_FOUND` |
   * | the article was archived | `410 BLOG_ARTICLE_GONE` + `details.categoryKey` |
   * | the pair matches a **retired** slug | `404 BLOG_ARTICLE_MOVED` + `details.slug` |
   * | the article exists, but not in this locale | `404 BLOG_ARTICLE_NOT_FOUND` |
   *
   * `BLOG_ARTICLE_MOVED` carries the current slug and **the frontend owes the 301**: this
   * API can only redirect its own URL, and the URL that needs redirecting is the *page*.
   * Answering with a machine-readable hint instead of an HTTP redirect is what lets the
   * page issue a permanent redirect for the address a reader actually typed.
   */
  async getBySlug(slug: string, locale: BlogLocale): Promise<PublicArticleDetailDto> {
    const article = await this.articles.findBySlug(locale, slug);
    if (!article) {
      throw createAppError(ERROR_CODES.BLOG_ARTICLE_NOT_FOUND, 404, undefined, { locale, slug });
    }

    if (article.status === 'archived') {
      throw createAppError(
        ERROR_CODES.BLOG_ARTICLE_GONE,
        410,
        undefined,
        // The hub is the useful destination for a reader who followed a dead link — a 404
        // on a URL with inbound links wastes them.
        { locale, slug, categoryKey: article.category_key },
      );
    }

    if (article.status !== 'published') {
      throw createAppError(ERROR_CODES.BLOG_ARTICLE_NOT_FOUND, 404, undefined, { locale, slug });
    }

    const translation = this.publishedTranslation(article, locale);
    if (!translation) {
      // Either this language was never written or it is still drafted. Both are a 404 by
      // decision 3 — no fallback to another language.
      throw createAppError(ERROR_CODES.BLOG_ARTICLE_NOT_FOUND, 404, undefined, { locale, slug });
    }

    if (translation.slug !== slug) {
      throw createAppError(ERROR_CODES.BLOG_ARTICLE_MOVED, 404, undefined, {
        locale,
        slug: translation.slug,
        previousSlug: slug,
        id: article.key,
      });
    }

    const author = await this.authors.findByKey(article.author_key);
    return toPublicArticleDetailDto(article, translation, author);
  }

  /**
   * Every `(locale, slug)` pair plus dates — `generateStaticParams` and `app/sitemap.ts`.
   *
   * Separate from `list()` because the build needs every pair in one round-trip, and paying
   * for five paginated calls with full summaries to get a list of slugs would be the
   * slowest part of it. Unpaginated on purpose.
   */
  async index(): Promise<PublicArticleIndexRowDto[]> {
    const articles = await this.articles.listAllPublished();
    return articles
      .map(toPublicArticleIndexRowDto)
      // An article whose every translation is drafted has no route to enumerate. It stays
      // out of the sitemap rather than contributing a row with an empty alternates set.
      .filter((row) => row.translations.length > 0);
  }

  private publishedTranslation(article: IArticle, locale: BlogLocale) {
    return article.translations.find(
      (translation) => translation.locale === locale && translation.published,
    );
  }
}

export const publicArticleService = new PublicArticleService();
