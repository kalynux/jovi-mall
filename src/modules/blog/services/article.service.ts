import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { Page, PaginationOptions } from '../../../core/repositories/base.repository';
import { articleRepository, ArticleRepository } from '../repositories/article.repository';
import { articleAuthorRepository, ArticleAuthorRepository } from '../repositories/article-author.repository';
import { buildSlugKeys, IArticle, IArticleTranslation } from '../models/article.model';
import { BlogLocale } from '../blog.types';
import {
  collectPublishBlockers,
  contentChanged,
  isReservedSlug,
  mergeTranslations,
  TranslationInput,
} from '../domain/article-content.rules';
import {
  AdminArticleQueryInput,
  CreateArticleInput,
  PublishArticleInput,
  UpdateArticleInput,
} from '../validators/article.validator';
import { AdminArticleDto, toAdminArticleDto } from '../dto/admin-article.dto';
import {
  PublicArticleDetailDto,
  toPublicArticleDetailDto,
} from '../dto/public-article.dto';

/**
 * The editor's half — every write, and the reads that show drafts.
 *
 * ## The lifecycle
 *
 * ```
 *   create ──▶ draft ──publish──▶ published ──archive──▶ archived
 *                 ▲                    │                     │
 *                 └────unpublish───────┘                     │
 *                 └───────────────unpublish──────────────────┘
 * ```
 *
 * `draft` and `archived` are both invisible publicly, but they are **not** the same state
 * and collapsing them would lose the distinction that matters: an archived URL answers
 * `410 Gone` with its category, so a reader who followed an inbound link is sent to the hub
 * instead of nowhere, and a search engine drops it cleanly. A draft URL simply 404s,
 * because it was never published in the first place.
 *
 * ## Where the rules live
 *
 * Shape rules are in the Zod schemas (`validators/`), rules that need no database are in
 * `domain/article-content.rules.ts`, and this class holds only what needs a query: slug
 * uniqueness across articles, the author's existence, and the featured-article rule.
 */
export class ArticleService {
  constructor(
    private readonly articles: ArticleRepository = articleRepository,
    private readonly authors: ArticleAuthorRepository = articleAuthorRepository,
  ) {}

  // ─── Reads ─────────────────────────────────────────────────────────────────

  async list(query: AdminArticleQueryInput): Promise<Page<AdminArticleDto>> {
    const pagination: PaginationOptions = { page: query.page, limit: query.limit };
    const page = await this.articles.listForEditor(
      {
        status: query.status,
        category: query.category,
        locale: query.locale,
        authorKey: query.author,
      },
      pagination,
    );

    const authorMap = await this.authors.findByKeys(page.data.map((article) => article.author_key));

    return {
      data: page.data.map((article) =>
        toAdminArticleDto(article, authorMap.get(article.author_key) ?? null),
      ),
      meta: page.meta,
    };
  }

  async getByKey(key: string): Promise<AdminArticleDto> {
    const article = await this.requireArticle(key);
    const author = await this.authors.findByKey(article.author_key);
    return toAdminArticleDto(article, author);
  }

  /**
   * The editor's preview: exactly the public detail shape, for an article at any status.
   *
   * It exists so that previewing never becomes a reason to relax the public endpoints. The
   * shape is produced by the same DTO the reader gets, so what an editor approves is what
   * ships — and it is behind `requireAuth + requireRole(['admin'])`, which is the whole
   * difference.
   */
  async preview(key: string, locale: BlogLocale): Promise<PublicArticleDetailDto> {
    const article = await this.requireArticle(key);
    const translation = article.translations.find((t) => t.locale === locale);
    if (!translation) {
      throw createAppError(ERROR_CODES.BLOG_ARTICLE_NOT_FOUND, 404, 'This article has no translation in that language', {
        id: key,
        locale,
      });
    }
    const author = await this.authors.findByKey(article.author_key);
    return toPublicArticleDetailDto(article, translation, author);
  }

  // ─── Writes ────────────────────────────────────────────────────────────────

  /** Creates a **draft**. Publishing is a separate, checklisted decision. */
  async create(input: CreateArticleInput): Promise<AdminArticleDto> {
    const existing = await this.articles.findByKey(input.id);
    if (existing) {
      throw createAppError(ERROR_CODES.BLOG_ARTICLE_KEY_TAKEN, 409, undefined, { id: input.id });
    }

    const translations = mergeTranslations([], input.translations as TranslationInput[]);
    await this.assertSlugsAvailable(translations, input.id);

    const author = await this.authors.findByKey(input.authorId);
    if (!author) {
      throw createAppError(ERROR_CODES.BLOG_AUTHOR_NOT_FOUND, 404, undefined, { authorId: input.authorId });
    }

    const created = await this.articles.create({
      key: input.id,
      category_key: input.categoryKey,
      author_key: input.authorId,
      status: 'draft',
      // A draft is not published, so it cannot be the featured article yet. The flag is
      // stored and applied at publish time, where the one-per-locale rule can actually be
      // evaluated against the articles it competes with.
      featured: input.featured,
      cover: input.cover ?? null,
      published_at: null,
      content_updated_at: null,
      archived_at: null,
      translations,
      slug_keys: buildSlugKeys(translations),
    });

    return toAdminArticleDto(created, author);
  }

  async update(key: string, input: UpdateArticleInput): Promise<AdminArticleDto> {
    const article = await this.requireArticle(key);

    const set: Partial<IArticle> = {};

    if (input.categoryKey !== undefined) set.category_key = input.categoryKey;

    let author = await this.authors.findByKey(article.author_key);
    if (input.authorId !== undefined && input.authorId !== article.author_key) {
      const nextAuthor = await this.authors.findByKey(input.authorId);
      if (!nextAuthor) {
        throw createAppError(ERROR_CODES.BLOG_AUTHOR_NOT_FOUND, 404, undefined, { authorId: input.authorId });
      }
      set.author_key = input.authorId;
      author = nextAuthor;
    }

    if (input.cover !== undefined) set.cover = input.cover ?? null;

    let nextTranslations = article.translations;
    if (input.translations !== undefined) {
      nextTranslations = mergeTranslations(article.translations, input.translations as TranslationInput[]);
      await this.assertSlugsAvailable(nextTranslations, key);
      set.translations = nextTranslations;
      set.slug_keys = buildSlugKeys(nextTranslations);
    }

    // Only a *published* article can be revised — a draft has no readers and no
    // `dateModified` for a revision to describe.
    if (article.status === 'published') {
      const changed = contentChanged(
        { translations: article.translations, cover: article.cover },
        { translations: nextTranslations, cover: input.cover !== undefined ? input.cover ?? null : article.cover },
      );
      if (changed) set.content_updated_at = new Date();
    }

    const updated = (await this.articles.updateByKey(key, set)) ?? article;

    // Featured last, and only after the write: the rule reads the article's live locale set,
    // which the translations above may have just changed.
    if (input.featured !== undefined && input.featured !== article.featured) {
      await this.applyFeatured(updated, input.featured);
      const reread = await this.articles.findByKey(key);
      return toAdminArticleDto(reread ?? updated, author);
    }

    return toAdminArticleDto(updated, author);
  }

  /**
   * Publish.
   *
   * `published_at` is stamped on the **first** publish only. A republish after an unpublish
   * keeps the original date, because it is the sort key the index, the sitemap and the
   * prev/next links share — re-stamping it silently reorders pages that link to each other.
   * `publishedAt` in the body overrides it, for importing an article that went live
   * elsewhere.
   */
  async publish(key: string, input: PublishArticleInput): Promise<AdminArticleDto> {
    const article = await this.requireArticle(key);
    if (article.status === 'published') {
      throw createAppError(ERROR_CODES.BLOG_ARTICLE_ALREADY_PUBLISHED, 409, undefined, { id: key });
    }

    const author = await this.authors.findByKey(article.author_key);
    const blockers = collectPublishBlockers({
      translations: article.translations,
      authorExists: author !== null,
    });
    if (blockers.length > 0) {
      throw createAppError(ERROR_CODES.BLOG_ARTICLE_NOT_PUBLISHABLE, 422, undefined, { id: key, blockers });
    }

    const updated = await this.articles.updateByKey(key, {
      status: 'published',
      published_at: input.publishedAt ?? article.published_at ?? new Date(),
      archived_at: null,
    });

    const result = updated ?? article;
    if (result.featured) await this.applyFeatured(result, true);

    const reread = await this.articles.findByKey(key);
    return toAdminArticleDto(reread ?? result, author);
  }

  /**
   * Back to `draft` — for an article pulled while it is corrected.
   *
   * Not the way to retire an article for good: that is `archive`, which keeps the URL
   * answering `410` with its category rather than 404-ing an address other sites link to.
   */
  async unpublish(key: string): Promise<AdminArticleDto> {
    const article = await this.requireArticle(key);
    const updated = await this.articles.updateByKey(key, {
      status: 'draft',
      archived_at: null,
      // A draft cannot hold the featured slot: the index would lead with an article whose
      // every URL 404s.
      featured: false,
    });
    const author = await this.authors.findByKey(article.author_key);
    return toAdminArticleDto(updated ?? article, author);
  }

  /** Retire for good. The URL keeps answering — `410 Gone`, with the hub to fall back to. */
  async archive(key: string): Promise<AdminArticleDto> {
    const article = await this.requireArticle(key);
    const updated = await this.articles.updateByKey(key, {
      status: 'archived',
      archived_at: new Date(),
      featured: false,
    });
    const author = await this.authors.findByKey(article.author_key);
    return toAdminArticleDto(updated ?? article, author);
  }

  /**
   * Delete — **only an article that was never published.**
   *
   * Once an address has been live it may have inbound links, and a 404 wastes them. The
   * remedy for a published mistake is `archive` (410 + the category hub), so this refuses
   * with `409 BLOG_ARTICLE_DELETE_NOT_ALLOWED` and says so. `published_at` rather than
   * `status` is the test: an already-unpublished article was still live once.
   */
  async remove(key: string): Promise<void> {
    const article = await this.requireArticle(key);
    if (article.published_at !== null) {
      throw createAppError(ERROR_CODES.BLOG_ARTICLE_DELETE_NOT_ALLOWED, 409, undefined, {
        id: key,
        publishedAt: article.published_at.toISOString(),
      });
    }
    await this.articles.softDeleteByKey(key);
  }

  // ─── Rules that need a query ───────────────────────────────────────────────

  /**
   * At most one featured article per locale.
   *
   * Implemented as a demotion rather than a `409`: `featured` is per-article while the rule
   * is per-locale, so an editor featuring a French article has no way to know what is
   * currently featured in the four other languages it also publishes in. Refusing would ask
   * them to go and find out; demoting states the rule and moves on. It is an editorial
   * nicety anyway — the index falls back to the newest article when nothing is featured.
   */
  private async applyFeatured(article: IArticle, featured: boolean): Promise<void> {
    if (!featured) {
      await this.articles.setFeatured(article.key, false);
      return;
    }

    const locales = article.translations
      .filter((translation) => translation.published)
      .map((translation) => translation.locale);

    const competitors = await this.articles.findFeaturedSharingLocales(locales, article.key);
    for (const competitor of competitors) {
      await this.articles.setFeatured(competitor.key, false);
    }

    await this.articles.setFeatured(article.key, true);
  }

  /**
   * Slug availability, per locale, across every article.
   *
   * Checks **retired** slugs too (`slug_keys` holds both), so no article can claim a slug
   * another one redirects from — a reused slug turns a permanent redirect into a wrong
   * answer, which is worse than the 404 it was avoiding.
   *
   * Check-then-write, narrowed by the unique index on `slug_keys`: two editors racing on
   * the same slug lose the second write to a `11000`, which the global error handler maps
   * to `409 DATABASE_UNIQUE_CONSTRAINT_VIOLATION`. The check is what turns the common case
   * into a named error.
   */
  private async assertSlugsAvailable(
    translations: IArticleTranslation[],
    ownKey: string,
  ): Promise<void> {
    for (const translation of translations) {
      if (isReservedSlug(translation.slug)) {
        throw createAppError(ERROR_CODES.BLOG_SLUG_RESERVED, 400, undefined, {
          locale: translation.locale,
          slug: translation.slug,
          reserved: ['category', 'page', 'index'],
        });
      }

      const taken = await this.articles.slugTakenByAnother(translation.locale, translation.slug, ownKey);
      if (taken) {
        throw createAppError(ERROR_CODES.BLOG_SLUG_TAKEN, 409, undefined, {
          locale: translation.locale,
          slug: translation.slug,
        });
      }
    }
  }

  private async requireArticle(key: string): Promise<IArticle> {
    const article = await this.articles.findByKey(key);
    if (!article) {
      throw createAppError(ERROR_CODES.BLOG_ARTICLE_NOT_FOUND, 404, undefined, { id: key });
    }
    return article;
  }
}

export const articleService = new ArticleService();
