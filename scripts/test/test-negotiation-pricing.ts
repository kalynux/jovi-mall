/**
 * Test: the negotiated-price lock seam and the platform's AI margin.
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no
 * framework). DB-free throughout — the arithmetic lives on its own pure module
 * for exactly that reason, and the port is driven against fake resolvers.
 *
 * Covers BARGAINING-AGENT-PLAN Stream C+E:
 *
 *   1. The margin arithmetic, including where the rounding lands.
 *   2. `vendorGross = P − aiMargin`, and why `floor + 0.7·U` is NOT the same.
 *   3. Invariant 1 (`vendorGross ≥ floor × qty`) SWEPT over the whole window,
 *      not argued from the algebra. That is the section this file exists for.
 *   4. Reconciliation on a mixed cart, re-derived the way both split paths do it.
 *   5. The port: the refusal codes, and that an unregistered resolver REFUSES.
 *   6. Source scans for the three invariants nothing behavioural can see.
 *
 * Run: npm run test:negotiation-pricing
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  computeAiMargin,
  computeNegotiatedLineSplit,
  computeOrderAiMargin,
  computeVendorFloorTotal,
  NegotiatedLineInput,
} from '../../src/modules/earnings/services/negotiation-margin.service';
import { EARNINGS_CONFIG } from '../../src/modules/earnings/config/earnings.config';
import {
  getNegotiatedPriceResolver,
  setNegotiatedPriceResolver,
  resetNegotiatedPriceResolver,
  INegotiatedPriceResolver,
  LockVerdict,
  NegotiatedPriceContext,
} from '../../src/modules/catalog/domain/ports/negotiated-price.port';
import { PriceResolverService } from '../../src/modules/catalog/domain/services/pricing-inventory/PriceResolverService';
import { publicDisplayPrice } from '../../src/modules/catalog/read-models/public-display-price';
import { ERROR_CODES } from '../../src/core/error-codes';
import { DEFAULT_ERROR_MESSAGES, GENERIC_ERROR_MESSAGE, AppError } from '../../src/core/errors';

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

/** The closed refusal set — one code and one status each, asserted below. */
type LockRefusalReason = Extract<LockVerdict, { ok: false }>['reason'];

const SRC = join(__dirname, '..', '..', 'src');
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');

/** Strip comments before a source scan — a rule proven by a docstring is not proven. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const PERCENT = EARNINGS_CONFIG.AI_MARGIN_PERCENT;

const line = (unitPrice: number, floorPrice: number | null, quantity: number): NegotiatedLineInput =>
  ({ unitPrice, floorPrice, quantity });

/** A resolver that always answers the same verdict — the Stream A stand-in. */
class FakeResolver implements INegotiatedPriceResolver {
  readonly name = 'fake';
  public lastContext: NegotiatedPriceContext | null = null;
  public consumeCalls = 0;
  public peekCalls = 0;

  constructor(private readonly verdict: LockVerdict) {}

  async peek(_ref: string, context: NegotiatedPriceContext): Promise<LockVerdict> {
    this.peekCalls++;
    this.lastContext = context;
    return this.verdict;
  }

  async consume(_ref: string, context: NegotiatedPriceContext): Promise<LockVerdict> {
    this.consumeCalls++;
    this.lastContext = context;
    return this.verdict;
  }
}

/**
 * Just enough repository to run `PriceResolverService.execute` with no Mongo.
 *
 * `bargain` + `vectorisationEnabled` are what make a variant BARGAINABLE, and
 * therefore shelved at its ask — see `isBargainEffective`.
 */
function fakeRepos(
  variantPrice: number,
  opts: { bargainMax?: number; vectorisationEnabled?: boolean; compareAtPrice?: number } = {},
) {
  const product: any = {
    id: 'p1',
    vendorId: 'v1',
    status: 'active',
    type: 'physical',
    vectorisationEnabled: opts.vectorisationEnabled ?? false,
  };
  const variant: any = {
    id: 'var1',
    productId: 'p1',
    status: 'active',
    price: variantPrice,
    compareAtPrice: opts.compareAtPrice,
    bargain: opts.bargainMax === undefined
      ? undefined
      : { minPrice: variantPrice, maxPrice: opts.bargainMax },
  };
  return {
    productRepository: { findById: async () => product } as any,
    variantRepository: { findById: async () => variant } as any,
  };
}

const BASE_COMMAND = {
  productId: 'p1',
  variantId: 'var1',
  vendorId: 'v1',
  quantity: 2,
};

/** Run `execute` and return the AppError it threw, or null if it did not throw. */
async function catchAppError(fn: () => Promise<unknown>): Promise<AppError | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return err as AppError;
  }
}

async function main(): Promise<void> {
  // ───────────────────────────────────────────────────────────────────────────
  originalConsole.log('\n▶ 1. computeAiMargin — the platform share of one uplift');

  assert('the configured percentage is the plan\'s 30 unless overridden', () => PERCENT === 30);

  assert('a whole-number share is exact (30% of 1000 = 300)', () =>
    computeAiMargin(1000) === 300);
  assert('a fractional share is FLOORED, never rounded (30% of 10 = 3)', () =>
    computeAiMargin(10) === 3);
  assert('flooring favours the vendor (30% of 3 = 0.9 → 0)', () =>
    computeAiMargin(3) === 0);
  assert('no uplift, no margin', () => computeAiMargin(0) === 0);
  // P < floor should be impossible — the gate refuses it and the consume verdict
  // re-checks. If one ever arrives the answer is to take nothing, not to bill.
  assert('a negative uplift takes nothing rather than billing the vendor', () =>
    computeAiMargin(-500) === 0);
  assert('a non-finite uplift takes nothing', () => computeAiMargin(NaN) === 0);

  // ───────────────────────────────────────────────────────────────────────────
  originalConsole.log('\n▶ 2. vendorGross = P − aiMargin, and why floor + 0.7·U is not');

  assert('an ordinary line (no floor) has no uplift and no margin', () => {
    const s = computeNegotiatedLineSplit(line(45_000, null, 2));
    return s.uplift === 0 && s.aiMargin === 0 && s.vendorGross === 90_000;
  });

  assert('a negotiated line: P=41000 floor=38000 qty=2 → U=6000, margin=1800', () => {
    const s = computeNegotiatedLineSplit(line(41_000, 38_000, 2));
    return s.lineGross === 82_000 && s.uplift === 6_000 && s.aiMargin === 1_800
      && s.vendorGross === 80_200;
  });

  assert('P === floor: the agent conceded the whole window, nothing is taken', () => {
    const s = computeNegotiatedLineSplit(line(38_000, 38_000, 3));
    return s.uplift === 0 && s.aiMargin === 0 && s.vendorGross === 114_000;
  });

  /**
   * ⚠ THE TRAP the plan calls out by name. The two forms differ by a franc after
   * flooring, and only `P×qty − aiMargin` reconciles: it is DEFINED as the
   * complement of what was actually allocated, so `aiMargin + vendorGross` is the
   * gross by construction rather than by the rounding happening to agree.
   */
  assert('the two forms genuinely DISAGREE where 0.3·U is fractional', () => {
    const P = 103, floor = 100, qty = 1;
    const s = computeNegotiatedLineSplit(line(P, floor, qty));
    const naive = floor * qty + Math.floor(0.7 * (P - floor) * qty); // 100 + 2 = 102
    // The gap is the whole point: 103 reconciles (0 + 103 === 103), 102 does not.
    return s.vendorGross - naive === 1 && s.aiMargin + s.vendorGross === s.lineGross;
  });

  assert('only the correct form reconciles: aiMargin + vendorGross === lineGross', () => {
    // Swept, because one worked example proves nothing about the rounding.
    for (let P = 100; P <= 160; P++) {
      for (let qty = 1; qty <= 7; qty++) {
        const s = computeNegotiatedLineSplit(line(P, 100, qty));
        if (s.aiMargin + s.vendorGross !== s.lineGross) return false;
      }
    }
    return true;
  });

  // ───────────────────────────────────────────────────────────────────────────
  originalConsole.log('\n▶ 3. INVARIANT 1 — vendorGross ≥ floor × qty, swept over the whole window');

  /**
   * The plan asserts this rather than assuming it, and this is the section that
   * does it. `vendorGross = 0.7·P + 0.3·floor per unit` is the ALGEBRAIC claim;
   * what actually ships is a floored per-line subtraction, and an off-by-one in
   * the flooring is exactly the shape that would break this while every worked
   * example still passed.
   */
  assert('holds for every P in [floor, ask] × every qty 1..10, on a realistic window', () => {
    const floor = 38_000;
    const ask = 45_000;
    for (let P = floor; P <= ask; P++) {
      for (let qty = 1; qty <= 10; qty++) {
        const s = computeNegotiatedLineSplit(line(P, floor, qty));
        if (s.vendorGross < floor * qty) return false;
      }
    }
    return true;
  });

  assert('holds on a tiny window where the flooring bites hardest (floor 1..40, ask+40)', () => {
    for (let floor = 1; floor <= 40; floor++) {
      for (let P = floor; P <= floor + 40; P++) {
        for (let qty = 1; qty <= 5; qty++) {
          const s = computeNegotiatedLineSplit(line(P, floor, qty));
          if (s.vendorGross < floor * qty) return false;
        }
      }
    }
    return true;
  });

  assert('holds at a degenerate window (floor === ask, no headroom to concede)', () => {
    for (let qty = 1; qty <= 10; qty++) {
      const s = computeNegotiatedLineSplit(line(38_000, 38_000, qty));
      if (s.vendorGross < 38_000 * qty) return false;
    }
    return true;
  });

  assert('holds at the ORDER level over a mixed basket, against computeVendorFloorTotal', () => {
    const lines = [
      line(41_000, 38_000, 2),  // negotiated
      line(45_000, null, 1),    // ordinary — its own price is its floor
      line(12_345, 12_000, 3),  // negotiated, awkward numbers
      line(999, 998, 7),        // negotiated, uplift of 1 per unit
    ];
    const gross = lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0);
    const vendorGross = gross - computeOrderAiMargin(lines);
    return vendorGross >= computeVendorFloorTotal(lines);
  });

  // The invariant is what guarantees D-5 cannot newly trip EARNINGS_INVALID_SPLIT.
  // It has to survive a misconfigured percentage too, since that is an env var.
  assert('the invariant is a property of the FORM, not of 30 — holds at 0 and 100', () => {
    const floor = 100;
    for (const percent of [0, 1, 50, 99, 100]) {
      for (let P = floor; P <= floor + 60; P++) {
        for (let qty = 1; qty <= 4; qty++) {
          const uplift = (P - floor) * qty;
          const margin = Math.floor((uplift * percent) / 100);
          if (P * qty - margin < floor * qty) return false;
        }
      }
    }
    return true;
  });

  // ───────────────────────────────────────────────────────────────────────────
  originalConsole.log('\n▶ 4. Reconciliation — re-derived the way both split paths do it');

  assert('the order-level margin is the SUM of per-line margins, not a margin on the sum', () => {
    // floor(a) + floor(b) <= floor(a+b): summing the uplifts first would allocate
    // a franc no line produced and leave the reconciliation short.
    const lines = [line(103, 100, 1), line(103, 100, 1)];
    const perLine = computeOrderAiMargin(lines);          // 0 + 0
    const onTheSum = Math.floor((6 * PERCENT) / 100);     // floor(1.8) = 1
    return onTheSum - perLine === 1;
  });

  assert('splitOrder reconciles: gross = aiMargin + commission + vendorNet + delivery', () => {
    const lines = [line(41_000, 38_000, 2), line(45_000, null, 1)];
    const gross = lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0);
    const aiMargin = computeOrderAiMargin(lines);
    const vendorGross = gross - aiMargin;
    const commission = Math.floor((vendorGross * 10) / 100);
    const deliveryTotal = 1_500;
    const vendorNet = vendorGross - commission - deliveryTotal;
    return vendorNet >= 0 && aiMargin + commission + vendorNet + deliveryTotal === gross;
  });

  assert('splitCodCollection reconciles: gross = aiMargin + commission + agency + agent + vendorNet', () => {
    // One shipment's slice, so the quantity is the SHIPMENT item's.
    const shipmentLines = [line(41_000, 38_000, 1)];
    const gross = shipmentLines.reduce((s, l) => s + l.unitPrice * l.quantity, 0);
    const aiMargin = computeOrderAiMargin(shipmentLines);
    const vendorGross = gross - aiMargin;
    const commission = Math.floor((vendorGross * 10) / 100);
    const deliveryFee = 1_500;
    const codFee = 250;
    const agentCut = 450;
    const agencyCut = deliveryFee - agentCut + codFee; // computeAgencyCut
    const vendorNet = vendorGross - commission - deliveryFee - codFee;
    return vendorNet >= 0
      && aiMargin + commission + agencyCut + agentCut + vendorNet === gross;
  });

  assert('an ordinary order is BYTE-IDENTICAL to the pre-D-5 split (aiMargin === 0)', () => {
    const lines = [line(45_000, null, 2), line(12_000, null, 1)];
    const gross = lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0);
    const aiMargin = computeOrderAiMargin(lines);
    const vendorGross = gross - aiMargin;
    // The old code took commission off `gross`; the new one off `vendorGross`.
    // With no negotiated line the two are the same number, which is what makes
    // this change invisible to every existing order.
    return aiMargin === 0 && vendorGross === gross;
  });

  assert('a multi-shipment order splits its margin ACROSS collections, never per-order', () => {
    // One order item, qty 3, split 2 + 1 across two shipments.
    const whole = computeOrderAiMargin([line(41_000, 38_000, 3)]);
    const first = computeOrderAiMargin([line(41_000, 38_000, 2)]);
    const second = computeOrderAiMargin([line(41_000, 38_000, 1)]);
    // Per-shipment flooring can lose a franc against the whole-order figure, and
    // that is correct: each collection reconciles against its OWN gross.
    return first + second <= whole && first + second >= whole - 1;
  });

  // ───────────────────────────────────────────────────────────────────────────
  originalConsole.log('\n▶ 5. The port — refusals, and the unregistered default');

  await assertAsync('an unregistered resolver REFUSES a presented lock (never falls back)', async () => {
    resetNegotiatedPriceResolver();
    const repos = fakeRepos(38_000);
    const svc = new PriceResolverService(repos.productRepository, repos.variantRepository);
    const err = await catchAppError(() =>
      svc.execute({
        ...BASE_COMMAND,
        negotiation: { lockRef: 'lk_1', customerId: 'c1', mode: 'peek' },
      }),
    );
    // A 500, deliberately: "nobody is wired up to look" is a statement about us,
    // not about the lock. What matters is that it did not quietly charge 38 000.
    return err !== null && err.statusCode === 500;
  });

  await assertAsync('no lock presented → the unregistered default is never consulted', async () => {
    resetNegotiatedPriceResolver();
    const repos = fakeRepos(38_000);
    const svc = new PriceResolverService(repos.productRepository, repos.variantRepository);
    const price = await svc.execute(BASE_COMMAND);
    return price.unitPrice === 38_000 && price.total === 76_000 && price.negotiated === undefined;
  });

  await assertAsync('an honoured lock replaces the unit price and carries the floor', async () => {
    const fake = new FakeResolver({ ok: true, unitPrice: 41_000, floorSnapshot: 38_000 });
    setNegotiatedPriceResolver(fake);
    const repos = fakeRepos(38_000);
    const svc = new PriceResolverService(repos.productRepository, repos.variantRepository);
    const price = await svc.execute({
      ...BASE_COMMAND,
      negotiation: { lockRef: 'lk_1', customerId: 'c1', mode: 'peek' },
    });
    return price.unitPrice === 41_000
      && price.total === 82_000
      && price.negotiated?.floorPrice === 38_000
      && price.negotiated?.lockRef === 'lk_1';
  });

  await assertAsync('the binding — customer, variant and quantity — reaches the resolver', async () => {
    const fake = new FakeResolver({ ok: true, unitPrice: 41_000, floorSnapshot: 38_000 });
    setNegotiatedPriceResolver(fake);
    const repos = fakeRepos(38_000);
    const svc = new PriceResolverService(repos.productRepository, repos.variantRepository);
    await svc.execute({
      ...BASE_COMMAND,
      quantity: 3,
      negotiation: { lockRef: 'lk_1', customerId: 'cust-42', mode: 'peek' },
    });
    return fake.lastContext?.customerId === 'cust-42'
      && fake.lastContext?.variantId === 'var1'
      && fake.lastContext?.quantity === 3;
  });

  await assertAsync('peek does not consume, and consume does not peek', async () => {
    const fake = new FakeResolver({ ok: true, unitPrice: 41_000, floorSnapshot: 38_000 });
    setNegotiatedPriceResolver(fake);
    const repos = fakeRepos(38_000);
    const svc = new PriceResolverService(repos.productRepository, repos.variantRepository);
    await svc.execute({
      ...BASE_COMMAND,
      negotiation: { lockRef: 'lk_1', customerId: 'c1', mode: 'peek' },
    });
    const afterPeek = fake.peekCalls === 1 && fake.consumeCalls === 0;
    await svc.execute({
      ...BASE_COMMAND,
      negotiation: { lockRef: 'lk_1', customerId: 'c1', mode: 'consume', session: {} as any },
    });
    return afterPeek && fake.peekCalls === 1 && fake.consumeCalls === 1;
  });

  await assertAsync('consume WITHOUT a transaction is refused, never downgraded to a peek', async () => {
    const fake = new FakeResolver({ ok: true, unitPrice: 41_000, floorSnapshot: 38_000 });
    setNegotiatedPriceResolver(fake);
    const repos = fakeRepos(38_000);
    const svc = new PriceResolverService(repos.productRepository, repos.variantRepository);
    const err = await catchAppError(() =>
      svc.execute({
        ...BASE_COMMAND,
        negotiation: { lockRef: 'lk_1', customerId: 'c1', mode: 'consume' },
      }),
    );
    return err !== null && err.statusCode === 500
      && fake.consumeCalls === 0 && fake.peekCalls === 0;
  });

  // The whole refusal table, one case each. The mapping is the only thing
  // `catalog` decides about a lock, so it is the only thing worth pinning here.
  const REFUSALS: Array<[LockRefusalReason, string, number]> = [
    ['not_found', ERROR_CODES.NEGOTIATION_LOCK_INVALID, 404],
    ['expired', ERROR_CODES.NEGOTIATION_LOCK_EXPIRED, 422],
    ['consumed', ERROR_CODES.NEGOTIATION_LOCK_CONSUMED, 409],
    ['mismatch', ERROR_CODES.NEGOTIATION_LOCK_VARIANT_MISMATCH, 422],
    ['window_moved', ERROR_CODES.NEGOTIATION_LOCK_WINDOW_MOVED, 409],
  ];

  for (const [reason, code, status] of REFUSALS) {
    await assertAsync(`reason '${reason}' → ${code} at ${status}`, async () => {
      setNegotiatedPriceResolver(new FakeResolver({ ok: false, reason }));
      const repos = fakeRepos(38_000);
      const svc = new PriceResolverService(repos.productRepository, repos.variantRepository);
      const err = await catchAppError(() =>
        svc.execute({
          ...BASE_COMMAND,
          negotiation: { lockRef: 'lk_1', customerId: 'c1', mode: 'peek' },
        }),
      );
      return err !== null && err.code === code && err.statusCode === status;
    });
  }

  await assertAsync('an UNRECOGNISED reason is refused, never treated as permission', async () => {
    // The resolver lives in another module and may grow a reason before the
    // mapping table does. The fall-through must land on a refusal.
    setNegotiatedPriceResolver(new FakeResolver({ ok: false, reason: 'something_new' as any }));
    const repos = fakeRepos(38_000);
    const svc = new PriceResolverService(repos.productRepository, repos.variantRepository);
    const err = await catchAppError(() =>
      svc.execute({
        ...BASE_COMMAND,
        negotiation: { lockRef: 'lk_1', customerId: 'c1', mode: 'peek' },
      }),
    );
    return err !== null && err.code === ERROR_CODES.NEGOTIATION_LOCK_INVALID;
  });

  await assertAsync('the catalogue gates run BEFORE the lock — an archived variant is not spent on', async () => {
    const fake = new FakeResolver({ ok: true, unitPrice: 41_000, floorSnapshot: 38_000 });
    setNegotiatedPriceResolver(fake);
    const product: any = { id: 'p1', vendorId: 'v1', status: 'active', type: 'physical' };
    const variant: any = { id: 'var1', productId: 'p1', status: 'archived', price: 38_000 };
    const svc = new PriceResolverService(
      { findById: async () => product } as any,
      { findById: async () => variant } as any,
    );
    const err = await catchAppError(() =>
      svc.execute({
        ...BASE_COMMAND,
        negotiation: { lockRef: 'lk_1', customerId: 'c1', mode: 'consume', session: {} as any },
      }),
    );
    return err !== null
      && err.code === ERROR_CODES.CATALOG_VARIANT_ARCHIVED
      && fake.consumeCalls === 0;
  });

  resetNegotiatedPriceResolver();

  // ───────────────────────────────────────────────────────────────────────────
  originalConsole.log('\n▶ 5b. An UN-negotiated sale is at the ask, not the floor (Stream D handoff)');

  /**
   * The defect Stream D handed over. After the storefront flip a bargainable
   * variant is displayed at `bargain.maxPrice` while `variant.price` is the
   * vendor's floor — so returning `variant.price` here charged 30 001 for
   * something shown at 48 000. It fails customer-favourably, so no test went red
   * and no vendor saw an error; they were simply paid their floor on every sale.
   */
  await assertAsync('a bargainable variant with NO lock resolves at the ask', async () => {
    resetNegotiatedPriceResolver();
    const repos = fakeRepos(30_001, { bargainMax: 48_000, vectorisationEnabled: true });
    const svc = new PriceResolverService(repos.productRepository, repos.variantRepository);
    const price = await svc.execute({ ...BASE_COMMAND, quantity: 1 });
    return price.unitPrice === 48_000 && price.total === 48_000 && price.negotiated === undefined;
  });

  await assertAsync('a NON-bargainable variant is unchanged — still variant.price', async () => {
    const repos = fakeRepos(30_001);
    const svc = new PriceResolverService(repos.productRepository, repos.variantRepository);
    const price = await svc.execute({ ...BASE_COMMAND, quantity: 1 });
    return price.unitPrice === 30_001;
  });

  await assertAsync('a window on an OPTED-OUT product is inert — sold at the floor', async () => {
    // `isBargainEffective` gates on the product being in the AI index. A window
    // is kept and reported inert rather than deleted, so this case is real.
    const repos = fakeRepos(30_001, { bargainMax: 48_000, vectorisationEnabled: false });
    const svc = new PriceResolverService(repos.productRepository, repos.variantRepository);
    const price = await svc.execute({ ...BASE_COMMAND, quantity: 1 });
    return price.unitPrice === 30_001;
  });

  await assertAsync('a lock still WINS over the ask — it is a discount off it', async () => {
    setNegotiatedPriceResolver(new FakeResolver({ ok: true, unitPrice: 41_000, floorSnapshot: 30_001 }));
    const repos = fakeRepos(30_001, { bargainMax: 48_000, vectorisationEnabled: true });
    const svc = new PriceResolverService(repos.productRepository, repos.variantRepository);
    const price = await svc.execute({
      ...BASE_COMMAND,
      quantity: 1,
      negotiation: { lockRef: 'lk_1', customerId: 'c1', mode: 'peek' },
    });
    return price.unitPrice === 41_000 && price.negotiated?.floorPrice === 30_001;
  });

  await assertAsync('the discount derivation follows the ask, as Stream D said it would', async () => {
    resetNegotiatedPriceResolver();
    // compareAtPrice 50 000 is above the ask, so it is still a real "was" price.
    const repos = fakeRepos(30_001, {
      bargainMax: 48_000,
      vectorisationEnabled: true,
      compareAtPrice: 50_000,
    });
    const svc = new PriceResolverService(repos.productRepository, repos.variantRepository);
    const price = await svc.execute({ ...BASE_COMMAND, quantity: 1 });
    // 50 000 − 48 000, not 50 000 − 30 001: the discount is off what is charged.
    return price.discount === 2_000;
  });

  await assertAsync('the cart and the storefront quote ONE number, from one function', async () => {
    resetNegotiatedPriceResolver();
    const repos = fakeRepos(30_001, { bargainMax: 48_000, vectorisationEnabled: true });
    const svc = new PriceResolverService(repos.productRepository, repos.variantRepository);
    const charged = (await svc.execute({ ...BASE_COMMAND, quantity: 1 })).unitPrice;
    const displayed = publicDisplayPrice(true, {
      price: 30_001,
      bargain: { minPrice: 30_001, maxPrice: 48_000 },
    });
    return charged === displayed;
  });

  // ───────────────────────────────────────────────────────────────────────────
  originalConsole.log('\n▶ 5c. D-5\'s lock condition — an un-haggled uplift earns the platform NOTHING');

  /**
   * The consequence of 5b, and the reason D asked for the condition to be
   * explicit. An ordinary sale of a bargainable variant now has P = ask, so
   * `P − floor > 0`. Keying the margin on the uplift alone would take 30% of it
   * on a sale no model touched — quietly reducing the payout of every vendor who
   * configured a window.
   */
  assert('an un-locked line with a real uplift still yields ZERO margin', () => {
    // The split passes `floorPrice: null` for a line with no negotiated price;
    // that is what `negotiatedLineOf` does, and it is what makes this true.
    const unlocked = computeNegotiatedLineSplit(line(48_000, null, 2));
    return unlocked.uplift === 0 && unlocked.aiMargin === 0 && unlocked.vendorGross === 96_000;
  });

  assert('the SAME numbers with a lock DO earn the platform its share', () => {
    const locked = computeNegotiatedLineSplit(line(48_000, 30_001, 2));
    return locked.uplift === 35_998 && locked.aiMargin === 10_799;
  });

  // Every refusal must survive the Phase-16 boundary filter, or the chat cannot
  // explain itself — that is D-10's "never a generic error", made checkable.
  originalConsole.log('\n▶ 6. The five codes render a real sentence');

  for (const code of [
    ERROR_CODES.NEGOTIATION_LOCK_INVALID,
    ERROR_CODES.NEGOTIATION_LOCK_EXPIRED,
    ERROR_CODES.NEGOTIATION_LOCK_CONSUMED,
    ERROR_CODES.NEGOTIATION_LOCK_VARIANT_MISMATCH,
    ERROR_CODES.NEGOTIATION_LOCK_WINDOW_MOVED,
  ]) {
    assert(`${code} has a registry message (never "${GENERIC_ERROR_MESSAGE}")`, () => {
      const message = DEFAULT_ERROR_MESSAGES[code];
      return typeof message === 'string' && message.length > 0 && message !== GENERIC_ERROR_MESSAGE;
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  originalConsole.log('\n▶ 7. Source scans — the invariants nothing behavioural can see');

  assert('BOTH split paths carry the third allocation', () => {
    const src = stripComments(read('modules/earnings/services/earnings-split.service.ts'));
    // Two `platform_ai` allocation literals: one in splitOrder, one in
    // splitCodCollection. A single one means a whole payment method silently
    // stopped funding the model spend.
    const matches = src.match(/beneficiary_type: 'platform_ai'/g) ?? [];
    return matches.length === 2;
  });

  assert('BOTH margin-bearing paths take commission off vendorGross, not gross', () => {
    const src = stripComments(read('modules/earnings/services/earnings-split.service.ts'));
    // The platform must not take commission on money it has already taken as
    // margin, and `(gross * commissionPercent)` is what that mistake looks like.
    // Exactly two sites, because exactly two paths carry an AI margin.
    const corrected = src.match(/Math\.floor\(\(vendorGross \* commissionPercent\) \/ 100\)/g) ?? [];
    return corrected.length === 2;
  });

  assert('splitBooking is deliberately NOT converted, and stays on gross', () => {
    const src = stripComments(read('modules/earnings/services/earnings-split.service.ts'));
    // A booking is a SERVICE product, and `resolveBargainWrite` refuses a bargain
    // window on one outright (400 CATALOG_VARIANT_BARGAIN_NOT_SUPPORTED). So a
    // booking can never carry an uplift, `vendorGross` would always equal `gross`,
    // and introducing the term would be dead arithmetic on a money path. This
    // assertion exists so the next person to widen the scan reads that reason
    // instead of "fixing" the inconsistency.
    const start = src.indexOf('async splitBooking(');
    if (start === -1) return false;
    const body = src.slice(start, start + 900);
    return body.includes('Math.floor((gross * commissionPercent) / 100)')
      && !body.includes('vendorGross');
  });

  assert('D-5\'s lock gate is EXPLICIT, in one place, and both paths go through it', () => {
    const src = stripComments(read('modules/earnings/services/earnings-split.service.ts'));
    // Since the storefront flip, an ordinary sale of a bargainable variant also
    // has an uplift — so the margin must be keyed on the LOCK, not on the uplift.
    // One helper, two call sites, and the gate is a visible condition in it.
    return src.includes('item.negotiated_unit_price != null')
      && (src.match(/negotiatedLineOf/g) ?? []).length === 3; // the definition + both paths
  });

  assert('PriceResolverService quotes the storefront\'s own rule, not a second copy', () => {
    const src = stripComments(
      read('modules/catalog/domain/services/pricing-inventory/PriceResolverService.ts'),
    );
    // A hand-rolled `variant.bargain.maxPrice` here would be the sixth copy of
    // D-1, and the one that decides what a customer is CHARGED.
    return src.includes('publicDisplayPrice(product.vectorisationEnabled, variant)')
      && !src.includes('maxPrice');
  });

  assert('the COD path uses the SHIPMENT quantity, not the order item\'s', () => {
    const src = stripComments(read('modules/earnings/services/earnings-split.service.ts'));
    // `collection.expected_amount` is one shipment's slice, so a per-order
    // quantity here allocates the whole order's margin once per collection.
    return src.includes('quantity: shipmentItem.quantity');
  });

  assert('the split service never re-reads a floor from the variant', () => {
    const src = stripComments(read('modules/earnings/services/earnings-split.service.ts'));
    // The floor must come from the order item's snapshot. A `variant.price` or a
    // `bargain` read here would compute a share of an uplift nobody agreed to —
    // and could pay a vendor below the floor they actually sold at.
    return !src.includes('variant.price') && !/\bbargain\b/.test(src);
  });

  assert('PriceResolverService does NOT re-derive the window (D-10 stays the resolver\'s)', () => {
    const src = stripComments(
      read('modules/catalog/domain/services/pricing-inventory/PriceResolverService.ts'),
    );
    // Two modules interpreting one lock is the drift the port exists to prevent.
    // The verdict is the resolver's; this file may only map its `reason`.
    return !/\bbargain\b/.test(src) && !src.includes('maxPrice') && !src.includes('minPrice');
  });

  assert('catalog reaches the lock ONLY through the port — no negotiation import', () => {
    const src = read('modules/catalog/domain/services/pricing-inventory/PriceResolverService.ts');
    // A direct import closes a require cycle: negotiation needs catalog for the
    // window, and catalog would need negotiation for the lock. That has crashed
    // this service's boot before (see modules/agents/index.ts).
    return !src.includes("modules/negotiation") && !src.includes("../../../negotiation");
  });

  assert('the floor NEVER reaches the customer-facing cart DTO', () => {
    const src = stripComments(read('modules/cart/services/cart.service.ts'));
    // CartResponse is returned verbatim by GET /customer/cart and by every bot
    // cart route. `floor_price_snapshot` is the vendor's floor — the same secret
    // `bargain.minPrice` is on the public catalogue.
    const dtoStart = src.indexOf('export interface CartResponse');
    const dtoEnd = src.indexOf('export type CartMergeStrategy');
    if (dtoStart === -1 || dtoEnd === -1 || dtoEnd < dtoStart) return false;
    const dto = src.slice(dtoStart, dtoEnd);
    return !dto.includes('floor') && !dto.includes('Floor');
  });

  assert('formatCartResponse emits no floor either', () => {
    const src = stripComments(read('modules/cart/services/cart.service.ts'));
    const start = src.indexOf('private formatCartResponse');
    if (start === -1) return false;
    const body = src.slice(start, start + 1600);
    return !body.includes('floor_price_snapshot');
  });

  assert('order creation CONSUMES inside the transaction, and only for locked lines', () => {
    const src = stripComments(read('modules/orders/order.service.ts'));
    // Three things at once: the mode is consume, the session is threaded through,
    // and the loop is gated on a lock ref rather than re-resolving every line.
    return src.includes("mode: 'consume'")
      && src.includes('session,')
      && src.includes('if (!item.negotiationLockRef) continue;');
  });

  assert('the misleading cart comment is gone', () => {
    const src = read('modules/cart/services/cart.service.ts');
    // "The price a cart quotes is re-resolved at checkout, which is the moment
    // that actually binds" was false for as long as it was written, and D-12
    // asks for it to be fixed rather than worked around.
    const claim = 'The price a cart quotes is re-resolved\n   *     at checkout, which is the moment that actually binds.';
    return !src.includes(claim)
      && !/re-resolved at checkout, which is the moment that actually binds\./.test(
        src.replace(/\s+/g, ' '),
      );
  });

  assert('the port is registered nowhere in catalog — the composition root owns that', () => {
    const src = stripComments(
      read('modules/catalog/domain/services/pricing-inventory/PriceResolverService.ts'),
    );
    // `setNegotiatedPriceResolver` belongs to negotiation.bootstrap.ts. A call
    // from inside catalog would be catalog implementing its own port.
    return !src.includes('setNegotiatedPriceResolver');
  });

  assert('getNegotiatedPriceResolver never returns null — refusal is a THROW, not an absence', () => {
    resetNegotiatedPriceResolver();
    const resolver = getNegotiatedPriceResolver();
    // A null here would put an `if (!resolver)` at every call site, and the
    // tempting body of that `if` is "carry on at the list price".
    return resolver !== null && resolver !== undefined && resolver.name === 'unregistered';
  });

  originalConsole.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  originalConsole.error(err);
  process.exit(1);
});
