/**
 * Test: customer-paid delivery on the SURFACES (ADR-A11, W-D, 2026-10-04).
 *
 * What the customer, the vendor and the bargaining agent are shown about delivery — never how it is
 * priced (that is `test:customer-delivery-fee`). No database, no network: pure functions plus source
 * scans over the invariants nothing behavioural can see.
 *
 *   1 · The bot delivery line comes from the server quote — worded, never computed
 *   2 · Every language carries the new copy, placeholders intact
 *   3 · The chat confirmation shows the delivery line(s) before the total
 *   4 · The Mini App page draws server strings and does no money arithmetic
 *   5 · Shop terms on cards — free / free from X / nothing
 *   6 · Order DTOs — customer-facing fee per parcel, vendor-borne per shipment
 *   7 · The MCP catalogue lists the new quote fields and drops the old "delivery included" notes
 *   8 · The bargaining promise is derived from the shop's terms — no hardcoded `free: true`
 *
 * Run: npm run test:delivery-surfaces
 */
import * as fs from 'fs';
import * as path from 'path';

import { BOT_COPY_LANGUAGES } from '../../src/modules/bot-surface/domain/bot-error-copy';
import {
    __CHROME_TABLE,
    __CHROME_TEMPLATES,
    botChromeCopyGaps,
} from '../../src/modules/bot-surface/domain/bot-chrome-copy';
import {
    deliveryIncludedLine,
    deliveryLinesOf,
    deliveryTermsLine,
    QuoteDeliveryFacts,
} from '../../src/modules/bot-surface/domain/delivery-lines';
import { checkoutReviewReply, ChatReviewForReply } from '../../src/modules/bot-surface/domain/checkout-chat-reply';
import { toCustomerDeliveryFees } from '../../src/modules/orders/dto/customer-order.dto';
import { toVendorShipmentDeliveryFee } from '../../src/modules/vendor/dto/vendor-order.dto';
import { buildDeliveryPromise } from '../../src/modules/negotiation/domain/delivery-promise';
import { __IN_APP_HANDLE_PREFIX } from '../../src/modules/bot-surface/services/inapp-surface.store';

let passed = 0;
let failed = 0;

function assert(label: string, fn: () => boolean | void): void {
    try {
        const out = fn();
        if (out === false) throw new Error('returned false');
        passed += 1;
        console.log(`  ✅ ${label}`);
    } catch (error) {
        failed += 1;
        console.log(`  ❌ FAIL: ${label}`);
        console.log(`     ${error instanceof Error ? error.message : String(error)}`);
    }
}

function eq<T>(actual: T, expected: T, what: string): void {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

function ok(condition: unknown, what: string): void {
    if (!condition) throw new Error(what);
}

const ROOT = path.join(__dirname, '..', '..');
const read = (...parts: string[]): string => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const stripComments = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, '').replace(/<!--[\s\S]*?-->/g, '');

const section = (title: string): void => console.log(`\n▶ ${title}`);

// ─────────────────────────────────────────────────────────────────────────────
section('1 · The bot delivery line comes from the server quote — worded, never computed');

const freeShop: QuoteDeliveryFacts = {
    vendorId: 'v1', delivery: 0, deliveryPayer: 'vendor',
    freeDelivery: { mode: 'always', freeAboveAmount: null, shortfall: null },
};
const paidShop: QuoteDeliveryFacts = {
    vendorId: 'v2', delivery: 1500, deliveryPayer: 'customer',
    freeDelivery: { mode: 'above', freeAboveAmount: 10000, shortfall: 4000 },
};
const digitalShop: QuoteDeliveryFacts = { vendorId: 'v3', delivery: 0, deliveryPayer: null, freeDelivery: null };
const names = new Map<string, string | null>([['v1', 'Chez Mado'], ['v2', 'Kiosque Bella']]);

assert('one shipping shop → "Delivery: 1 500 XAF" with the one-shop hint; a digital shop draws no line', () => {
    const lines = deliveryLinesOf([paidShop, digitalShop], 'XAF', names, 'en');
    eq(lines.length, 1, 'line count');
    eq(lines[0].text, 'Delivery: 1 500 XAF', 'text');
    eq(lines[0].hint, 'Add 4 000 XAF more and delivery is free.', 'hint');
    eq(lines[0].charged, true, 'charged');
});

assert('several shops → one labelled line each; a free shop reads "Free" and carries no hint', () => {
    const lines = deliveryLinesOf([freeShop, paidShop], 'XAF', names, 'en');
    eq(lines.map((l) => l.text), ['Delivery · Chez Mado: Free', 'Delivery · Kiosque Bella: 1 500 XAF'], 'texts');
    eq(lines[0].hint, null, 'no hint when the shop pays');
    eq(lines[1].hint, 'Add 4 000 XAF more from Kiosque Bella and delivery is free.', 'shop hint');
});

assert('French typography and wording; an unnamed shop reads "Cette boutique"', () => {
    const lines = deliveryLinesOf([freeShop, { ...paidShop, vendorId: 'vX' }], 'XAF', names, 'fr');
    eq(lines[0].text, 'Livraison · Chez Mado : Offerte', 'fr free');
    eq(lines[1].text, 'Livraison · Cette boutique : 1 500 XAF', 'fr unnamed');
});

assert('the hint follows the QUOTE\'s shortfall only — null shortfall ⇒ no hint, even below a threshold', () => {
    const lines = deliveryLinesOf([{ ...paidShop, freeDelivery: { mode: 'never', freeAboveAmount: null, shortfall: null } }], 'XAF', names, 'en');
    eq(lines[0].hint, null, 'hint');
});

assert('⛔ delivery-lines.ts adds nothing up — no reduce, no sum, no `+ line.delivery`', () => {
    const src = stripComments(read('src', 'modules', 'bot-surface', 'domain', 'delivery-lines.ts'));
    ok(!/\.reduce\(/.test(src), 'a reduce in delivery-lines.ts');
    ok(!/\+\s*line\.delivery|delivery\s*\+/.test(src), 'delivery added to something');
    ok(!/\bfreeAboveAmount\s*-/.test(src), 're-derives the shortfall from the threshold');
});

assert('both checkout reads build their lines from THE quote (`deliveryLinesFor(quote, …)`)', () => {
    const src = stripComments(read('src', 'modules', 'bot-surface', 'miniapp', 'surfaces', 'checkout.controller.ts'));
    const calls = src.match(/deliveryLinesFor\(quote,/g) ?? [];
    ok(calls.length >= 2, `expected the screen AND the chat review to call deliveryLinesFor(quote, …), found ${calls.length}`);
    ok(src.includes('deliveryLinesOf(quote.perVendor, quote.currency'), 'the helper reads perVendor + currency off the quote');
    ok(/quoteForCustomer\(\s*customerId,\s*destination\.kind === 'address'/.test(src), 'the chat review is quoted AT the address it names');
});

// ─────────────────────────────────────────────────────────────────────────────
section('2 · Every language carries the new copy, placeholders intact');

const NEW_KEYS = [
    'checkoutDeliveryLabel', 'checkoutDeliveryShopLabel', 'checkoutDeliveryFree', 'checkoutDeliveryLine',
    'checkoutFreeDeliveryHint', 'checkoutFreeDeliveryHintOneShop', 'cardFreeDelivery', 'cardFreeDeliveryFrom',
    'orderDeliveryIncluded',
] as const;

assert(`all ${NEW_KEYS.length} new chrome keys exist in all ${BOT_COPY_LANGUAGES.length} languages`, () => {
    const table = __CHROME_TABLE as unknown as Record<string, { copy: Record<string, string> }>;
    for (const key of NEW_KEYS) {
        ok(table[key], `missing key ${key}`);
        for (const lang of BOT_COPY_LANGUAGES) {
            ok(typeof table[key].copy[lang] === 'string' && table[key].copy[lang].trim().length > 0, `${key}:${lang}`);
        }
    }
});

assert('the boot assert finds no gap (every template carries exactly its declared placeholders)', () => {
    const gaps = botChromeCopyGaps(__CHROME_TABLE as never, __CHROME_TEMPLATES as never);
    eq(gaps, [], 'gaps');
});

assert('the five templates are declared with the placeholders the builders fill', () => {
    const t = __CHROME_TEMPLATES as Record<string, readonly string[] | undefined>;
    eq([...(t.checkoutDeliveryLine ?? [])], ['label', 'value'], 'line');
    eq([...(t.checkoutFreeDeliveryHint ?? [])], ['amount', 'shop'], 'hint');
    eq([...(t.cardFreeDeliveryFrom ?? [])], ['amount'], 'card');
    eq([...(t.orderDeliveryIncluded ?? [])], ['amount'], 'order');
});

// ─────────────────────────────────────────────────────────────────────────────
section('3 · The chat confirmation shows the delivery line(s) before the total');

const address = { id: 'a'.repeat(24), label: 'Home', formattedAddress: 'Akwa, Douala', isDefault: true, deliverable: true };
const other = { ...address, id: 'b'.repeat(24), label: 'Office', isDefault: false };
const baseReview = (over: Partial<ChatReviewForReply> = {}): ChatReviewForReply => ({
    ready: true,
    blocker: null,
    checkoutRef: `${__IN_APP_HANDLE_PREFIX}testref123`,
    lines: [{ title: 'Shoes', variantLabel: null, quantity: 1, lineTotalText: '6 000 XAF' }],
    totalText: '7 500 XAF',
    delivery: { kind: 'address', address: address as never },
    addresses: [address as never],
    payment: { method: 'mobile_money', phoneMasked: '+2376••••0001', cashOnDelivery: false },
    addAddressUrl: null,
    deliveryShortfalls: [],
    deliveryLines: [{ text: 'Delivery: 1 500 XAF', hint: 'Add 4 000 XAF more and delivery is free.' }],
    deliveryCharged: true,
    ...over,
});

assert('the delivery line and its hint sit immediately above "Total:"', () => {
    const reply = checkoutReviewReply(baseReview(), { addressChosen: true }, 'en');
    ok(reply && 'text' in reply, 'a reply');
    const text = (reply as { text: string }).text;
    const d = text.indexOf('Delivery: 1 500 XAF');
    const h = text.indexOf('Add 4 000 XAF more and delivery is free.');
    const t = text.indexOf('Total: 7 500 XAF');
    ok(d >= 0 && h > d && t > h, `order delivery(${d}) < hint(${h}) < total(${t})`);
});

assert('no delivery lines (a download / an older fixture) → the confirmation is unchanged', () => {
    const reply = checkoutReviewReply(baseReview({ deliveryLines: undefined }), { addressChosen: true }, 'en');
    ok(!(reply as { text: string }).text.includes('Delivery'), 'a Delivery line appeared');
});

assert('several addresses + a customer-paid fee → each row CHOOSES (`yes:coa:`) rather than placing', () => {
    const reply = checkoutReviewReply(baseReview({ addresses: [address, other] as never }), { addressChosen: false }, 'en') as unknown as {
        options: Array<{ id: string }>;
    };
    const rows = reply.options.filter((o) => o.id.includes('a'.repeat(24)) || o.id.includes('b'.repeat(24)));
    ok(rows.length === 2 && rows.every((o) => o.id.startsWith('yes:coa:')), JSON.stringify(rows.map((o) => o.id)));
});

assert('…and with free delivery for every shop, rows still place directly (unchanged behaviour)', () => {
    const reply = checkoutReviewReply(
        baseReview({ addresses: [address, other] as never, deliveryCharged: false, deliveryLines: [{ text: 'Delivery: Free', hint: null }] }),
        { addressChosen: false },
        'en',
    ) as unknown as { options: Array<{ id: string }> };
    ok(reply.options.some((o) => !o.id.startsWith('yes:coa:') && o.id.includes('a'.repeat(24))), 'a placing row');
});

// ─────────────────────────────────────────────────────────────────────────────
section('4 · The Mini App page draws server strings and does no money arithmetic');

const CO = stripComments(read('src', 'modules', 'bot-surface', 'miniapp', 'public', 'co.html'));

assert('co.html draws `data.delivery` rows through textContent', () => {
    ok(CO.includes('data.delivery'), 'reads data.delivery');
    ok(/textContent\s*=\s*String\(d\.valueText/.test(CO), 'valueText through textContent');
    ok(/textContent\s*=\s*String\(d\.label/.test(CO), 'label through textContent');
});

assert('⛔ co.html never parses, formats or sums money', () => {
    for (const banned of ['toFixed', 'parseFloat', 'parseInt', 'Intl.NumberFormat', 'Number(d.', '.reduce(']) {
        ok(!CO.includes(banned), `co.html contains ${banned}`);
    }
    ok(!/valueText\s*\+|\+\s*d\.valueText/.test(CO), 'valueText concatenated/added');
});

assert('the /data endpoint sends `delivery` and the read sets it from the quote', () => {
    const src = stripComments(read('src', 'modules', 'bot-surface', 'miniapp', 'surfaces', 'checkout.controller.ts'));
    ok(src.includes('delivery: view.delivery ?? []'), 'the endpoint projects delivery');
    ok(/delivery:\s*\(await deliveryLinesFor\(quote, session\.language\)\)/.test(src), 'readCheckoutView sets it');
});

assert('ol.html prints the server\'s `deliveryText`; the order card builds it with deliveryIncludedLine', () => {
    ok(stripComments(read('src', 'modules', 'bot-surface', 'miniapp', 'public', 'ol.html')).includes('group.deliveryText'), 'ol.html');
    ok(read('src', 'modules', 'bot-surface', 'miniapp', 'surfaces', 'order-listing.controller.ts').includes('deliveryIncludedLine('), 'controller');
    eq(deliveryIncludedLine(1500, 'XAF', 'en'), 'Incl. 1 500 XAF delivery', 'en');
    eq(deliveryIncludedLine(0, 'XAF', 'en'), null, 'none paid');
});

// ─────────────────────────────────────────────────────────────────────────────
section('5 · Shop terms on cards — free / free from X / nothing');

assert('always → "Free delivery"; above → "Free delivery from X"; never → null', () => {
    eq(deliveryTermsLine({ mode: 'always', freeAboveAmount: null }, 'XAF', 'en'), 'Free delivery', 'always');
    eq(deliveryTermsLine({ mode: 'above', freeAboveAmount: 20000 }, 'XAF', 'en'), 'Free delivery from 20 000 XAF', 'above');
    eq(deliveryTermsLine({ mode: 'never', freeAboveAmount: null }, 'XAF', 'en'), null, 'never');
    eq(deliveryTermsLine({ mode: 'above', freeAboveAmount: 20000 }, 'XAF', 'fr'), 'Livraison offerte dès 20 000 XAF', 'fr');
});

assert('both card renderers and the product screen carry the line', () => {
    const reply = read('src', 'modules', 'bot-surface', 'domain', 'channel-reply.ts');
    ok((reply.match(/card\.deliveryText/g) ?? []).length >= 2, 'Telegram caption + WhatsApp body');
    ok(read('src', 'modules', 'bot-surface', 'miniapp', 'surfaces', 'product-detail.controller.ts').includes('deliveryText: detail.deliveryText'), 'pd data');
    ok(stripComments(read('src', 'modules', 'bot-surface', 'miniapp', 'public', 'pd.html')).includes('data.deliveryText'), 'pd.html');
});

// ─────────────────────────────────────────────────────────────────────────────
section('6 · Order DTOs — customer-facing fee per parcel, vendor-borne per shipment');

assert('customer: amount is customer_delivery_fee (never the agency snapshot); refundable only when > 0', () => {
    const fees = toCustomerDeliveryFees({ delivery_payer: 'customer' }, [
        { _id: 's1', delivery_payer: 'customer', customer_delivery_fee: 1500, customer_fee_refundable: 0 },
        { _id: 's2', delivery_payer: 'customer', customer_delivery_fee: 900, customer_fee_refundable: 400 },
    ]);
    eq(fees, [
        { shipmentId: 's1', amount: 1500 },
        { shipmentId: 's2', amount: 900, customerFeeRefundable: 400 },
    ], 'fees');
    eq(toCustomerDeliveryFees({ delivery_payer: 'vendor' }, [{ _id: 's3', delivery_payer: 'vendor', customer_delivery_fee: 0 }]),
        [{ shipmentId: 's3', amount: 0 }], 'vendor-paid parcel');
});

assert('vendor: fee = override ?? snapshot; vendorBorne = max(0, fee − customerPaid)', () => {
    eq(toVendorShipmentDeliveryFee({ delivery_payer: 'vendor' }, { delivery_payer: 'vendor', delivery_fee_snapshot: 1800 }),
        { payer: 'vendor', fee: 1800, customerPaid: 0, vendorBorne: 1800 }, 'vendor-paid');
    eq(toVendorShipmentDeliveryFee({ delivery_payer: 'customer' }, { delivery_payer: 'customer', delivery_fee_snapshot: 1500, customer_delivery_fee: 1500 }),
        { payer: 'customer', fee: 1500, customerPaid: 1500, vendorBorne: 0 }, 'customer-paid');
    eq(toVendorShipmentDeliveryFee({ delivery_payer: 'customer' }, {
        delivery_payer: 'customer', delivery_fee_snapshot: 1500, customer_delivery_fee: 1500, delivery_fee_override: { amount: 2000 },
    }), { payer: 'customer', fee: 2000, customerPaid: 1500, vendorBorne: 500 }, 'override above what the customer paid');
    eq(toVendorShipmentDeliveryFee(null, {}), { payer: 'vendor', fee: null, customerPaid: 0, vendorBorne: null }, 'legacy');
});

assert('⛔ the vendor list no longer hardcodes `shipping: 0`', () => {
    ok(!/shipping:\s*0\b/.test(stripComments(read('src', 'modules', 'orders', 'vendor-order.service.ts'))), 'shipping: 0');
});

// ─────────────────────────────────────────────────────────────────────────────
section('7 · The MCP catalogue lists the new quote fields and drops the old notes');

const catalog = JSON.parse(read('api-doc', 'n8n', 'tools', 'catalog.json')) as { tools: Array<Record<string, any>> };
const tool = (name: string): Record<string, any> => {
    const t = catalog.tools.find((x) => x.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    return t;
};

assert('cart_quote: delivery, regionKnown and every per-shop delivery field are important_fields', () => {
    const f: string[] = tool('cart_quote').response.important_fields;
    for (const field of ['delivery', 'total', 'regionKnown', 'perVendor[].delivery', 'perVendor[].deliveryPayer',
        'perVendor[].deliveryPayerReason', 'perVendor[].freeDelivery.mode', 'perVendor[].freeDelivery.freeAboveAmount',
        'perVendor[].freeDelivery.shortfall', 'perVendor[].shipments[].fee']) {
        ok(f.includes(field), `missing ${field}`);
    }
    ok(!f.includes('absorbedByVendor'), 'absorbedByVendor is still an important field');
    ok((tool('cart_quote').response.never_relay ?? []).includes('absorbedByVendor'), 'absorbedByVendor not never_relay');
});

assert('no tool text says "delivery included" / "never mention the delivery fee" any more', () => {
    const text = JSON.stringify(catalog);
    ok(!/delivery included/i.test(text), '"delivery included"');
    ok(!/never mention the delivery fee/i.test(text), '"never mention the delivery fee"');
    ok(tool('checkout_review').response.important_fields.includes('deliveryLines[].text'), 'checkout_review deliveryLines');
    ok(tool('catalog_search_products').response.important_fields.includes('deliveryTerms.mode'), 'deliveryTerms');
});

assert('the generated workflow file is in step with the catalogue (checkout_review description)', () => {
    const generated = read('api-doc', 'n8n', 'generated', 'wi-mall-mcp.workflow.ts');
    ok(generated.includes('quote deliveryLines[] exactly'), 'regenerate with `npm run gen:mcp-workflow`');
    ok(!generated.includes('never mention the delivery fee'), 'stale description in the generated file');
});

// ─────────────────────────────────────────────────────────────────────────────
section('8 · The bargaining promise is derived from the shop\'s terms');

assert('⛔ no hardcoded `free: true as const` / `customerPays: 0 as const`; the rule is resolveDeliveryPayer', () => {
    const src = stripComments(read('src', 'modules', 'negotiation', 'domain', 'delivery-promise.ts'));
    ok(!/free:\s*true\s+as\s+const/.test(src), 'free: true as const');
    ok(!/customerPays:\s*0\s+as\s+const/.test(src), 'customerPays: 0 as const');
    ok(src.includes('resolveDeliveryPayer('), 'resolveDeliveryPayer');
});

assert('a `never` shop is never promised free delivery; the promise never carries a fee number', () => {
    const agency = { id: 'a', name: 'X', coverageAreas: [] };
    const p = buildDeliveryPromise({ productType: 'physical', currency: 'XAF', agency, terms: { mode: 'never', freeAboveAmount: null } });
    eq([p.free, p.customerPays], [false, null], 'never');
});

assert('the playbook no longer promises free delivery unconditionally', () => {
    const playbook = read('src', 'modules', 'negotiation', 'playbook', 'negotiation.core.md');
    ok(!playbook.includes('I deliver it to you tomorrow morning, free'), 'old free-delivery line');
    ok(playbook.includes('free: true'), 'the playbook names the tool\'s `free: true` condition');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(76)}\n  ${passed} passed, ${failed} failed\n${'─'.repeat(76)}\n`);
if (failed > 0) process.exit(1);
