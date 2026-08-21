import { FilterQuery } from 'mongoose';
import { ArticleModel, IArticle, slugKey } from '../models/article.model';
import { BlogCategoryKey, BlogLocale } from '../blog.types';

export interface PublicArticleListFilters {
  locale: BlogLocale;
  category?: BlogCategoryKey;
}

/**
 * A plain repository, not a `BaseRepository` — the same call the stock-request and
 * connection repositories make. Articles are addressed by their stable string `key`
 * rather than an ObjectId, and every public read carries a `status`/`translations`
 * predicate the generic finders cannot express.
 *
 * Every query filters `deletedAt: null` explicitly.
 *
 * ── READ ONLY since Phase 5 Part A ────────────────────────────────────────────
 * The write half — `create`, `updateByKey`, `setFeatured`, `softDeleteByKey`,
 * `slugTakenByAnother`, `findFeaturedSharingLocales`, `listForEditor`, `countByAuthor` —
 * went with `ArticleService` when the editor moved to wi-admin (ADR-004 D-4). wi-admin
 * writes this collection through its own `PlatformOwnedRepository`, on the raw driver.
 *
 * **Do not add a write back here.** Two writers on one collection, only one of which
 * applies this schema's defaults and validators, is the state Phase 5 step 5.0 exists to
 * prevent. If jovi-mall needs to change an article, the question to answer first is why
 * the service that owns the editor cannot.
 */

/**
 * **The one sort order in this module.**
 *
 * `publishedAt` descending with `_id` as tie-break. The index, the sitemap and the
 * previous/next links at the foot of an article are three views of one sequence; if any of
 * them ordered differently, prev/next would stop matching what the index showed. Two
 * articles published in the same second are the case that makes the tie-break load-bearing.
 */
const PUBLISHED_SORT = { published_at: -1 as const, _id: -1 as const };

export class ArticleRepository {
  /** By stable public id, whatever its status. */
  async findByKey(key: string): Promise<IArticle | null> {
    return ArticleModel.findOne({ key, deletedAt: null }).exec();
  }

  /**
   * By `(locale, slug)`, matching **current and retired** slugs alike.
   *
   * Returning the retired match rather than nothing is what lets the service answer
   * `BLOG_ARTICLE_MOVED` with the article's current slug instead of a bare 404 that wastes
   * whatever inbound links the old path had. Status is deliberately not filtered here: an
   * archived article must be distinguishable from a nonexistent one (410 vs 404), and that
   * is the service's decision to make.
   */
  async findBySlug(locale: BlogLocale, slug: string): Promise<IArticle | null> {
    return ArticleModel.findOne({ slug_keys: slugKey(locale, slug), deletedAt: null }).exec();
  }

  /**
   * The public index and the category hubs: published articles with a **live** translation
   * in this locale.
   *
   * `$elemMatch` rather than two dotted predicates, because `translations.locale` and
   * `translations.published` matched independently would return an article whose English
   * translation is live and whose French one is drafted, when the caller asked for French.
   */
  async listPublished(
    filters: PublicArticleListFilters,
    limit: number,
    offset: number,
  ): Promise<{ items: IArticle[]; total: number }> {
    const filter: FilterQuery<IArticle> = {
      status: 'published',
      deletedAt: null,
      translations: { $elemMatch: { locale: filters.locale, published: true } },
    };
    if (filters.category) filter.category_key = filters.category;

    const [total, items] = await Promise.all([
      ArticleModel.countDocuments(filter).exec(),
      ArticleModel.find(filter).sort(PUBLISHED_SORT).skip(offset).limit(limit).exec(),
    ]);

    return { items, total };
  }

  /**
   * Every published article, in the one sort order, for `generateStaticParams` and the
   * sitemap. Unpaginated by design: the build needs every `(locale, slug)` pair in one
   * round-trip, and paying for five paginated calls with full summaries to get a list of
   * slugs would be the slowest part of it.
   */
  async listAllPublished(): Promise<IArticle[]> {
    return ArticleModel.find({ status: 'published', deletedAt: null }).sort(PUBLISHED_SORT).exec();
  }

}

export const articleRepository = new ArticleRepository();
