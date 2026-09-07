/**
 * test:negotiation-tools — the bargaining sub-agent's five read tools (Stream B).
 *
 * No database. Every rule worth pinning was deliberately extracted onto a pure function in
 * `modules/negotiation/domain/`, so the decision tables below are behavioural rather than
 * scanned — and the handful that genuinely cannot be observed without Mongo are asserted
 * from source instead of skipped.
 *
 * The three the plan asks for by name are §§ 1, 5 and 7:
 *   1 · the price bound is really applied — and it bounds the FLOOR, not the ask
 *   5 · a stub that cannot accidentally report a promotion
 *   7 · a leak assertion that no response carries `absorbedByVendor`
 *
 * Run: npm run test:negotiation-tools
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import { AppError } from '../../src/core/errors';
import { ERROR_CODES } from '../../src/core/error-codes';
import { DEFAULT_ERROR_MESSAGES } from '../../src/core/errors';
import {
    buildDeliveryPromise,
    NO_ETA_BASIS,
} from '../../src/modules/negotiation/domain/delivery-promise';
import {
    requireProductSubject,
    requireSearchSubject,
} from '../../src/modules/negotiation/domain/negotiation-tool-subject';
import {
    askingPriceOf,
    compareAtPriceOf,
    reachablePriceOf,
    stockOf,
    windowOf,
    withinBudget,
} from '../../src/modules/negotiation/domain/negotiation-tool-view';
import { negotiationToolsService } from '../../src/modules/negotiation/services/negotiation-tools.service';

// The console bridge swaps `console.log` for the logger; a harness printing through it
// swallows its own results. Same reason `test:negotiation-playbook` does this.
const originalConsole = { log: console.log.bind(console), error: console.error.bind(console) };

let passed = 0;
let failed = 0;

function assert(label: string, fn: () => void): void {
    try {
        fn();
        passed += 1;
        originalConsole.log(`  ✅ ${label}`);
    } catch (error) {
        failed += 1;
        originalConsole.log(`  ❌ FAIL: ${label}`);
        originalConsole.log(`     ${error instanceof Error ? error.message : String(error)}`);
    }
}

function section(title: string): void {
    originalConsole.log(`\n── ${title} ${'─'.repeat(Math.max(0, 72 - title.length))}`);
}

function eq<T>(actual: T, expected: T, what: string): void {
    if (actual !== expected) {
        throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

function ok(condition: boolean, what: string): void {
    if (!condition) throw new Error(what);
}

/**
 * Assert a call raises `code` at `status`, and hand back the error for further inspection.
 *
 * The comparisons happen OUTSIDE the catch, for the reason `test:negotiation-playbook`
 * records at the same spot: `preserve-caught-error` demands a `cause` on an error raised
 * from inside a catch, and `new Error(msg, { cause })` needs the ES2022 lib this tsconfig
 * does not target. Capturing and re-examining satisfies both.
 */
function raises(fn: () => unknown, code: string, status: number, what: string): AppError {
    let caught: unknown;
    let threw = false;
    try {
        fn();
    } catch (error) {
        caught = error;
        threw = true;
    }

    if (!threw) throw new Error(`${what}: expected a throw, got none`);
    if (!(caught instanceof AppError)) {
        throw new Error(
            `${what}: expected an AppError, got ${caught instanceof Error ? caught.constructor.name : typeof caught}`,
        );
    }

    eq(caught.code, code, `${what} — code`);
    eq(caught.statusCode, status, `${what} — status`);
    return caught;
}

// ─── Source, for the assertions nothing behavioural can make ────────────────

const SRC = join(__dirname, '..', '..', 'src');
const NEG = join(SRC, 'modules', 'negotiation');

const read = (...parts: string[]): string => readFileSync(join(...parts), 'utf8');

/** Every file Stream B owns. The leak and lane scans below run over all of them. */
const SURFACE_FILES: Array<[string, string]> = [
    ['domain/negotiation-tool-view.ts', read(NEG, 'domain', 'negotiation-tool-view.ts')],
    ['domain/negotiation-tool-subject.ts', read(NEG, 'domain', 'negotiation-tool-subject.ts')],
    ['domain/delivery-promise.ts', read(NEG, 'domain', 'delivery-promise.ts')],
    ['repositories/negotiation-catalog.repository.ts', read(NEG, 'repositories', 'negotiation-catalog.repository.ts')],
    ['services/negotiation-tools.service.ts', read(NEG, 'services', 'negotiation-tools.service.ts')],
    ['controllers/negotiation-tools.controller.ts', read(NEG, 'controllers', 'negotiation-tools.controller.ts')],
    ['validators/negotiation-tools.validators.ts', read(NEG, 'validators', 'negotiation-tools.validators.ts')],
    ['routes/negotiation-tools.routes.ts', read(NEG, 'routes', 'negotiation-tools.routes.ts')],
];

const fileOf = (name: string): string => {
    const found = SURFACE_FILES.find(([n]) => n === name);
    if (!found) throw new Error(`no such surface file: ${name}`);
    return found[1];
};

/**
 * Strip line and block comments before a scan.
 *
 * Every file here explains at length why `absorbedByVendor` must not appear and which files
 * must not be imported — so a scan over raw source would fail on its own documentation. The
 * tombstones are the most useful thing in these files; a scan that forced their removal would
 * have made the codebase worse. Same rule `test:connections` applies.
 */
function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function main(): void {
    // ── 1. The price bound ───────────────────────────────────────────────────
    section('1. The price bound — a budget bounds the FLOOR, never the ask');

    /**
     * The fixture that makes the whole section meaningful: a variant the vendor shelves at
     * 45 000 and will go down to 38 000 on. A customer with 40 000 CAN be served this — the
     * agent's entire job is to get them there — and an implementation bounding on the ask
     * filters it out while passing every other test in this file.
     */
    const negotiable = { price: 38_000, bargain: { minPrice: 38_000, maxPrice: 45_000 } };
    const flat = { price: 41_000 };

    assert('a variant whose FLOOR is under budget is admitted, though its ASK is over it', () => {
        ok(withinBudget(negotiable, 40_000), 'floor 38 000 must be within a 40 000 budget');
        eq(askingPriceOf(true, negotiable), 45_000, 'the ask is genuinely above the budget');
    });

    assert('a variant whose floor is above budget is excluded', () =>
        ok(!withinBudget(negotiable, 30_000), 'floor 38 000 must be outside a 30 000 budget'));

    assert('the bound is inclusive at the floor', () =>
        ok(withinBudget(negotiable, 38_000), 'a budget exactly equal to the floor must admit'));

    assert('a non-bargainable variant is bounded on its price, which IS its floor', () => {
        ok(withinBudget(flat, 41_000), 'inclusive');
        ok(!withinBudget(flat, 40_999), 'one franc short must exclude');
        eq(reachablePriceOf(flat), 41_000, 'reachable price');
    });

    assert('an absent budget admits everything', () => {
        ok(withinBudget(negotiable, undefined), 'undefined budget must admit');
        ok(withinBudget({ price: 9_000_000 }, undefined), 'undefined budget must admit any price');
    });

    assert('⚠ the repository matches on the FLOOR, and derives it from variant.price', () => {
        const repo = stripComments(fileOf('repositories/negotiation-catalog.repository.ts'));
        ok(
            /_reachableFloor:\s*\{\s*\$min:\s*'\$sellableVariants\.price'\s*\}/.test(repo),
            '_reachableFloor is not $min of sellableVariants.price — the budget would bound '
            + 'something other than the cheapest floor',
        );
        ok(
            /\{\s*_reachableFloor:\s*\{\s*\$lte:\s*query\.maxPrice\s*\}\s*\}/.test(repo),
            'maxPrice is not matched against _reachableFloor with $lte',
        );
        ok(
            !/maxPrice[\s\S]{0,200}bargain\.maxPrice/.test(repo),
            'the budget appears to be compared against a bargain ceiling — it must bound the floor',
        );
    });

    assert('the Mongo dialect and the TS predicate agree on which field they bound', () => {
        // `withinBudget` compares `reachablePriceOf` (variant.price); the pipeline compares the
        // $min of the same field. Asserting both here is what stops one being "fixed" alone.
        const repo = stripComments(fileOf('repositories/negotiation-catalog.repository.ts'));
        ok(repo.includes("$min: '$sellableVariants.price'"), 'pipeline side');
        ok(withinBudget({ price: 38_000 }, 38_000) && !withinBudget({ price: 38_001 }, 38_000), 'TS side');
    });

    // ── 2. The window ────────────────────────────────────────────────────────
    section('2. The window — floor / ask, and when it is inert');

    assert('a bargainable variant reports floor = price and ask = bargain.maxPrice', () => {
        const w = windowOf(true, negotiable);
        ok(w !== null, 'expected a window');
        eq(w!.floor, 38_000, 'floor');
        eq(w!.ask, 45_000, 'ask');
    });

    assert('a window on an un-vectorised product is INERT — kept in the row, null on the wire', () => {
        eq(windowOf(false, negotiable), null, 'window under vectorisationEnabled=false');
        eq(askingPriceOf(false, negotiable), 38_000, 'an inert variant is quoted at its price');
    });

    assert('a variant with no window has none', () => eq(windowOf(true, flat), null, 'window'));

    assert('the asking price is the ask when bargainable, the price otherwise', () => {
        eq(askingPriceOf(true, negotiable), 45_000, 'bargainable');
        eq(askingPriceOf(true, flat), 41_000, 'flat');
    });

    assert('compareAtPrice is dropped when it falls at or below the quoted price', () => {
        // price 38 000 · compareAt 42 000 · ask 45 000 — "was 42 000, now 45 000" is worse
        // than saying nothing, so it is withheld.
        const trap = { price: 38_000, compareAtPrice: 42_000, bargain: { minPrice: 38_000, maxPrice: 45_000 } };
        eq(compareAtPriceOf(true, trap), null, 'compareAt below the ask must be withheld');
        eq(compareAtPriceOf(false, trap), 42_000, 'inert variant is quoted at 38 000, so 42 000 stands');
    });

    assert('compareAtPrice survives when it is genuinely above the quoted price', () =>
        eq(
            compareAtPriceOf(true, { price: 38_000, compareAtPrice: 52_000, bargain: { minPrice: 38_000, maxPrice: 45_000 } }),
            52_000,
            'compareAt',
        ));

    assert('an absent compareAtPrice is null, never 0', () =>
        eq(compareAtPriceOf(true, flat), null, 'compareAt'));

    // ── 3. Stock ─────────────────────────────────────────────────────────────
    section('3. Stock — a count is not a verdict, and a verdict is not a count');

    assert('a counted variant reports its real number', () => {
        const s = stockOf({ price: 1, stock: 2, isInfiniteStock: false, allow_oversell: false });
        eq(s.onHand, 2, 'onHand');
        eq(s.isInfinite, false, 'isInfinite');
        eq(s.sellable, true, 'sellable');
    });

    assert('an infinite-stock variant reports onHand NULL, never 0', () => {
        const s = stockOf({ price: 1, stock: 0, isInfiniteStock: true, allow_oversell: false });
        eq(s.onHand, null, 'onHand must be null so no scarcity claim can be built from it');
        eq(s.sellable, true, 'sellable');
    });

    assert('⚠ sellable can be TRUE at zero stock — overselling', () => {
        const s = stockOf({ price: 1, stock: 0, isInfiniteStock: false, allow_oversell: true });
        eq(s.onHand, 0, 'onHand');
        eq(s.sellable, true, 'the cart would accept this order');
        // This pair is the whole reason `sellable` and `onHand` are separate fields: a model
        // deriving "only N left" from `sellable` would say "2 left" about a shelf holding none.
    });

    assert('a sold-out variant with no oversell is not sellable', () => {
        const s = stockOf({ price: 1, stock: 0, isInfiniteStock: false, allow_oversell: false });
        eq(s.sellable, false, 'sellable');
    });

    assert('a missing stock field reads as 0, not as unknown', () =>
        eq(stockOf({ price: 1 }).onHand, 0, 'onHand'));

    // ── 4. The subject rule ──────────────────────────────────────────────────
    section('4. The subject — a tool called without naming a product');

    assert('an empty body raises NEGOTIATION_TOOL_SUBJECT_REQUIRED at 400', () => {
        const error = raises(
            () => requireProductSubject({}, 'get_product_details'),
            ERROR_CODES.NEGOTIATION_TOOL_SUBJECT_REQUIRED,
            400,
            'empty subject',
        );
        eq((error.details as { tool: string }).tool, 'get_product_details', 'details.tool');
    });

    assert('whitespace is not a value — a model sending "" has said nothing', () =>
        raises(
            () => requireProductSubject({ sku: '   ', productId: '' }, 'quote_delivery'),
            ERROR_CODES.NEGOTIATION_TOOL_SUBJECT_REQUIRED,
            400,
            'whitespace subject',
        ));

    assert('any one identifier is enough, and it is trimmed', () => {
        eq(requireProductSubject({ sku: '  ABC-1 ' }, 't').sku, 'ABC-1', 'sku');
        eq(requireProductSubject({ slug: 'blue-shirt' }, 't').slug, 'blue-shirt', 'slug');
        eq(requireProductSubject({ productId: 'abc' }, 't').productId, 'abc', 'productId');
        eq(requireProductSubject({ variantId: 'v1' }, 't').variantId, 'v1', 'variantId');
    });

    assert('an unsupplied identifier is undefined, never an empty string', () =>
        eq(requireProductSubject({ sku: 'X' }, 't').productId, undefined, 'productId'));

    assert('the search form accepts a bare query — there is no id in the conversation', () => {
        const resolved = requireSearchSubject({ query: '  something cheaper  ' }, 'find_alternative_product');
        eq(resolved.query, 'something cheaper', 'query');
        eq(resolved.productId, undefined, 'productId');
    });

    assert('the search form still refuses neither-a-subject-nor-a-query', () => {
        const error = raises(
            () => requireSearchSubject({ query: '  ' }, 'find_alternative_product'),
            ERROR_CODES.NEGOTIATION_TOOL_SUBJECT_REQUIRED,
            400,
            'empty search subject',
        );
        ok(
            (error.details as { accepts: string[] }).accepts.includes('query'),
            'the search form must tell the model that a query would have done',
        );
    });

    assert('the code renders a real message, never the generic fallback', () => {
        const message = DEFAULT_ERROR_MESSAGES[ERROR_CODES.NEGOTIATION_TOOL_SUBJECT_REQUIRED];
        ok(typeof message === 'string' && message.length > 20, 'no registry entry — test:errors § 8');
    });

    // ── 5. check_promotion ───────────────────────────────────────────────────
    section('5. check_promotion — a stub that cannot report a promotion');

    assert('with no code it answers 200, available: false, and an empty list', () => {
        const result = negotiationToolsService.checkPromotion({});
        eq(result.available, false, 'available');
        eq(result.promotions.length, 0, 'promotions');
        eq(result.reason, 'no_promotion_system', 'reason');
        ok(result.guidance.length > 40, 'the guidance must be a sentence the model can say');
    });

    assert('a supplied CODE is refused at 422 rather than answered false', () => {
        // `{available:false}` to a named code reads as "that code is not valid" — a verdict on
        // a code nobody checked, which is exactly the invented fact this tool exists to stop.
        raises(
            () => negotiationToolsService.checkPromotion({ code: 'JOVI10' }),
            ERROR_CODES.NEGOTIATION_PROMOTIONS_UNAVAILABLE,
            422,
            'a named code',
        );
    });

    assert('a whitespace-only code is not a code', () => {
        const result = negotiationToolsService.checkPromotion({ code: '   ' });
        eq(result.available, false, 'available');
    });

    assert('⚠ the refusal does NOT echo the code back', () => {
        const error = raises(
            () => negotiationToolsService.checkPromotion({ code: 'JOVI10' }),
            ERROR_CODES.NEGOTIATION_PROMOTIONS_UNAVAILABLE,
            422,
            'a named code',
        );
        ok(
            !JSON.stringify(error.details ?? {}).includes('JOVI10'),
            'the code is in `details` — nothing validated it, and a code in the envelope is a '
            + 'code that gets quoted back at the customer',
        );
    });

    assert('⚠ the registry message cannot be rendered as a verdict on the code', () => {
        const message = DEFAULT_ERROR_MESSAGES[ERROR_CODES.NEGOTIATION_PROMOTIONS_UNAVAILABLE] ?? '';
        ok(message.length > 20, 'no registry entry — test:errors § 8');
        for (const forbidden of ['invalid', 'expired', 'not valid', 'incorrect', 'wrong']) {
            ok(
                !message.toLowerCase().includes(forbidden),
                `the message contains "${forbidden}" — a model will relay it as a verdict on the `
                + 'customer\'s code, which is the failure the 422 exists to avoid',
            );
        }
    });

    assert('nothing on this surface can return a truthy `available`', () => {
        const service = stripComments(fileOf('services/negotiation-tools.service.ts'));
        ok(!/available:\s*true/.test(service), 'a code path reports an available promotion');
        ok(/available:\s*false/.test(service), 'the stub no longer answers false at all');
        ok(
            !/\bdiscount\s*:/.test(service) && !/\bcoupon\s*:/.test(service),
            'a discount or coupon field appeared — there is no coupon model to fill it from',
        );
    });

    // ── 6. quote_delivery ────────────────────────────────────────────────────
    section('6. quote_delivery — the promise, and the ETA that does not exist');

    const agency = { id: 'a1', name: 'Douala Express', coverageAreas: ['littoral', 'centre'] };

    assert('a physical product with an agency is deliverable and free', () => {
        const p = buildDeliveryPromise({ productType: 'physical', currency: 'XAF', agency });
        eq(p.deliverable, true, 'deliverable');
        eq(p.reason, 'agency_assigned', 'reason');
        eq(p.customerPays, 0, 'customerPays');
        eq(p.free, true, 'free');
        eq(p.agency?.name, 'Douala Express', 'agency name');
    });

    assert('a physical product with NO resolvable agency is not deliverable', () => {
        const p = buildDeliveryPromise({ productType: 'physical', currency: 'XAF', agency: null });
        eq(p.deliverable, false, 'deliverable');
        eq(p.reason, 'no_agency_resolved', 'reason');
        // Checkout raises ORDER_NO_DELIVERY_AGENCY on this, so a silent yes would have the
        // agent promise a delivery the cart is about to refuse.
    });

    assert('a digital product is deliverable with no agency at all', () => {
        const p = buildDeliveryPromise({ productType: 'digital', currency: 'XAF', agency: null });
        eq(p.deliverable, true, 'deliverable');
        eq(p.reason, 'digital_download', 'reason');
        eq(p.agency, null, 'agency');
    });

    assert('a service is reported as not shipped rather than as undeliverable', () => {
        const p = buildDeliveryPromise({ productType: 'service', currency: 'XAF', agency: null });
        eq(p.deliverable, true, 'deliverable');
        eq(p.reason, 'not_shipped', 'reason');
    });

    assert('⚠ the ETA is null on EVERY branch, with a stated reason beside it', () => {
        for (const productType of ['physical', 'digital', 'service'] as const) {
            const p = buildDeliveryPromise({ productType, currency: 'XAF', agency });
            eq(p.eta, null, `eta on ${productType}`);
            eq(p.etaBasis, NO_ETA_BASIS, `etaBasis on ${productType}`);
        }
        ok(NO_ETA_BASIS.toLowerCase().includes('do not name a day'), 'the basis must tell the model what to do');
    });

    assert('⚠ the agency policy model still carries NO delivery-time field', () => {
        // The plan said to report a date "if the agency policy model supports it". It does not:
        // IAgencyPolicies is pricing · returns · damage · cod · documents. This assertion is
        // what makes that a CHECKED claim rather than a note that quietly goes stale — if
        // somebody adds a lead time, this fails and the `null` above gets revisited.
        const model = stripComments(read(SRC, 'modules', 'delivery', 'delivery-agency.model.ts'));
        const block = model.slice(model.indexOf('export interface IAgencyPolicies '));
        const body = block.slice(0, block.indexOf('}'));
        for (const invented of ['delivery_time', 'lead_time', 'eta', 'sla', 'delivery_days']) {
            ok(
                !body.includes(invented),
                `IAgencyPolicies now carries "${invented}" — quote_delivery can stop returning a `
                + 'null ETA. Revisit delivery-promise.ts.',
            );
        }
    });

    assert('coverage is three-valued — null when there is nothing to compare', () => {
        eq(buildDeliveryPromise({ productType: 'physical', currency: 'XAF', agency }).coversRegion, null, 'no region named');
        eq(
            buildDeliveryPromise({
                productType: 'physical',
                currency: 'XAF',
                agency: { ...agency, coverageAreas: [] },
                region: 'littoral',
            }).coversRegion,
            null,
            'an agency that published no coverage must not be reported as refusing a region',
        );
    });

    assert('a named region resolves true or false, case-insensitively', () => {
        const covered = buildDeliveryPromise({ productType: 'physical', currency: 'XAF', agency, region: '  LITTORAL ' });
        eq(covered.coversRegion, true, 'covered');
        const not = buildDeliveryPromise({ productType: 'physical', currency: 'XAF', agency, region: 'far_north' });
        eq(not.coversRegion, false, 'not covered');
    });

    // ── 7. The leak assertion ────────────────────────────────────────────────
    section('7. absorbedByVendor — never, on any response from this surface');

    assert('⚠ no file on this surface so much as NAMES absorbedByVendor', () => {
        for (const [name, source] of SURFACE_FILES) {
            ok(
                !stripComments(source).includes('absorbedByVendor'),
                `${name} references absorbedByVendor — it is what the VENDOR pays the agency, and `
                + 'in front of a model negotiating with a customer it is a lever, not a fact',
            );
        }
    });

    assert('a serialised delivery promise carries no trace of it', () => {
        const serialised = JSON.stringify(
            buildDeliveryPromise({ productType: 'physical', currency: 'XAF', agency, region: 'littoral' }),
        );
        ok(!serialised.includes('absorbedByVendor'), 'absorbedByVendor in the promise');
        ok(!serialised.includes('absorbed'), 'a renamed variant of the same number');
    });

    assert('nothing here imports the cart quote at all', () => {
        for (const [name, source] of SURFACE_FILES) {
            ok(
                !stripComments(source).includes('cart-quote.service'),
                `${name} imports CartQuoteService — the only thing it could add here is the fee `
                + 'the customer does not pay',
            );
        }
    });

    // ── 8. Wiring, and staying in Stream B's lane ────────────────────────────
    section('8. Wiring — the door, the verbs, and the files this stream may not touch');

    assert('the tools router is mounted UNDER the service-token-guarded parent', () => {
        const parent = read(NEG, 'routes', 'internal-negotiation.routes.ts');
        ok(parent.includes('router.use(requireServiceToken)'), 'the parent lost its guard');
        ok(
            parent.includes("router.use('/tools', negotiationToolsRoutes)"),
            'the tools router is not mounted on the guarded parent — mounting it in api/index.ts '
            + 'instead would give it no credential at all',
        );
        const guardAt = parent.indexOf('router.use(requireServiceToken)');
        const mountAt = parent.indexOf("router.use('/tools'");
        ok(guardAt !== -1 && mountAt > guardAt, 'the mount is declared above the guard, so it is unguarded');
    });

    assert('all five tools are mounted, and every one is a POST', () => {
        const routes = stripComments(fileOf('routes/negotiation-tools.routes.ts'));
        for (const path of ['/product-details', '/alternatives', '/complements', '/delivery-promise', '/promotion']) {
            ok(routes.includes(`router.post('${path}'`), `missing POST ${path}`);
        }
        for (const verb of ['router.get(', 'router.put(', 'router.patch(', 'router.delete(']) {
            ok(!routes.includes(verb), `${verb} on this surface — the customer's own words travel in the body`);
        }
    });

    assert('the controller uses the house error path — no res.status().json, no bare throw', () => {
        for (const [name, source] of SURFACE_FILES) {
            const code = stripComments(source);
            ok(!/res\.status\([^)]*\)\.json\(/.test(code), `${name} hand-rolls a response`);
            ok(!/throw new Error\(/.test(code), `${name} throws a bare Error — createAppError only`);
        }
        ok(fileOf('controllers/negotiation-tools.controller.ts').includes('asyncHandler'), 'no asyncHandler');
        ok(fileOf('controllers/negotiation-tools.controller.ts').includes('sendSuccess'), 'no sendSuccess');
    });

    assert('the repository imports the SHARED publishable predicate rather than re-expressing it', () => {
        const repo = fileOf('repositories/negotiation-catalog.repository.ts');
        ok(repo.includes('publishableProductFilter'), 'the product half is not the shared one');
        ok(repo.includes('VENDOR_PUBLISHABLE_MATCH'), 'the vendor half is not the shared one');
        // Every PRODUCT-level match must spread the shared predicate. Inline `status:
        // 'active'` is allowed only on a VARIANT — `publishableProductFilter` is about
        // products and says nothing about variants — so each occurrence must sit beside one
        // of the two markers that identify a variant query: the `$$pid` correlation in the
        // `$lookup`, or `ProductVariantModel` in the two id-resolution helpers.
        const code = stripComments(repo);
        const inlineActive = [...code.matchAll(/status:\s*'active'/g)];
        ok(inlineActive.length > 0, 'the variant filters lost their own active/deleted predicate');
        for (const match of inlineActive) {
            const around = code.slice(Math.max(0, match.index! - 300), match.index! + 100);
            ok(
                around.includes('$$pid') || around.includes('ProductVariantModel'),
                'a PRODUCT-level publishable predicate is spelled out inline instead of spread '
                + 'from publishableProductFilter() — a product the sub-agent offers and the '
                + 'storefront has taken down is the failure that produces',
            );
        }
    });

    assert('search goes through $text, never a hand-built RegExp', () => {
        const repo = stripComments(fileOf('repositories/negotiation-catalog.repository.ts'));
        ok(repo.includes('$text'), 'no $text search');
        ok(!/new RegExp\(/.test(repo), 'a bare RegExp — every search path here is injection + ReDoS');
        ok(!/\$regex/.test(repo), '$regex on a phrase that came out of a chat message');
    });

    assert('⚠ Stream B stays out of the three files the plan fences off', () => {
        // `PriceResolverService`, `earnings-split.service.ts` and
        // `public-catalog.repository.mongo.ts` belong to Streams C+E and D. Importing one is how
        // two sessions end up editing one file through a dependency neither of them declared.
        const fenced = ['PriceResolverService', 'earnings-split.service', 'public-catalog.repository.mongo'];
        for (const [name, source] of SURFACE_FILES) {
            const code = stripComments(source);
            for (const forbidden of fenced) {
                ok(!code.includes(forbidden), `${name} reaches into ${forbidden} — another stream's file`);
            }
        }
    });

    assert('the complements tool reports a REAL count and refuses a same-category fallback', () => {
        const service = stripComments(fileOf('services/negotiation-tools.service.ts'));
        ok(service.includes('coOccurring'), 'complements are not built from co-purchase history');
        ok(
            !service.includes('sameCategoryRecent'),
            'the same-category fallback is wired in — a same-category product is a SUBSTITUTE, and '
            + 'offering one as a bundle tells a customer to buy two of the same thing',
        );
        ok(service.includes('coPurchasedOrders'), 'the count is not published, so the claim is unfalsifiable');
    });

    originalConsole.log('\n════════════════════════════════════════════════════════════════════════════');
    originalConsole.log(`  ${passed} passed, ${failed} failed`);
    originalConsole.log('════════════════════════════════════════════════════════════════════════════\n');

    if (failed > 0) process.exitCode = 1;
}

try {
    main();
} catch (error) {
    originalConsole.error('Suite crashed:', error);
    process.exitCode = 1;
}
