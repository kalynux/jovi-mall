/**
 * Live-DB smoke test for the blog's **public reader**.
 *
 * Like `verify-live-parity.ts` this one NEEDS Mongo, and for the same reasons — it covers
 * exactly what `tsc` and the DB-free suite structurally cannot see:
 *
 *   1. the schema indexes actually BUILD — in particular the **unique multikey index on
 *      `slug_keys`**, which only exists because MongoDB refuses a compound index on
 *      `translations.locale` + `translations.slug` (parallel array paths). If that
 *      reasoning were wrong, this is where it shows. `autoIndex` is off in production, so
 *      this is also the only place the index is proven at all.
 *   2. the index actually REJECTS a duplicate — a unique index that builds but does not
 *      bind is indistinguishable from one that works, until two articles answer one URL.
 *   3. the queries actually RUN — `$elemMatch` on the translations array, the sort, the
 *      count
 *   4. the Express route table resolves `/articles/index` BEFORE `/articles/:slug`
 *
 * ── What changed at Phase 5 Part A ────────────────────────────────────────────
 * The editor moved to wi-admin (ADR-004 D-4), so `articleService` and
 * `articleAuthorService` no longer exist here and this file no longer drives the lifecycle
 * through them. It writes **`ArticleModel` fixtures directly** and then asserts what the
 * public reader does with them.
 *
 * That is a smaller claim than the old file made, and deliberately so: the editor's rules —
 * slug-taken, reserved slugs, the featured demotion, publish-twice, delete-once-published,
 * the author-in-use guard — are wi-admin's to enforce and wi-admin's `test:content` and
 * `verify:content` assert them. Asserting them here would assert a copy nothing runs.
 *
 * ⚠ **What this file writes by hand, wi-admin must write for real.** These fixtures are
 * built to the shape `ArticleSchema` declares, and wi-admin writes the same collection on
 * the RAW driver, which applies none of this schema's defaults. `verify:content` over
 * there is what proves its writer produces documents this reader renders; this file proves
 * the reader, given correct documents. Neither is sufficient alone — that is the O-3 split.
 *
 * **It writes**, then cleans up after itself: every document it creates is keyed
 * `verify-blog-*` and deleted at the end, pass or fail.
 *
 * Run: npm run verify:blog
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import {
  ArticleModel,
  IArticle,
  IArticleTranslation,
  buildSlugKeys,
} from '../../src/modules/blog/models/article.model';
import { ArticleAuthorModel } from '../../src/modules/blog/models/article-author.model';
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
    text: [{ type: 'text' as const, text: 'Commission is taken at payment, not at payout.' }],
  },
];

/**
 * One stored translation.
 *
 * Every field `ArticleSchema` would default is written explicitly, because that is the
 * discipline wi-admin's raw-driver writer has to keep and a fixture that leans on Mongoose
 * defaults would be testing the reader against documents the real writer never produces.
 */
function translation(over: Partial<IArticleTranslation> = {}): IArticleTranslation {
  return {
    locale: 'en',
    slug: 'verify-getting-paid',
    title: 'Getting paid',
    meta_title: null,
    excerpt: 'How.',
    body,
    word_count: 11,
    published: true,
    previous_slugs: [],
    ...over,
  } as IArticleTranslation;
}

/** One stored article, with `slug_keys` derived exactly as a writer must derive it. */
function articleDoc(key: string, translations: IArticleTranslation[], over: Partial<IArticle> = {}) {
  return {
    key,
    category_key: 'payments',
    author_key: AUTHOR,
    status: 'draft',
    featured: false,
    cover: null,
    published_at: null,
    content_updated_at: null,
    archived_at: null,
    translations,
    slug_keys: buildSlugKeys(translations),
    deletedAt: null,
    purgeAt: null,
    ...over,
  };
}

async function cleanup(): Promise<void> {
  await ArticleModel.deleteMany({ key: { $in: [ARTICLE, OTHER] } });
  await ArticleAuthorModel.deleteMany({ key: AUTHOR });
}

async function main(): Promise<void> {
  await mongoose.connect(MONGO_URI);
  console.log(`Connected: ${MONGO_URI}\n`);
  await cleanup();

  // ── 1. Index builds ────────────────────────────────────────────────────────
  console.log('── Index builds (autoIndex is OFF in production — nothing else proves these) ──');
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
  await ArticleModel.create([
    articleDoc(ARTICLE, [
      translation(),
      translation({ locale: 'fr', slug: 'verify-se-faire-payer', title: 'Se faire payer', excerpt: 'Comment.' }),
    ]),
  ]);
  check('created as draft', (await ArticleModel.findOne({ key: ARTICLE }))?.status === 'draft');

  const draftList = await publicArticleService.list({ locale: 'en', limit: 24, offset: 0 });
  check('a draft is absent from the public list',
    !draftList.items.some((a) => a.id === ARTICLE), `${draftList.total} published article(s)`);

  await expectError('a draft slug 404s publicly', 'BLOG_ARTICLE_NOT_FOUND', () =>
    publicArticleService.getBySlug('verify-getting-paid', 'en'));

  // ── 3. Published — the public queries ──────────────────────────────────────
  console.log('\n── Published ──');
  const publishedAt = new Date('2026-07-08T08:00:00.000Z');
  await ArticleModel.updateOne({ key: ARTICLE }, { $set: { status: 'published', published_at: publishedAt } });

  const enList = await publicArticleService.list({ locale: 'en', limit: 24, offset: 0 });
  check('appears in the English list ($elemMatch + sort + count run)',
    enList.items.some((a) => a.id === ARTICLE));

  const detail = await publicArticleService.getBySlug('verify-getting-paid', 'en');
  check('detail carries the body', Array.isArray(detail.body) && detail.body.length === 2);
  check('detail resolves the byline inline', detail.author?.name === 'Verify Byline');
  check('availableLocales lists both languages', JSON.stringify(detail.availableLocales) === '["en","fr"]');
  check('wordCount is served from the stored translation', detail.wordCount > 0, String(detail.wordCount));

  // A missing translation is a 404, never a fallback — the language decision, in the reader.
  await expectError('the English slug under /pt 404s (no fallback)', 'BLOG_ARTICLE_NOT_FOUND', () =>
    publicArticleService.getBySlug('verify-getting-paid', 'pt'));

  const categoryList = await publicArticleService.list({ locale: 'en', category: 'payments', limit: 24, offset: 0 });
  check('the category hub query runs and matches', categoryList.items.some((a) => a.id === ARTICLE));

  const wrongCategory = await publicArticleService.list({ locale: 'en', category: 'delivery', limit: 24, offset: 0 });
  check('another category excludes it', !wrongCategory.items.some((a) => a.id === ARTICLE));

  const index = await publicArticleService.index();
  const row = index.find((r) => r.id === ARTICLE);
  check('the build index lists every (locale, slug) pair', row?.translations.length === 2);

  // ── 4. The unique index BINDS ──────────────────────────────────────────────
  //
  // The whole reason `slug_keys` exists. wi-admin owns the writes now and this index is
  // declared here, so "a duplicate is refused" is a claim spanning two repositories — and
  // a unique index that builds but does not bind looks exactly like one that works.
  console.log('\n── Slug-key uniqueness (enforced by the index, not by application code) ──');
  let duplicateRefused = false;
  try {
    await ArticleModel.create([
      articleDoc(OTHER, [translation({ slug: 'verify-getting-paid' })], { category_key: 'growth' }),
    ]);
  } catch (err) {
    duplicateRefused = (err as { code?: number }).code === 11000;
  }
  check('a second article claiming a live slug is refused by the index', duplicateRefused);

  // The same slug in a DIFFERENT locale is a different key and must be allowed.
  await ArticleModel.deleteMany({ key: OTHER });
  await ArticleModel.create([
    articleDoc(
      OTHER,
      [translation({ locale: 'fr', slug: 'verify-getting-paid', title: 'Autre', excerpt: 'Autre.' })],
      { category_key: 'growth', status: 'published', published_at: publishedAt },
    ),
  ]);
  check('the same slug in another locale is allowed',
    (await ArticleModel.countDocuments({ key: OTHER })) === 1);

  // ── 5. A retired slug keeps answering ──────────────────────────────────────
  console.log('\n── Slug rename ──');
  const renamedTranslations = [
    translation({ slug: 'verify-how-to-get-paid', previous_slugs: ['verify-getting-paid'] }),
    translation({ locale: 'fr', slug: 'verify-se-faire-payer', title: 'Se faire payer', excerpt: 'Comment.' }),
  ];
  await ArticleModel.updateOne(
    { key: ARTICLE },
    { $set: { translations: renamedTranslations, slug_keys: buildSlugKeys(renamedTranslations) } },
  );

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

  // Nobody else may claim a retired slug — a reused one turns a redirect into a wrong
  // answer, and the index is what makes that true rather than a service check.
  let retiredRefused = false;
  try {
    await ArticleModel.updateOne(
      { key: OTHER },
      { $addToSet: { slug_keys: 'en:verify-getting-paid' } },
    );
  } catch (err) {
    retiredRefused = (err as { code?: number }).code === 11000;
  }
  check('a retired slug cannot be claimed by another article', retiredRefused);

  // ── 6. Per-locale publish and archive ──────────────────────────────────────
  console.log('\n── Visibility ──');
  const frDrafted = [
    translation({ slug: 'verify-how-to-get-paid', previous_slugs: ['verify-getting-paid'] }),
    translation({
      locale: 'fr',
      slug: 'verify-se-faire-payer',
      title: 'Se faire payer',
      excerpt: 'Comment.',
      published: false,
    }),
  ];
  await ArticleModel.updateOne(
    { key: ARTICLE },
    { $set: { translations: frDrafted, slug_keys: buildSlugKeys(frDrafted) } },
  );

  await expectError('an unpublished translation 404s', 'BLOG_ARTICLE_NOT_FOUND', () =>
    publicArticleService.getBySlug('verify-se-faire-payer', 'fr'));

  const afterUnpublishFr = await publicArticleService.getBySlug('verify-how-to-get-paid', 'en');
  check('availableLocales drops the drafted language',
    JSON.stringify(afterUnpublishFr.availableLocales) === '["en"]');

  await ArticleModel.updateOne(
    { key: ARTICLE },
    { $set: { status: 'archived', archived_at: new Date() } },
  );
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

  // ── 7. Route table ─────────────────────────────────────────────────────────
  console.log('\n── Express route table ──');
  const app = (await import('../../src/app')).app as unknown as { _router: { stack: unknown[] } };

  const routes: string[] = [];

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

  walk(app._router.stack as any[], '');

  const idxOf = (r: string): number => routes.indexOf(r);
  for (const r of [
    'GET /api/public/articles',
    'GET /api/public/articles/index',
    'GET /api/public/articles/:slug',
  ]) {
    check(`${r} is mounted`, routes.includes(r));
  }

  // The editor is gone from this service. Asserting its ABSENCE is the half of the cutover
  // a mount deletion can silently fail to achieve — a stray re-import would restore a
  // second writer on a collection wi-admin now owns, which is what step 5.0 exists to stop.
  const adminBlogRoutes = routes.filter((r) => r.includes('/admin/article'));
  check('no /api/admin/article* route survives (the editor moved to wi-admin)',
    adminBlogRoutes.length === 0, adminBlogRoutes.join(', ') || 'none');

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
