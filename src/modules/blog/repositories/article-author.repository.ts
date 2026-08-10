import { ArticleAuthorModel, IArticleAuthor } from '../models/article-author.model';

/**
 * Authors, addressed by their stable `key`.
 *
 * `findByKeys` is the batch path and it is the one that matters: an index page of 24
 * articles resolves its bylines in a single query, not 24.
 */
export class ArticleAuthorRepository {
  async create(data: Partial<IArticleAuthor>): Promise<IArticleAuthor> {
    const [doc] = await ArticleAuthorModel.create([data]);
    return doc;
  }

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

  async updateByKey(key: string, set: Partial<IArticleAuthor>): Promise<IArticleAuthor | null> {
    return ArticleAuthorModel.findOneAndUpdate({ key, deletedAt: null }, { $set: set }, { new: true }).exec();
  }

  async softDeleteByKey(key: string): Promise<void> {
    await ArticleAuthorModel.updateOne({ key, deletedAt: null }, { $set: { deletedAt: new Date() } }).exec();
  }
}

export const articleAuthorRepository = new ArticleAuthorRepository();
