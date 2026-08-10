import { SUPPORTED_LANGUAGES, Language } from '../../core/constants/languages';

/**
 * Blog domain vocabulary — the pieces both the editor and the public reader agree on.
 *
 * The block union and every validation rule live in `validators/article-body.validator.ts`;
 * the TypeScript shapes are *inferred from those schemas* rather than declared twice, so a
 * rule and its type cannot drift. This file holds only what is not a Zod schema: the five
 * category keys, the locale alias, and the reserved-slug list.
 */

/**
 * The five categories, with stable keys.
 *
 * **The backend knows only the key.** Labels are translated in the frontend message
 * catalog (`pages.blog.categories.<key>`) and the URL slug is the frontend's too — five
 * words per language belong with the rest of the site chrome, and routing them through
 * the API would mean a deploy to fix a typo.
 *
 * Adding a sixth key is a frontend change as well (`CategoryKey` is a union type there),
 * so it is a two-repo change — and worth resisting: a category with one article in it is
 * an empty hub that dilutes the internal linking it exists to concentrate.
 */
export const BLOG_CATEGORY_KEYS = ['selling', 'payments', 'delivery', 'growth', 'guides'] as const;

export type BlogCategoryKey = (typeof BLOG_CATEGORY_KEYS)[number];

/** Article locales are the platform's five languages — same list, not a second one. */
export const BLOG_LOCALES = SUPPORTED_LANGUAGES;
export type BlogLocale = Language;

/**
 * Author identity type. **Not cosmetic** — it becomes the `@type` of the `author` node in
 * the article's `BlogPosting` structured data. A house byline like "The WiMall team" is an
 * `Organization`; marking it `Person` asserts to a search engine that a human by that name
 * exists, which is the class of claim that earns a manual action rather than a warning.
 */
export const BLOG_AUTHOR_TYPES = ['Person', 'Organization'] as const;
export type BlogAuthorType = (typeof BLOG_AUTHOR_TYPES)[number];

/** Draft and archived articles are invisible to every public endpoint. */
export const BLOG_ARTICLE_STATUSES = ['draft', 'published', 'archived'] as const;
export type BlogArticleStatus = (typeof BLOG_ARTICLE_STATUSES)[number];

/**
 * Slugs that would collide with a route rather than resolve to an article.
 *
 * - `category` — collides with the frontend's `/blog/category/…` hub.
 * - `page`     — collides with the path-based pagination `/blog/page/2` that §7b of the
 *                requirements commits to; reserving it now costs nothing and reserving it
 *                later means retiring a published URL.
 * - `index`    — collides with **this API's** own `GET /api/public/articles/index`, which
 *                is matched before `/:slug` and would shadow such an article entirely.
 *
 * Rejected at the editor (`400 BLOG_SLUG_RESERVED`) rather than at read time, because by
 * read time the URL is already published.
 */
export const RESERVED_ARTICLE_SLUGS: readonly string[] = ['category', 'page', 'index'];
