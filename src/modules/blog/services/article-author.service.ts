import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { articleAuthorRepository, ArticleAuthorRepository } from '../repositories/article-author.repository';
import { articleRepository, ArticleRepository } from '../repositories/article.repository';
import { IArticleAuthor, IArticleAuthorTranslation } from '../models/article-author.model';
import { BlogLocale } from '../blog.types';
import { AdminAuthorDto, toAdminAuthorDto } from '../dto/admin-article.dto';
import { CreateAuthorInput, UpdateAuthorInput } from '../validators/article.validator';

/** Bylines. Small surface, one rule worth stating — see `remove`. */
export class ArticleAuthorService {
  constructor(
    private readonly authors: ArticleAuthorRepository = articleAuthorRepository,
    private readonly articles: ArticleRepository = articleRepository,
  ) {}

  async list(): Promise<AdminAuthorDto[]> {
    const authors = await this.authors.listAll();
    const counts = await Promise.all(authors.map((author) => this.articles.countByAuthor(author.key)));
    return authors.map((author, index) => toAdminAuthorDto(author, counts[index]));
  }

  async getByKey(key: string): Promise<AdminAuthorDto> {
    const author = await this.requireAuthor(key);
    const count = await this.articles.countByAuthor(key);
    return toAdminAuthorDto(author, count);
  }

  async create(input: CreateAuthorInput): Promise<AdminAuthorDto> {
    const existing = await this.authors.findByKey(input.id);
    if (existing) {
      throw createAppError(ERROR_CODES.BLOG_AUTHOR_KEY_TAKEN, 409, undefined, { id: input.id });
    }

    const created = await this.authors.create({
      key: input.id,
      name: input.name,
      type: input.type,
      avatar_url: input.avatarUrl ?? null,
      translations: toTranslationMap(input.translations),
    });

    return toAdminAuthorDto(created, 0);
  }

  async update(key: string, input: UpdateAuthorInput): Promise<AdminAuthorDto> {
    const author = await this.requireAuthor(key);

    const set: Partial<IArticleAuthor> = {};
    if (input.name !== undefined) set.name = input.name;
    if (input.type !== undefined) set.type = input.type;
    if (input.avatarUrl !== undefined) set.avatar_url = input.avatarUrl ?? null;
    if (input.translations !== undefined) set.translations = toTranslationMap(input.translations);

    const updated = (await this.authors.updateByKey(key, set)) ?? author;
    const count = await this.articles.countByAuthor(key);
    return toAdminAuthorDto(updated, count);
  }

  /**
   * Refused while any article credits this byline (`409 BLOG_AUTHOR_IN_USE`).
   *
   * It is what makes `author` non-null on every published article: the public DTO resolves
   * the byline by key, and a dangling reference would put an article carrying `BlogPosting`
   * structured data on the site with no author node at all. Re-point the articles first.
   */
  async remove(key: string): Promise<void> {
    await this.requireAuthor(key);
    const count = await this.articles.countByAuthor(key);
    if (count > 0) {
      throw createAppError(ERROR_CODES.BLOG_AUTHOR_IN_USE, 409, undefined, { id: key, articleCount: count });
    }
    await this.authors.softDeleteByKey(key);
  }

  private async requireAuthor(key: string): Promise<IArticleAuthor> {
    const author = await this.authors.findByKey(key);
    if (!author) {
      throw createAppError(ERROR_CODES.BLOG_AUTHOR_NOT_FOUND, 404, undefined, { id: key });
    }
    return author;
  }
}

function toTranslationMap(
  translations: Partial<Record<BlogLocale, { title: string; bio: string }>>,
): Map<BlogLocale, IArticleAuthorTranslation> {
  const map = new Map<BlogLocale, IArticleAuthorTranslation>();
  for (const [locale, translation] of Object.entries(translations)) {
    if (translation) map.set(locale as BlogLocale, { title: translation.title, bio: translation.bio });
  }
  return map;
}

export const articleAuthorService = new ArticleAuthorService();
