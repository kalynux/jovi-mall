/**
 * Test: the delivery-cost cap at checkout (ADR-A07).
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no
 * framework). DB-free: the arithmetic is a pure module, and the service is driven
 * against fake agency / entitlement repositories.
 *
 *   1. The rule on the owner's own example (500 basket, 1 000 fee).
 *   2. Commission is NOT in the ratio — and `vendorNet > 0` still catches it.
 *   3. COD handling fee, fixed and percentage; the unsatisfiable cases.
 *   4. `minimumSubtotal` SWEPT: the value passes and the value below it fails.
 *   5. The unit: online = one per order, COD = one per shipment.
 *   6. The refusal: code, status, category, bot copy, and what `details` withholds.
 *   7. Source scans for the wiring nothing behavioural here can see.
 *
 * Run: npm run test:delivery-cost-cap
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  evaluateDeliveryCostCap,
  minimumSubtotalFor,
  resolveMaxDeliveryPercent,
} from '../../src/modules/earnings/services/delivery-cost-cap';
import { EARNINGS_CONFIG } from '../../src/modules/earnings/config/earnings.config';
import {
  DeliveryCostCapService,
  DeliveryCapVendorInput,
} from '../../src/modules/orders/services/delivery-cost-cap.service';
import { ERROR_CODES } from '../../src/core/error-codes';
import { AppError, DEFAULT_ERROR_MESSAGES } from '../../src/core/errors';
import { categoryFor, ERROR_CATEGORIES } from '../../src/core/error-category';
import { customerMessageFor, BOT_COPY_LANGUAGES } from '../../src/modules/bot-surface/domain/bot-error-copy';

// The console bridge swallows a harness's own output once logging initialises;
// every sibling suite captures the originals for the same reason.
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

async function assertAsync(name: string, fn: () => Promise<boolean>): Promise<void> {
  let ok: boolean;
  try {
    ok = await fn();
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
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** The body of `name` in `src`, from its declaration to the next sibling at the same indent. */
function spanOf(src: string, startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker);
  if (start < 0) throw new Error(`span start not found: ${startMarker}`);
  const end = src.indexOf(endMarker, start + startMarker.length);
  if (end < 0) throw new Error(`span end not found: ${endMarker}`);
  return src.slice(start, end);
}

// ─── Fakes ───────────────────────────────────────────────────────────────────

/** An agency policy whose vendor-pickup delivery costs `fee`, with an optional COD fee. */
function policies(fee: number, cod: { type: 'percentage' | 'fixed'; value: number } | null = null): any {
  return {
    pricing: {
      pickup_based: { base_rate_first_kg: fee, additional_per_kg: 0, out_of_region_surcharge: 0 },
      storage_based: { local_delivery_fee: 0, pick_pack_fee_per_order: 0, out_of_region_delivery_fee: 0, monthly_storage_fee_per_sku: 0 },
      additional_fees: {
        cod_handling_fee: cod ?? { type: 'fixed', value: 0 },
        failed_delivery_fee: 0,
        rto_fee: 0,
      },
    },
  };
}

function serviceWith(agencies: Record<string, any>, commissionPercent: number): DeliveryCostCapService {
  const agencyRepo: any = {
    findByIds: async (ids: string[]) => ids.filter((id) => agencies[id]).map((id) => ({ _id: id, policies: agencies[id] })),
  };
  const entitlements: any = { getEntitlements: async () => ({ commissionPercent }) };
  return new DeliveryCostCapService(agencyRepo, entitlements);
}

const PICKUP = { hasPickupBased: true, hasStorageBased: false };
const A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbbbbbbbbbb';

function vendorInput(groups: Array<{ agencyId: string; subtotal: number }>): DeliveryCapVendorInput {
  const built = groups.map((g) => ({ agencyId: g.agencyId, mix: PICKUP, lines: [{ unitPrice: g.subtotal, quantity: 1 }] }));
  return { vendorId: 'vendor-1', lines: built.flatMap((g) => g.lines), groups: built };
}

async function main(): Promise<void> {
  originalConsole.log('🧪 delivery-cost cap (ADR-A07)');

  section('1. The rule, on the owner\'s example');

  const example = evaluateDeliveryCostCap({ subtotal: 500, commissionPercent: 10, deliveryFee: 1000, maxDeliveryPercent: 30 });
  assert('500 basket, 1 000 fee → refused on the ratio', () => !example.met && example.failure === 'delivery_cost_ratio');
  assert('its minimum is ceil(1000 × 100 / 30) = 3 334', () => example.minimumSubtotal === 3334);
  assert('its shortfall is 3 334 − 500 = 2 834', () => example.shortfall === 2834);
  assert('3 334 passes', () => evaluateDeliveryCostCap({ subtotal: 3334, commissionPercent: 10, deliveryFee: 1000, maxDeliveryPercent: 30 }).met);
  assert('3 333 fails (1 000 × 100 > 30 × 3 333)', () => !evaluateDeliveryCostCap({ subtotal: 3333, commissionPercent: 10, deliveryFee: 1000, maxDeliveryPercent: 30 }).met);
  assert('a met verdict has shortfall 0', () => evaluateDeliveryCostCap({ subtotal: 10_000, commissionPercent: 10, deliveryFee: 1000, maxDeliveryPercent: 30 }).shortfall === 0);
  assert('no delivery fee → any basket passes the ratio', () => evaluateDeliveryCostCap({ subtotal: 1, commissionPercent: 0, deliveryFee: 0, maxDeliveryPercent: 30 }).met);
  assert('the default cap is EARNINGS_CONFIG.MAX_DELIVERY_COST_PERCENT (30 unless configured)', () =>
    evaluateDeliveryCostCap({ subtotal: 500, commissionPercent: 0, deliveryFee: 1000 }).maxDeliveryPercent === EARNINGS_CONFIG.MAX_DELIVERY_COST_PERCENT);

  section('2. Commission is outside the ratio; vendorNet > 0 is the backstop');

  assert('50% commission does not move the minimum (the variant, not the owner\'s first rule)', () =>
    minimumSubtotalFor({ commissionPercent: 50, deliveryFee: 1000, codHandling: null, maxDeliveryPercent: 30 })
      === minimumSubtotalFor({ commissionPercent: 0, deliveryFee: 1000, codHandling: null, maxDeliveryPercent: 30 }));
  assert('a 30% plan can still sell (the rule-as-written would block every sale)', () =>
    evaluateDeliveryCostCap({ subtotal: 10_000, commissionPercent: 30, deliveryFee: 1000, maxDeliveryPercent: 30 }).met);
  assert('80% commission, 5 000 basket → net exactly 0 → refused on vendor_net_not_positive', () => {
    const v = evaluateDeliveryCostCap({ subtotal: 5000, commissionPercent: 80, deliveryFee: 1000, maxDeliveryPercent: 30 });
    return !v.met && v.failure === 'vendor_net_not_positive' && v.vendorNet === 0;
  });
  assert('the AI margin is counted in the net: 75% plan, 5 000 basket passes at margin 0 …', () =>
    evaluateDeliveryCostCap({ subtotal: 5000, aiMargin: 0, commissionPercent: 75, deliveryFee: 1000, maxDeliveryPercent: 30 }).met);
  assert('… and fails at margin 1 000 (net 0)', () => {
    const v = evaluateDeliveryCostCap({ subtotal: 5000, aiMargin: 1000, commissionPercent: 75, deliveryFee: 1000, maxDeliveryPercent: 30 });
    return !v.met && v.failure === 'vendor_net_not_positive';
  });
  assert('100% commission → no subtotal can pass → minimumSubtotal null, shortfall 0', () => {
    const v = evaluateDeliveryCostCap({ subtotal: 5000, commissionPercent: 100, deliveryFee: 1000, maxDeliveryPercent: 30 });
    return !v.met && v.minimumSubtotal === null && v.shortfall === 0;
  });

  section('3. COD handling fee');

  assert('fixed 200 → delivery cost 1 200 → minimum ceil(1200 × 100 / 30) = 4 000', () =>
    minimumSubtotalFor({ commissionPercent: 10, deliveryFee: 1000, codHandling: { type: 'fixed', value: 200 }, maxDeliveryPercent: 30 }) === 4000);
  // The algebra says 1000 × 100 / (30 − 5) = 4 000, but the COD fee is FLOORED (as the split
  // charges it): at 3 997 it is floor(199.85) = 199, and 1 199 × 100 ≤ 30 × 3 997. The closed
  // form is only the starting point; the walk lands on the value `check` actually accepts.
  assert('percentage 5% → 3 997, not the closed-form 4 000 (the COD fee is floored)', () =>
    minimumSubtotalFor({ commissionPercent: 10, deliveryFee: 1000, codHandling: { type: 'percentage', value: 5 }, maxDeliveryPercent: 30 }) === 3997);
  assert('the COD fee is the split\'s: floor(subtotal × % / 100)', () =>
    evaluateDeliveryCostCap({ subtotal: 4999, commissionPercent: 0, deliveryFee: 1000, codHandling: { type: 'percentage', value: 5 }, maxDeliveryPercent: 30 }).codFee === 249);
  assert('a COD percentage AT the cap → unsatisfiable → null', () =>
    minimumSubtotalFor({ commissionPercent: 0, deliveryFee: 1000, codHandling: { type: 'percentage', value: 30 }, maxDeliveryPercent: 30 }) === null);

  section('4. minimumSubtotal, swept');

  let sweepOk = true;
  let sweepCases = 0;
  const failures: string[] = [];
  for (const fee of [0, 1, 250, 999, 1000, 1500, 3750]) {
    for (const commissionPercent of [0, 5, 12, 30, 55, 69]) {
      for (const cod of [null, { type: 'fixed' as const, value: 150 }, { type: 'percentage' as const, value: 3 }, { type: 'percentage' as const, value: 7 }]) {
        for (const maxDeliveryPercent of [10, 30, 45, 100]) {
          const terms = { commissionPercent, deliveryFee: fee, codHandling: cod, maxDeliveryPercent };
          const m = minimumSubtotalFor(terms);
          sweepCases++;
          if (m === null) continue;
          const at = evaluateDeliveryCostCap({ ...terms, subtotal: m });
          const below = m > 1 ? evaluateDeliveryCostCap({ ...terms, subtotal: m - 1 }) : null;
          if (!at.met || (below && below.met)) {
            sweepOk = false;
            if (failures.length < 5) failures.push(JSON.stringify({ ...terms, m }));
          }
        }
      }
    }
  }
  assert(`over ${sweepCases} term sets: the minimum passes and the franc below it fails`, () => {
    if (!sweepOk) originalConsole.error('     e.g. ' + failures.join('\n          '));
    return sweepOk;
  });
  assert('the cap is clamped to [1, 100]', () =>
    resolveMaxDeliveryPercent(0) === 1 && resolveMaxDeliveryPercent(500) === 100 && resolveMaxDeliveryPercent(30) === 30);

  section('5. The unit is the split\'s unit');

  const agencies = { [A]: policies(1000), [B]: policies(1000, { type: 'fixed', value: 300 }) };
  const service = serviceWith(agencies, 10);

  await assertAsync('online, two shipments of 1 000 on a 5 000 order → 2 000 > 1 500 → refused, ONE unit, agencyId null', async () => {
    const v = await service.assessVendor(vendorInput([{ agencyId: A, subtotal: 2500 }, { agencyId: B, subtotal: 2500 }]), 'online');
    return !v.met && v.scope === 'order' && v.units.length === 1 && v.units[0].agencyId === null
      && v.units[0].subtotal === 5000 && v.units[0].minimumSubtotal === 6667;
  });
  await assertAsync('online ignores the COD fee (none is charged on a prepaid delivery)', async () => {
    const v = await service.assessVendor(vendorInput([{ agencyId: B, subtotal: 3334 }]), 'online');
    return v.met;
  });
  await assertAsync('COD: checked per shipment — a 4 500 shipment passes, a 500 one fails', async () => {
    const v = await service.assessVendor(vendorInput([{ agencyId: A, subtotal: 4500 }, { agencyId: B, subtotal: 500 }]), 'cash_on_delivery');
    const [a, b] = v.units;
    return !v.met && v.scope === 'shipment' && v.units.length === 2
      && a.agencyId === A && a.met && b.agencyId === B && !b.met;
  });
  await assertAsync('COD applies THAT agency\'s handling fee: B (1 000 + 300) needs 4 334', async () => {
    const v = await service.assessVendor(vendorInput([{ agencyId: B, subtotal: 500 }]), 'cash_on_delivery');
    return v.units[0].minimumSubtotal === 4334 && v.shortfall === 3834;
  });
  await assertAsync('COD on a big ORDER still fails a small SHIPMENT (the per-order sum would have passed)', async () => {
    const input = vendorInput([{ agencyId: A, subtotal: 20_000 }, { agencyId: B, subtotal: 500 }]);
    const online = await service.assessVendor(input, 'online');
    const cod = await service.assessVendor(input, 'cash_on_delivery');
    return online.met && !cod.met;
  });
  await assertAsync('an agency with no policy costs EARNINGS_CONFIG.DELIVERY_FLAT_FEE, like the split', async () => {
    const v = await serviceWith({}, 0).assessVendor(vendorInput([{ agencyId: A, subtotal: 100 }]), 'online');
    return EARNINGS_CONFIG.DELIVERY_FLAT_FEE === 0 ? v.met : true;
  });
  await assertAsync('a negotiated line\'s AI margin reaches the net (floor 3 000, price 5 000 on a 75% plan)', async () => {
    const svc = serviceWith({ [A]: policies(1000) }, 75);
    const plain: DeliveryCapVendorInput = {
      vendorId: 'v', lines: [{ unitPrice: 5000, quantity: 1 }],
      groups: [{ agencyId: A, mix: PICKUP, lines: [{ unitPrice: 5000, quantity: 1 }] }],
    };
    const haggled: DeliveryCapVendorInput = {
      vendorId: 'v', lines: [{ unitPrice: 5000, quantity: 1, floorPrice: 1000 }],
      groups: [{ agencyId: A, mix: PICKUP, lines: [{ unitPrice: 5000, quantity: 1, floorPrice: 1000 }] }],
    };
    // uplift 4 000 → margin floor(0.30 × 4000) = 1 200 (at the default 30%) → net < 0.
    return (await svc.assessVendor(plain, 'online')).met
      && (EARNINGS_CONFIG.AI_MARGIN_PERCENT < 20 || !(await svc.assessVendor(haggled, 'online')).met);
  });

  section('6. The refusal');

  let thrown: unknown = null;
  try {
    await service.assertVendor(vendorInput([{ agencyId: A, subtotal: 500 }]), 'online', 'XAF', { spent: false });
  } catch (e) {
    thrown = e;
  }
  const err = thrown as AppError;
  assert('assertVendor throws ORDER_BELOW_DELIVERY_MINIMUM 422', () =>
    err instanceof AppError && err.code === ERROR_CODES.ORDER_BELOW_DELIVERY_MINIMUM && err.statusCode === 422);
  assert('… categorised business_rule (422 → client-safe, details survive the boundary)', () =>
    categoryFor(ERROR_CODES.ORDER_BELOW_DELIVERY_MINIMUM, 422) === ERROR_CATEGORIES.BUSINESS_RULE);
  assert('details carry what the customer can act on', () => {
    const d = (err as any).details ?? {};
    return d.vendorId === 'vendor-1' && d.scope === 'order' && d.subtotal === 500 && d.minimumSubtotal === 3334
      && d.shortfall === 2834 && d.maxDeliveryPercent === 30 && d.reason === 'delivery_cost_ratio' && d.currency === 'XAF';
  });
  assert('details carry the caller\'s protocol fields (spent: false)', () => (err as any).details?.spent === false);
  assert('details NEVER carry the vendor\'s business terms (commission, net, fee)', () => {
    const keys = Object.keys((err as any).details ?? {}).join(',').toLowerCase();
    return !/commission|net|fee|deliverycost/.test(keys);
  });
  await assertAsync('a met vendor does not throw', async () => {
    await service.assertVendor(vendorInput([{ agencyId: A, subtotal: 50_000 }]), 'online', 'XAF');
    return true;
  });
  assert('a default message is registered', () => typeof DEFAULT_ERROR_MESSAGES[ERROR_CODES.ORDER_BELOW_DELIVERY_MINIMUM] === 'string');
  assert('bot copy is specific (not the category fallback) in all five languages', () => {
    const fallback = customerMessageFor('SOME_UNLISTED_CODE_XYZ', ERROR_CATEGORIES.BUSINESS_RULE, 'en');
    return BOT_COPY_LANGUAGES.every((lang) => {
      const text = customerMessageFor(ERROR_CODES.ORDER_BELOW_DELIVERY_MINIMUM, ERROR_CATEGORIES.BUSINESS_RULE, lang);
      return text.length > 0 && text !== customerMessageFor('SOME_UNLISTED_CODE_XYZ', ERROR_CATEGORIES.BUSINESS_RULE, lang)
        && (lang !== 'en' || text !== fallback);
    });
  });

  section('7. Wiring (source scans)');

  const orderSrc = stripComments(read('modules/orders/order.service.ts'));
  const buildVendorOrder = spanOf(orderSrc, 'private async buildVendorOrder(', 'async handlePaymentSuccess(');
  assert('checkout: buildVendorOrder calls deliveryCostCapService.assertVendor', () =>
    buildVendorOrder.includes('deliveryCostCapService.assertVendor('));
  assert('… with the real payment method and currency (not a literal)', () =>
    /assertVendor\([\s\S]*?\},\s*paymentMethod,\s*currency,?\s*\)/.test(buildVendorOrder));
  assert('… BEFORE the physical order is created (a refusal must leave no order)', () => {
    const call = buildVendorOrder.indexOf('deliveryCostCapService.assertVendor(');
    const create = buildVendorOrder.indexOf('this.orderRepo.create(');
    return call > 0 && create > call;
  });
  assert('… from the negotiated floor snapshot (exact AI margin)', () => buildVendorOrder.includes('floor_price_snapshot'));
  assert('… and the pickup SNAPSHOT the split classifies, not the live product', () =>
    buildVendorOrder.includes('orderItem.delivery?.pickup_location?.source'));
  assert('buildVendorOrder runs inside the checkout transaction (so the refusal rolls back holds)', () => {
    const create = spanOf(orderSrc, 'async createOrdersFromCart(', 'private async resolveDeliveryAddress(');
    return /runInTransaction\(async \(session\) => \{[\s\S]*this\.buildVendorOrder\(/.test(create);
  });

  const chatSrc = stripComments(read('modules/bot-surface/miniapp/surfaces/checkout.controller.ts'));
  const precheck = spanOf(chatSrc, 'async function precheckChatDoor(', 'function handleGone(');
  assert('chat door: precheckChatDoor checks the minimum with spent: false', () =>
    /cartQuoteService\.assertDeliveryMinimum\(cart,\s*'online',\s*\{\s*spent:\s*false\s*\}\)/.test(precheck));

  const quoteSrc = stripComments(read('modules/orders/services/cart-quote.service.ts'));
  assert('the quote uses the same service checkout does', () => quoteSrc.includes('this.deliveryCap.assessVendor('));

  const splitSrc = stripComments(read('modules/earnings/services/earnings-split.service.ts'));
  assert('the split\'s EARNINGS_INVALID_SPLIT backstop is still there (prepaid + COD)', () =>
    (splitSrc.match(/ERROR_CODES\.EARNINGS_INVALID_SPLIT/g) ?? []).length >= 2);

  const capSrc = stripComments(read('modules/earnings/services/delivery-cost-cap.ts'));
  assert('the COD fee comes from the split\'s own computeCodHandlingFee', () => capSrc.includes('computeCodHandlingFee('));

  originalConsole.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  originalConsole.error(err);
  process.exit(1);
});
