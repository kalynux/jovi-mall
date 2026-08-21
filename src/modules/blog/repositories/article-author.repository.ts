import { ArticleAuthorModel, IArticleAuthor } from '../models/article-author.model';

/**
 * Authors, addressed by their stable `key`.
 *
 * `findByKeys` is the batch path and it is the one that matters: an index page of 24
 * articles resolves its bylines in a single query, not 24.
 *
 * ── READ ONLY since Phase 5 Part A ────────────────────────────────────────────
 * `create`, `updateByKey` and `softDeleteByKey` went with `ArticleAuthorService` when the
 * editor moved to wi-admin (ADR-004 D-4). Same rule as `article.repository.ts`: do not add
 * a write back here — wi-admin is the writer, and a second one applying different defaults
 * to the same collection is the state Phase 5 step 5.0 exists to prevent.
 */
export class ArticleAuthorRepository {
  async findByKey(key: string): Promise<IArticleAuthor | null> {
    return ArticleAuthorModel.findOne({ key, deletedAt: null }).exec();
  }

  /** Keyed by author key, so a caller can resolve a page of articles in one pass. */
  async findByKeys(keys: string[]): Promise<Map<string, IArticleAuthor>> {
    const unique = [...new Set(keys)];
    if (unique.length === 0) return new Map();

    const docs = await ArticleAuthorModel.find({ key: { $in: unique }, deletedAt: null }).exec();
    return new Map(docs.map((doc) => [doc.key, doc]));
  }

  async listAll(): Promise<IArticleAuthor[]> {
    return ArticleAuthorModel.find({ deletedAt: null }).sort({ name: 1 }).exec();
  }
}

export const articleAuthorRepository = new ArticleAuthorRepository();
