/**
 * test:variant-options — the three changes of 2026-10-17, from the owner's WhatsApp handset test.
 *
 *   1. The bargain question ("Make me an offer…") carries the LISTED price as a button
 *      (`take:<productId>:<variantId>:<price>`), and names the variant it is for.
 *   2. A product card whose product has several variants gains **See options** (`open:pd:<id>`).
 *   3. The product screen shows the CHOSEN variant's picture, from a gallery of all of them.
 *
 * Offline: pure modules are imported; the controllers are read as TEXT, because a surface
 * controller reaches `orders/` and `payments/` and hangs bare ts-node at import.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
    __CALLBACK_DATA_BYTES,
    addToCartActionId,
    buyNowActionId,
    listPriceActionId,
    openSurfaceActionId,
    parseBotActionId,
    parseListPriceArgument,
} from '../../src/modules/bot-surface/domain/bot-action-id';
import { listPriceActions } from '../../src/modules/bot-surface/domain/list-price-option';
import { BotProductCard, toBotProductCard } from '../../src/modules/bot-surface/domain/product-card';
import { renderBotReplies } from '../../src/modules/bot-surface/domain/channel-reply';
import { purchaseInviteTitle } from '../../src/modules/bot-surface/domain/purchase-chat-copy';

let passed = 0;
let failed = 0;

function assert(name: string, check: () => boolean): void {
    let ok = false;
    try {
        ok = check();
    } catch (err) {
        console.error(`      threw: ${(err as Error).message}`);
    }
    if (ok) {
        passed += 1;
        console.log(`  ✅ ${name}`);
    } else {
        failed += 1;
        console.log(`  ❌ FAIL: ${name}`);
    }
}

const ROOT = path.join(__dirname, '../..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const code = (rel: string): string => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, '');

const P = 'aaaaaaaaaaaaaaaaaaaaaaa1';
const V = 'bbbbbbbbbbbbbbbbbbbbbbb1';
const LANGS = ['en', 'fr', 'pt', 'es', 'ar'] as const;

console.log('\n── 1 · The listed-price token ──');

assert('take:<product>:<variant>:<price>, and it parses back to the same three values', () => {
    const id = listPriceActionId(P, V, 7000);
    const parsed = id ? parseBotActionId(id) : null;
    const args = parsed ? parseListPriceArgument(parsed.argument) : null;
    return id === `take:${P}:${V}:7000`
        && parsed?.verb === 'take'
        && args?.productId === P && args.variantId === V && args.price === 7000;
});

assert('⛔ a nine-digit price still fits Telegram\'s 64 bytes; a tenth digit draws NO button', () => {
    const nine = listPriceActionId(P, V, 999_999_999);
    return nine !== null && Buffer.byteLength(nine, 'utf8') <= __CALLBACK_DATA_BYTES
        && listPriceActionId(P, V, 1_000_000_000) === null;
});

assert('⛔ a fractional or negative price draws no button rather than a token nobody minted', () =>
    listPriceActionId(P, V, 7000.5) === null && listPriceActionId(P, V, -1) === null);

assert('⛔ the parser refuses anything this service could not have minted', () =>
    parseListPriceArgument(`${P}:${V}`) === null
    && parseListPriceArgument(`${P}:${V}:7000:1`) === null
    && parseListPriceArgument(`${P}:not-an-id:7000`) === null
    && parseListPriceArgument(`${P}:${V}:7e3`) === null
    && parseListPriceArgument(`${P}:${V}:1000000000`) === null);

console.log('\n── 2 · The button under the bargain question ──');

assert('the label carries the price — "Buy at 7 000 XAF"', () => {
    const [option] = listPriceActions({ productId: P, variantId: V, amount: 7000, currency: 'XAF' }, 'en');
    return option?.label === 'Buy at 7 000 XAF' && option.shortLabel === undefined;
});

assert('⛔ every language, every price up to nine digits, fits WhatsApp\'s 20-character title', () =>
    LANGS.every((lang) => [500, 7000, 65_000, 1_250_000, 999_999_999].every((amount) => {
        const [option] = listPriceActions({ productId: P, variantId: V, amount, currency: 'XAF' }, lang);
        const title = option ? (option.shortLabel ?? option.label) : '';
        return title.length > 0 && title.length <= 20 && title.includes(amount.toLocaleString('en').split(',')[0]!);
    })));

assert('a label too long for WhatsApp falls back to "✓ <price>", the counter-offer button\'s own shape', () => {
    const [option] = listPriceActions({ productId: P, variantId: V, amount: 7000, currency: 'XAF' }, 'pt');
    return option?.shortLabel === '✓ 7 000 XAF' && option.label.includes('7 000 XAF');
});

assert('on WhatsApp the question and the button arrive as ONE interactive message', () => {
    const actions = listPriceActions({ productId: P, variantId: V, amount: 7000, currency: 'XAF' }, 'en');
    const [reply] = renderBotReplies({ kind: 'text', text: 'Water Bottle — color: orange\n\nMake me an offer', actions }, 'whatsapp', '237600000000');
    const body = reply?.body as { interactive?: { action?: { buttons?: Array<{ reply: { id: string; title: string } }> } } };
    const buttons = body.interactive?.action?.buttons ?? [];
    return buttons.length === 1 && buttons[0]!.reply.id === `take:${P}:${V}:7000` && buttons[0]!.reply.title === 'Buy at 7 000 XAF';
});

assert('the product line names the variant only when there is a choice', () =>
    purchaseInviteTitle('Water Bottle', 'color: orange') === 'Water Bottle — color: orange'
    && purchaseInviteTitle('Water Bottle', null) === 'Water Bottle');

console.log('\n── 3 · All three doors draw it ──');

const PURCHASE = code('src/modules/bot-surface/controllers/bot-purchase.controller.ts');
const ENTRY = code('src/modules/bot-surface/services/bargain-entry.service.ts');

assert('the chat tap: the bargain rung carries the variant\'s listed price, and the reply draws it', () =>
    /listedPrice:\s*\{\s*productId,\s*variantId: variant!\.id,\s*amount: variant!\.price,/.test(PURCHASE)
    && PURCHASE.includes('listPriceActions(result.listedPrice, language)'));

assert('the product screen: the pushed question is a CARD with the button, the plain push its fallback', () =>
    /pushCardIntoConversation\([\s\S]{0,200}\{ text: result\.message, actions \}/.test(PURCHASE)
    && /if \(!pushedCard\) \{\s*await pushIntoConversation\(/.test(PURCHASE));

assert('the website link: both the direct invite and the after-setup one pass the listed price', () =>
    (ENTRY.match(/bargainInviteIntent\(verdict\.productTitle, [a-z.]+, verdict\.listedPrice\)/gi) ?? []).length === 2);

console.log('\n── 4 · The tap: listed price, re-checked, haggle closed ──');

const TAKE = code('src/modules/bot-surface/controllers/bot-list-price.controller.ts');
const DISPATCH = code('src/modules/bot-surface/controllers/bot-action.controller.ts');

assert('take: is routed', () =>
    /take: handleListPriceTap/.test(TAKE) && DISPATCH.includes("['listprice', LIST_PRICE_ACTION_HANDLERS]"));

assert('⛔ the token\'s price is a CHECK — a moved price adds nothing and offers the current one', () => {
    const check = TAKE.indexOf('if (variant.price !== ids.price) {');
    const add = TAKE.indexOf('cartService.addToCart(');
    const changed = TAKE.slice(check, add);
    return check !== -1 && add > check
        && changed.includes("botChrome('listPriceChangedPrompt', language)")
        && changed.includes('amount: variant.price')
        && changed.includes('return;');
});

assert('⛔ the basket gets the LIVE variant at quantity 1, with no lock — the shelf price is the price', () =>
    TAKE.includes('cartService.addToCart(caller.customerId, ids.productId, variant.id, 1)')
    && !TAKE.includes('negotiationLockRef'));

assert('⛔ sold out, gone or a service is refused before any write', () => {
    const refuse = TAKE.indexOf("if (!variant || !variant.inStock || product.type === 'service') {");
    return refuse !== -1 && refuse < TAKE.indexOf('cartService.addToCart(');
});

assert('⛔ it tells n8n the haggle is CLOSED — the key `bargain key change?` clears the flag on', () =>
    /negotiation:\s*\{\s*closed: true,\s*closedBy: 'button',\s*sessionId: null,/.test(TAKE));

console.log('\n── 5 · See options on a card ──');

const listItem = (over: Record<string, unknown> = {}) => ({
    id: P, slug: 'water-bottle', title: 'Water Bottle', type: 'physical', category: null, tags: [],
    price: 7000, compareAtPrice: null, currency: 'XAF', priceRange: { min: 6500, max: 7500 },
    inStock: true, negotiable: true, image: null, rating: null,
    store: { slug: 'ulrich', name: 'Ulrich Shop', isOpen: true },
    freeDelivery: false, deliveryTerms: { mode: 'never', freeAboveAmount: null },
    updatedAt: new Date().toISOString(), ...over,
}) as never;

assert('several variants → open:pd:<product>; one variant → none', () =>
    toBotProductCard(listItem(), V, 'en', 4).optionsToken === openSurfaceActionId('pd', P)
    && toBotProductCard(listItem(), V, 'en', 1).optionsToken === null
    && toBotProductCard(listItem(), V, 'en').optionsToken === null);

assert('⛔ never on a sold-out card or a service — their button budgets are spoken for', () =>
    toBotProductCard(listItem({ inStock: false }), V, 'en', 4).optionsToken === null
    && toBotProductCard(listItem({ type: 'service' }), V, 'en', 4).optionsToken === null);

const card = (over: Partial<BotProductCard> = {}): BotProductCard => ({
    productId: P, variantId: V, title: 'Water Bottle', priceText: '6 500 – 7 500 XAF', storeName: 'Ulrich Shop',
    inStock: true, imageUrl: 'https://cdn.example.com/a.jpg', detailUrl: null,
    addToken: addToCartActionId(P, V), buyToken: buyNowActionId(P, V), ...over,
});
const labels = { browse: 'Browse', buyNow: 'Buy now', addToCart: 'Add to cart', seeMore: 'See more', details: 'Details', seeOptions: 'See options' };
const list = (cards: BotProductCard[], more: boolean) => ({
    kind: 'product_list' as const, text: '', browsePrompt: 'Here are more.', cards, miniAppUrl: null,
    hasMore: more, moreToken: more ? 'more:set1' : null, labels, carousel: null, carouselUrlSuffix: null,
}) as Parameters<typeof renderBotReplies>[0];

type WaButtons = { interactive?: { action?: { buttons?: Array<{ reply: { id: string } }> } } };
const idsOf = (r: { body: unknown }): string[] => ((r.body as WaButtons).interactive?.action?.buttons ?? []).map((b) => b.reply.id);

assert('WhatsApp: Buy now · Add to cart · See options, in that order', () => {
    const [only] = renderBotReplies(list([card({ optionsToken: openSurfaceActionId('pd', P) })], false), 'whatsapp', '1');
    return JSON.stringify(idsOf(only!)) === JSON.stringify([buyNowActionId(P, V), addToCartActionId(P, V), `open:pd:${P}`]);
});

assert('⛔ a full last card does not swallow "See more" — it follows as its own message', () => {
    const replies = renderBotReplies(list([card({ optionsToken: openSurfaceActionId('pd', P) })], true), 'whatsapp', '1');
    return replies.length === 2 && idsOf(replies[0]!).length === 3 && JSON.stringify(idsOf(replies[1]!)) === '["more:set1"]';
});

assert('without options, "See more" still rides the last card exactly as before', () => {
    const replies = renderBotReplies(list([card()], true), 'whatsapp', '1');
    return replies.length === 1 && idsOf(replies[0]!).includes('more:set1');
});

assert('Telegram: See options is its own row under the buy pair', () => {
    const [only] = renderBotReplies(list([card({ optionsToken: openSurfaceActionId('pd', P) })], false), 'telegram', '1');
    const rows = ((only!.body as { reply_markup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> } }).reply_markup?.inline_keyboard) ?? [];
    return rows.length === 2 && rows[1]!.length === 1 && rows[1]![0]!.callback_data === `open:pd:${P}`;
});

assert('the count is internal: projected on the row, never copied onto the public list DTO', () => {
    const repo = code('src/modules/catalog/repositories/mongo/public-catalog.repository.mongo.ts');
    const service = code('src/modules/catalog/services/public-catalog.service.ts');
    const decorate = service.slice(service.indexOf('private async decorateRows('));
    return repo.includes("variantCount: { $size: { $ifNull: ['$sellableVariants', []] } }")
        && !decorate.includes('variantCount');
});

console.log('\n── 6 · The product screen shows the chosen variant ──');

const READ = code('src/modules/bot-surface/miniapp/surfaces/product-detail.read.ts');
const DETAIL = code('src/modules/bot-surface/miniapp/surfaces/product-detail.controller.ts');
const PAGE = read('src/modules/bot-surface/miniapp/public/pd.html')
    .replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

assert('the read carries each variant\'s own picture and a gallery holding them all', () =>
    READ.includes('imageSourceUrl: variant.images?.[0]?.url ?? null')
    && READ.includes('...product.variants.flatMap((variant) => (variant.images ?? []).map((file) => file.url))'));

assert('the browser gets them through the browser image rule, field by field', () =>
    DETAIL.includes('imageUrl: browserImageUrl(variant.imageSourceUrl ?? null)')
    && /images: \(detail\.gallerySourceUrls \?\? \[\]\)\s*\.map\(\(url\) => browserImageUrl\(url\)\)/.test(DETAIL));

assert('⛔ choosing a chip moves the gallery to that variant\'s picture — and so does opening the page', () =>
    /refresh\(\);\s*showVariantImage\(currentVariant\(\), true\);/.test(PAGE)
    && /refresh\(\);\s*showVariantImage\(currentVariant\(\), false\);/.test(PAGE));

assert('the "was" price arrives formatted; the page computes no money', () =>
    READ.includes('formatBotPrice(variant.compareAtPrice, variant.currency)')
    && PAGE.includes('el.was.textContent = v.compareAtText')
    && !/toFixed|parseFloat|Intl\.NumberFormat/.test(PAGE));

console.log(failed === 0 ? `\n✅ ${passed} passed, 0 failed` : `\n❌ ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
