/**
 * Structured product descriptions (`descriptionRich`) — tests, no DB needed.
 *
 * Three things are covered, and only the first is obvious:
 *
 * 1. **The formatters, against the vendor dashboard's own fixtures.** The chat
 *    output IS the feature, and the two implementations live in two repositories
 *    with no shared package. The expected strings below are copied verbatim from
 *    `frontend/vendor-dash/tools/richtext/fixtures.ts`, so a drift on either side
 *    shows up here as a byte diff rather than as a vendor complaining that
 *    WhatsApp "put stars everywhere".
 *
 * 2. **The invariants that survive truncation.** A message cut mid-marker is not
 *    a shorter message: WhatsApp renders everything after an unclosed `*` as one
 *    bold run, and Telegram rejects a severed `</b>` outright with
 *    `400 can't parse entities` — which the bot service logs and discards, so the
 *    send silently never happens. These are asserted on a document that is more
 *    than twice the cap.
 *
 * 3. **The wiring, by source scan.** `descriptionRich` must be accepted on all
 *    four write endpoints (two of them `.strict()`, where a missing field is a
 *    400 on the *whole* save), must clear on an explicit `null`, and must stay
 *    out of the text index, the vectoriser payload and the public DTOs. A
 *    formatter nobody calls and a field half the endpoints reject both look fine
 *    from every other angle.
 *
 * Run: npx ts-node scripts/test/test-rich-description.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  CHAT_LIMITS,
  RichDoc,
  docCharCount,
  escapeTelegramHtml,
  isAllowedHref,
  parseRichDoc,
  richDocSchema,
  toPlainText,
  toTelegramHtml,
  toTelegramPlain,
  toWhatsApp,
  truncateDoc,
} from '../../src/core/richtext';
import { WA_LIMITS } from '../../src/modules/whatsapp/constants/whatsapp-limits';
import {
  CreateProductSchema,
  UpdateProductSchema,
} from '../../src/modules/catalog/validators/product.validator';
import {
  CreateSimpleProductSchema,
  UpdateSimpleProductSchema,
} from '../../src/modules/catalog/validators/simple-product.validator';
import { ProductUpdateService } from '../../src/modules/catalog/domain/services/ProductUpdateService';
import { IProductRepository } from '../../src/modules/catalog/repositories/interfaces/product.repository.interface';
import { Product, ProductMapper } from '../../src/modules/catalog/repositories/mappers/product.mapper';
import { toTelegramNotificationBody } from '../../src/modules/notifications/catalog/message-renderer';

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL  ${label}`);
  }
}

function assertEqual(actual: string, expected: string, label: string): void {
  if (actual === expected) {
    passed++;
    return;
  }
  failed++;
  console.error(`  FAIL  ${label}`);
  console.error(`        expected: ${JSON.stringify(expected)}`);
  console.error(`        actual:   ${JSON.stringify(actual)}`);
}

const SRC = path.resolve(__dirname, '../../src');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');

/**
 * Strip comments before scanning for a symbol.
 *
 * Needed because the files here explain at length why `descriptionRich` is
 * absent from a place — and a naive scan then reads the explanation as the thing
 * it was written to forbid.
 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const doc = (blocks: RichDoc['blocks']): RichDoc => ({ version: 1, blocks });

/* ─── 1. Test vectors, byte-for-byte with the dashboard's fixtures ────────── */

function testVectors(): void {
  console.log('\n· Test vectors (frontend/vendor-dash/tools/richtext/fixtures.ts)');

  // A. Bold name, struck-through old price, emoji.
  const a = doc([
    {
      type: 'paragraph',
      text: [
        { type: 'text', text: '🔥 ' },
        { type: 'text', text: 'Sac en raphia tressé', bold: true },
        { type: 'text', text: ' — fait main à Douala.' },
      ],
    },
    {
      type: 'paragraph',
      text: [
        { type: 'text', text: 'Prix : ' },
        { type: 'text', text: '12.500 FCFA', bold: true },
        { type: 'text', text: ' (au lieu de ' },
        { type: 'text', text: '18.000 FCFA', strike: true },
        { type: 'text', text: ')' },
      ],
    },
  ]);
  assertEqual(
    toWhatsApp(a),
    '🔥 *Sac en raphia tressé* — fait main à Douala.\n\nPrix : *12.500 FCFA* (au lieu de ~18.000 FCFA~)',
    'A: whatsapp',
  );
  assertEqual(
    toTelegramHtml(a),
    '🔥 <b>Sac en raphia tressé</b> — fait main à Douala.\n\n' +
      'Prix : <b>12.500 FCFA</b> (au lieu de <s>18.000 FCFA</s>)',
    'A: telegram html',
  );

  // B. Links — the channel divergence. WhatsApp flattens to `Label: url` and a
  // bare URL stays bare; Telegram keeps the label and escapes `&` in the href.
  const b = doc([
    {
      type: 'paragraph',
      text: [
        { type: 'text', text: 'Voir le ' },
        { type: 'link', text: 'guide des tailles', href: 'https://wimall.cm/guide?ref=a&size=eu' },
        { type: 'text', text: ' avant de commander.' },
      ],
    },
    {
      type: 'paragraph',
      text: [
        { type: 'link', text: 'https://wimall.cm/boutique', href: 'https://wimall.cm/boutique' },
      ],
    },
  ]);
  assertEqual(
    toWhatsApp(b),
    'Voir le guide des tailles: https://wimall.cm/guide?ref=a&size=eu avant de commander.\n\n' +
      'https://wimall.cm/boutique',
    'B: whatsapp',
  );
  assertEqual(
    toTelegramHtml(b),
    'Voir le <a href="https://wimall.cm/guide?ref=a&amp;size=eu">guide des tailles</a> avant de commander.\n\n' +
      '<a href="https://wimall.cm/boutique">https://wimall.cm/boutique</a>',
    'B: telegram html',
  );

  // C. Marker collision — WhatsApp has no escape character, so it drops the mark
  // and keeps the sentence. Telegram has real markup and keeps both.
  const c = doc([
    {
      type: 'paragraph',
      text: [
        { type: 'text', text: 'Toile 5*7 cm', bold: true },
        { type: 'text', text: ' · réf. ' },
        { type: 'text', text: 'AB_12', italic: true },
      ],
    },
  ]);
  assertEqual(toWhatsApp(c), 'Toile 5*7 cm · réf. AB_12', 'C: whatsapp drops colliding markers');
  assertEqual(
    toTelegramHtml(c),
    '<b>Toile 5*7 cm</b> · réf. <i>AB_12</i>',
    'C: telegram keeps them',
  );

  // D. HTML-hostile characters.
  const d = doc([
    {
      type: 'paragraph',
      text: [
        { type: 'text', text: 'Tailles < 40 & > 44 disponibles' },
        { type: 'text', text: ' — voir "conditions"' },
      ],
    },
  ]);
  assertEqual(
    toWhatsApp(d),
    'Tailles < 40 & > 44 disponibles — voir "conditions"',
    'D: whatsapp leaves angle brackets alone',
  );
  assertEqual(
    toTelegramHtml(d),
    'Tailles &lt; 40 &amp; &gt; 44 disponibles — voir "conditions"',
    'D: telegram escapes & first, then < and >',
  );

  // E. Edge whitespace inside a mark (what a double-click selection produces).
  const e = doc([
    {
      type: 'paragraph',
      text: [
        { type: 'text', text: 'Promo' },
        { type: 'text', text: ' spéciale ', bold: true },
        { type: 'text', text: 'du weekend' },
      ],
    },
  ]);
  assertEqual(toWhatsApp(e), 'Promo *spéciale* du weekend', 'E: markers hug non-whitespace');

  // F. Lists — literal prefixes, since neither platform has list markup.
  const f = doc([
    { type: 'paragraph', text: [{ type: 'text', text: 'Caractéristiques', bold: true }] },
    {
      type: 'list',
      items: [
        [{ type: 'text', text: 'Cuir véritable, doublure coton' }],
        [
          { type: 'text', text: 'Garantie ' },
          { type: 'text', text: '2 ans', bold: true },
        ],
        [{ type: 'text', text: 'Livraison 48h à Douala et Yaoundé 🚚' }],
      ],
    },
    {
      type: 'list',
      ordered: true,
      items: [
        [{ type: 'text', text: 'Hauteur : 32 cm' }],
        [{ type: 'text', text: 'Largeur : 28 cm' }],
        [{ type: 'text', text: 'Poids : 640 g' }],
      ],
    },
  ]);
  assertEqual(
    toWhatsApp(f),
    '*Caractéristiques*\n\n' +
      '• Cuir véritable, doublure coton\n• Garantie *2 ans*\n• Livraison 48h à Douala et Yaoundé 🚚\n\n' +
      '1. Hauteur : 32 cm\n2. Largeur : 28 cm\n3. Poids : 640 g',
    'F: whatsapp lists',
  );

  // Mixed nested marks — outermost-first for HTML, innermost-first for WhatsApp.
  const nested = doc([
    {
      type: 'paragraph',
      text: [
        { type: 'text', text: 'Édition limitée', bold: true, italic: true },
        { type: 'text', text: ' — ' },
        { type: 'text', text: 'stock épuisé', bold: true, strike: true },
        { type: 'text', text: ' réapprovisionné !' },
      ],
    },
  ]);
  assertEqual(
    toWhatsApp(nested),
    '*_Édition limitée_* — ~*stock épuisé*~ réapprovisionné !',
    'nested marks: whatsapp',
  );
  assertEqual(
    toTelegramHtml(nested),
    '<b><i>Édition limitée</i></b> — <s><b>stock épuisé</b></s> réapprovisionné !',
    'nested marks: telegram',
  );

  // Hard line break inside one paragraph — one block, markers applied per line.
  const breaks = doc([
    {
      type: 'paragraph',
      text: [
        { type: 'text', text: 'Retrait en boutique :', bold: true },
        { type: 'text', text: '\nMarché Mokolo, allée 3\nDouala, Cameroun' },
      ],
    },
  ]);
  assertEqual(
    toWhatsApp(breaks),
    '*Retrait en boutique :*\nMarché Mokolo, allée 3\nDouala, Cameroun',
    'hard line breaks stay inside one block',
  );

  // Multi-codepoint emoji must not be split by mark application.
  const emoji = doc([
    {
      type: 'paragraph',
      text: [
        { type: 'text', text: '👨‍👩‍👧‍👦 Pack famille 🇨🇲 ' },
        { type: 'text', text: 'meilleure vente', bold: true },
        { type: 'text', text: ' ⭐️⚡' },
      ],
    },
  ]);
  assertEqual(
    toWhatsApp(emoji),
    '👨‍👩‍👧‍👦 Pack famille 🇨🇲 *meilleure vente* ⭐️⚡',
    'multi-codepoint emoji survive',
  );

  // The worked example's plain projection — what belongs in `description`.
  const worked = doc([
    {
      type: 'paragraph',
      text: [
        { type: 'text', text: '🔥 ' },
        { type: 'text', text: 'Sac en raphia tressé', bold: true },
        { type: 'text', text: ' — fait main à Douala.' },
      ],
    },
    {
      type: 'list',
      items: [
        [{ type: 'text', text: 'Cuir véritable' }],
        [
          { type: 'text', text: 'Garantie ' },
          { type: 'text', text: '2 ans', bold: true },
        ],
      ],
    },
    {
      type: 'paragraph',
      text: [
        { type: 'text', text: 'Voir le ' },
        { type: 'link', text: 'guide des tailles', href: 'https://wimall.cm/guide' },
      ],
    },
  ]);
  assertEqual(
    toPlainText(worked),
    '🔥 Sac en raphia tressé — fait main à Douala.\n\n' +
      '• Cuir véritable\n• Garantie 2 ans\n\n' +
      'Voir le guide des tailles: https://wimall.cm/guide',
    'plain projection matches the documented worked example',
  );
  assert(
    !/[*_~]|<\/?[a-z]/i.test(toPlainText(worked)),
    'plain projection carries no markers and no tags',
  );
}

/* ─── 2. Truncation invariants ────────────────────────────────────────────── */

/** Telegram rejects the whole message on a malformed entity — so this is a send, not a style. */
function assertWellFormedTelegramHtml(html: string, label: string): void {
  const TAG = /<\/?(b|i|s|a)(?:\s+href="[^"]*")?>/g;
  const stack: string[] = [];
  let balanced = true;
  for (const match of html.matchAll(TAG)) {
    if (match[0].startsWith('</')) {
      if (stack.pop() !== match[1]) balanced = false;
    } else {
      stack.push(match[1]);
    }
  }
  assert(balanced && stack.length === 0, `${label}: telegram HTML tags are balanced`);

  const stripped = html.replace(TAG, '');
  assert(!/[<>]/.test(stripped), `${label}: no unescaped < or > outside a tag`);
  assert(!/&(?!amp;|lt;|gt;)/.test(stripped), `${label}: no bare & (must be &amp;)`);
}

function assertBalancedWhatsAppMarkers(body: string, label: string): void {
  for (const marker of ['*', '_', '~']) {
    const count = body.split(marker).length - 1;
    assert(count % 2 === 0, `${label}: even number of "${marker}" markers`);
  }
  assert(!/(^|\s)[*_~]\s/.test(body), `${label}: no opening marker followed by whitespace`);
  assert(!/\s[*_~](\s|$)/.test(body), `${label}: no closing marker preceded by whitespace`);
}

function testTruncation(): void {
  console.log('\n· Truncation — the document is trimmed, never the formatted string');

  // The dashboard's own over-long fixture: 60 list items, well past 4096.
  const long = doc([
    { type: 'paragraph', text: [{ type: 'text', text: 'Collection complète', bold: true }] },
    {
      type: 'list',
      items: Array.from({ length: 60 }, (_, i) => [
        {
          type: 'text' as const,
          text:
            `Modèle ${i + 1} — tissu pagne authentique, coupe ajustée, disponible ` +
            'du 36 au 46, livraison sous 48 heures dans tout le Cameroun, retours ' +
            'acceptés sous 14 jours sans justification.',
        },
      ]),
    },
  ]);

  assert(docCharCount(long) > CHAT_LIMITS.MAX * 2, 'fixture is comfortably over the cap');

  const wa = toWhatsApp(long);
  const tg = toTelegramHtml(long);
  const tgPlain = toTelegramPlain(long);

  assert(wa.length <= CHAT_LIMITS.MAX, `whatsapp body fits the cap (${wa.length})`);
  assert(tg.length <= CHAT_LIMITS.MAX, `telegram html fits the cap (${tg.length})`);
  assert(tgPlain.length <= CHAT_LIMITS.MAX, `telegram plain fits the cap (${tgPlain.length})`);

  assertBalancedWhatsAppMarkers(wa, 'truncated whatsapp');
  assertWellFormedTelegramHtml(tg, 'truncated telegram');

  assert(wa.includes('…'), 'truncation leaves an ellipsis at the cut');
  assert(!/<\/?[a-z]/i.test(tgPlain), 'the deep-link projection carries no HTML tags');

  // A caption budget is far tighter than a body one, and must hold the same shape.
  const caption = toWhatsApp(long, { maxLength: CHAT_LIMITS.CAPTION });
  assert(caption.length <= CHAT_LIMITS.CAPTION, `caption budget honoured (${caption.length})`);
  assertBalancedWhatsAppMarkers(caption, 'caption');

  // A link is atomic: half a URL is not a shorter link, it is a broken one.
  const linkAtCut = doc([
    {
      type: 'paragraph',
      text: [
        { type: 'text', text: 'x'.repeat(40) },
        { type: 'link', text: 'boutique', href: 'https://wimall.cm/une-tres-longue-adresse' },
      ],
    },
  ]);
  const clipped = truncateDoc(linkAtCut, 50).doc;
  const flattened = toPlainText(clipped);
  assert(
    !flattened.includes('https://wimall.cm/une') || flattened.includes('longue-adresse'),
    'a link is dropped whole rather than cut mid-URL',
  );

  // The formatted output is measured AFTER formatting: marks cost characters the
  // document budget never counted, so a doc that exactly fills the budget must
  // still come out under it once markers are added.
  const dense = doc([
    {
      type: 'paragraph',
      text: Array.from({ length: 300 }, (_, i) => ({
        type: 'text' as const,
        text: `mot${i} `,
        bold: true,
      })),
    },
  ]);
  const denseOut = toWhatsApp(dense, { maxLength: 200 });
  assert(denseOut.length <= 200, `marker overhead is fed back into the budget (${denseOut.length})`);
  assertBalancedWhatsAppMarkers(denseOut, 'dense');
}

/* ─── 3. The schema — the href allowlist is a security boundary ───────────── */

function testSchema(): void {
  console.log('\n· Schema');

  assert(richDocSchema.safeParse({ version: 1, blocks: [] }).success, 'an empty document is valid');
  assert(
    !richDocSchema.safeParse({ version: 2, blocks: [] }).success,
    'an unknown version is rejected (a reader must fall back, not guess)',
  );
  assert(!richDocSchema.safeParse({ blocks: [] }).success, 'version is required');
  assert(
    !richDocSchema.safeParse({ version: 1, blocks: [{ type: 'heading', text: [] }] }).success,
    'an unknown block type is rejected',
  );

  const link = (href: string) => ({
    version: 1,
    blocks: [{ type: 'paragraph', text: [{ type: 'link', text: 'x', href }] }],
  });

  for (const good of [
    'https://wimall.cm/guide',
    'http://wimall.cm',
    'mailto:vendeur@wimall.cm',
    'tel:+237600000000',
  ]) {
    assert(richDocSchema.safeParse(link(good)).success, `href allowed: ${good}`);
    assert(isAllowedHref(good), `isAllowedHref: ${good}`);
  }

  // The whole reason the allowlist lives at parse time: a renderer that misses
  // one of these is one call site away from shipping it.
  for (const bad of [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD4=',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    '/relative/path',
    'wimall.cm/no-scheme',
    '',
  ]) {
    assert(!richDocSchema.safeParse(link(bad)).success, `href rejected: ${JSON.stringify(bad)}`);
    assert(!isAllowedHref(bad), `isAllowedHref rejects: ${JSON.stringify(bad)}`);
  }

  // The payload cap. `description` is an unbounded string, which is survivable;
  // an unbounded nested document is not.
  const block = { type: 'paragraph' as const, text: [{ type: 'text' as const, text: 'x' }] };
  assert(
    richDocSchema.safeParse({ version: 1, blocks: Array(200).fill(block) }).success,
    '200 blocks is accepted',
  );
  assert(
    !richDocSchema.safeParse({ version: 1, blocks: Array(201).fill(block) }).success,
    '201 blocks is rejected',
  );

  // parseRichDoc is the READ-side helper — null rather than a throw, because
  // every reader's fallback is the same one: `description`.
  assert(parseRichDoc(null) === null, 'parseRichDoc(null) is null');
  assert(parseRichDoc({ version: 9 }) === null, 'parseRichDoc of a bad document is null');
  assert(parseRichDoc({ version: 1, blocks: [] })?.version === 1, 'parseRichDoc of a good one parses');
}

/* ─── 4. All four write endpoints, and the null-clears semantics ──────────── */

function testEndpointSchemas(): void {
  console.log('\n· The four write schemas');

  const rich = {
    version: 1,
    blocks: [{ type: 'paragraph', text: [{ type: 'text', text: 'Bonjour', bold: true }] }],
  };

  const base = {
    create: { type: 'physical', title: 'Sac tressé', description: 'Bonjour', category: 'bags' },
    update: { description: 'Bonjour' },
    simpleCreate: {
      title: 'Sac tressé',
      description: 'Bonjour',
      category: 'bags',
      price: 12500,
    },
    simpleUpdate: { description: 'Bonjour' },
  };

  const cases: Array<[string, { safeParse: (v: unknown) => { success: boolean } }, Record<string, unknown>]> = [
    ['POST /vendor/products', CreateProductSchema, base.create],
    ['PATCH /vendor/products/:id', UpdateProductSchema, base.update],
    ['POST /vendor/products/simple', CreateSimpleProductSchema, base.simpleCreate],
    ['PATCH /vendor/products/:id/simple', UpdateSimpleProductSchema, base.simpleUpdate],
  ];

  for (const [name, schema, body] of cases) {
    assert(schema.safeParse({ ...body }).success, `${name}: accepts a body without the field`);
    assert(
      schema.safeParse({ ...body, descriptionRich: rich }).success,
      `${name}: accepts a document`,
    );
    assert(
      schema.safeParse({ ...body, descriptionRich: null }).success,
      `${name}: accepts an explicit null (the clear signal)`,
    );
    assert(
      !schema.safeParse({ ...body, descriptionRich: { version: 1, blocks: [{ type: 'x' }] } })
        .success,
      `${name}: rejects a malformed document`,
    );
    assert(
      !schema.safeParse({
        ...body,
        descriptionRich: {
          version: 1,
          blocks: [
            { type: 'paragraph', text: [{ type: 'link', text: 'x', href: 'javascript:alert(1)' }] },
          ],
        },
      }).success,
      `${name}: rejects a javascript: href`,
    );
  }

  // The reason all four had to land together: an unknown key on the two quick-add
  // schemas is a 400 on the ENTIRE save, not a stripped field.
  assert(
    !CreateSimpleProductSchema.safeParse({ ...base.simpleCreate, notAField: 1 }).success,
    'the simple create schema is still .strict()',
  );
  assert(
    !UpdateSimpleProductSchema.safeParse({ ...base.simpleUpdate, notAField: 1 }).success,
    'the simple update schema is still .strict()',
  );

  // The value survives parsing rather than being coerced or dropped.
  const parsed = UpdateProductSchema.parse({ descriptionRich: rich });
  assert(
    JSON.stringify(parsed.descriptionRich) === JSON.stringify(rich),
    'the parsed document round-trips unchanged',
  );
}

/**
 * The write path, against a fake repository.
 *
 * `null` has to reach the repository's `$set` as `null`. A truthiness guard here
 * would turn "the vendor deleted their formatting" into "leave it alone", and the
 * next read would resurrect a document they removed on purpose — the one case
 * this field exists to get right, and one no schema test can catch.
 */
async function testNullClears(): Promise<void> {
  console.log('\n· null clears, absent leaves alone');

  const stored: Product = new ProductMapper().toDomain({
    toObject: () => ({
      _id: '507f1f77bcf86cd799439011',
      vendorId: '507f1f77bcf86cd799439012',
      type: 'physical',
      status: 'draft',
      mode: 'advanced',
      title: 'Sac tressé',
      description: 'Bonjour',
      descriptionRich: { version: 1, blocks: [] },
      slug: 'sac-tresse',
      category: 'bags',
      tags: [],
      seo: {},
      hasVariants: false,
      fileIds: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
  } as never);

  let captured: Partial<Product> | null = null;
  const repo = {
    findById: async () => stored,
    update: async (_id: string, _vendorId: string, updates: Partial<Product>) => {
      captured = updates;
      return { ...stored, ...updates };
    },
  } as unknown as IProductRepository;

  const service = new ProductUpdateService(repo, {} as never, {} as never);
  const vendorId = stored.vendorId;

  await service.execute(stored.id, vendorId, { descriptionRich: null });
  assert(
    captured !== null && 'descriptionRich' in (captured as object),
    'an explicit null is written to the update',
  );
  assert(
    (captured as unknown as Partial<Product>).descriptionRich === null,
    'and it is written as null, not dropped',
  );

  captured = null;
  await service.execute(stored.id, vendorId, { title: 'Sac tressé XL' });
  assert(
    captured !== null && !('descriptionRich' in (captured as object)),
    'an absent field is not written at all',
  );

  captured = null;
  const next = { version: 1 as const, blocks: [] };
  await service.execute(stored.id, vendorId, { descriptionRich: next });
  assert(
    (captured as unknown as Partial<Product>).descriptionRich === next,
    'a supplied document replaces the stored one',
  );
}

/* ─── 5. Limits agree with the module they were copied from ───────────────── */

function testLimits(): void {
  console.log('\n· Limits');

  // core/ cannot import a module, so these numbers are restated in
  // core/richtext/limits.ts. That duplication is only safe while it is checked.
  assert(CHAT_LIMITS.MAX === WA_LIMITS.TEXT_BODY, 'CHAT_LIMITS.MAX === WA_LIMITS.TEXT_BODY');
  assert(
    CHAT_LIMITS.CAPTION === WA_LIMITS.MEDIA_CAPTION,
    'CHAT_LIMITS.CAPTION === WA_LIMITS.MEDIA_CAPTION',
  );
}

/* ─── 6. Telegram transport ───────────────────────────────────────────────── */

function testTelegramTransport(): void {
  console.log('\n· Telegram transport');

  assertEqual(escapeTelegramHtml('a & b < c > d'), 'a &amp; b &lt; c &gt; d', 'escape order');
  assertEqual(escapeTelegramHtml('<b>'), '&lt;b&gt;', 'a literal tag is neutralised');
  assert(
    !escapeTelegramHtml('&lt;').includes('&amp;lt;') === false,
    'an already-escaped entity is escaped again (the input is text, not HTML)',
  );

  // The notification body is the shared composer all four stacks use.
  assertEqual(
    toTelegramNotificationBody('Commande #12 & retrait', 'Chez L_Artisan <Douala>'),
    '<b>Commande #12 &amp; retrait</b>\n\nChez L_Artisan &lt;Douala&gt;',
    'notification body escapes both halves',
  );
  assertWellFormedTelegramHtml(
    toTelegramNotificationBody('Chez L_Artisan *promo*', 'Prix : 12.500 FCFA (x2) !'),
    'notification body with markdown-hostile prose',
  );

  const bot = read('modules/telegram/services/telegram-bot.service.ts');
  assert(
    !/parse_mode:\s*'Markdown'/.test(bot),
    "telegram-bot.service.ts no longer hardcodes parse_mode: 'Markdown'",
  );
  assert(
    /parseMode\s*=\s*options\.parseMode\s*\?\?\s*'none'/.test(bot),
    "the default parse mode is 'none' — an unformatted message always arrives",
  );

  // Every remaining Markdown emphasis in the module would be a silent-drop path.
  //
  // `telegram-link.service.ts` was on this list and is GONE — account linking moved to
  // `modules/channel-connections`, which sends no Telegram message at all: the bot replies
  // with the code itself (Phase 4), so there is no interpolated body on this side to escape.
  for (const rel of [
    'modules/notifications/services/vendor-notification-event-handler.service.ts',
    'modules/notifications/services/agency-notification-event-handler.service.ts',
    'modules/notifications/services/agent-notification-event-handler.service.ts',
    'modules/notifications/services/customer-notification-event-handler.service.ts',
  ]) {
    const src = read(rel);
    assert(
      !/\*\$\{[^}]+\}\*/.test(src),
      `scan: ${path.basename(rel)} does not wrap an interpolated value in Markdown emphasis`,
    );
  }

  for (const rel of [
    'modules/notifications/services/vendor-notification-event-handler.service.ts',
    'modules/notifications/services/agency-notification-event-handler.service.ts',
    'modules/notifications/services/agent-notification-event-handler.service.ts',
    'modules/notifications/services/customer-notification-event-handler.service.ts',
  ]) {
    const src = read(rel);
    assert(
      src.includes('toTelegramNotificationBody(content.subject, content.body)'),
      `scan: ${path.basename(rel)} composes its Telegram body through the shared escaper`,
    );
    assert(
      /parseMode:\s*'HTML'/.test(src),
      `scan: ${path.basename(rel)} opts into parse_mode HTML explicitly`,
    );
  }
}

/* ─── 7. Wiring, by source scan ───────────────────────────────────────────── */

function testWiring(): void {
  console.log('\n· Wiring');

  const model = read('modules/catalog/models/product.model.ts');
  assert(
    /descriptionRich:\s*\{\s*type:\s*Schema\.Types\.Mixed,\s*default:\s*null\s*\}/.test(model),
    'the schema path is Mixed, defaulting to null',
  );

  // The text index is the one place adding the field would be actively wrong:
  // `$text` on a nested document tokenises its structural keys and every href.
  // Scanned with comments stripped — the model explains this at length right
  // above the index, and the explanation must not read as the violation.
  const modelCode = stripComments(model);
  const indexCalls = modelCode.split('ProductSchema.index(').slice(1);
  assert(indexCalls.length > 0, 'the model still declares indexes');
  assert(
    indexCalls.every((call) => !call.slice(0, call.indexOf(');')).includes('descriptionRich')),
    'descriptionRich is in NO index — least of all product_storefront_text',
  );
  assert(
    /\{\s*title:\s*'text',\s*tags:\s*'text',\s*description:\s*'text'\s*\}/.test(modelCode),
    'the text index still covers exactly title + tags + description',
  );
  assert(
    (modelCode.match(/descriptionRich/g) ?? []).length === 2,
    'descriptionRich appears exactly twice in the model code: the interface and the schema path',
  );

  // The vectoriser embeds `description` and must keep doing exactly that.
  assert(
    !read('modules/catalog/domain/services/VectorisationService.ts').includes('descriptionRich'),
    'the vectoriser payload never mentions descriptionRich',
  );

  // The public DTOs are the storefront's security boundary and are explicit
  // projections — the field is vendor-facing only.
  assert(
    !read('modules/catalog/dto/public-product.dto.ts').includes('descriptionRich'),
    'the public catalog DTOs do not expose descriptionRich',
  );

  // The trimmed vendor LIST response deliberately omits it too.
  assert(
    !read('modules/catalog/read-models/product-detail.read-model.ts').includes('descriptionRich'),
    'the trimmed list projection omits descriptionRich',
  );

  // One fragment, four schemas — the split that would break quick-add.
  for (const rel of [
    'modules/catalog/validators/product.validator.ts',
    'modules/catalog/validators/simple-product.validator.ts',
  ]) {
    const src = read(rel);
    const uses = src.split('descriptionRich: descriptionRichSchema').length - 1;
    assert(uses === 2, `scan: ${path.basename(rel)} wires the shared fragment onto both schemas`);
  }

  // Every persistence path writes it, including the two that are easy to forget.
  const writers: Array<[string, string]> = [
    ['modules/catalog/domain/services/ProductDraftService.ts', 'input.descriptionRich ?? null'],
    [
      'modules/catalog/domain/services/simple/SimpleProductCreateService.ts',
      'input.descriptionRich ?? null',
    ],
    [
      'modules/catalog/domain/services/ProductUpdateService.ts',
      'command.descriptionRich !== undefined',
    ],
    [
      'modules/catalog/domain/services/simple/SimpleProductUpdateService.ts',
      'descriptionRich: input.descriptionRich',
    ],
    [
      'modules/catalog/domain/services/ProductDuplicateService.ts',
      'originalProduct.descriptionRich ?? null',
    ],
  ];
  for (const [rel, needle] of writers) {
    assert(read(rel).includes(needle), `scan: ${path.basename(rel)} persists the field`);
  }

  // Both layered controller hand-offs — the field reaches the service, not just
  // the schema. A validated field nobody forwards is silently discarded.
  const controller = read('modules/catalog/controllers/vendor-product.controller.ts');
  assert(
    (controller.split('descriptionRich: input.descriptionRich').length - 1) === 2,
    'the layered controller forwards the field on BOTH create and update',
  );

  // The read path: being on the domain type is what puts it on GET /:id and on
  // every write response, since EnrichedProduct is Omit<Product, 'fileIds'>.
  const mapper = read('modules/catalog/repositories/mappers/product.mapper.ts');
  assert(mapper.includes('descriptionRich: RichDoc | null'), 'the domain type carries the field');
  assert(
    /descriptionRich:\s*\(doc\.descriptionRich/.test(mapper),
    'the mapper reads it back onto the domain object',
  );
  assert(
    read('modules/catalog/read-models/enrich-product-detail.ts').includes(
      "Omit<Product, 'fileIds'>",
    ),
    'EnrichedProduct still spreads the domain product, so the field is returned',
  );

  // `description` must stay the projection nobody derives server-side.
  for (const rel of [
    'modules/catalog/domain/services/ProductUpdateService.ts',
    'modules/catalog/domain/services/ProductDraftService.ts',
    'modules/catalog/domain/services/simple/SimpleProductCreateService.ts',
  ]) {
    assert(
      !read(rel).includes('toPlainText'),
      `scan: ${path.basename(rel)} does not derive description from the document`,
    );
  }
}

/* ─── Runner ──────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  testVectors();
  testTruncation();
  testSchema();
  testEndpointSchemas();
  await testNullClears();
  testLimits();
  testTelegramTransport();
  testWiring();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void main();
