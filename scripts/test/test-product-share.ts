/**
 * Test: the product-share send path (Phase 6 Step 5 · 6.J).
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no framework).
 * DB-free: `render` is pure, which is why it was split from `resolveTarget` and `dispatch`.
 *
 * ── What this guards ─────────────────────────────────────────────────────────
 * `core/richtext/`'s WhatsApp and Telegram formatters were complete and asserted
 * byte-for-byte against the vendor dashboard's fixtures, and **nothing called them**. The
 * inverse of that finding is the scan at the bottom: the formatters must stay imported, or
 * this path has rotted back to the state 07 § 2.6 recorded.
 *
 * The rendering assertions matter for a reason the formatters' own suite cannot cover:
 * this is the first caller that puts a HEADER in front of a formatted document, and the
 * budget arithmetic between the two is where a 4096-cap violation would come from.
 *
 * Run: npm run test:product-share
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  ProductShareService,
  type ShareChannel,
} from '../../src/modules/catalog/domain/services/ProductShareService';
import { CHAT_LIMITS, type RichDoc } from '../../src/core/richtext';
import type { Product } from '../../src/modules/catalog/repositories/mappers/product.mapper';

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

const SRC = join(__dirname, '..', '..', 'src');
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const service = new ProductShareService();

// ─── Fixtures ────────────────────────────────────────────────────────────────

/**
 * ⚠ The real block shape is `{ type: 'paragraph', text: InlineNode[] }` — the key is
 * `text`, not `content`, and a mark is a BOOLEAN on the span (`bold: true`), not a
 * `marks: []` array. The first version of this fixture invented both; it rendered
 * plausibly and then threw "nodes is not iterable" the moment `truncateDoc` walked it.
 * Build fixtures from `core/richtext/types.ts`, not from memory of other editors.
 */
const richDoc = (text: string, bold = false): RichDoc => ({
  version: 1,
  blocks: [{ type: 'paragraph', text: [{ type: 'text', text, ...(bold ? { bold: true } : {}) }] }],
});

const product = (over: Partial<Product> = {}): Product =>
  ({
    id: '650000000000000000000001',
    vendorId: '650000000000000000000002',
    type: 'physical',
    status: 'active',
    mode: 'simple',
    title: 'Blue Shirt',
    description: 'A plain blue shirt.',
    descriptionRich: null,
    slug: 'blue-shirt',
    category: 'clothing',
    tags: [],
    seo: {},
    hasVariants: false,
    ...over,
  }) as unknown as Product;

const STOREFRONT = 'https://shop.example.com';

function withStorefront<T>(fn: () => T): T {
  const before = process.env.STOREFRONT_URL;
  process.env.STOREFRONT_URL = STOREFRONT;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.STOREFRONT_URL;
    else process.env.STOREFRONT_URL = before;
  }
}

function withoutStorefront<T>(fn: () => T): T {
  const before = process.env.STOREFRONT_URL;
  delete process.env.STOREFRONT_URL;
  try {
    return fn();
  } finally {
    if (before !== undefined) process.env.STOREFRONT_URL = before;
  }
}

function main(): void {
  console.log('\n── The header, and the store-scoped link ───────────────────────────────\n');

  assert('the title leads the message', () =>
    withStorefront(() => service.render(product(), 'whatsapp', 'my-store').body.startsWith('*Blue Shirt*')));

  // Product.slug is unique per VENDOR, so a bare /products/:slug cannot resolve two
  // vendors owning `blue-shirt`. The canonical URL resolves the store first.
  assert('the link is store-scoped, not a bare product slug', () =>
    withStorefront(() =>
      service.render(product(), 'whatsapp', 'my-store').body.includes(`${STOREFRONT}/shop/stores/my-store/products/blue-shirt`)));

  assert('a vendor with no store still gets a shareable message', () => {
    const body = withStorefront(() => service.render(product(), 'whatsapp', null).body);
    return body.includes('Blue Shirt') && !body.includes('/stores/');
  });

  assert('no STOREFRONT_URL means no link, never a broken one', () => {
    const body = withoutStorefront(() => service.render(product(), 'whatsapp', 'my-store').body);
    return body.includes('Blue Shirt') && !body.includes('http');
  });

  assert('a trailing slash on STOREFRONT_URL does not double up', () => {
    const before = process.env.STOREFRONT_URL;
    process.env.STOREFRONT_URL = 'https://shop.example.com///';
    try {
      return !service.render(product(), 'whatsapp', 'my-store').body.includes('com///stores');
    } finally {
      if (before === undefined) delete process.env.STOREFRONT_URL;
      else process.env.STOREFRONT_URL = before;
    }
  });

  console.log('\n── The description: rich when there is one, plain when there is not ────\n');

  assert('a plain-text description is used when no rich document exists', () =>
    withStorefront(() => service.render(product(), 'whatsapp', null).body.includes('A plain blue shirt.')));

  assert('a rich document is rendered through the WhatsApp formatter', () => {
    const body = withStorefront(() =>
      service.render(product({ descriptionRich: richDoc('bold thing', true) }), 'whatsapp', null).body);
    // The formatter's own suite pins the marker; this asserts it was REACHED.
    return body.includes('*bold thing*');
  });

  assert('a rich document is rendered through the Telegram formatter', () => {
    const body = withStorefront(() =>
      service.render(product({ descriptionRich: richDoc('bold thing', true) }), 'telegram', null).body);
    return body.includes('<b>bold thing</b>');
  });

  assert('an EMPTY rich document falls back to the plain description', () => {
    const empty: RichDoc = { version: 1, blocks: [] };
    return withStorefront(() =>
      service.render(product({ descriptionRich: empty }), 'whatsapp', null).body.includes('A plain blue shirt.'));
  });

  console.log('\n── Telegram HTML: escaped, and declared ────────────────────────────────\n');

  // The bot service defaults to parse_mode 'none' precisely because most senders
  // interpolate unescaped text. This body IS HTML, so it must say so — and everything
  // in it must already be escaped or the Bot API rejects the whole send.
  assert('the Telegram message declares HTML', () =>
    withStorefront(() => service.render(product(), 'telegram', null).parseMode === 'HTML'));

  assert('the WhatsApp message declares no parse mode', () =>
    withStorefront(() => service.render(product(), 'whatsapp', null).parseMode === 'none'));

  assert('a title containing HTML is escaped for Telegram', () => {
    const body = withStorefront(() =>
      service.render(product({ title: 'Shirt <b>XL</b> & Co' }), 'telegram', null).body);
    return body.includes('&lt;b&gt;XL&lt;/b&gt;') && body.includes('&amp;') && !body.includes('<b>XL</b>');
  });

  assert('a plain description containing HTML is escaped for Telegram', () => {
    const body = withStorefront(() =>
      service.render(product({ description: 'Cotton <script>alert(1)</script>' }), 'telegram', null).body);
    return !body.includes('<script>') && body.includes('&lt;script&gt;');
  });

  console.log('\n── The 4096 cap holds once a header is in front of the document ────────\n');

  // This is what the formatters' own suite cannot cover: they fit a document to a budget,
  // and this is the first caller that spends part of that budget on a header first.
  assert('a huge rich description still fits WhatsApp’s cap', () => {
    const huge = richDoc('x'.repeat(20000));
    const body = withStorefront(() => service.render(product({ descriptionRich: huge }), 'whatsapp', 'my-store').body);
    return body.length <= CHAT_LIMITS.MAX;
  });

  assert('a huge rich description still fits Telegram’s cap', () => {
    const huge = richDoc('y'.repeat(20000));
    const body = withStorefront(() => service.render(product({ descriptionRich: huge }), 'telegram', 'my-store').body);
    return body.length <= CHAT_LIMITS.MAX;
  });

  assert('a huge PLAIN description still fits the cap', () => {
    const body = withStorefront(() =>
      service.render(product({ description: 'z'.repeat(20000) }), 'whatsapp', 'my-store').body);
    return body.length <= CHAT_LIMITS.MAX;
  });

  /**
   * This one caught a real defect rather than confirming one. `Product.title` has no
   * `maxlength`, so before the header was clamped a 5 000-character title produced a body
   * over the cap however small the description budget went — and `WaServiceMessage.text`
   * would then hard-cut the rendered string, which is exactly the severed-marker failure
   * `fitFormatted` exists to prevent.
   */
  assert('a very long TITLE does not push the message over the cap', () => {
    const body = withStorefront(() =>
      service.render(product({ title: 'T'.repeat(5000), descriptionRich: richDoc('tail') }), 'whatsapp', 'my-store').body);
    return body.length <= CHAT_LIMITS.MAX;
  });

  assert('…and the same title is clamped for Telegram, where escaping expands it', () => {
    const body = withStorefront(() =>
      service.render(product({ title: '<&>'.repeat(2000), descriptionRich: richDoc('tail') }), 'telegram', 'my-store').body);
    return body.length <= CHAT_LIMITS.MAX;
  });

  console.log('\n── SOURCE SCANS: the formatters are called, and there is no `to` ───────\n');

  const svc = stripComments(read('modules/catalog/domain/services/ProductShareService.ts'));
  const validator = stripComments(read('modules/catalog/validators/product-share.validator.ts'));
  const routes = stripComments(read('modules/catalog/routes/vendor-products.routes.ts'));
  const controller = stripComments(read('modules/catalog/controllers/vendor-product-share.controller.ts'));

  // The inverse of 07 § 2.6's finding. If this ever fails, the send path has rotted back
  // to "the formatters are ready and nothing calls them".
  assert('toWhatsApp is imported and called', () => svc.includes('toWhatsApp') && /toWhatsApp\(/.test(svc));

  assert('toTelegramHtml is imported and called', () => svc.includes('toTelegramHtml') && /toTelegramHtml\(/.test(svc));

  assert('the route is declared', () => routes.includes("router.post('/:id/share'"));

  // Neither channel can address a stranger, so accepting a recipient would be a field that
  // cannot work. Strict schema, so a client sending one is told rather than ignored.
  assert('the request body accepts no recipient', () => !/\bto\s*:/.test(validator));

  assert('the body schema is strict', () => validator.includes('.strict()'));

  assert('ownership is vendor-scoped through the repository, not a role check', () =>
    controller.includes('findById(req.params.id, vendorId)'));

  assert('a missing product is 404, never 403', () =>
    controller.includes('CATALOG_PRODUCT_NOT_FOUND') && !controller.includes('403'));

  // The window check exists to make the refusal legible; the policy layer would refuse
  // anyway, but with an error naming message types rather than the remedy.
  assert('the WhatsApp 24-hour window is checked before sending', () =>
    svc.includes('canSendFreeMessage') && svc.includes('PRODUCT_SHARE_WINDOW_CLOSED'));

  assert('there is no template fallback — a share is not a notification', () => !svc.includes("'template'"));

  assert('the connection lookup goes through the connections module’s one door', () =>
    svc.includes('connectionService.getConnection'));

  console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main();
