import { Schema, model } from 'mongoose';
import { IBaseDocument, BaseSchemaFields, BaseSchemaOptions } from '../../../core/base.schema';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';
import { SUPPORTED_LANGUAGES } from '../../../core/constants/languages';
import { BLOG_AUTHOR_TYPES, BlogAuthorType, BlogLocale } from '../blog.types';

/** The translated half of a byline. */
export interface IArticleAuthorTranslation {
  /** Job title — "Editorial", "Rédaction". */
  title: string;
  bio: string;
}

export interface IArticleAuthor extends IBaseDocument {
  /** Stable public id — `wimall-editorial`. Articles reference this, not an ObjectId. */
  key: string;
  /**
   * **Not translated.** A person's name is the same in five languages; only the job title
   * and the bio change.
   */
  name: string;
  /**
   * `Person` | `Organization`, and it is not cosmetic: it becomes the `@type` of the
   * `author` node in the article's `BlogPosting` structured data. A house byline like "The
   * WiMall team" is an `Organization`. Marking it `Person` asserts to a search engine that
   * a human by that name exists — the same class of claim as an invented review count, and
   * the kind that earns a manual action rather than a warning.
   */
  type: BlogAuthorType;
  avatar_url: string | null;
  /**
   * Keyed by locale. **This is the one place a missing translation falls back to English**,
   * because a blank byline where the structured data expects an author is worse than a bio
   * in the wrong language — unlike article prose, where a fallback would publish a page
   * that contradicts its own `lang` attribute.
   */
  translations: Map<BlogLocale, IArticleAuthorTranslation>;
}

const AuthorTranslationSchema = new Schema<IArticleAuthorTranslation>(
  {
    title: { type: String, required: true, trim: true, maxlength: 120 },
    bio: { type: String, required: true, trim: true, maxlength: 1000 },
  },
  { _id: false },
);

/**
 * An article byline.
 *
 * Kept as its own collection rather than embedded on each article so that fixing a typo in a
 * bio does not mean rewriting every article that carries it — and so the same byline is
 * provably the same entity across articles, which is what makes the structured data's author
 * node consistent.
 *
 * They are still served **inline on every article** (`GET /api/public/articles` resolves
 * them), because while there are two house bylines a separate `GET /api/public/authors`
 * round-trip buys the frontend nothing.
 */
const ArticleAuthorSchema = new Schema<IArticleAuthor>({
  key: { type: String, required: true, trim: true, maxlength: 200 },
  name: { type: String, required: true, trim: true, maxlength: 200 },
  type: { type: String, enum: BLOG_AUTHOR_TYPES, required: true },
  avatar_url: { type: String, default: null, trim: true },
  translations: {
    type: Map,
    of: AuthorTranslationSchema,
    default: () => new Map(),
    validate: {
      validator: (value: Map<string, unknown>) =>
        [...value.keys()].every((locale) => (SUPPORTED_LANGUAGES as readonly string[]).includes(locale)),
      message: 'Author translations may only be keyed by a supported language',
    },
  },

  ...BaseSchemaFields,
}, BaseSchemaOptions);

ArticleAuthorSchema.index({ key: 1 }, { unique: true });

export const ArticleAuthorModel = model<IArticleAuthor>(
  MODELS.ARTICLE_AUTHOR,
  ArticleAuthorSchema,
  COLLECTIONS.ARTICLE_AUTHOR,
);
