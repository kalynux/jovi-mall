/**
 * Test: shop delivery terms (ADR-A11, owner decisions D-1 · D-2 · D-6, 2026-10-03).
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no framework).
 * DB-free: the rules are pure, and the wiring is checked by SOURCE SCAN.
 *
 *   1. The default — a shop that never set terms is `always` (the shop pays).
 *   2. Reading stored terms — legacy, malformed and well-formed rows.
 *   3. resolveDeliveryPayer — every mode, the inclusive threshold, the shortfall.
 *   4. The PUT validator — `.strict()`, `freeAboveAmount` iff `above`, bounds.
 *   5. The public derivation — `freeDelivery` follows the shop, never a product flag.
 *   6. SOURCE SCANS — the product flag is gone, the routes and the batch read are wired.
 *
 * Run: npm run test:delivery-terms
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  DEFAULT_VENDOR_DELIVERY_TERMS,
  DeliveryPayerReason,
  FREE_ABOVE_AMOUNT_MAX,
  SetDeliveryTermsSchema,
  VENDOR_DELIVERY_TERMS_MODES,
  isAlwaysFreeDelivery,
  resolveDeliveryPayer,
  vendorDeliveryTermsOf,
} from '../../src/modules/vendors/domain/delivery-terms';

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

const ROOT = join(__dirname, '..', '..');
const SRC = join(ROOT, 'src');
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const parses = (v: unknown): boolean => SetDeliveryTermsSchema.safeParse(v).success;

// ═══ 1 · The default ═══════════════════════════════════════════════════════
console.log('\n── 1 · The default (D-2) ──────────────────────────────────────────────\n');

assert('the default is `always` with no threshold', () =>
  DEFAULT_VENDOR_DELIVERY_TERMS.mode === 'always' && DEFAULT_VENDOR_DELIVERY_TERMS.freeAboveAmount === null);
assert('null (never set) reads as the default', () => {
  const t = vendorDeliveryTermsOf(null);
  return t.mode === 'always' && t.freeAboveAmount === null;
});
assert('undefined reads as the default', () => vendorDeliveryTermsOf(undefined).mode === 'always');
assert('the default is a COPY — mutating a read cannot poison the next one', () => {
  const t = vendorDeliveryTermsOf(null);
  (t as { mode: string }).mode = 'never';
  return vendorDeliveryTermsOf(null).mode === 'always';
});
assert('a never-set shop pays delivery (vendor, shop_always)', () => {
  const v = resolveDeliveryPayer(vendorDeliveryTermsOf(null), 5000);
  return v.payer === 'vendor' && v.reason === 'shop_always' && v.freeDeliveryShortfall === null;
});

// ═══ 2 · Reading stored terms ══════════════════════════════════════════════
console.log('\n── 2 · Reading stored terms ───────────────────────────────────────────\n');

assert('{mode: never} reads as never, threshold dropped', () => {
  const t = vendorDeliveryTermsOf({ mode: 'never', free_above_amount: 9000 });
  return t.mode === 'never' && t.freeAboveAmount === null;
});
assert('{mode: above, 20000} reads as above 20000', () => {
  const t = vendorDeliveryTermsOf({ mode: 'above', free_above_amount: 20000 });
  return t.mode === 'above' && t.freeAboveAmount === 20000;
});
assert('{mode: always, stray threshold} drops the threshold', () =>
  vendorDeliveryTermsOf({ mode: 'always', free_above_amount: 5 }).freeAboveAmount === null);
assert('a malformed `above` with no threshold reads as the shop-pays default (never charges on a guess)', () =>
  vendorDeliveryTermsOf({ mode: 'above', free_above_amount: null }).mode === 'always');
assert('a malformed `above` with a 0 threshold reads as the default', () =>
  vendorDeliveryTermsOf({ mode: 'above', free_above_amount: 0 }).mode === 'always');
assert('an unknown mode reads as the default', () =>
  vendorDeliveryTermsOf({ mode: 'sometimes', free_above_amount: null }).mode === 'always');
assert('the mode list is exactly always · never · above', () =>
  JSON.stringify([...VENDOR_DELIVERY_TERMS_MODES]) === '["always","never","above"]');

// ═══ 3 · resolveDeliveryPayer ══════════════════════════════════════════════
console.log('\n── 3 · resolveDeliveryPayer ───────────────────────────────────────────\n');

const above = (n: number) => ({ mode: 'above' as const, freeAboveAmount: n });

assert('always → vendor / shop_always, whatever the subtotal', () =>
  [0, 1, 1_000_000].every((s) => {
    const v = resolveDeliveryPayer({ mode: 'always', freeAboveAmount: null }, s);
    return v.payer === 'vendor' && v.reason === 'shop_always' && v.freeDeliveryShortfall === null;
  }));
assert('never → customer / shop_never, whatever the subtotal', () =>
  [0, 1, 1_000_000].every((s) => {
    const v = resolveDeliveryPayer({ mode: 'never', freeAboveAmount: null }, s);
    return v.payer === 'customer' && v.reason === 'shop_never' && v.freeDeliveryShortfall === null;
  }));
assert('above, subtotal ABOVE the threshold → vendor / shop_threshold_met', () => {
  const v = resolveDeliveryPayer(above(20000), 25000);
  return v.payer === 'vendor' && v.reason === 'shop_threshold_met' && v.freeDeliveryShortfall === null;
});
assert('above, subtotal EQUAL to the threshold → FREE (the threshold is inclusive)', () => {
  const v = resolveDeliveryPayer(above(20000), 20000);
  return v.payer === 'vendor' && v.reason === 'shop_threshold_met';
});
assert('above, one franc short → customer / threshold_not_met, shortfall 1', () => {
  const v = resolveDeliveryPayer(above(20000), 19999);
  return v.payer === 'customer' && v.reason === 'threshold_not_met' && v.freeDeliveryShortfall === 1;
});
assert('above, shortfall = threshold − subtotal', () =>
  resolveDeliveryPayer(above(20000), 12500).freeDeliveryShortfall === 7500);
assert('above, empty subtotal → shortfall is the whole threshold', () =>
  resolveDeliveryPayer(above(20000), 0).freeDeliveryShortfall === 20000);
assert('above, a non-finite subtotal is treated as 0 (never as "met")', () => {
  const v = resolveDeliveryPayer(above(20000), Number.NaN);
  return v.payer === 'customer' && v.freeDeliveryShortfall === 20000;
});
assert('a hand-built `above` with a null threshold reads as shop-pays', () =>
  resolveDeliveryPayer({ mode: 'above', freeAboveAmount: null }, 0).payer === 'vendor');
assert('the reason union carries cap_fallback for checkout (D-6) — the resolver never emits it', () => {
  const fallback: DeliveryPayerReason = 'cap_fallback';
  const emitted = [
    resolveDeliveryPayer({ mode: 'always', freeAboveAmount: null }, 1).reason,
    resolveDeliveryPayer({ mode: 'never', freeAboveAmount: null }, 1).reason,
    resolveDeliveryPayer(above(5), 10).reason,
    resolveDeliveryPayer(above(5), 1).reason,
  ];
  return fallback === 'cap_fallback' && !emitted.includes('cap_fallback');
});

// ═══ 4 · The PUT validator ═════════════════════════════════════════════════
console.log('\n── 4 · PUT /api/vendor/profile/delivery-terms — the validator ─────────\n');

assert('{mode: always} passes', () => parses({ mode: 'always' }));
assert('{mode: never, freeAboveAmount: null} passes', () => parses({ mode: 'never', freeAboveAmount: null }));
assert('{mode: above, freeAboveAmount: 20000} passes', () => parses({ mode: 'above', freeAboveAmount: 20000 }));
assert('above WITHOUT freeAboveAmount is refused', () => !parses({ mode: 'above' }));
assert('above with freeAboveAmount: null is refused', () => !parses({ mode: 'above', freeAboveAmount: null }));
assert('above with 0 is refused (min 1)', () => !parses({ mode: 'above', freeAboveAmount: 0 }));
assert('above with a fraction is refused (integer XAF)', () => !parses({ mode: 'above', freeAboveAmount: 100.5 }));
assert('above with a negative is refused', () => !parses({ mode: 'above', freeAboveAmount: -1 }));
assert('above at the ceiling passes, one past it is refused', () =>
  parses({ mode: 'above', freeAboveAmount: FREE_ABOVE_AMOUNT_MAX })
  && !parses({ mode: 'above', freeAboveAmount: FREE_ABOVE_AMOUNT_MAX + 1 }));
assert('always WITH a threshold is refused (a stored lie about what the shop charges)', () =>
  !parses({ mode: 'always', freeAboveAmount: 5000 }));
assert('never WITH a threshold is refused', () => !parses({ mode: 'never', freeAboveAmount: 5000 }));
assert('an unknown mode is refused', () => !parses({ mode: 'sometimes' }));
assert('a missing mode is refused', () => !parses({ freeAboveAmount: 5000 }));
assert('an unknown key is refused (.strict())', () => !parses({ mode: 'always', freeDelivery: true }));
assert('snake_case is refused (.strict()) — the wire is camelCase', () =>
  !parses({ mode: 'above', free_above_amount: 5000 }));

// ═══ 5 · The public derivation ═════════════════════════════════════════════
console.log('\n── 5 · freeDelivery on the storefront is DERIVED from the shop ────────\n');

assert('always ⇒ freeDelivery true', () => isAlwaysFreeDelivery({ mode: 'always', freeAboveAmount: null }));
assert('never ⇒ freeDelivery false', () => !isAlwaysFreeDelivery({ mode: 'never', freeAboveAmount: null }));
assert('above ⇒ freeDelivery false (the badge would promise what the basket may not meet)', () =>
  !isAlwaysFreeDelivery(above(1)));

// ═══ 6 · Source scans ══════════════════════════════════════════════════════
console.log('\n── 6 · SOURCE SCANS ───────────────────────────────────────────────────\n');

const productModel = stripComments(read('modules/catalog/models/product.model.ts'));
assert('product.model.ts no longer declares free_delivery (interface or schema)', () =>
  !/free_delivery/.test(productModel));

const PRODUCT_FLAG_FILES = [
  'modules/catalog/domain/services/delivery-config.merge.ts',
  'modules/catalog/domain/services/ProductUpdateService.ts',
  'modules/catalog/domain/services/simple/SimpleProductCreateService.ts',
  'modules/catalog/domain/services/simple/SimpleProductUpdateService.ts',
  'modules/catalog/validators/product.validator.ts',
  'modules/catalog/validators/simple-product.validator.ts',
  'modules/catalog/repositories/mappers/product.mapper.ts',
  'modules/inventory/services/agency-stored-product.service.ts',
];
for (const rel of PRODUCT_FLAG_FILES) {
  assert(`${rel} reads/writes no product free-delivery flag`, () =>
    !/\bfree_delivery\b|\bfreeDelivery\b/.test(stripComments(read(rel))));
}
// The order side keeps legitimate per-ORDER vocabulary (`free_delivery_shortfall`,
// `freeDeliveryShortfall`, a quote's `freeDelivery {…}`), so it is scanned only for the
// removed per-ITEM snapshot and for reading the flag off a product's delivery block.
const ORDER_FILES = [
  'modules/orders/order.model.ts',
  'modules/orders/order.service.ts',
  'modules/orders/vendor-order.service.ts',
  'modules/orders/dto/customer-order.dto.ts',
];
for (const rel of ORDER_FILES) {
  assert(`${rel} carries no item free_delivery snapshot and reads no product flag`, () =>
    !/\bfree_delivery\b|delivery\??\.freeDelivery\b/.test(stripComments(read(rel))));
}

const publicRepo = stripComments(read('modules/catalog/repositories/mongo/public-catalog.repository.mongo.ts'));
assert('the public list pipeline no longer projects delivery.free_delivery', () =>
  !publicRepo.includes('delivery.free_delivery'));

const publicSvc = stripComments(read('modules/catalog/services/public-catalog.service.ts'));
assert('the public service derives freeDelivery from the terms, never from a row field', () =>
  publicSvc.includes('isAlwaysFreeDelivery(deliveryTerms)') && !publicSvc.includes('row.freeDelivery'));
assert('the card terms are BATCH-loaded per page (no N+1)', () =>
  (publicSvc.match(/findDeliveryTermsForVendors\(/g) ?? []).length === 2);

const publicDto = stripComments(read('modules/catalog/dto/public-product.dto.ts'));
assert('the detail DTO derives freeDelivery from input.deliveryTerms, not the product', () =>
  publicDto.includes('isAlwaysFreeDelivery(input.deliveryTerms)') && !publicDto.includes('product.delivery?.freeDelivery'));

const routes = stripComments(read('modules/vendor/routes.ts'));
assert('GET and PUT /profile/delivery-terms are mounted', () =>
  routes.includes("router.get('/profile/delivery-terms', VendorProfileController.getDeliveryTerms)")
  && routes.includes("router.put('/profile/delivery-terms', VendorProfileController.setDeliveryTerms)"));

const controller = stripComments(read('modules/vendor/controller/vendor-profile.controller.ts'));
assert('the PUT parses with SetDeliveryTermsSchema', () =>
  controller.includes('SetDeliveryTermsSchema.parse(req.body)'));

const repo = stripComments(read('modules/vendors/repositories/vendor-settings.repository.ts'));
assert('the write upserts with $setOnInsert, like cod_terms', () => {
  const start = repo.indexOf('async setDeliveryTerms(');
  const body = repo.slice(start, repo.indexOf('\n    }\n', start));
  return body.includes('$setOnInsert') && body.includes('upsert: true') && body.includes('runValidators: true');
});
assert('the reads never upsert (checkout and the storefront must not write a settings doc)', () => {
  const start = repo.indexOf('async findDeliveryTerms(');
  const end = repo.indexOf('async setDeliveryTerms(');
  return start > 0 && end > start && !repo.slice(start, end).includes('upsert');
});

const settingsModel = stripComments(read('modules/vendors/models/vendor-settings.model.ts'));
assert('delivery_terms lives on vendor_settings (NOT on Vendor.policies — editing must not pause connections)', () =>
  settingsModel.includes('delivery_terms:') && !/delivery_terms/.test(stripComments(read('modules/vendors/vendor.model.ts'))));

console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
