/**
 * Test: the blog's **public reader** — the block vocabulary, the slug index, the derivations
 * and the public projection.
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no framework).
 * DB-free: everything under test is either a Zod schema or a pure function.
 *
 * ── What left this file at Phase 5 Part A, and why the rest stayed ────────────
 * The editor moved to wi-admin (ADR-004 D-4), and with it the create/update payload
 * schemas, `mergeTranslations`, `contentChanged`, `collectPublishBlockers` and
 * `isReservedSlug`. Those are **write** rules, and wi-admin's `test:content` owns them now.
 * Asserting them here would be asserting a copy nothing runs.
 *
 * What stayed is what jovi-mall still executes on every public request: the block union,
 * the derivations read off a body, `buildSlugKeys` (the model's, and the index the redirect
 * depends on) and the public DTO.
 *
 * ── The cross-repo fixture assertion (Phase 5 C-15) ───────────────────────────
 * `ArticleBodySchema` now exists in BOTH repositories — wi-admin validates what it writes,
 * jovi-mall types what it reads — and there is no shared package to keep them in step. So
 * the two are pinned the way `test-rich-description.ts` pins the vendor dashboard's
 * formatters: § 2b below holds a fixture list of block documents with their expected
 * verdict, wi-admin's `test:content` holds the **identical** list, and neither repo imports
 * the other. A change to the union on either side turns both red.
 *
 * That list is the point of the file now. `ArticleBodySchema` is still the only thing
 * standing between an editor and the published marketing domain — the frontend renders
 * blocks through React components rather than `dangerouslySetInnerHTML`, so a body that
 * gets past that schema is a body that renders. jovi-mall no longer writes one, but it
 * still serves every one wi-admin writes, and a union that has silently diverged is how a
 * block reaches the reader that this side cannot render.
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
  PublicArticleListQuerySchema,
} from '../../src/modules/blog/validators/article.validator';
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

/**
 * A stored translation, as `buildSlugKeys` receives it.
 *
 * It used to be built by `mergeTranslations` from an editor payload. That function moved to
 * wi-admin with the rest of the write path, so the fixture is now the **persisted** shape
 * directly — which is also the shape jovi-mall actually reads.
 */
const translation = (over: Partial<IArticleTranslation> = {}): IArticleTranslation =>
  ({
    locale: 'en',
    slug: 'getting-paid-on-whatsapp-in-cameroon',
    title: 'Getting paid on WhatsApp',
    meta_title: null,
    excerpt: 'How the money actually reaches you.',
    body: [paragraph('Commission is taken at payment, not at payout.')],
    word_count: 8,
    published: true,
    previous_slugs: [],
    ...over,
  }) as IArticleTranslation;

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

// ─── 2b. The CROSS-REPO fixture list (Phase 5 C-15) ──────────────────────────

/**
 * The shared block-union contract, copied verbatim into wi-admin's `test:content`.
 *
 * ⚠ **This array is duplicated in another repository and the duplication is the point.**
 * There is no shared package between jovi-mall and wi-admin and there will not be one, so
 * the house answer — established by `test-rich-description.ts`, which copies the vendor
 * dashboard's fixture strings byte-for-byte — is that both sides assert the *same inputs*
 * reach the *same verdict*. Neither repo imports the other; both go red when they disagree.
 *
 * Editing a case here without editing wi-admin's copy is the failure this guards, and it is
 * a silent one in production: wi-admin would accept a block jovi-mall's reader cannot type,
 * or refuse one the public DTO already serves. Change both, in one commit.
 *
 * Keep it small and behavioural. It is a drift alarm, not a second copy of § 2 — the cases
 * are the ones where the two unions could plausibly diverge, not every rule either enforces.
 */
const SHARED_BLOCK_FIXTURES: ReadonlyArray<{ name: string; body: unknown; accepted: boolean }> = [
  { name: 'a minimal paragraph', body: [paragraph('Hello.')], accepted: true },
  { name: 'an empty body', body: [], accepted: false },
  { name: 'a raw-html block', body: [{ type: 'html', html: '<script>x</script>' }], accepted: false },
  {
    name: 'an unknown key on a known block',
    body: [{ type: 'paragraph', text: [{ type: 'text', text: 'Hi.' }], html: '<b>x</b>' }],
    accepted: false,
  },
  { name: 'a heading with no id', body: [{ type: 'heading', level: 2, text: 'No id' }], accepted: false },
  { name: 'a heading at level 4', body: [{ type: 'heading', level: 4, id: 'x', text: 'Deep' }], accepted: false },
  { name: 'two headings sharing an id', body: [heading('pricing'), heading('pricing')], accepted: false },
  { name: 'two headings with distinct ids', body: [heading('pricing'), heading('payouts')], accepted: true },
  {
    name: 'an image without dimensions',
    body: [{ type: 'image', url: 'https://cdn.example/a.jpg', alt: 'A' }],
    accepted: false,
  },
  {
    name: 'an image with dimensions',
    body: [{ type: 'image', url: 'https://cdn.example/a.jpg', alt: 'A', width: 1600, height: 900 }],
    accepted: true,
  },
  {
    name: 'a javascript: href',
    body: [{ type: 'paragraph', text: [{ type: 'link', text: 'x', href: 'javascript:alert(1)' }] }],
    accepted: false,
  },
  {
    name: 'a locale-prefixed internal href',
    body: [{ type: 'paragraph', text: [{ type: 'link', text: 'x', href: '/fr/pricing' }] }],
    accepted: false,
  },
  {
    name: 'an unprefixed internal href',
    body: [{ type: 'paragraph', text: [{ type: 'link', text: 'x', href: '/pricing' }] }],
    accepted: true,
  },
  { name: 'a divider alone', body: [{ type: 'divider' }], accepted: true },
  { name: 'an empty faq', body: [{ type: 'faq', items: [] }], accepted: false },
  {
    name: 'a faq with one pair',
    body: [{ type: 'faq', items: [{ question: 'Q?', answer: 'A.' }] }],
    accepted: true,
  },
  {
    name: 'a callout with an unknown tone',
    body: [{ type: 'callout', tone: 'danger', text: [{ type: 'text', text: 'x' }] }],
    accepted: false,
  },
];

console.log('\n── Shared block fixtures (mirrored in wi-admin test:content) ──');

for (const fixture of SHARED_BLOCK_FIXTURES) {
  assert(`${fixture.name} is ${fixture.accepted ? 'ACCEPTED' : 'REFUSED'}`, () =>
    ArticleBodySchema.safeParse(fixture.body).success === fixture.accepted);
}

assert('the shared fixture list has not silently shrunk', () => SHARED_BLOCK_FIXTURES.length === 17);

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

/**
 * The reserved list, but NOT the `isReservedSlug` predicate.
 *
 * That predicate is a write-time refusal and moved to wi-admin with the editor. The list
 * itself stays here because it is a fact about **this** service's public route table:
 * `category` collides with the hub route, `page` with `/blog/page/2`, and `index` with
 * `GET /api/public/articles/index`, which `public-blog.routes.ts` declares before `/:slug`.
 *
 * So this asserts what jovi-mall still owns — the membership — and leaves the enforcement
 * to the repo that enforces it. If a route is added here that shadows a slug, this list
 * grows and wi-admin's copy has to grow with it; that is a two-repo change, and the
 * count below is what makes forgetting it visible on this side.
 */
assert('"category" is reserved (collides with the hub route)', () =>
  RESERVED_ARTICLE_SLUGS.includes('category'));
assert('"page" is reserved (collides with /blog/page/2)', () => RESERVED_ARTICLE_SLUGS.includes('page'));
assert('"index" is reserved (collides with GET /articles/index)', () =>
  RESERVED_ARTICLE_SLUGS.includes('index'));
assert('a normal slug is not reserved', () =>
  !RESERVED_ARTICLE_SLUGS.includes('getting-paid-on-whatsapp'));
assert('the reserved list is exactly those three', () => RESERVED_ARTICLE_SLUGS.length === 3);

// ─── 5. Slug keys — the retired-slug index the redirect depends on ───────────

console.log('\n── Slug keys ──');

// `buildSlugKeys` lives on the MODEL, not on the deleted service, so it is still
// jovi-mall code and still runs on every read that resolves a slug. wi-admin has its own
// copy (`content/domain/slug-keys.ts`) because it derives the field on write; the two must
// agree, and the fixtures below are the same ones its `test:content` uses.
//
// Retired slugs are in the index deliberately: a renamed article keeps answering its old
// address with `BLOG_ARTICLE_MOVED`, and no OTHER article may claim it — a reused slug
// turns a permanent redirect into a wrong answer, which is worse than the 404 it avoided.

assert("a slug key is locale-prefixed", () => slugKey("fr", "vendre") === "fr:vendre");

assert("the current slug is in the index", () =>
  buildSlugKeys([translation()]).includes("en:getting-paid-on-whatsapp-in-cameroon"));

assert("a retired slug stays in the index — this IS the redirect", () => {
  const keys = buildSlugKeys([
    translation({ slug: "how-to-get-paid", previous_slugs: ["getting-paid-on-whatsapp-in-cameroon"] }),
  ]);
  return keys.includes("en:how-to-get-paid") && keys.includes("en:getting-paid-on-whatsapp-in-cameroon");
});

assert("two renames keep both retired slugs", () =>
  buildSlugKeys([
    translation({ slug: "third-slug", previous_slugs: ["getting-paid-on-whatsapp-in-cameroon", "how-to-get-paid"] }),
  ]).length === 3);

assert("slug keys are per-locale — the same slug in two languages is two keys", () =>
  buildSlugKeys([
    translation({ locale: "en", slug: "shared-slug" }),
    translation({ locale: "fr", slug: "shared-slug" }),
  ]).length === 2);

assert("slug keys de-duplicate within one document", () =>
  buildSlugKeys([
    translation({ slug: "getting-paid-on-whatsapp-in-cameroon", previous_slugs: ["getting-paid-on-whatsapp-in-cameroon"] }),
  ]).length === 1);


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
    translations: [
      translation(),
      translation({ locale: 'fr', slug: 'se-faire-payer-sur-whatsapp' }),
    ],
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
    translations: [
      translation(),
      translation({ locale: 'fr', slug: 'se-faire-payer-sur-whatsapp', published: false }),
    ],
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
    translations: [translation({ meta_title: 'Getting paid — MoMo, OM and cash' })],
  });
  const dto = toPublicArticleSummaryDto(withMeta, withMeta.translations[0], author);
  return dto.metaTitle === 'Getting paid — MoMo, OM and cash';
});

assert('wordCount comes from the translation being served', () => summary.wordCount > 0);
assert('the author is resolved inline, not by id alone', () => summary.author?.name === 'The WiMall team');

/**
 * ⚠ **The cover's alt text is PER-LOCALE, and these assertions mirror wi-admin's.**
 *
 * `test:content` § 7 there holds the matching set — same input, same expected projection —
 * the way § 2b above mirrors its block union. The stored `IArticleCover` carries no `alt`;
 * this projection reassembles `{ url, alt, width, height }` from the translation being
 * served, which is what kept the change invisible to the marketing frontend.
 */
const COVER = { url: '/covers/getting-paid.jpg', width: 1600, height: 900 };
const covered = makeArticle({
  cover: COVER,
  translations: [
    translation({ cover_alt: 'A market stall taking a mobile payment' }),
    translation({
      locale: 'fr',
      slug: 'se-faire-payer-sur-whatsapp',
      cover_alt: 'Un étal acceptant un paiement mobile',
    }),
  ],
} as unknown as Partial<IArticle>);

const enCover = toPublicArticleSummaryDto(covered, covered.translations[0], author).cover;
const frCover = toPublicArticleSummaryDto(covered, covered.translations[1], author).cover;

assert('the public cover still carries url, alt, width and height', () =>
  JSON.stringify(Object.keys(enCover ?? {}).sort()) === JSON.stringify(['alt', 'height', 'url', 'width']));
assert('the cover alt is the one written for the language being served', () =>
  enCover?.alt === 'A market stall taking a mobile payment'
  && frCover?.alt === 'Un étal acceptant un paiement mobile');
assert('both languages share the one image', () => enCover?.url === frCover?.url);

// Unreachable from this route — wi-admin refuses to publish a live language whose cover has
// no alt — so this pins the DEFENSIVE branch: never blank, never the wrong language.
assert('an unwritten alt falls back to the title in that same language, never to blank', () => {
  const bare = makeArticle({
    cover: COVER,
    translations: [translation({ cover_alt: null })],
  } as unknown as Partial<IArticle>);
  const dto = toPublicArticleSummaryDto(bare, bare.translations[0], author);
  return dto.cover?.alt === bare.translations[0].title && dto.cover?.alt !== '';
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
