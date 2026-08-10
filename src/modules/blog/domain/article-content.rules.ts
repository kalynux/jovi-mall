import { IArticleCover, IArticleTranslation } from '../models/article.model';
import { ArticleBody, countWords } from '../validators/article-body.validator';
import { RESERVED_ARTICLE_SLUGS, BlogLocale } from '../blog.types';

/**
 * The article rules that need no database.
 *
 * Extracted for the same reason `deriveWorkingState` and `applyFeeSplit` are: they are the
 * part worth testing, and a DB-free test is the only kind this project has. Covered by
 * `npm run test:blog`.
 */

/** A translation as the editor sends it, before it becomes a persisted subdocument. */
export interface TranslationInput {
  locale: BlogLocale;
  slug: string;
  title: string;
  metaTitle?: string;
  excerpt: string;
  body: ArticleBody;
  published: boolean;
}

/** `category`, `page`, `index` — see `RESERVED_ARTICLE_SLUGS` for what each collides with. */
export function isReservedSlug(slug: string): boolean {
  return RESERVED_ARTICLE_SLUGS.includes(slug);
}

/**
 * Merge an incoming translation set over the stored one, **preserving slug history**.
 *
 * The whole point: when a translation's slug changes, the old one is not lost — it is
 * pushed onto `previous_slugs`, which is what lets the public route answer
 * `BLOG_ARTICLE_MOVED` instead of a bare 404 that wastes the old path's inbound links.
 *
 * A slug that changes and then changes *back* keeps only one copy of each retired value,
 * and the slug now in use is removed from the history — it is current, not retired, and
 * leaving it in both places would make the "did this move?" test ambiguous.
 *
 * `word_count` is recomputed here rather than accepted, so it cannot drift from the prose
 * after a revision.
 */
export function mergeTranslations(
  existing: IArticleTranslation[],
  incoming: TranslationInput[],
): IArticleTranslation[] {
  const previousByLocale = new Map(existing.map((translation) => [translation.locale, translation]));

  return incoming.map((translation) => {
    const before = previousByLocale.get(translation.locale);

    const history = new Set<string>(before?.previous_slugs ?? []);
    if (before && before.slug !== translation.slug) history.add(before.slug);
    history.delete(translation.slug);

    return {
      locale: translation.locale,
      slug: translation.slug,
      title: translation.title,
      meta_title: translation.metaTitle ?? null,
      excerpt: translation.excerpt,
      body: translation.body,
      word_count: countWords(translation.body),
      published: translation.published,
      previous_slugs: [...history],
    };
  });
}

/**
 * Did the *prose* change?
 *
 * Stamping `content_updated_at` from Mongoose's `updatedAt` would move it on every save,
 * so toggling `featured` or moving a category would tell a search engine the article was
 * revised. This compares only what a reader would see — the fields that render, plus the
 * cover — and ignores `published`, which is a visibility decision rather than an edit.
 *
 * Adding or removing a language *is* a revision: the article's `hreflang` set changed, and
 * that is a change to the published page.
 */
export function contentChanged(
  before: { translations: IArticleTranslation[]; cover: IArticleCover | null },
  after: { translations: IArticleTranslation[]; cover: IArticleCover | null },
): boolean {
  return fingerprint(before) !== fingerprint(after);
}

function fingerprint(article: {
  translations: IArticleTranslation[];
  cover: IArticleCover | null;
}): string {
  const translations = [...article.translations]
    .sort((a, b) => a.locale.localeCompare(b.locale))
    .map((translation) => ({
      locale: translation.locale,
      slug: translation.slug,
      title: translation.title,
      meta_title: translation.meta_title,
      excerpt: translation.excerpt,
      body: translation.body,
    }));

  return JSON.stringify({ translations, cover: article.cover ?? null });
}

/**
 * Why this article cannot be published yet, as a checklist rather than a first failure.
 *
 * A checklist because publishing is an explicit human action: telling an editor about one
 * missing piece at a time, over three round-trips, is how a publish button earns a
 * reputation for being broken. Same reasoning as the unsuspend blocker list in
 * `agency-stored-product.service.ts`.
 */
export function collectPublishBlockers(article: {
  translations: IArticleTranslation[];
  authorExists: boolean;
}): string[] {
  const blockers: string[] = [];

  if (!article.authorExists) {
    blockers.push('The byline this article credits does not exist — create the author first');
  }
  if (article.translations.length === 0) {
    blockers.push('An article needs at least one translation');
  }
  if (article.translations.length > 0 && !article.translations.some((t) => t.published)) {
    blockers.push('Every translation is marked unpublished — at least one language must be live');
  }

  return blockers;
}
