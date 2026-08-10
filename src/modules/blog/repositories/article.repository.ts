import { FilterQuery } from 'mongoose';
import { ArticleModel, IArticle, slugKey } from '../models/article.model';
import { BlogArticleStatus, BlogCategoryKey, BlogLocale } from '../blog.types';
import { Page, PaginationOptions } from '../../../core/repositories/base.repository';

export interface PublicArticleListFilters {
  locale: BlogLocale;
  category?: BlogCategoryKey;
}

export interface AdminArticleListFilters {
  status?: BlogArticleStatus;
  category?: BlogCategoryKey;
  locale?: BlogLocale;
  authorKey?: string;
}

/**
 * A plain repository, not a `BaseRepository` — the same call the stock-request and
 * connection repositories make. Articles are addressed by their stable string `key`
 * rather than an ObjectId, and every public read carries a `status`/`translations`
 * predicate the generic finders cannot express.
 *
 * Every query filters `deletedAt: null` explicitly.
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
  async create(data: Partial<IArticle>): Promise<IArticle> {
    const [doc] = await ArticleModel.create([data]);
    return doc;
  }

  /** By stable public id, whatever its status — the editor's read. */
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
   * Does any **other** article answer to this `(locale, slug)`?
   *
   * `excludeKey` is the article being edited — re-saving it with the slug it already has
   * must not collide with itself.
   */
  async slugTakenByAnother(locale: BlogLocale, slug: string, excludeKey: string): Promise<boolean> {
    const existing = await ArticleModel.exists({
      slug_keys: slugKey(locale, slug),
      key: { $ne: excludeKey },
      deletedAt: null,
    }).exec();
    return existing !== null;
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

  /** The editor's list. Every status by default — a draft inbox is the point of it. */
  async listForEditor(
    filters: AdminArticleListFilters,
    pagination: PaginationOptions,
  ): Promise<Page<IArticle>> {
    const { page, limit } = pagination;

    const filter: FilterQuery<IArticle> = { deletedAt: null };
    if (filters.status) filter.status = filters.status;
    if (filters.category) filter.category_key = filters.category;
    if (filters.authorKey) filter.author_key = filters.authorKey;
    if (filters.locale) filter['translations.locale'] = filters.locale;

    const [total, docs] = await Promise.all([
      ArticleModel.countDocuments(filter).exec(),
      ArticleModel.find(filter)
        // Drafts have no `published_at`, so the editor's list sorts by last touched
        // instead — a different question from the reader's, and deliberately a different
        // order. Nothing public reads this method.
        .sort({ updatedAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
    ]);

    return { data: docs, meta: { total, page, limit, pages: Math.ceil(total / limit) } };
  }

  /**
   * Published articles that are `featured` and share a locale with the given list.
   *
   * Backs the "at most one featured article per locale" rule: featuring an article demotes
   * whatever it would have competed with, rather than 409-ing an editor who has no way to
   * know what is featured in another language.
   */
  async findFeaturedSharingLocales(locales: BlogLocale[], excludeKey: string): Promise<IArticle[]> {
    if (locales.length === 0) return [];
    return ArticleModel.find({
      featured: true,
      status: 'published',
      key: { $ne: excludeKey },
      deletedAt: null,
      translations: { $elemMatch: { locale: { $in: locales }, published: true } },
    }).exec();
  }

  async setFeatured(key: string, featured: boolean): Promise<void> {
    await ArticleModel.updateOne({ key, deletedAt: null }, { $set: { featured } }).exec();
  }

  async updateByKey(key: string, set: Partial<IArticle>): Promise<IArticle | null> {
    return ArticleModel.findOneAndUpdate({ key, deletedAt: null }, { $set: set }, { new: true }).exec();
  }

  async softDeleteByKey(key: string): Promise<void> {
    await ArticleModel.updateOne({ key, deletedAt: null }, { $set: { deletedAt: new Date() } }).exec();
  }

  /** Guards the author delete: a byline credited on an article cannot be removed. */
  async countByAuthor(authorKey: string): Promise<number> {
    return ArticleModel.countDocuments({ author_key: authorKey, deletedAt: null }).exec();
  }
}

export const articleRepository = new ArticleRepository();
