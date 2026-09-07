/**
 * Seed: give some of the catalogue a haggling window, so the bargaining agent has
 * something to bargain over.
 *
 * ── WHY THIS SCRIPT EXISTS ───────────────────────────────────────────────────
 *
 * Measured on the dev database 2026-09-07, immediately after the whole bargaining
 * feature went live end to end: **thirty active products, twenty-nine of them
 * vectorisation-enabled, and NOT ONE variant carrying a `bargain` window.** The
 * window is vendor configuration and predates this effort; nobody had ever set one.
 *
 * The consequence is that the feature is complete and inert. `open_negotiation`
 * resolves the variant, finds `isBargainEffective` false, and answers
 * `negotiable: false` — for every product, every customer, every time. The
 * assistant then correctly tells the customer the price is fixed, and a
 * five-stream feature looks broken while behaving exactly as designed.
 *
 * ── HOW THE WINDOW IS PLACED, AND WHY IT IS NOT THE OBVIOUS WAY ──────────────
 *
 * The obvious seed sets `bargain.maxPrice` ABOVE the current price. Do not: plan
 * decision **D-1** made the *displayed* price `bargain.maxPrice`, so that would
 * raise the shelf price of every product it touched. A seed that re-prices the
 * storefront upward is a seed nobody dares run twice.
 *
 * So it goes the other way. The current price becomes the **ask** (unchanged on
 * every screen) and `variant.price` drops to become the **floor**:
 *
 *     before   price 12 500                       shelf 12 500
 *     after    price 10 000 · maxPrice 12 500     shelf 12 500, floor 10 000
 *
 * Three things stay identical, which is what makes this safe to run against a
 * populated database:
 *
 *   - **The displayed price.** Stream D publishes `bargain.maxPrice`, which is
 *     the number that was already there.
 *   - **What an un-negotiated sale is charged.** `PriceResolverService` resolves
 *     an un-locked bargainable line through `publicDisplayPrice`, i.e. the ask.
 *   - **What the vendor is paid for one.** D-5's AI margin is gated on the line
 *     carrying a negotiation lock, so an un-haggled sale has an uplift and a
 *     margin of zero.
 *
 * What changes is that the agent now has real room: it may come down as far as
 * the floor, and the platform keeps 30% of whatever it holds back.
 *
 * ── THE RULE IS NOT RE-EXPRESSED HERE ────────────────────────────────────────
 *
 * Every window is built by `resolveBargainWrite`, the same function the three
 * vendor write paths call. A seed that hand-assembled `{ minPrice, maxPrice }`
 * could write `minPrice !== price` — the one invariant that makes this a window
 * rather than a second price field — and nothing downstream would notice, because
 * nothing downstream reads `bargain` except the rule and the negotiation module.
 *
 * ── IDEMPOTENT, BOUNDED, REVERSIBLE ─────────────────────────────────────────
 *
 *   npm run seed:bargain-windows                 apply
 *   npm run seed:bargain-windows -- --dry-run    print, write nothing
 *   npm run seed:bargain-windows -- --clean      clear every window it could set
 *   npm run seed:bargain-windows -- --limit=20   how many variants to touch (default 12)
 *   npm run seed:bargain-windows -- --discount=25  how far below the ask the floor sits
 *
 * A variant that already carries a window is left alone, so re-running adds only
 * what is missing and never deepens an existing discount.
 */
import 'dotenv/config'; // load .env (MONGO_URI etc.) before anything reads it
import mongoose from 'mongoose';

import { ProductModel } from '../../src/modules/catalog/models/product.model';
import { ProductVariantModel } from '../../src/modules/catalog/models/product-variant.model';
import { resolveBargainWrite } from '../../src/modules/catalog/domain/services/bargain-price.rule';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi-mall';

const DEFAULT_LIMIT = 12;
const DEFAULT_DISCOUNT_PERCENT = 20;

/**
 * Market prices are round. A floor of 9 999 reads as a computer's answer and
 * invites the model to counter with equally odd numbers; the playbook's own rule
 * 5 is "round numbers close deals". 500 is the smallest step this catalogue's
 * prices are expressed in.
 */
const ROUNDING_STEP = 500;

interface Args {
    dryRun: boolean;
    clean: boolean;
    limit: number;
    discountPercent: number;
}

function parseArgs(argv: string[]): Args {
    const numeric = (flag: string, fallback: number): number => {
        const hit = argv.find((a) => a.startsWith(`${flag}=`));
        if (!hit) return fallback;
        const parsed = Number.parseInt(hit.slice(flag.length + 1), 10);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
    };

    return {
        dryRun: argv.includes('--dry-run'),
        clean: argv.includes('--clean'),
        limit: numeric('--limit', DEFAULT_LIMIT),
        discountPercent: Math.min(numeric('--discount', DEFAULT_DISCOUNT_PERCENT), 60),
    };
}

/**
 * The floor, rounded DOWN to a market-round number so the discount is never
 * shallower than asked for. Returns null when the price is too small for the
 * rounding step to leave a meaningful gap — a 900 XAF item with a 500 step has
 * nowhere sensible to go, and a one-franc window is not a negotiation.
 */
function floorFor(price: number, discountPercent: number): number | null {
    const target = price * (1 - discountPercent / 100);
    const rounded = Math.floor(target / ROUNDING_STEP) * ROUNDING_STEP;
    if (rounded < ROUNDING_STEP) return null;
    if (rounded >= price) return null;
    return rounded;
}

/**
 * Thousands separated by a PLAIN space. Deliberately not toLocaleString('fr-FR'),
 * which groups with U+202F — an irregular whitespace character ESLint refuses, and
 * one that survives a copy-paste out of this output into a shell as an invisible
 * space that separates no arguments.
 */
function money(value: number): string {
    return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));

    await mongoose.connect(MONGO_URI);
    console.log(`Connected to ${mongoose.connection.name}\n`);

    if (args.clean) {
        await clean(args);
        return;
    }

    // Only products the window could ever be EFFECTIVE on. `isBargainEffective`
    // requires `vectorisationEnabled`, so seeding a window on anything else would
    // write configuration that reads as `bargainable: false` and look like a bug.
    const products = await ProductModel.find({
        deletedAt: null,
        status: 'active',
        vectorisationEnabled: true,
        type: { $ne: 'service' },
    })
        .select({ _id: 1, title: 1, type: 1 })
        .lean();

    if (products.length === 0) {
        console.log('No active, vectorisation-enabled, non-service products. Nothing to do.');
        return;
    }

    const byId = new Map(products.map((p) => [String(p._id), p]));

    const variants = await ProductVariantModel.find({
        deletedAt: null,
        status: 'active',
        productId: { $in: products.map((p) => String(p._id)) },
    }).sort({ price: -1 });

    let touched = 0;
    let skippedExisting = 0;
    let skippedTooCheap = 0;

    for (const variant of variants) {
        if (touched >= args.limit) break;

        if (variant.bargain && variant.bargain.maxPrice != null) {
            skippedExisting += 1;
            continue;
        }

        const product = byId.get(String(variant.productId));
        if (!product) continue;

        const ask = variant.price;
        const floor = floorFor(ask, args.discountPercent);
        if (floor === null) {
            skippedTooCheap += 1;
            continue;
        }

        // The rule builds the pair and enforces `minPrice === price`. Passing the
        // new floor as `price` is what makes it come back as `{ floor, ask }`.
        const window = resolveBargainWrite({
            mode: 'update',
            productType: product.type,
            current: { price: variant.price, bargain: variant.bargain ?? null },
            price: floor,
            bargain: { maxPrice: ask },
            variantLabel: variant.name || variant.sku,
        });

        if (!window) continue;

        console.log(
            `  ${product.title} · ${variant.sku}\n`
            + `      ask ${money(window.maxPrice)}  (unchanged on every screen)\n`
            + `      floor ${money(window.minPrice)}  (room to haggle: ${money(window.maxPrice - window.minPrice)})`,
        );

        if (!args.dryRun) {
            variant.price = floor;
            variant.bargain = window;
            await variant.save();
        }

        touched += 1;
    }

    console.log(
        `\n${args.dryRun ? '[dry-run] would configure' : 'Configured'} ${touched} variant(s)`
        + ` at ${args.discountPercent}% room.`,
    );
    if (skippedExisting > 0) console.log(`${skippedExisting} already had a window and were left alone.`);
    if (skippedTooCheap > 0) console.log(`${skippedTooCheap} were too cheap for a ${money(ROUNDING_STEP)} step.`);
    if (touched === 0 && skippedExisting === 0) {
        console.log('Nothing was eligible. Check that products are active AND vectorisation-enabled.');
    }
}

/**
 * ⚠ `--clean` restores the FLOOR as the price, not the ask.
 *
 * That is the exact inverse of what this script did, and it is the only reversal
 * that leaves the database where it started. Restoring the ask instead would
 * silently raise `variant.price` on every variant a vendor had configured by hand
 * before this ran — and there is no way from here to tell those apart.
 */
async function clean(args: Args): Promise<void> {
    const variants = await ProductVariantModel.find({
        deletedAt: null,
        'bargain.maxPrice': { $ne: null },
    });

    if (variants.length === 0) {
        console.log('No variant carries a window. Nothing to clean.');
        return;
    }

    for (const variant of variants) {
        console.log(`  clearing ${variant.sku} · price stays ${money(variant.price)}`);
        if (!args.dryRun) {
            variant.bargain = undefined;
            await variant.save();
        }
    }

    console.log(`\n${args.dryRun ? '[dry-run] would clear' : 'Cleared'} ${variants.length} window(s).`);
}

main()
    .catch((error) => {
        console.error('\nSeed failed:', error instanceof Error ? error.message : error);
        process.exitCode = 1;
    })
    .finally(async () => {
        if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    });
