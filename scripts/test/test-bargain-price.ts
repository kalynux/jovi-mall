/**
 * Bargainable pricing tests (no DB needed).
 *
 * Covers the whole feature except the HTTP hop: the Zod fragment on all four
 * schemas, the pure rule that every write path funnels through, the read model's
 * `bargainable` derivation, the repository's update-operator builder, and a source
 * scan proving the rule is actually CALLED — and called before the side effects it
 * has to precede. A rule nobody calls protects nothing, and an ordering guarantee
 * nobody asserts is a comment.
 *
 * Run: npx ts-node scripts/test/test-bargain-price.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { AppError } from '../../src/core/errors';
import { ERROR_CODES } from '../../src/core/error-codes';
import {
  BargainRangeSchema,
  CreateVariantSchema,
  UpdateVariantSchema,
} from '../../src/modules/catalog/validators/variant.validator';
import {
  CreateSimpleProductSchema,
  UpdateSimpleProductSchema,
} from '../../src/modules/catalog/validators/simple-product.validator';
import {
  BargainRange,
  isBargainEffective,
  resolveBargainWrite,
} from '../../src/modules/catalog/domain/services/bargain-price.rule';
import { buildVariantUpdateOps } from '../../src/modules/catalog/repositories/mongo/variant.repository.mongo';
import { enrichVariant } from '../../src/modules/catalog/read-models/enrich-product-detail';
import { Variant } from '../../src/modules/catalog/repositories/mappers/variant.mapper';
import { Product } from '../../src/modules/catalog/repositories/mappers/product.mapper';

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

/** Run `fn` and return the AppError it threw, or undefined. */
function capture(fn: () => unknown): AppError | undefined {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e instanceof AppError ? e : undefined;
  }
}

function assertThrows(fn: () => unknown, code: string, status: number, label: string): void {
  const err = capture(fn);
  assert(err !== undefined, `${label}: throws an AppError`);
  assert(err?.code === code, `${label}: code is ${code} (got ${err?.code})`);
  assert(err?.statusCode === status, `${label}: status is ${status} (got ${err?.statusCode})`);
  assert(
    typeof (err?.details as Record<string, unknown> | undefined)?.variant === 'string',
    `${label}: carries details.variant`,
  );
}

const SRC = path.resolve(__dirname, '../../src');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');

// ─── 1. Zod: the shared fragment and its four hosts ───────────────────────────

{
  assert(BargainRangeSchema.safeParse({ maxPrice: 5000 }).success,
    'zod: maxPrice alone is a complete window (minPrice defaults to the price)');
  assert(BargainRangeSchema.safeParse({ minPrice: 1000, maxPrice: 5000 }).success,
    'zod: both bounds pass');
  assert(!BargainRangeSchema.safeParse({ minPrice: 1000 }).success,
    'zod: minPrice alone is rejected — maxPrice is required');
  assert(!BargainRangeSchema.safeParse({}).success, 'zod: an empty window is rejected');
  assert(!BargainRangeSchema.safeParse({ maxPrice: -1 }).success, 'zod: negative maxPrice rejected');
  assert(!BargainRangeSchema.safeParse({ minPrice: -1, maxPrice: 5 }).success, 'zod: negative minPrice rejected');
  assert(!BargainRangeSchema.safeParse({ maxPrice: 'x' }).success, 'zod: non-numeric maxPrice rejected');
  assert(!BargainRangeSchema.safeParse({ maxPrice: NaN }).success, 'zod: NaN maxPrice rejected');
  assert(!BargainRangeSchema.safeParse({ maxPrice: 5000, currency: 'XAF' }).success,
    'zod: unknown key rejected (.strict())');
  assert(BargainRangeSchema.safeParse({ minPrice: 0, maxPrice: 0 }).success,
    'zod: zero bounds pass — the price check is the rule\'s, not the schema\'s');

  // THE pin. The ordering check must NOT be here: the same violation also arrives
  // as `price` + `bargain` siblings and as a bare `price` against stored state,
  // neither of which a schema can see. Enforcing the visible third at 400 while the
  // other two are 422 would give one error code two categories, which
  // `npm run test:errors` refuses.
  assert(BargainRangeSchema.safeParse({ minPrice: 5000, maxPrice: 100 }).success,
    'zod: maxPrice < minPrice PASSES the schema — ordering belongs to the rule (422)');
}

{
  const variantBase = { sku: 'SKU-1', price: 1000 };

  assert(CreateVariantSchema.safeParse(variantBase).success,
    'CreateVariantSchema: bargain omitted passes');
  assert(CreateVariantSchema.safeParse({ ...variantBase, bargain: { maxPrice: 2000 } }).success,
    'CreateVariantSchema: bargain accepted');
  assert(!CreateVariantSchema.safeParse({ ...variantBase, bargain: null }).success,
    'CreateVariantSchema: bargain null rejected — there is nothing to clear on create');
  assert(!CreateVariantSchema.safeParse({ ...variantBase, bargain: { minPrice: 1 } }).success,
    'CreateVariantSchema: bargain without maxPrice rejected');

  assert(UpdateVariantSchema.safeParse({ bargain: { maxPrice: 2000 } }).success,
    'UpdateVariantSchema: bargain accepted');
  assert(UpdateVariantSchema.safeParse({ bargain: null }).success,
    'UpdateVariantSchema: bargain null accepted — the clear signal');
  assert(UpdateVariantSchema.safeParse({ price: 100 }).success,
    'UpdateVariantSchema: price alone still passes (auto-sync happens in the rule)');
}

{
  const simpleBase = { title: 'Simple Shoes', description: 'Comfy.', category: 'footwear', price: 15000 };

  assert(CreateSimpleProductSchema.safeParse(simpleBase).success,
    'CreateSimpleProductSchema: bargain omitted passes');
  assert(CreateSimpleProductSchema.safeParse({ ...simpleBase, bargain: { maxPrice: 20000 } }).success,
    'CreateSimpleProductSchema: bargain accepted despite .strict()');
  assert(!CreateSimpleProductSchema.safeParse({ ...simpleBase, bargain: null }).success,
    'CreateSimpleProductSchema: bargain null rejected');

  assert(UpdateSimpleProductSchema.safeParse({ bargain: { maxPrice: 20000 } }).success,
    'UpdateSimpleProductSchema: bargain alone satisfies the at-least-one-field refine');
  assert(UpdateSimpleProductSchema.safeParse({ bargain: null }).success,
    'UpdateSimpleProductSchema: bargain null accepted');
  assert(!UpdateSimpleProductSchema.safeParse({ bargin: { maxPrice: 1 } }).success,
    'UpdateSimpleProductSchema: a typo 400s here (.strict()) — unlike UpdateVariantSchema');
}

// ─── 2. resolveBargainWrite — create ──────────────────────────────────────────

{
  const base = { mode: 'create' as const, productType: 'physical' as const, variantLabel: 'Red / M' };

  assert(resolveBargainWrite({ ...base, price: 1000 }) === undefined,
    'create: no bargain → undefined (field left out of the write)');

  const defaulted = resolveBargainWrite({ ...base, price: 1000, bargain: { maxPrice: 2000 } });
  assert(defaulted?.minPrice === 1000 && defaulted?.maxPrice === 2000,
    'create: minPrice defaults to the price being set');

  const explicit = resolveBargainWrite({ ...base, price: 1000, bargain: { minPrice: 1000, maxPrice: 2000 } });
  assert(explicit?.minPrice === 1000 && explicit?.maxPrice === 2000,
    'create: an agreeing explicit minPrice is accepted');

  const degenerate = resolveBargainWrite({ ...base, price: 1000, bargain: { maxPrice: 1000 } });
  assert(degenerate?.maxPrice === 1000,
    'create: maxPrice === minPrice is allowed (bargainable, no headroom yet)');

  const digital = resolveBargainWrite({
    ...base, productType: 'digital', price: 500, bargain: { maxPrice: 900 },
  });
  assert(digital?.minPrice === 500 && digital?.maxPrice === 900,
    'create: digital products behave exactly like physical');

  assertThrows(
    () => resolveBargainWrite({ ...base, price: 1000, bargain: { minPrice: 900, maxPrice: 2000 } }),
    ERROR_CODES.CATALOG_VARIANT_BARGAIN_PRICE_MISMATCH, 422,
    'create: minPrice disagreeing with the price',
  );

  assertThrows(
    () => resolveBargainWrite({ ...base, price: 1000, bargain: { maxPrice: 900 } }),
    ERROR_CODES.CATALOG_VARIANT_BARGAIN_RANGE_INVALID, 422,
    'create: maxPrice below the price',
  );

  assertThrows(
    () => resolveBargainWrite({ ...base, productType: 'service', price: 1000, bargain: { maxPrice: 2000 } }),
    ERROR_CODES.CATALOG_VARIANT_BARGAIN_NOT_SUPPORTED, 400,
    'create: a window on a service product',
  );

  assert(resolveBargainWrite({ ...base, productType: 'service', price: 1000 }) === undefined,
    'create: a service variant with no window is fine');
}

// ─── 3. resolveBargainWrite — update ──────────────────────────────────────────

{
  const stored: BargainRange = { minPrice: 1000, maxPrice: 2000 };
  const base = { mode: 'update' as const, productType: 'physical' as const, variantLabel: 'Red / M' };
  const withRange = { ...base, current: { price: 1000, bargain: stored } };
  const without = { ...base, current: { price: 1000 } };

  assert(resolveBargainWrite(withRange) === undefined,
    'update: neither price nor bargain → untouched');
  assert(resolveBargainWrite({ ...without, price: 1500 }) === undefined,
    'update: a price change on a non-bargainable variant writes no window');

  // The auto-sync: a bare price edit keeps minPrice === price by construction, and
  // returns a COMPLETE pair carrying the stored ceiling — never a half object, which
  // the repository would $set whole and thereby drop the ceiling.
  const synced = resolveBargainWrite({ ...withRange, price: 1500 });
  assert(synced?.minPrice === 1500, 'update: a bare price edit auto-syncs minPrice');
  assert(synced?.maxPrice === 2000, 'update: the auto-sync carries the stored maxPrice through');

  const atCeiling = resolveBargainWrite({ ...withRange, price: 2000 });
  assert(atCeiling?.minPrice === 2000, 'update: price === maxPrice is allowed (boundary)');

  assertThrows(
    () => resolveBargainWrite({ ...withRange, price: 2001 }),
    ERROR_CODES.CATALOG_VARIANT_BARGAIN_RANGE_INVALID, 422,
    'update: a bare price edit above the ceiling',
  );

  const ceilingOnly = resolveBargainWrite({ ...withRange, bargain: { maxPrice: 3000 } });
  assert(ceilingOnly?.minPrice === 1000 && ceilingOnly?.maxPrice === 3000,
    'update: a ceiling-only edit takes minPrice from the STORED price');

  assertThrows(
    () => resolveBargainWrite({ ...withRange, bargain: { maxPrice: 900 } }),
    ERROR_CODES.CATALOG_VARIANT_BARGAIN_RANGE_INVALID, 422,
    'update: a ceiling below the stored price',
  );

  assertThrows(
    () => resolveBargainWrite({ ...withRange, bargain: { minPrice: 900, maxPrice: 3000 } }),
    ERROR_CODES.CATALOG_VARIANT_BARGAIN_PRICE_MISMATCH, 422,
    'update: minPrice disagreeing with the stored price',
  );

  // Both in one body: judged against the price this request is about to write, not
  // the one it replaces.
  const both = resolveBargainWrite({ ...withRange, price: 2500, bargain: { maxPrice: 3000 } });
  assert(both?.minPrice === 2500 && both?.maxPrice === 3000,
    'update: price + ceiling together are judged against the INCOMING price');
  assert(
    capture(() => resolveBargainWrite({ ...withRange, price: 2500, bargain: { maxPrice: 3000 } })) === undefined,
    'update: raising a price past the old ceiling works when both are sent together',
  );

  assertThrows(
    () => resolveBargainWrite({ ...withRange, price: 2500, bargain: { minPrice: 1000, maxPrice: 3000 } }),
    ERROR_CODES.CATALOG_VARIANT_BARGAIN_PRICE_MISMATCH, 422,
    'update: minPrice disagreeing with the INCOMING price',
  );

  const enabling = resolveBargainWrite({ ...without, bargain: { maxPrice: 4000 } });
  assert(enabling?.minPrice === 1000 && enabling?.maxPrice === 4000,
    'update: a window can be added to a variant that had none');

  // Clearing.
  assert(resolveBargainWrite({ ...withRange, bargain: null }) === null,
    'update: bargain null → null (the $unset signal)');
  assert(resolveBargainWrite({ ...withRange, bargain: null, price: 9999 }) === null,
    'update: a clear wins over the auto-sync, at any price');
  assert(resolveBargainWrite({ ...without, bargain: null }) === null,
    'update: clearing a window that was never set is a harmless no-op signal');

  // Service products.
  const svc = { ...base, productType: 'service' as const, current: { price: 1000, bargain: stored } };
  assertThrows(
    () => resolveBargainWrite({ ...svc, bargain: { maxPrice: 3000 } }),
    ERROR_CODES.CATALOG_VARIANT_BARGAIN_NOT_SUPPORTED, 400,
    'update: setting a window on a service variant',
  );
  assert(resolveBargainWrite({ ...svc, price: 1500 }) === undefined,
    'update: a bare price edit never CREATES a window on a service variant');
  assert(resolveBargainWrite({ ...svc, bargain: null }) === null,
    'update: clearing IS allowed on a service variant — else a stray window is unremovable');
}

// ─── 4. isBargainEffective ────────────────────────────────────────────────────

{
  const range: BargainRange = { minPrice: 1, maxPrice: 2 };
  assert(isBargainEffective(true, range) === true, 'effective: enabled + window → true');
  assert(isBargainEffective(false, range) === false, 'effective: disabled + window → false (inert, not deleted)');
  assert(isBargainEffective(true, undefined) === false, 'effective: enabled + no window → false');
  assert(isBargainEffective(true, null) === false, 'effective: enabled + null → false');
  assert(isBargainEffective(undefined as unknown as boolean, range) === false,
    'effective: a legacy product with no vectorisation column → false (=== true, not truthy)');
}

// ─── 5. Error identity ────────────────────────────────────────────────────────

{
  const cases = [
    {
      code: ERROR_CODES.CATALOG_VARIANT_BARGAIN_NOT_SUPPORTED,
      category: 'validation',
      run: () => resolveBargainWrite({
        mode: 'create', productType: 'service', price: 1, bargain: { maxPrice: 2 }, variantLabel: 'v',
      }),
    },
    {
      code: ERROR_CODES.CATALOG_VARIANT_BARGAIN_RANGE_INVALID,
      category: 'business_rule',
      run: () => resolveBargainWrite({
        mode: 'create', productType: 'physical', price: 10, bargain: { maxPrice: 2 }, variantLabel: 'v',
      }),
    },
    {
      code: ERROR_CODES.CATALOG_VARIANT_BARGAIN_PRICE_MISMATCH,
      category: 'business_rule',
      run: () => resolveBargainWrite({
        mode: 'create', productType: 'physical', price: 10, bargain: { minPrice: 9, maxPrice: 20 }, variantLabel: 'v',
      }),
    },
  ];

  for (const c of cases) {
    const err = capture(c.run);
    assert(err?.category === c.category, `errors: ${c.code} derives category ${c.category} (got ${err?.category})`);
    // Vendor-facing copy, like every activation blocker: never the generic fallback
    // and never the code with its underscores knocked out.
    assert(
      err !== undefined
      && err.message !== 'An unexpected error occurred'
      && err.message !== c.code.toLowerCase().replace(/_/g, ' '),
      `errors: ${c.code} has vendor-readable copy (got "${err?.message}")`,
    );
  }

  // Mini-census: each new code must be raised at exactly one status literal, or
  // `test:errors` fails on the (code, statusCode) → category derivation. Cheap here,
  // and it fails inside this feature's own suite rather than a global one.
  const ruleSrc = read('modules/catalog/domain/services/bargain-price.rule.ts');
  for (const [code, status] of [
    ['CATALOG_VARIANT_BARGAIN_NOT_SUPPORTED', '400'],
    ['CATALOG_VARIANT_BARGAIN_RANGE_INVALID', '422'],
    ['CATALOG_VARIANT_BARGAIN_PRICE_MISMATCH', '422'],
  ] as const) {
    const raises = ruleSrc.split(`ERROR_CODES.${code}`).length - 1;
    assert(raises === 1, `census: ${code} is raised exactly once (got ${raises})`);
    const other = status === '400' ? '422' : '400';
    const idx = ruleSrc.indexOf(`ERROR_CODES.${code}`);
    assert(ruleSrc.slice(idx, idx + 120).includes(status)
      && !ruleSrc.slice(idx, idx + 120).includes(other),
      `census: ${code} is raised at ${status} and nowhere else`);
  }

  // And nothing outside the rule may raise them — that is what makes the census above
  // exhaustive rather than a sample.
  for (const dir of ['modules/catalog/controllers', 'modules/catalog/domain/services/simple']) {
    for (const file of fs.readdirSync(path.join(SRC, dir))) {
      if (!file.endsWith('.ts')) continue;
      const src = read(path.join(dir, file));
      assert(!src.includes('CATALOG_VARIANT_BARGAIN_'),
        `census: ${dir}/${file} raises no bargain code directly — the rule owns them`);
    }
  }
}

// ─── 6. Read model ────────────────────────────────────────────────────────────

{
  const variant = (bargain?: BargainRange): Variant => ({
    id: 'v1', productId: 'p1', sku: 'SKU-1', status: 'active', optionSignature: 'SKU-1',
    price: 1000, bargain, stock: 5, isInfiniteStock: false, lowStockThreshold: null,
    allowOversell: false, optionValueIds: [], fileIds: [],
    createdAt: new Date(), updatedAt: new Date(),
  });

  // fileIds is empty, so buildFileDetails short-circuits and never touches the repo;
  // digitalConfig is unset, so DigitalAssetModel is never queried. No DB, no stubs
  // that have to behave.
  const fileRepo = {} as never;
  const storage = { getPublicUrl: () => '' } as never;
  const parent = (vectorisationEnabled: boolean): Pick<Product, 'title' | 'vectorisationEnabled'> =>
    ({ title: 'Shoes', vectorisationEnabled });

  const range: BargainRange = { minPrice: 1000, maxPrice: 2000 };

  void (async () => {
    const live = await enrichVariant(variant(range), fileRepo, storage, parent(true));
    assert(live.bargainable === true, 'read: window + vectorisation on → bargainable true');
    assert(live.bargain?.maxPrice === 2000, 'read: the window itself is returned');

    const inert = await enrichVariant(variant(range), fileRepo, storage, parent(false));
    assert(inert.bargainable === false, 'read: window + vectorisation off → bargainable false');
    assert(inert.bargain?.maxPrice === 2000,
      'read: the window is STILL returned when inert — never deleted, and editable');

    const none = await enrichVariant(variant(), fileRepo, storage, parent(true));
    assert(none.bargainable === false, 'read: no window → bargainable false');
    assert(!('bargain' in none), 'read: `bargain` is absent, not null, when unconfigured');

    const named = await enrichVariant({ ...variant(), name: 'Red / M' }, fileRepo, storage, parent(true));
    assert(named.displayName === 'Red / M', 'read: displayName still prefers the variant name');
    assert(none.displayName === 'Shoes', 'read: displayName still falls back to the product title');
    const untitled = await enrichVariant(variant(), fileRepo, storage,
      { title: '', vectorisationEnabled: true });
    assert(untitled.displayName === 'SKU-1', 'read: displayName still falls back to the sku');

    runOperatorAndSourceGroups();
  })();
}

// ─── 7 + 8, deferred so the async read-model group finishes first ─────────────

function runOperatorAndSourceGroups(): void {
  // ─── 7. buildVariantUpdateOps ───────────────────────────────────────────────
  {
    const range: BargainRange = { minPrice: 1000, maxPrice: 2000 };

    const setOnly = buildVariantUpdateOps({ price: 1000 });
    assert(setOnly.$set?.price === 1000 && setOnly.$unset === undefined,
      'ops: a plain field produces $set only');

    const withRange = buildVariantUpdateOps({ bargain: range });
    assert(JSON.stringify(withRange.$set?.bargain) === JSON.stringify(range),
      'ops: a window is $set as a WHOLE pair (the rule guarantees it is complete)');
    assert(withRange.$unset === undefined, 'ops: setting a window produces no $unset');

    const cleared = buildVariantUpdateOps({ bargain: null });
    assert(cleared.$unset?.bargain === 1,
      'ops: bargain null → $unset (never a literal null on a default:undefined path)');
    assert(cleared.$set === undefined,
      'ops: a clear-only patch omits $set entirely — MongoDB rejects an empty $set');

    const both = buildVariantUpdateOps({ price: 2000, bargain: null });
    assert(both.$set?.price === 2000 && both.$unset?.bargain === 1,
      'ops: price + clear produces both operators');

    assert(buildVariantUpdateOps({}).$set === undefined,
      'ops: an empty patch produces no $set (the pre-existing empty-$set crash)');

    // Regressions on the translations that were already there.
    const lst = buildVariantUpdateOps({ lowStockThreshold: 5 });
    assert(lst.$set?.low_stock_threshold === 5 && !('lowStockThreshold' in (lst.$set ?? {})),
      'ops: lowStockThreshold still maps to low_stock_threshold');
    const ao = buildVariantUpdateOps({ allowOversell: true });
    assert(ao.$set?.allow_oversell === true && !('allowOversell' in (ao.$set ?? {})),
      'ops: allowOversell still maps to allow_oversell');
    const dc = buildVariantUpdateOps({ digitalConfig: { maxDownloads: 3 } });
    assert(dc.$set?.['digitalConfig.maxDownloads'] === 3 && !('digitalConfig' in (dc.$set ?? {})),
      'ops: digitalConfig is still expanded into dotted paths');
  }

  // ─── 8. Source scan ─────────────────────────────────────────────────────────
  {
    const writePaths = [
      'modules/catalog/controllers/vendor-variant.controller.ts',
      'modules/catalog/domain/services/simple/SimpleProductCreateService.ts',
      'modules/catalog/domain/services/simple/SimpleProductUpdateService.ts',
    ];
    for (const rel of writePaths) {
      assert(read(rel).includes('resolveBargainWrite('),
        `scan: ${path.basename(rel)} calls the rule — a rule nobody calls protects nothing`);
    }

    // THE ordering guarantee. A 422 raised after the stock gate leaves an approval
    // request in an agency's queue for a PATCH that failed; after the file reconcile,
    // orphaned references. Asserted, not promised.
    //
    // Scoped to updateVariant's own body: createVariant reconciles media too, so a
    // whole-file indexOf would compare against the wrong call and pass vacuously.
    const controller = read(writePaths[0]);
    const updateBody = (() => {
      const start = controller.indexOf('static updateVariant = asyncHandler');
      assert(start > -1, 'scan: updateVariant is findable in the controller');
      const end = controller.indexOf('static ', start + 10);
      return controller.slice(start, end > -1 ? end : undefined);
    })();

    assert(updateBody.includes('resolveBargainWrite('), 'scan: updateVariant itself calls the rule');
    const ruleAt = updateBody.indexOf('resolveBargainWrite(');
    for (const sideEffect of ['stockChangeGate.intercept(', 'fileReferenceService.reconcile(']) {
      const at = updateBody.indexOf(sideEffect);
      assert(at > -1, `scan: updateVariant still performs ${sideEffect}`);
      assert(ruleAt < at, `scan: updateVariant resolves the window before ${sideEffect}`);
    }

    // createVariant is under the same obligation — its media attach runs after the
    // create, but the SKU-uniqueness 409 and the repository write both follow the rule.
    const createBody = (() => {
      const start = controller.indexOf('static createVariant = asyncHandler');
      const end = controller.indexOf('static ', start + 10);
      return controller.slice(start, end > -1 ? end : undefined);
    })();
    assert(createBody.indexOf('resolveBargainWrite(') < createBody.indexOf('variantRepository.create('),
      'scan: createVariant resolves the window before writing the variant');

    const simpleUpdate = read(writePaths[2]);
    assert(simpleUpdate.indexOf('resolveBargainWrite(') < simpleUpdate.indexOf('stockGate.intercept('),
      'scan: SimpleProductUpdateService resolves the window before the stock gate');
    assert(simpleUpdate.indexOf('resolveBargainWrite(') < simpleUpdate.indexOf('productUpdateService.execute('),
      'scan: SimpleProductUpdateService resolves the window before the product write');

    const simpleCreate = read(writePaths[1]);
    assert(simpleCreate.indexOf('resolveBargainWrite(') < simpleCreate.indexOf('runInTransaction('),
      'scan: SimpleProductCreateService resolves the window before opening the transaction');

    // T5: the raw partial input must never reach the repository through the spread.
    assert(controller.includes('bargain: _rawBargain'),
      'scan: updateVariant destructures the raw bargain OUT of the spread (a partial $set would drop minPrice)');

    assert(read('modules/catalog/domain/services/VectorisationService.ts').includes('bargain:'),
      'scan: the vectoriser payload carries the window');

    /**
     * ⚠ **The scope guarantee changed on 2026-09-07, and the change is the point.**
     *
     * This block used to assert that cart, orders, earnings, COD and shipments
     * "must not know the field exists", on the grounds that bargainable pricing
     * was configuration only: a vendor could describe a window and nothing could
     * spend one. That is no longer true. BARGAINING-AGENT-PLAN Stream C+E built
     * the spending path — a negotiated price reaches the cart, is consumed at
     * order creation, and its floor drives the platform's AI margin in both
     * earnings splits.
     *
     * Deleting the assertion would have been wrong, because the load-bearing half
     * of it survives and is now MORE important than it was. What must never
     * happen is that any of these modules READS THE WINDOW — `variant.bargain`,
     * `minPrice`, `maxPrice`. The floor they work from is a snapshot taken when
     * the lock was honoured (`floor_price_snapshot`), and a live re-read would
     * compute a share of an uplift nobody agreed to, and could pay a vendor below
     * the floor they actually sold at. So the rule is narrowed rather than
     * dropped, and it is now a rule about CODE:
     *
     *   - cod / shipments: unchanged — not one mention, comments included. The
     *     bargaining path does not reach them at all, and if it ever does, this
     *     failing is the notification.
     *   - cart / orders / earnings: no window read in code. Comments are exempt,
     *     because the whole reason those modules are legible is that they explain
     *     which number they are using and why it is not the live one.
     */
    const stripComments = (text: string): string =>
      text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    const tsFilesIn = (mod: string): string[] => {
      const stack = [path.join(SRC, 'modules', mod)];
      const files: string[] = [];
      while (stack.length > 0) {
        const cur = stack.pop() as string;
        for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
          const full = path.join(cur, entry.name);
          if (entry.isDirectory()) stack.push(full);
          else if (entry.name.endsWith('.ts')) files.push(full);
        }
      }
      return files;
    };

    // Never reached by the bargaining path — the original rule, unchanged.
    for (const mod of ['cod', 'shipments']) {
      const hits = tsFilesIn(mod).filter((f) => fs.readFileSync(f, 'utf8').includes('bargain'));
      assert(hits.length === 0,
        `scan: modules/${mod} does not mention bargain at all (${hits.length} file(s) do)`);
    }

    // Spend a window, yes; read one, never.
    for (const mod of ['cart', 'orders', 'earnings']) {
      const hits = tsFilesIn(mod).filter((f) => {
        const code = stripComments(fs.readFileSync(f, 'utf8'));
        return /\bbargain\b/.test(code) || code.includes('minPrice') || code.includes('maxPrice');
      });
      assert(hits.length === 0,
        `scan: modules/${mod} never READS the bargain window in code — the floor is a `
        + `snapshot, not a live read (${hits.map((f) => path.basename(f)).join(', ')})`);
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}
