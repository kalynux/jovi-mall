/**
 * Test: the blog's content rules — the block vocabulary, slug handling and the derivations.
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no framework).
 * DB-free: everything under test is either a Zod schema or a pure function, which is why
 * they were kept out of the services.
 *
 * The first section is the point of the file. `ArticleBodySchema` is the **only** thing
 * standing between an editor and the published marketing domain — the frontend renders
 * blocks through React components rather than `dangerouslySetInnerHTML`, so a body that
 * gets past this schema is a body that renders. Each rejection below is a page-level bug
 * it prevents, not a style preference.
 *
 * Run: npm run test:blog
 */
import {
  ArticleBodySchema,
  HrefSchema,
  countWords,
  headingIds,
} from '../../src/modules/blog/validators/article-body.validator';
import {
  ArticleSlugSchema,
  ArticleKeySchema,
  CreateArticleSchema,
  PublicArticleListQuerySchema,
} from '../../src/modules/blog/validators/article.validator';
import {
  contentChanged,
  collectPublishBlockers,
  isReservedSlug,
  mergeTranslations,
  TranslationInput,
} from '../../src/modules/blog/domain/article-content.rules';
import { buildSlugKeys, IArticle, IArticleTranslation, slugKey } from '../../src/modules/blog/models/article.model';
import {
  availableLocalesOf,
  toPublicArticleSummaryDto,
  toPublicAuthorDto,
} from '../../src/modules/blog/dto/public-article.dto';
import { IArticleAuthor } from '../../src/modules/blog/models/article-author.model';
import { RESERVED_ARTICLE_SLUGS } from '../../src/modules/blog/blog.types';

let passed = 0;
let failed = 0;

function assert(name: string, fn: () => boolean): void {
  let ok: boolean;
  try {
    ok = fn();
  } catch (err) {
    console.error(`  ❌ THROW: ${name} — ${(err as Error).message}`);
    failed++;
    return;
  }
  if (ok) {
    console.log(`  ✅ ${name}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${name}`);
    failed++;
  }
}

const accepts = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) =>
  schema.safeParse(value).success;
const rejects = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) =>
  !schema.safeParse(value).success;

// ─── Fixtures ────────────────────────────────────────────────────────────────

const paragraph = (text: string) => ({
  type: 'paragraph' as const,
  text: [{ type: 'text' as const, text }],
});

const heading = (id: string, text = 'A heading') => ({
  type: 'heading' as const,
  level: 2 as const,
  id,
  text,
});

const translation = (over: Partial<TranslationInput> = {}): TranslationInput => ({
  locale: 'en',
  slug: 'getting-paid-on-whatsapp-in-cameroon',
  title: 'Getting paid on WhatsApp',
  excerpt: 'How the money actually reaches you.',
  body: [paragraph('Commission is taken at payment, not at payout.')],
  published: true,
  ...over,
});

// ─── 1. Links: the locale-prefix rule and the protocol allowlist ─────────────

console.log('\n── Links ──');

assert('an internal path is accepted', () => accepts(HrefSchema, '/pricing'));
assert('an external https URL is accepted', () => accepts(HrefSchema, 'https://example.com/x'));
assert('a fragment is accepted', () => accepts(HrefSchema, '#how-momo-payouts-work'));
assert('a mailto: is accepted', () => accepts(HrefSchema, 'mailto:hello@example.com'));

// The rule the requirements call out by name: a prefixed path renders as /fr/fr/pricing.
assert('/fr/pricing is REFUSED (renderer adds the locale)', () => rejects(HrefSchema, '/fr/pricing'));
assert('/en is REFUSED (bare locale root)', () => rejects(HrefSchema, '/en'));
assert('/ar/guides is REFUSED', () => rejects(HrefSchema, '/ar/guides'));
assert('/pricing/fr is ACCEPTED (locale not in first segment)', () => accepts(HrefSchema, '/pricing/fr'));
assert('/french-guide is ACCEPTED (prefix is a segment, not a substring)', () =>
  accepts(HrefSchema, '/french-guide'));

assert('javascript: is REFUSED', () => rejects(HrefSchema, 'javascript:alert(1)'));
assert('data: is REFUSED', () => rejects(HrefSchema, 'data:text/html;base64,PHNjcmlwdD4='));
assert('protocol-relative //evil.example is REFUSED', () => rejects(HrefSchema, '//evil.example'));
assert('a bare relative word is REFUSED', () => rejects(HrefSchema, 'pricing'));

// ─── 2. Blocks ───────────────────────────────────────────────────────────────

console.log('\n── Blocks ──');

assert('a minimal body is accepted', () => accepts(ArticleBodySchema, [paragraph('Hello.')]));
assert('an empty body is refused', () => rejects(ArticleBodySchema, []));

assert('an unknown block type is refused', () =>
  rejects(ArticleBodySchema, [{ type: 'html', html: '<script>x</script>' }]));

assert('an unknown KEY on a known block is refused (strict, not stripped)', () =>
  rejects(ArticleBodySchema, [{ ...paragraph('Hi.'), html: '<b>x</b>' }]));

assert('heading ids must be authored', () =>
  rejects(ArticleBodySchema, [{ type: 'heading', level: 2, text: 'No id here' }]));

assert('heading ids must be kebab-case', () => rejects(ArticleBodySchema, [heading('How It Works')]));

assert('heading level 4 is refused (only 2 and 3 render)', () =>
  rejects(ArticleBodySchema, [{ type: 'heading', level: 4, id: 'x', text: 'Too deep' }]));

// Two #pricing anchors mean one is unreachable, and which one wins is a browser detail.
assert('duplicate heading ids in one body are refused', () =>
  rejects(ArticleBodySchema, [heading('pricing'), paragraph('…'), heading('pricing')]));

assert('distinct heading ids are accepted', () =>
  accepts(ArticleBodySchema, [heading('pricing'), heading('payouts')]));

assert('an image without width/height is refused (layout shift)', () =>
  rejects(ArticleBodySchema, [{ type: 'image', url: 'https://cdn.example/a.jpg', alt: 'A' }]));

assert('an image with width/height is accepted', () =>
  accepts(ArticleBodySchema, [
    { type: 'image', url: 'https://cdn.example/a.jpg', alt: 'A', width: 1600, height: 900 },
  ]));

assert('an image without alt is refused', () =>
  rejects(ArticleBodySchema, [
    { type: 'image', url: 'https://cdn.example/a.jpg', alt: '', width: 16, height: 9 },
  ]));

assert('a locale-prefixed link INSIDE a paragraph is refused', () =>
  rejects(ArticleBodySchema, [
    {
      type: 'paragraph',
      text: [{ type: 'link', text: 'pricing', href: '/fr/pricing' }],
    },
  ]));

assert('a locale-prefixed CTA href is refused', () =>
  rejects(ArticleBodySchema, [
    { type: 'cta', title: 'T', body: 'B', href: '/fr/pricing', label: 'Go' },
  ]));

assert('a CTA with a clean href is accepted', () =>
  accepts(ArticleBodySchema, [{ type: 'cta', title: 'T', body: 'B', href: '/pricing', label: 'Go' }]));

assert('marks compose on one span', () =>
  accepts(ArticleBodySchema, [
    { type: 'paragraph', text: [{ type: 'text', text: 'at payment', bold: true, italic: true }] },
  ]));

assert('spans do not nest', () =>
  rejects(ArticleBodySchema, [
    { type: 'paragraph', text: [{ type: 'text', text: 'x', children: [{ type: 'text', text: 'y' }] }] },
  ]));

assert('a faq block is accepted', () =>
  accepts(ArticleBodySchema, [{ type: 'faq', items: [{ question: 'Q?', answer: 'A.' }] }]));

assert('an empty faq block is refused', () => rejects(ArticleBodySchema, [{ type: 'faq', items: [] }]));

assert('a callout needs a known tone', () =>
  rejects(ArticleBodySchema, [{ type: 'callout', tone: 'danger', text: [{ type: 'text', text: 'x' }] }]));

assert('a divider needs nothing else', () => accepts(ArticleBodySchema, [{ type: 'divider' }]));

assert('a list of rich-text items is accepted', () =>
  accepts(ArticleBodySchema, [
    { type: 'list', ordered: true, items: [[{ type: 'text', text: 'One' }], [{ type: 'text', text: 'Two' }]] },
  ]));

// ─── 3. Derivations from a body ──────────────────────────────────────────────

console.log('\n── Derivations ──');

const richBody = ArticleBodySchema.parse([
  heading('how-it-works', 'How it works'),
  {
    type: 'paragraph',
    text: [
      { type: 'text', text: 'Commission is taken ' },
      { type: 'text', text: 'at payment', bold: true },
      { type: 'text', text: ', not at payout. See ' },
      { type: 'link', text: 'the pricing page', href: '/pricing' },
      { type: 'text', text: '.' },
    ],
  },
  { type: 'image', url: '/a.jpg', alt: 'alt text is not prose', width: 4, height: 3 },
  heading('payouts', 'Payouts'),
]);

// 3 (heading) + 12 (paragraph) + 1 (second heading). Spans concatenate with no separator,
// so the punctuation-only span "." joins "page" rather than counting as a thirteenth word —
// otherwise every bold run in an article would inflate the count.
assert('countWords counts prose across spans without splitting on formatting', () =>
  countWords(richBody) === 16);

assert('countWords ignores image alt', () => {
  const withLongerAlt = ArticleBodySchema.parse(
    richBody.map((block) =>
      block.type === 'image'
        ? { ...block, alt: 'a much longer alternative text with many extra words in it' }
        : block,
    ),
  );
  return countWords(withLongerAlt) === countWords(richBody);
});
assert('countWords is 0 for a bodyless-but-valid divider body', () =>
  countWords(ArticleBodySchema.parse([{ type: 'divider' }])) === 0);
assert('headingIds recovers the table of contents in order', () =>
  JSON.stringify(headingIds(richBody)) === JSON.stringify(['how-it-works', 'payouts']));

// ─── 4. Slugs and ids ────────────────────────────────────────────────────────

console.log('\n── Slugs & ids ──');

assert('an ASCII slug is accepted', () => accepts(ArticleSlugSchema, 'comment-vendre-sur-whatsapp'));
assert('an Arabic slug is accepted', () => accepts(ArticleSlugSchema, 'كيفية-البيع'));
assert('a slug with a space is refused', () => rejects(ArticleSlugSchema, 'comment vendre'));
assert('a slug with a slash is refused', () => rejects(ArticleSlugSchema, 'blog/post'));
assert('an uppercase slug is refused', () => rejects(ArticleSlugSchema, 'Getting-Paid'));
assert('a double hyphen is refused', () => rejects(ArticleSlugSchema, 'getting--paid'));
assert('a leading hyphen is refused', () => rejects(ArticleSlugSchema, '-getting-paid'));

assert('an article id must be ASCII kebab', () => accepts(ArticleKeySchema, 'getting-paid-on-whatsapp'));
assert('an article id refuses non-ASCII (it is a log key, not a URL)', () =>
  rejects(ArticleKeySchema, 'كيفية-البيع'));

assert('"category" is reserved (collides with the hub route)', () => isReservedSlug('category'));
assert('"page" is reserved (collides with /blog/page/2)', () => isReservedSlug('page'));
assert('"index" is reserved (collides with GET /articles/index)', () => isReservedSlug('index'));
assert('a normal slug is not reserved', () => !isReservedSlug('getting-paid-on-whatsapp'));
assert('the reserved list is exactly those three', () => RESERVED_ARTICLE_SLUGS.length === 3);

// ─── 5. Create payload ───────────────────────────────────────────────────────

console.log('\n── Create payload ──');

const validCreate = {
  id: 'getting-paid-on-whatsapp',
  categoryKey: 'payments',
  authorId: 'wimall-editorial',
  translations: [translation()],
};

assert('a valid create body parses', () => accepts(CreateArticleSchema, validCreate));
assert('status is not settable on create', () =>
  rejects(CreateArticleSchema, { ...validCreate, status: 'published' }));
assert('an unknown category key is refused', () =>
  rejects(CreateArticleSchema, { ...validCreate, categoryKey: 'money' }));
assert('two translations in the same locale are refused', () =>
  rejects(CreateArticleSchema, {
    ...validCreate,
    translations: [translation(), translation({ slug: 'other-slug' })],
  }));
assert('two translations in different locales are accepted', () =>
  accepts(CreateArticleSchema, {
    ...validCreate,
    translations: [translation(), translation({ locale: 'fr', slug: 'se-faire-payer' })],
  }));
assert('no translations is refused', () =>
  rejects(CreateArticleSchema, { ...validCreate, translations: [] }));
assert('a cover without dimensions is refused', () =>
  rejects(CreateArticleSchema, {
    ...validCreate,
    cover: { url: 'https://cdn.example/c.jpg', alt: 'Cover' },
  }));
assert('translations default to published', () => {
  const parsed = CreateArticleSchema.parse(validCreate);
  return parsed.translations[0].published === true;
});

console.log('\n── Public list query ──');

assert('locale is required — no silent English default', () =>
  rejects(PublicArticleListQuerySchema, { category: 'payments' }));
assert('limit defaults to 24, offset to 0', () => {
  const parsed = PublicArticleListQuerySchema.parse({ locale: 'fr' });
  return parsed.limit === 24 && parsed.offset === 0;
});
assert('limit and offset coerce from query strings', () => {
  const parsed = PublicArticleListQuerySchema.parse({ locale: 'fr', limit: '10', offset: '20' });
  return parsed.limit === 10 && parsed.offset === 20;
});
assert('an unknown locale is refused', () => rejects(PublicArticleListQuerySchema, { locale: 'de' }));

// ─── 6. Slug history — the redirect the requirements ask for ─────────────────

console.log('\n── Slug history ──');

const initial = mergeTranslations([], [translation()]);

assert('a first save has no slug history', () => initial[0].previous_slugs.length === 0);
assert('word_count is derived on save', () => initial[0].word_count > 0);

const renamed = mergeTranslations(initial, [translation({ slug: 'how-to-get-paid-on-whatsapp' })]);

assert('renaming a slug retires the old one', () =>
  JSON.stringify(renamed[0].previous_slugs) === JSON.stringify(['getting-paid-on-whatsapp-in-cameroon']));

const renamedTwice = mergeTranslations(renamed, [translation({ slug: 'third-slug' })]);

assert('a second rename keeps both retired slugs', () => renamedTwice[0].previous_slugs.length === 2);

const revertedToFirst = mergeTranslations(renamedTwice, [
  translation({ slug: 'getting-paid-on-whatsapp-in-cameroon' }),
]);

assert('reverting to an old slug removes it from the history (it is current, not retired)', () =>
  !revertedToFirst[0].previous_slugs.includes('getting-paid-on-whatsapp-in-cameroon') &&
  revertedToFirst[0].previous_slugs.length === 2);

assert('an unchanged slug does not accumulate history', () => {
  const again = mergeTranslations(initial, [translation()]);
  return again[0].previous_slugs.length === 0;
});

assert('a new locale starts with a clean history', () => {
  const withFrench = mergeTranslations(renamed, [
    translation({ slug: 'how-to-get-paid-on-whatsapp' }),
    translation({ locale: 'fr', slug: 'se-faire-payer-sur-whatsapp' }),
  ]);
  return withFrench[1].previous_slugs.length === 0;
});

console.log('\n── Slug keys (the uniqueness index) ──');

assert('slug keys cover current and retired slugs', () => {
  const keys = buildSlugKeys(renamed);
  return (
    keys.includes(slugKey('en', 'how-to-get-paid-on-whatsapp')) &&
    keys.includes(slugKey('en', 'getting-paid-on-whatsapp-in-cameroon')) &&
    keys.length === 2
  );
});

assert('slug keys are per-locale — the same slug in two languages is two keys', () => {
  const both = mergeTranslations([], [
    translation({ locale: 'en', slug: 'shared-slug' }),
    translation({ locale: 'fr', slug: 'shared-slug' }),
  ]);
  return buildSlugKeys(both).length === 2;
});

assert('slug keys de-duplicate within one document', () => {
  const withDupHistory: IArticleTranslation[] = [
    { ...initial[0], previous_slugs: [initial[0].slug] },
  ];
  return buildSlugKeys(withDupHistory).length === 1;
});

// ─── 7. contentChanged — what counts as a revision ───────────────────────────

console.log('\n── Revision detection ──');

const before = { translations: initial, cover: null };

assert('an identical save is not a revision', () =>
  !contentChanged(before, { translations: mergeTranslations([], [translation()]), cover: null }));

assert('editing the body IS a revision', () =>
  contentChanged(before, {
    translations: mergeTranslations(initial, [
      translation({ body: [paragraph('Rewritten entirely.')] }),
    ]),
    cover: null,
  }));

assert('editing the title IS a revision', () =>
  contentChanged(before, {
    translations: mergeTranslations(initial, [translation({ title: 'A new title' })]),
    cover: null,
  }));

assert('adding a cover IS a revision', () =>
  contentChanged(before, {
    translations: initial,
    cover: { url: '/c.jpg', alt: 'Cover', width: 1600, height: 900 },
  }));

assert('adding a language IS a revision (the hreflang set changed)', () =>
  contentChanged(before, {
    translations: mergeTranslations(initial, [
      translation(),
      translation({ locale: 'fr', slug: 'se-faire-payer' }),
    ]),
    cover: null,
  }));

// The trap this whole mechanism exists to avoid: `featured` and `published` move on the
// document, so Mongoose's own updatedAt moves too — and a wrong `dateModified` in the
// structured data is what that would publish.
assert('flipping `published` on a translation is NOT a revision', () =>
  !contentChanged(before, {
    translations: mergeTranslations(initial, [translation({ published: false })]),
    cover: null,
  }));

// ─── 8. Publish blockers ─────────────────────────────────────────────────────

console.log('\n── Publish blockers ──');

assert('a complete article has no blockers', () =>
  collectPublishBlockers({ translations: initial, authorExists: true }).length === 0);

assert('a missing author blocks', () =>
  collectPublishBlockers({ translations: initial, authorExists: false }).length === 1);

assert('no translations blocks', () =>
  collectPublishBlockers({ translations: [], authorExists: true }).length === 1);

assert('every-translation-unpublished blocks', () =>
  collectPublishBlockers({
    translations: mergeTranslations(initial, [translation({ published: false })]),
    authorExists: true,
  }).length === 1);

// A checklist, not a first failure: an editor should not learn about three problems over
// three round-trips.
assert('blockers accumulate rather than short-circuit', () =>
  collectPublishBlockers({ translations: [], authorExists: false }).length === 2);

// ─── 9. The public projection ────────────────────────────────────────────────

console.log('\n── Public DTO ──');

const author = {
  key: 'wimall-editorial',
  name: 'The WiMall team',
  type: 'Organization' as const,
  avatar_url: null,
  translations: new Map([
    ['en', { title: 'Editorial', bio: 'We write about selling on WhatsApp.' }],
    ['fr', { title: 'Rédaction', bio: 'Nous écrivons sur la vente via WhatsApp.' }],
  ]),
} as unknown as IArticleAuthor;

const publishedAt = new Date('2026-07-08T08:00:00.000Z');

const makeArticle = (over: Partial<IArticle> = {}) =>
  ({
    key: 'getting-paid-on-whatsapp',
    category_key: 'payments',
    author_key: 'wimall-editorial',
    status: 'published',
    featured: false,
    cover: null,
    published_at: publishedAt,
    content_updated_at: null,
    archived_at: null,
    createdAt: publishedAt,
    updatedAt: publishedAt,
    translations: mergeTranslations([], [
      translation(),
      translation({ locale: 'fr', slug: 'se-faire-payer-sur-whatsapp' }),
    ]),
    ...over,
  } as unknown as IArticle);

assert('the author bio resolves in the requested locale', () =>
  toPublicAuthorDto(author, 'fr').title === 'Rédaction');

// The single deliberate fallback in the module — a blank byline is worse than an English one.
assert('a missing author locale falls back to English', () =>
  toPublicAuthorDto(author, 'pt').title === 'Editorial');

assert('availableLocales lists published languages in canonical order', () =>
  JSON.stringify(availableLocalesOf(makeArticle())) === JSON.stringify(['en', 'fr']));

assert('an unpublished translation is NOT in availableLocales', () => {
  const article = makeArticle({
    translations: mergeTranslations([], [
      translation(),
      translation({ locale: 'fr', slug: 'se-faire-payer-sur-whatsapp', published: false }),
    ]),
  });
  return JSON.stringify(availableLocalesOf(article)) === JSON.stringify(['en']);
});

const summary = toPublicArticleSummaryDto(makeArticle(), makeArticle().translations[0], author);

assert('the summary carries no body', () => !('body' in summary));
assert('the summary flattens the requested translation', () => summary.locale === 'en');
assert('publishedAt is ISO 8601 UTC', () => summary.publishedAt === '2026-07-08T08:00:00.000Z');
assert('cover is an explicit null, not omitted', () => 'cover' in summary && summary.cover === null);

// Both are `?:` on the frontend's types — `null` would be a type lie that happens to work.
assert('updatedAt is OMITTED when never revised', () => !('updatedAt' in summary));
assert('metaTitle is OMITTED when unset', () => !('metaTitle' in summary));

assert('updatedAt is present once revised', () => {
  const revised = makeArticle({ content_updated_at: new Date('2026-07-30T09:20:00.000Z') });
  const dto = toPublicArticleSummaryDto(revised, revised.translations[0], author);
  return dto.updatedAt === '2026-07-30T09:20:00.000Z';
});

assert('metaTitle is present once set', () => {
  const withMeta = makeArticle({
    translations: mergeTranslations([], [translation({ metaTitle: 'Getting paid — MoMo, OM and cash' })]),
  });
  const dto = toPublicArticleSummaryDto(withMeta, withMeta.translations[0], author);
  return dto.metaTitle === 'Getting paid — MoMo, OM and cash';
});

assert('wordCount comes from the translation being served', () => summary.wordCount > 0);
assert('the author is resolved inline, not by id alone', () => summary.author?.name === 'The WiMall team');

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
