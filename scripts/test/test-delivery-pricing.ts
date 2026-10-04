/**
 * Test: the delivery-fee formula (ADR-A11) — `earnings/domain/delivery-pricing.ts`.
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no framework).
 * DB-free: everything under test is pure.
 *
 *   1. kgOf — whole kilograms, rounded up, never below 1.
 *   2. resolveItemWeightGrams — variant > shipping config > the D-4 default; 0 is "not set".
 *   3. shipmentWeightGrams — Σ grams × quantity.
 *   4. isOutOfRegion — canonical keys; unknown on either side ⇒ in-region.
 *   5. computeShipmentFee — pickup, storage, both, weight, region, the ceiling, malformed policy.
 *   6. deliveryFeeForPickupMix — the wrapper equals the old flat formula (1 kg, in-region).
 *   7. The agency policy fields — validator defaults/refusals, vendor DTO echo.
 *   8. Source scans — one definition of the arithmetic; the env knob is wired.
 *
 * Run: npm run test:delivery-pricing
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import {
  computeShipmentFee,
  isOutOfRegion,
  kgOf,
  maxFeeCeilingOf,
  resolveItemWeightGrams,
  shipmentWeightGrams,
  PickupMix,
} from '../../src/modules/earnings/domain/delivery-pricing';
import { deliveryFeeForPickupMix } from '../../src/modules/earnings/services/earnings-quote.service';
import { EARNINGS_CONFIG } from '../../src/modules/earnings/config/earnings.config';
import { IAgencyPolicies } from '../../src/modules/delivery/delivery-agency.model';
import { AgencyOnboardingStep4Schema } from '../../src/modules/delivery/validators/agency-onboarding.validator';
import { VendorAgencyMapper } from '../../src/modules/vendor/dto/vendor-agency.dto';

const originalConsole = { log: console.log.bind(console), error: console.error.bind(console) };

let passed = 0;
let failed = 0;

function assert(name: string, fn: () => boolean): void {
  let ok: boolean;
  try {
    ok = fn();
  } catch (err) {
    originalConsole.error(`  ❌ THROW: ${name} — ${(err as Error).message}`);
    failed++;
    return;
  }
  if (ok) {
    originalConsole.log(`  ✅ ${name}`);
    passed++;
  } else {
    originalConsole.error(`  ❌ FAIL: ${name}`);
    failed++;
  }
}

function section(title: string): void {
  originalConsole.log(`\n${title}`);
}

const SRC = join(__dirname, '../../src');
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** A complete policy with distinct numbers, so every component is identifiable in a sum. */
function policies(overrides: { max?: number | null } = {}): IAgencyPolicies {
  return {
    pricing: {
      storage_based: {
        enabled: true,
        monthly_storage_fee_per_sku: 9999, // must never appear in a per-shipment fee
        pick_pack_fee_per_order: 200,
        local_delivery_fee: 1000,
        out_of_region_delivery_fee: 2500,
      },
      pickup_based: {
        enabled: true,
        base_rate_first_kg: 1500,
        additional_per_kg: 300,
        out_of_region_surcharge: 700,
      },
      additional_fees: {
        cod_handling_fee: { type: 'fixed', value: 100 },
        failed_delivery_fee: 500,
        rto_fee: 400,
        peak_season_surcharge: 8888, // must never appear either
      },
      max_fee_per_shipment: overrides.max === undefined ? null : overrides.max,
      accepts_cash_delivery_fee: false,
      notes: null,
    },
    returns: { payer: 'vendor', handling_fee: 0, return_window_days: 7, notes: null },
    damage: { claim_deadline_days: 7, max_refund_per_item: 0, notes: null },
    cod: { enabled: false, max_order_amount: null },
  };
}

const PICKUP: PickupMix = { hasPickupBased: true, hasStorageBased: false };
const STORAGE: PickupMix = { hasPickupBased: false, hasStorageBased: true };
const BOTH: PickupMix = { hasPickupBased: true, hasStorageBased: true };
const NONE: PickupMix = { hasPickupBased: false, hasStorageBased: false };

function main(): void {
  section('1. kgOf');
  assert('0 g ⇒ 1 kg', () => kgOf(0) === 1);
  assert('1 g ⇒ 1 kg', () => kgOf(1) === 1);
  assert('1000 g ⇒ 1 kg', () => kgOf(1000) === 1);
  assert('1001 g ⇒ 2 kg', () => kgOf(1001) === 2);
  assert('2000 g ⇒ 2 kg; 2001 g ⇒ 3 kg', () => kgOf(2000) === 2 && kgOf(2001) === 3);
  assert('negative / NaN / Infinity ⇒ 1 kg', () => kgOf(-5) === 1 && kgOf(NaN) === 1 && kgOf(Infinity) === 1);

  section('2. resolveItemWeightGrams');
  assert('variant weight wins', () => {
    const r = resolveItemWeightGrams({ variantWeight: 250, shippingConfigWeight: 900 }, 1000);
    return r.grams === 250 && r.source === 'variant';
  });
  assert('variant 0 ⇒ shipping config', () => {
    const r = resolveItemWeightGrams({ variantWeight: 0, shippingConfigWeight: 900 }, 1000);
    return r.grams === 900 && r.source === 'shipping_config';
  });
  assert('variant null/undefined ⇒ shipping config', () =>
    resolveItemWeightGrams({ variantWeight: null, shippingConfigWeight: 900 }, 1000).source === 'shipping_config' &&
    resolveItemWeightGrams({ shippingConfigWeight: 900 }, 1000).source === 'shipping_config');
  assert('neither set ⇒ the default, flagged as a fallback', () => {
    const r = resolveItemWeightGrams({ variantWeight: 0, shippingConfigWeight: 0 }, 750);
    return r.grams === 750 && r.source === 'default';
  });
  assert('negative / NaN weights are "not set"', () => {
    const r = resolveItemWeightGrams({ variantWeight: -3, shippingConfigWeight: NaN }, 1000);
    return r.grams === 1000 && r.source === 'default';
  });
  assert('default param is DELIVERY_DEFAULT_ITEM_WEIGHT_GRAMS', () =>
    resolveItemWeightGrams({}).grams === EARNINGS_CONFIG.DELIVERY_DEFAULT_ITEM_WEIGHT_GRAMS);
  assert('DELIVERY_DEFAULT_ITEM_WEIGHT_GRAMS defaults to 1000 (unset env)', () =>
    process.env.DELIVERY_DEFAULT_ITEM_WEIGHT_GRAMS !== undefined || EARNINGS_CONFIG.DELIVERY_DEFAULT_ITEM_WEIGHT_GRAMS === 1000);

  section('3. shipmentWeightGrams');
  assert('Σ grams × quantity', () =>
    shipmentWeightGrams([{ grams: 400, quantity: 3 }, { grams: 1000, quantity: 1 }]) === 2200);
  assert('empty ⇒ 0; garbage lines contribute nothing', () =>
    shipmentWeightGrams([]) === 0 && shipmentWeightGrams([{ grams: NaN, quantity: 2 }, { grams: 500, quantity: -1 }]) === 0);
  assert('D-4: three weightless units at the 1000 g default ⇒ 3 kg', () => {
    const unit = resolveItemWeightGrams({}, 1000).grams;
    return kgOf(shipmentWeightGrams([{ grams: unit, quantity: 3 }])) === 3;
  });

  section('4. isOutOfRegion');
  assert('same key ⇒ in region', () => isOutOfRegion('centre', 'centre') === false);
  assert('different regions ⇒ out of region', () => isOutOfRegion('littoral', 'centre') === true);
  assert('case + filler words fold ("Centre Region" vs "centre")', () => isOutOfRegion('Centre Region', 'centre') === false);
  assert('localized names fold ("Extrême-Nord" vs "Far North")', () => isOutOfRegion('Extrême-Nord', 'Far North') === false);
  assert('unknown delivery region ⇒ in region', () =>
    isOutOfRegion(null, 'centre') === false && isOutOfRegion(undefined, 'centre') === false && isOutOfRegion('', 'centre') === false);
  assert('unknown pickup region ⇒ in region', () => isOutOfRegion('littoral', null) === false && isOutOfRegion('littoral', '  ') === false);

  section('5. computeShipmentFee');
  const p = policies();
  assert('pickup, 1 kg, in region ⇒ base rate', () => computeShipmentFee(p, { mix: PICKUP, totalWeightGrams: 800, outOfRegion: false }).fee === 1500);
  assert('pickup, 3 kg ⇒ base + 2 × per-kg', () => {
    const r = computeShipmentFee(p, { mix: PICKUP, totalWeightGrams: 2500, outOfRegion: false });
    return r.fee === 1500 + 2 * 300 && r.components.kg === 3 && r.components.weightExtra === 600;
  });
  assert('pickup, out of region ⇒ + surcharge', () => {
    const r = computeShipmentFee(p, { mix: PICKUP, totalWeightGrams: 0, outOfRegion: true });
    return r.fee === 1500 + 700 && r.components.regionSurcharge === 700;
  });
  assert('storage, in region ⇒ local + pick&pack (weight ignored)', () => {
    const r = computeShipmentFee(p, { mix: STORAGE, totalWeightGrams: 9000, outOfRegion: false });
    return r.fee === 1000 + 200 && r.components.storage === 1200 && r.components.weightExtra === 0;
  });
  assert('storage, out of region ⇒ out-of-region fee + pick&pack (replaces local)', () =>
    computeShipmentFee(p, { mix: STORAGE, totalWeightGrams: 0, outOfRegion: true }).fee === 2500 + 200);
  assert('both mixes, 2 kg, out of region ⇒ both parts', () =>
    computeShipmentFee(p, { mix: BOTH, totalWeightGrams: 1500, outOfRegion: true }).fee ===
      (1500 + 300 + 700) + (2500 + 200));
  assert('no classified item ⇒ 0', () => computeShipmentFee(p, { mix: NONE, totalWeightGrams: 5000, outOfRegion: true }).fee === 0);
  assert('components sum to the uncapped fee', () => {
    const c = computeShipmentFee(p, { mix: BOTH, totalWeightGrams: 4200, outOfRegion: true }).components;
    const r = computeShipmentFee(p, { mix: BOTH, totalWeightGrams: 4200, outOfRegion: true });
    return c.pickupBase + c.weightExtra + c.regionSurcharge + c.storage === r.fee && !c.capApplied;
  });
  assert('peak-season and monthly storage never enter the fee', () => {
    const r = computeShipmentFee(p, { mix: BOTH, totalWeightGrams: 0, outOfRegion: false });
    return r.fee === 1500 + 1200;
  });
  assert('ceiling lowers the fee and is reported', () => {
    const r = computeShipmentFee(policies({ max: 2000 }), { mix: PICKUP, totalWeightGrams: 5000, outOfRegion: true });
    return r.fee === 2000 && r.components.capApplied === true;
  });
  assert('ceiling above the fee changes nothing', () => {
    const r = computeShipmentFee(policies({ max: 50_000 }), { mix: PICKUP, totalWeightGrams: 0, outOfRegion: false });
    return r.fee === 1500 && r.components.capApplied === false;
  });
  assert('ceiling exactly equal ⇒ not "applied"', () => {
    const r = computeShipmentFee(policies({ max: 1500 }), { mix: PICKUP, totalWeightGrams: 0, outOfRegion: false });
    return r.fee === 1500 && r.components.capApplied === false;
  });
  assert('null / 0 / NaN ceiling ⇒ no ceiling', () =>
    maxFeeCeilingOf(policies({ max: null })) === null &&
    maxFeeCeilingOf(policies({ max: 0 })) === null &&
    maxFeeCeilingOf(policies({ max: NaN })) === null &&
    computeShipmentFee(policies({ max: 0 }), { mix: PICKUP, totalWeightGrams: 0, outOfRegion: false }).fee === 1500);
  assert('legacy policy without the new fields ⇒ no ceiling', () => {
    const legacy = policies();
    delete (legacy.pricing as any).max_fee_per_shipment;
    delete (legacy.pricing as any).accepts_cash_delivery_fee;
    return computeShipmentFee(legacy, { mix: PICKUP, totalWeightGrams: 3000, outOfRegion: false }).fee === 2100;
  });
  assert('missing / NaN / negative policy numbers read as 0 (no NaN, never negative)', () => {
    const broken = policies();
    (broken.pricing.pickup_based as any).base_rate_first_kg = undefined;
    (broken.pricing.pickup_based as any).additional_per_kg = NaN;
    (broken.pricing.storage_based as any).local_delivery_fee = -400;
    delete (broken.pricing as any).storage_based.pick_pack_fee_per_order;
    const r = computeShipmentFee(broken, { mix: BOTH, totalWeightGrams: 5000, outOfRegion: false });
    return r.fee === 0 && Number.isInteger(r.fee);
  });
  assert('a policy with no storage_based block prices a pickup shipment', () => {
    const partial = { pricing: { pickup_based: { base_rate_first_kg: 1500, additional_per_kg: 300 } } } as any;
    return computeShipmentFee(partial, { mix: PICKUP, totalWeightGrams: 2000, outOfRegion: false }).fee === 1800;
  });
  assert('fractional policy amounts are rounded to integers', () => {
    const frac = policies();
    frac.pricing.pickup_based.base_rate_first_kg = 1500.6;
    return computeShipmentFee(frac, { mix: PICKUP, totalWeightGrams: 0, outOfRegion: false }).fee === 1501;
  });

  section('6. deliveryFeeForPickupMix — the 1 kg, in-region wrapper');
  /** The pre-ADR-A11 flat formula, verbatim, as the equivalence oracle. */
  const oldFlat = (pol: IAgencyPolicies, mix: PickupMix): number => {
    let fee = 0;
    if (mix.hasPickupBased) fee += pol.pricing.pickup_based.base_rate_first_kg;
    if (mix.hasStorageBased) fee += pol.pricing.storage_based.local_delivery_fee + pol.pricing.storage_based.pick_pack_fee_per_order;
    return fee;
  };
  for (const [label, mix] of [['pickup', PICKUP], ['storage', STORAGE], ['both', BOTH], ['none', NONE]] as const) {
    assert(`wrapper == old flat formula (${label})`, () => deliveryFeeForPickupMix(p, mix) === oldFlat(p, mix));
    assert(`wrapper == computeShipmentFee at 1 kg in-region (${label})`, () =>
      deliveryFeeForPickupMix(p, mix) === computeShipmentFee(p, { mix, totalWeightGrams: 1000, outOfRegion: false }).fee);
  }
  assert('wrapper honours the ceiling', () => deliveryFeeForPickupMix(policies({ max: 1000 }), BOTH) === 1000);

  section('7. Agency policy fields — validator + vendor DTO');
  const body = (pricingExtra: Record<string, unknown>) => ({
    policies: {
      pricing: { ...policies().pricing, max_fee_per_shipment: undefined, accepts_cash_delivery_fee: undefined, notes: undefined, ...pricingExtra },
      returns: { payer: 'vendor', handling_fee: 0, return_window_days: 7 },
      damage: { claim_deadline_days: 7, max_refund_per_item: 0 },
    },
  });
  assert('omitted ⇒ max_fee_per_shipment null, accepts_cash_delivery_fee false', () => {
    const r = AgencyOnboardingStep4Schema.safeParse(body({}));
    return r.success && r.data.policies.pricing.max_fee_per_shipment === null && r.data.policies.pricing.accepts_cash_delivery_fee === false;
  });
  assert('a positive integer ceiling + true are accepted', () => {
    const r = AgencyOnboardingStep4Schema.safeParse(body({ max_fee_per_shipment: 6000, accepts_cash_delivery_fee: true }));
    return r.success && r.data.policies.pricing.max_fee_per_shipment === 6000 && r.data.policies.pricing.accepts_cash_delivery_fee === true;
  });
  assert('explicit null ceiling is accepted', () => AgencyOnboardingStep4Schema.safeParse(body({ max_fee_per_shipment: null })).success);
  assert('ceiling 0 / negative / fractional are refused', () =>
    !AgencyOnboardingStep4Schema.safeParse(body({ max_fee_per_shipment: 0 })).success &&
    !AgencyOnboardingStep4Schema.safeParse(body({ max_fee_per_shipment: -1 })).success &&
    !AgencyOnboardingStep4Schema.safeParse(body({ max_fee_per_shipment: 10.5 })).success);
  assert('non-boolean accepts_cash_delivery_fee is refused', () =>
    !AgencyOnboardingStep4Schema.safeParse(body({ accepts_cash_delivery_fee: 'yes' })).success);
  assert('vendor DTO echoes both fields', () => {
    const dto = VendorAgencyMapper.toPolicySummary(policies({ max: 6000 }));
    return dto.pricing.max_fee_per_shipment === 6000 && dto.pricing.accepts_cash_delivery_fee === false;
  });
  assert('vendor DTO on a legacy row ⇒ null + false', () => {
    const legacy = policies();
    delete (legacy.pricing as any).max_fee_per_shipment;
    delete (legacy.pricing as any).accepts_cash_delivery_fee;
    const dto = VendorAgencyMapper.toPolicySummary(legacy);
    return dto.pricing.max_fee_per_shipment === null && dto.pricing.accepts_cash_delivery_fee === false;
  });
  assert('agency profile DTO normalises both fields', () => {
    const src = stripComments(read('modules/delivery/dto/agency-profile.dto.ts'));
    return src.includes('policies: withPricingDefaults(agency.policies)') &&
      /max_fee_per_shipment:\s*plain\.pricing\.max_fee_per_shipment \?\? null/.test(src) &&
      /accepts_cash_delivery_fee:\s*plain\.pricing\.accepts_cash_delivery_fee \?\? false/.test(src);
  });
  assert('model declares both fields with their defaults', () => {
    const src = stripComments(read('modules/delivery/delivery-agency.model.ts'));
    return /max_fee_per_shipment:\s*\{\s*type:\s*Number,\s*default:\s*null/.test(src) &&
      /accepts_cash_delivery_fee:\s*\{\s*type:\s*Boolean,\s*default:\s*false/.test(src);
  });

  section('8. Source scans — one definition');
  const FORMULA = 'modules/earnings/domain/delivery-pricing.ts';
  // Files allowed to NAME the per-shipment pricing fields: the schema, the validator, the two
  // DTOs that echo them, and the formula. Anything else naming them is a second copy of the
  // arithmetic (or about to become one).
  const ALLOWED = new Set([
    FORMULA,
    'modules/delivery/delivery-agency.model.ts',
    'modules/delivery/validators/agency-onboarding.validator.ts',
    'modules/delivery/dto/agency-profile.dto.ts',
    'modules/vendor/dto/vendor-agency.dto.ts',
  ]);
  const FIELDS = /\b(additional_per_kg|base_rate_first_kg|out_of_region_surcharge|out_of_region_delivery_fee|local_delivery_fee|pick_pack_fee_per_order|max_fee_per_shipment)\b/;
  const offenders = walk(SRC)
    .map((f) => relative(SRC, f).replace(/\\/g, '/'))
    .filter((rel) => !ALLOWED.has(rel) && FIELDS.test(stripComments(read(rel))));
  assert(`no file outside the formula reads the per-shipment pricing fields${offenders.length ? ` (${offenders.join(', ')})` : ''}`,
    () => offenders.length === 0);
  assert('additional_per_kg arithmetic exists exactly once, in the formula', () => {
    const hits = walk(SRC)
      .map((f) => relative(SRC, f).replace(/\\/g, '/'))
      .filter((rel) => /additional_per_kg[^\n]*\*|\*[^\n]*additional_per_kg/.test(stripComments(read(rel))));
    return hits.length === 1 && hits[0] === FORMULA;
  });
  const quoteSrc = stripComments(read('modules/earnings/services/earnings-quote.service.ts'));
  assert('deliveryFeeForPickupMix delegates to computeShipmentFee', () =>
    /deliveryFeeForPickupMix\([^)]*\)\s*:\s*number\s*\{\s*return computeShipmentFee\(policies,\s*\{\s*mix,\s*totalWeightGrams:\s*0,\s*outOfRegion:\s*false\s*\}\)\.fee;\s*\}/.test(quoteSrc));
  assert('the resolved TODOs are gone (additional_per_kg / out_of_region / free_delivery)', () => {
    const raw = read('modules/earnings/services/earnings-quote.service.ts');
    return !/TODO\(earnings\):\s*(additional_per_kg|out_of_region|free_delivery)/.test(raw);
  });
  assert('PickupMix is declared in the domain file and only re-exported by the service', () =>
    /export interface PickupMix/.test(read(FORMULA)) && !/export interface PickupMix/.test(quoteSrc));
  assert('the domain file imports nothing from services/ (no cycle)', () => !/from '\.\.\/services\//.test(read(FORMULA)));
  assert('.env.example documents DELIVERY_DEFAULT_ITEM_WEIGHT_GRAMS', () =>
    readFileSync(join(__dirname, '../../.env.example'), 'utf8').includes('DELIVERY_DEFAULT_ITEM_WEIGHT_GRAMS=1000'));

  originalConsole.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main();
