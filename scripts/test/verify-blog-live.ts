/**
 * Live-DB smoke test for the blog.
 *
 * Like `verify-live-parity.ts` this one NEEDS Mongo, and for the same reasons — it covers
 * exactly what `tsc` and the DB-free suite structurally cannot see:
 *
 *   1. the schema indexes actually BUILD (`autoIndex` is on, so a failure here is silent
 *      at boot) — in particular the **unique multikey index on `slug_keys`**, which only
 *      exists because MongoDB refuses a compound index on `translations.locale` +
 *      `translations.slug` (parallel array paths). If that reasoning were wrong, this is
 *      where it shows.
 *   2. the queries actually RUN — `$elemMatch` on the translations array, the sort, the
 *      count
 *   3. the whole lifecycle behaves against real persistence: draft invisible → publish →
 *      slug rename keeps the old URL answering → archive answers 410
 *   4. the Express route table resolves `/articles/index` BEFORE `/articles/:slug`
 *
 * **It writes**, then cleans up after itself: every document it creates is keyed
 * `verify-blog-*` and deleted at the end, pass or fail.
 *
 * Run: npm run verify:blog
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { ArticleModel } from '../../src/modules/blog/models/article.model';
import { ArticleAuthorModel } from '../../src/modules/blog/models/article-author.model';
import { articleService } from '../../src/modules/blog/services/article.service';
import { publicArticleService } from '../../src/modules/blog/services/public-article.service';
import { AppError } from '../../src/core/errors';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi-mall';

const AUTHOR = 'verify-blog-author';
const ARTICLE = 'verify-blog-article';
const OTHER = 'verify-blog-other';

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  ✅ ${name}${detail ? ' — ' + detail : ''}`);
    pass++;
  } else {
    console.error(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
    fail++;
  }
}

/** Run something that must throw an AppError, and report its code. */
async function expectError(name: string, code: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    check(name, false, 'did not throw');
  } catch (err) {
    const appError = err instanceof AppError ? err : null;
    check(name, appError?.code === code, appError ? `${appError.code} ${appError.statusCode}` : String(err));
  }
}

const body = [
  { type: 'heading' as const, level: 2 as const, id: 'how-it-works', text: 'How it works' },
  {
    type: 'paragraph' as const,
    text: [
      { type: 'text' as const, text: 'Commission is taken ' },
      { type: 'text' as const, text: 'at payment', bold: true },
      { type: 'text' as const, text: '. See ' },
      { type: 'link' as const, text: 'the pricing page', href: '/pricing' },
      { type: 'text' as const, text: '.' },
    ],
  },
];

async function cleanup(): Promise<void> {
  await ArticleModel.deleteMany({ key: { $in: [ARTICLE, OTHER] } });
  await ArticleAuthorModel.deleteMany({ key: AUTHOR });
}

async function main(): Promise<void> {
  await mongoose.connect(MONGO_URI);
  console.log(`Connected: ${MONGO_URI}\n`);
  await cleanup();

  // ── 1. Index builds ────────────────────────────────────────────────────────
  console.log('── Index builds (autoIndex is ON — a failure here is silent at boot) ──');
  try {
    await ArticleModel.createIndexes();
    check('Article indexes build', true);
  } catch (err) {
    check('Article indexes build', false, (err as Error).message);
  }
  try {
    await ArticleAuthorModel.createIndexes();
    check('ArticleAuthor indexes build', true);
  } catch (err) {
    check('ArticleAuthor indexes build', false, (err as Error).message);
  }

  const indexes = await ArticleModel.collection.indexes();
  const slugIndex = indexes.find((i) => i.key && 'slug_keys' in i.key);
  check('slug_keys index exists and is unique', Boolean(slugIndex?.unique), JSON.stringify(slugIndex?.key));

  try {
    await ArticleAuthorModel.create([
      {
        key: AUTHOR,
        name: 'Verify Byline',
        type: 'Organization',
        translations: new Map([['en', { title: 'Editorial', bio: 'Bio.' }]]),
      },
    ]);
    check('author created', true);
  } catch (err) {
    check('author created', false, (err as Error).message);
  }

  // ── 2. Draft is invisible publicly ─────────────────────────────────────────
  console.log('\n── Draft ──');
  await articleService.create({
    id: ARTICLE,
    categoryKey: 'payments',
    authorId: AUTHOR,
    featured: false,
    translations: [
      { locale: 'en', slug: 'verify-getting-paid', title: 'Getting paid', excerpt: 'How.', body, published: true },
      { locale: 'fr', slug: 'verify-se-faire-payer', title: 'Se faire payer', excerpt: 'Comment.', body, published: true },
    ],
  });
  check('created as draft', (await articleService.getByKey(ARTICLE)).status === 'draft');

  const draftList = await publicArticleService.list({ locale: 'en', limit: 24, offset: 0 });
  check('a draft is absent from the public list',
    !draftList.items.some((a) => a.id === ARTICLE), `${draftList.total} published article(s)`);

  await expectError('a draft slug 404s publicly', 'BLOG_ARTICLE_NOT_FOUND', () =>
    publicArticleService.getBySlug('verify-getting-paid', 'en'));

  // A preview is the authenticated answer to that — not a flag on the public route.
  const preview = await articleService.preview(ARTICLE, 'fr');
  check('the editor can preview a draft in the public shape', preview.slug === 'verify-se-faire-payer');

  // ── 3. Publish ─────────────────────────────────────────────────────────────
  console.log('\n── Publish ──');
  const published = await articleService.publish(ARTICLE, {});
  check('published_at is stamped', published.publishedAt !== null);
  check('updatedAt stays null (never revised)', published.updatedAt === null);

  const enList = await publicArticleService.list({ locale: 'en', limit: 24, offset: 0 });
  check('appears in the English list', enList.items.some((a) => a.id === ARTICLE));

  const detail = await publicArticleService.getBySlug('verify-getting-paid', 'en');
  check('detail carries the body', Array.isArray(detail.body) && detail.body.length === 2);
  check('detail resolves the byline inline', detail.author?.name === 'Verify Byline');
  check('availableLocales lists both languages', JSON.stringify(detail.availableLocales) === '["en","fr"]');
  check('wordCount is derived', detail.wordCount > 0, String(detail.wordCount));

  // Decision 3: a missing translation is a 404, never a fallback.
  await expectError('the English slug under /pt 404s (no fallback)', 'BLOG_ARTICLE_NOT_FOUND', () =>
    publicArticleService.getBySlug('verify-getting-paid', 'pt'));

  const categoryList = await publicArticleService.list({ locale: 'en', category: 'payments', limit: 24, offset: 0 });
  check('the category hub query runs and matches', categoryList.items.some((a) => a.id === ARTICLE));

  const wrongCategory = await publicArticleService.list({ locale: 'en', category: 'delivery', limit: 24, offset: 0 });
  check('another category excludes it', !wrongCategory.items.some((a) => a.id === ARTICLE));

  const index = await publicArticleService.index();
  const row = index.find((r) => r.id === ARTICLE);
  check('the build index lists every (locale, slug) pair', row?.translations.length === 2);

  // ── 4. Slug uniqueness, across articles and across history ─────────────────
  console.log('\n── Slug uniqueness ──');
  await articleService.create({
    id: OTHER,
    categoryKey: 'growth',
    authorId: AUTHOR,
    featured: false,
    translations: [
      { locale: 'en', slug: 'verify-other-article', title: 'Other', excerpt: 'Other.', body, published: true },
    ],
  });

  await expectError("another article cannot take a live slug", 'BLOG_SLUG_TAKEN', () =>
    articleService.update(OTHER, {
      translations: [
        { locale: 'en', slug: 'verify-getting-paid', title: 'Other', excerpt: 'Other.', body, published: true },
      ],
    }));

  await expectError('a reserved slug is refused', 'BLOG_SLUG_RESERVED', () =>
    articleService.update(OTHER, {
      translations: [{ locale: 'en', slug: 'category', title: 'Other', excerpt: 'Other.', body, published: true }],
    }));

  // The same slug in a DIFFERENT locale is a different key and must be allowed.
  const crossLocale = await articleService.update(OTHER, {
    translations: [
      { locale: 'en', slug: 'verify-other-article', title: 'Other', excerpt: 'Other.', body, published: true },
      { locale: 'fr', slug: 'verify-getting-paid', title: 'Autre', excerpt: 'Autre.', body, published: true },
    ],
  });
  check('the same slug in another locale is allowed', crossLocale.translations.length === 2);

  // ── 5. Rename → the old URL keeps answering ────────────────────────────────
  console.log('\n── Slug rename ──');
  await articleService.update(ARTICLE, {
    translations: [
      { locale: 'en', slug: 'verify-how-to-get-paid', title: 'Getting paid', excerpt: 'How.', body, published: true },
      { locale: 'fr', slug: 'verify-se-faire-payer', title: 'Se faire payer', excerpt: 'Comment.', body, published: true },
    ],
  });

  const renamed = await publicArticleService.getBySlug('verify-how-to-get-paid', 'en');
  check('the new slug resolves', renamed.id === ARTICLE);

  try {
    await publicArticleService.getBySlug('verify-getting-paid', 'en');
    check('the retired slug reports where it moved', false, 'did not throw');
  } catch (err) {
    const appError = err instanceof AppError ? err : null;
    check(
      'the retired slug reports where it moved',
      appError?.code === 'BLOG_ARTICLE_MOVED' && appError.details?.slug === 'verify-how-to-get-paid',
      JSON.stringify(appError?.details),
    );
  }

  const revised = await articleService.getByKey(ARTICLE);
  check('a content edit stamps updatedAt', revised.updatedAt !== null);
  check('the retired slug is kept in previousSlugs',
    revised.translations.some((t) => t.previousSlugs.includes('verify-getting-paid')));

  // Nobody else may claim a retired slug — a reused one turns a redirect into a wrong answer.
  await expectError('a retired slug cannot be claimed by another article', 'BLOG_SLUG_TAKEN', () =>
    articleService.update(OTHER, {
      translations: [
        { locale: 'en', slug: 'verify-getting-paid', title: 'Other', excerpt: 'Other.', body, published: true },
      ],
    }));

  // ── 6. Per-locale publish, featured, archive ───────────────────────────────
  console.log('\n── Visibility ──');
  await articleService.update(ARTICLE, {
    translations: [
      { locale: 'en', slug: 'verify-how-to-get-paid', title: 'Getting paid', excerpt: 'How.', body, published: true },
      { locale: 'fr', slug: 'verify-se-faire-payer', title: 'Se faire payer', excerpt: 'Comment.', body, published: false },
    ],
  });
  await expectError('an unpublished translation 404s', 'BLOG_ARTICLE_NOT_FOUND', () =>
    publicArticleService.getBySlug('verify-se-faire-payer', 'fr'));

  const afterUnpublishFr = await publicArticleService.getBySlug('verify-how-to-get-paid', 'en');
  check('availableLocales drops the drafted language',
    JSON.stringify(afterUnpublishFr.availableLocales) === '["en"]');

  await articleService.publish(OTHER, {});
  await articleService.update(ARTICLE, { featured: true });
  await articleService.update(OTHER, { featured: true });
  const demoted = await articleService.getByKey(ARTICLE);
  check('featuring one article demotes the other sharing its locale', demoted.featured === false);

  await expectError('publishing twice is a conflict', 'BLOG_ARTICLE_ALREADY_PUBLISHED', () =>
    articleService.publish(ARTICLE, {}));

  await expectError('a published article cannot be deleted', 'BLOG_ARTICLE_DELETE_NOT_ALLOWED', () =>
    articleService.remove(ARTICLE));

  await articleService.archive(ARTICLE);
  try {
    await publicArticleService.getBySlug('verify-how-to-get-paid', 'en');
    check('an archived article answers 410 with its hub', false, 'did not throw');
  } catch (err) {
    const appError = err instanceof AppError ? err : null;
    check(
      'an archived article answers 410 with its hub',
      appError?.code === 'BLOG_ARTICLE_GONE' &&
        appError.statusCode === 410 &&
        appError.details?.categoryKey === 'payments',
      `${appError?.statusCode} ${JSON.stringify(appError?.details)}`,
    );
  }

  const afterArchive = await publicArticleService.list({ locale: 'en', limit: 24, offset: 0 });
  check('an archived article leaves the list', !afterArchive.items.some((a) => a.id === ARTICLE));

  // ── 7. Author guard ────────────────────────────────────────────────────────
  console.log('\n── Author ──');
  await expectError('an author credited on an article cannot be deleted', 'BLOG_AUTHOR_IN_USE', async () => {
    const { articleAuthorService } = await import('../../src/modules/blog/services/article-author.service');
    return articleAuthorService.remove(AUTHOR);
  });

  // ── 8. Route table ─────────────────────────────────────────────────────────
  console.log('\n── Express route table ──');
  const app = (await import('../../src/app')).app as unknown as { _router: { stack: unknown[] } };

  const routes: string[] = [];
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const walk = (stack: any[], prefix: string): void => {
    for (const layer of stack) {
      if (layer.route) {
        for (const m of Object.keys(layer.route.methods)) {
          if (layer.route.methods[m]) routes.push(`${m.toUpperCase()} ${prefix}${layer.route.path}`);
        }
      } else if (layer.name === 'router' && layer.handle?.stack) {
        const seg = String(layer.regexp?.source ?? '')
          .replace('^\\/', '/')
          .replace('\\/?(?=\\/|$)', '')
          .replace(/\\\//g, '/')
          .replace(/\$$/, '');
        walk(layer.handle.stack, prefix + (seg === '/' ? '' : seg));
      }
    }
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */
  walk(app._router.stack as any[], '');

  const idxOf = (r: string): number => routes.indexOf(r);
  for (const r of [
    'GET /api/public/articles',
    'GET /api/public/articles/index',
    'GET /api/public/articles/:slug',
    // Trailing slash: a sub-router's own `/` route renders that way in the walked table.
    // Express matches the request with or without it, the same as every other module here.
    'GET /api/admin/articles/',
    'POST /api/admin/articles/',
    'POST /api/admin/articles/:id/publish',
    'POST /api/admin/articles/:id/archive',
    'DELETE /api/admin/articles/:id',
    'GET /api/admin/articles/:id/preview',
    'GET /api/admin/article-authors/',
  ]) {
    check(`${r} is mounted`, routes.includes(r));
  }

  // The one ordering that matters: reversed, the build's route enumeration resolves as an
  // article slugged "index" and 404s.
  const literal = idxOf('GET /api/public/articles/index');
  const param = idxOf('GET /api/public/articles/:slug');
  check('/articles/index is declared BEFORE /articles/:slug', literal !== -1 && literal < param,
    `${literal} < ${param}`);

  // The existing /public router must still resolve — two routers share that prefix.
  check('GET /api/public/plans still resolves', routes.includes('GET /api/public/plans'));

  console.log('\n  public blog routes:');
  routes.filter((r) => r.includes('/public/articles')).forEach((r) => console.log(`    ${r}`));
  console.log('\n  admin blog routes:');
  routes.filter((r) => r.includes('/admin/article')).forEach((r) => console.log(`    ${r}`));

  await cleanup();
  console.log(`\n${'─'.repeat(72)}\n  ${pass} passed, ${fail} failed\n${'─'.repeat(72)}`);
  await mongoose.disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('FATAL', err);
  try {
    await cleanup();
    await mongoose.disconnect();
  } catch {
    // best effort — the process is going down either way
  }
  process.exit(1);
});
