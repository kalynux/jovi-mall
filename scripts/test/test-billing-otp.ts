/**
 * test:billing-otp — the mobile-money OTP step for credit top-ups and plan
 * purchases.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
 * My-CoolPay's Orange Money branch answers `REQUIRE_OTP` at initiation and
 * takes no money until the SMS code is relayed back. Billing had no route that
 * accepted one: `initiateTopup` / `initiatePurchase` faithfully passed
 * `instructions.requiresOtp: true` up to the dashboard, and the only authorize
 * endpoint on the platform resolved its argument with
 * `PaymentTransactionModel.findById` — a collection a billing purchase
 * deliberately never writes to. So every Orange Money plan purchase and top-up,
 * for all three owner roles, was reachable, was offered an OTP screen, and
 * could never complete.
 *
 * Nothing in the repository could see that. `tsc` and `eslint` pass over a
 * missing route; `test:payments` asserts the transaction path and is right
 * about it. What is asserted here is the part that fails silently: the attempt
 * cap on a money row, the guard that stops a settled purchase taking a second
 * code, and the owner scoping that lets this endpoint be closed where the
 * payments module's equivalent is deliberately open.
 *
 * Sections:
 *   1. The rule       — attempts, ordering, and the cap
 *   2. Settled rows   — what may and may not take a code
 *   3. Gateways       — only the one that asks for a code accepts one
 *   4. Source scans   — one copy of the rule, owner-scoped everywhere
 *
 * DB-free (the rows are plain objects with a `save()` spy; the gateway is
 * stubbed on the registry instance). Run: npm run test:billing-otp
 */

process.env.LOG_STDOUT = 'false';

import { readFileSync } from 'fs';
import { join } from 'path';
import { originalConsole } from '../../src/core/logging/sink-guard';

import { submitGatewayOtp, OtpAuthorizableRow } from '../../src/modules/billing/domain/gateway-otp';
import { PAYMENT_GATEWAYS } from '../../src/modules/payments/gateways/registry';
import { PAYMENTS_CONFIG } from '../../src/modules/payments/config/payments.config';
import { ERROR_CODES } from '../../src/core/error-codes';
import { AppError } from '../../src/core/errors';

let passed = 0;
let failed = 0;

function assert(name: string, fn: () => boolean): void {
  // Never an async callback: a Promise is always truthy, so the assertion would
  // be permanently green. Same note as test-payments.
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
  originalConsole.log(`\n── ${title} ${'─'.repeat(Math.max(0, 72 - title.length))}`);
}

const SRC = join(__dirname, '..', '..', 'src');
const read = (...p: string[]) => readFileSync(join(SRC, ...p), 'utf8');

const RULE = read('modules', 'billing', 'domain', 'gateway-otp.ts');
const TOPUP_SERVICE = read('modules', 'billing', 'services', 'credit-topup.service.ts');
const PURCHASE_SERVICE = read('modules', 'billing', 'services', 'plan-purchase.service.ts');
const ROUTE_FILES = ['vendor', 'agency', 'agent'].map((role) => ({
  role,
  code: read('modules', 'billing', 'routes', `${role}-billing.routes.ts`),
}));
const BILLING_MODELS = ['credit-topup', 'plan-purchase'].map((name) => ({
  name,
  code: read('modules', 'billing', 'models', `${name}.model.ts`),
}));

// ── The stub ────────────────────────────────────────────────────────────────
// The registry holds one live instance per gateway, so replacing the method on
// it is enough to keep this suite off the network. Restored in section 3.
const mycoolpay = PAYMENT_GATEWAYS.get('MYCOOLPAY')!;
const realAuthorize = mycoolpay.authorizePayment;

interface Spy {
  row: OtpAuthorizableRow;
  saves: number[];
  calls: number;
}

function stub(accepts: boolean, initial: Partial<OtpAuthorizableRow> = {}): Spy {
  const spy: Spy = { saves: [], calls: 0, row: null as never };
  spy.row = {
    status: 'pending',
    gateway: 'MYCOOLPAY',
    gateway_ref: 'mcp_ref_1',
    otp_attempts: 0,
    ...initial,
    save: async () => {
      spy.saves.push(spy.row.otp_attempts);
      return spy.row;
    },
  } as OtpAuthorizableRow;
  mycoolpay.authorizePayment = async () => {
    spy.calls++;
    return accepts
      ? { success: true, status: 'PENDING' as const, instructions: { message: 'dial it' }, rawResponse: {} }
      : { success: false, status: 'PENDING' as const, error: 'refused', rawResponse: {} };
  };
  return spy;
}

/** Run the rule and report the AppError code it raised, or null on success. */
function codeOf(promise: Promise<unknown>): Promise<string | null> {
  return promise.then(
    () => null,
    (err) => (err instanceof AppError ? err.code : `NOT_AN_APP_ERROR:${String(err)}`)
  );
}

async function main(): Promise<void> {
  const INVALID_STATE = ERROR_CODES.BILLING_TOPUP_INVALID_STATE;

  section('1. The rule — attempts, ordering, and the cap');

  {
    const spy = stub(true);
    const result = await submitGatewayOtp(spy.row, '123456', INVALID_STATE);
    assert('an accepted code returns the gateway instructions', () =>
      (result.instructions as { message?: string })?.message === 'dial it');
    assert('an accepted code does NOT settle the row — the webhook still does', () =>
      spy.row.status === 'pending');
    assert('an accepted code still spends an attempt', () => spy.row.otp_attempts === 1);
  }

  {
    const spy = stub(false);
    const code = await codeOf(submitGatewayOtp(spy.row, '000000', INVALID_STATE));
    assert('a refused code raises PAYMENT_OTP_INVALID', () =>
      code === ERROR_CODES.PAYMENT_OTP_INVALID);
    // The whole point of the counter: it must already be durable when the
    // gateway is asked, so aborting mid-flight cannot buy a free guess.
    assert('the attempt is PERSISTED before the gateway is called', () =>
      spy.saves.length >= 1 && spy.saves[0] === 1 && spy.calls === 1);
  }

  {
    const spy = stub(false, { otp_attempts: PAYMENTS_CONFIG.OTP_MAX_ATTEMPTS });
    const code = await codeOf(submitGatewayOtp(spy.row, '000000', INVALID_STATE));
    assert('exhausting the cap raises PAYMENT_OTP_ATTEMPTS_EXCEEDED', () =>
      code === ERROR_CODES.PAYMENT_OTP_ATTEMPTS_EXCEEDED);
    assert('exhausting the cap FAILS the row rather than throttling it', () =>
      spy.row.status === 'failed');
    assert('the exhausted attempt never reaches the gateway', () => spy.calls === 0);
  }

  {
    const spy = stub(false, { otp_attempts: PAYMENTS_CONFIG.OTP_MAX_ATTEMPTS - 1 });
    await codeOf(submitGatewayOtp(spy.row, '000000', INVALID_STATE));
    assert('the last allowed attempt is still spent at the gateway', () =>
      spy.calls === 1 && spy.row.status === 'pending');
  }

  section('2. Settled rows — what may and may not take a code');

  for (const status of ['paid', 'failed', 'reversed'] as const) {
    const spy = stub(true, { status });
    const code = await codeOf(submitGatewayOtp(spy.row, '123456', INVALID_STATE));
    // `paid` is the one that matters: a second accepted code on a completed
    // purchase is a second charge on the owner's phone.
    assert(`a ${status} row refuses the code and never calls the gateway`, () =>
      code === INVALID_STATE && spy.calls === 0);
  }

  {
    const spy = stub(true, { gateway_ref: null });
    const code = await codeOf(submitGatewayOtp(spy.row, '123456', INVALID_STATE));
    assert('a row with no gateway reference refuses rather than sending null', () =>
      code === INVALID_STATE && spy.calls === 0);
  }

  section('3. Gateways — only the one that asks for a code accepts one');

  for (const name of ['STRIPE', 'NOTCHPAY'] as const) {
    const spy = stub(true, { gateway: name });
    const code = await codeOf(submitGatewayOtp(spy.row, '123456', INVALID_STATE));
    assert(`${name} has no OTP step, so a code raises PAYMENT_OTP_NOT_REQUIRED`, () =>
      code === ERROR_CODES.PAYMENT_OTP_NOT_REQUIRED && spy.calls === 0);
  }

  mycoolpay.authorizePayment = realAuthorize;

  assert('My-CoolPay is still the only gateway implementing authorizePayment', () =>
    [...PAYMENT_GATEWAYS.entries()]
      .filter(([, g]) => typeof g.authorizePayment === 'function')
      .map(([n]) => n)
      .join(',') === 'MYCOOLPAY');

  section('4. Source scans — one copy of the rule, owner-scoped everywhere');

  assert('both billing rows carry an attempt counter', () =>
    BILLING_MODELS.every(({ code }) =>
      /otp_attempts: \{ type: Number, default: 0, min: 0 \}/.test(code)));

  // Two copies of an attempt cap on a money path are two chances to loosen one.
  assert('the cap is read in exactly one place in billing', () => {
    const sources = [RULE, TOPUP_SERVICE, PURCHASE_SERVICE, ...ROUTE_FILES.map((f) => f.code)];
    return (
      sources.filter((s) => s.includes('OTP_MAX_ATTEMPTS')).length === 1 &&
      RULE.includes('OTP_MAX_ATTEMPTS')
    );
  });

  // The whole justification for closing this endpoint where the payments
  // module's is open. A service that called the rule without scoping first
  // would be authenticated but not owner-scoped — worse than open, because it
  // reads as safe.
  assert('both services scope to the owner BEFORE submitting the code', () =>
    (
      [
        [TOPUP_SERVICE, 'authorizeTopup'],
        [PURCHASE_SERVICE, 'authorizePurchase'],
      ] as const
    ).every(([src, method]) => {
      const body = src.split(`async ${method}(`)[1]?.slice(0, 900) ?? '';
      const guard = body.indexOf('owner_id.toString() !== ownerId');
      const submit = body.indexOf('submitGatewayOtp');
      return guard > 0 && submit > 0 && guard < submit;
    }));

  assert('all three owner roles expose both authorize routes', () =>
    ROUTE_FILES.every(
      ({ code }) =>
        /router\.post\('\/plan-purchases\/:id\/authorize'/.test(code) &&
        /router\.post\('\/credits\/topups\/:id\/authorize'/.test(code)
    ));

  assert('every authorize route sits behind requireAuth and requireRole', () =>
    ROUTE_FILES.every(({ role, code }) => {
      const guards = code.indexOf('router.use(requireAuth)');
      // A literal `includes`, not a built RegExp: `no-restricted-syntax` bans a
      // bare `new RegExp()` repo-wide, and this needs no pattern anyway.
      const scoped = code.includes(`router.use(requireRole(['${role}']))`);
      const firstAuthorize = code.indexOf("/authorize'");
      return guards > 0 && scoped && firstAuthorize > guards;
    }));

  // The reason this suite exists. `authorizePayment` on the orchestrator must
  // stay the transaction path only — if it ever grows a billing fallback, the
  // unauthenticated endpoint silently starts accepting codes for these rows.
  assert('the payments orchestrator still resolves only PaymentTransaction', () => {
    const orchestrator = read('modules', 'payments', 'services', 'payment-orchestrator.service.ts');
    const body = orchestrator.split('async authorizePayment(')[1]?.slice(0, 1600) ?? '';
    return (
      body.includes('PaymentTransactionModel.findById(transactionId)') &&
      !/CreditTopup|PlanPurchase/.test(body)
    );
  });

  originalConsole.log(`\n${'═'.repeat(76)}`);
  originalConsole.log(`  ${passed} passed, ${failed} failed`);
  originalConsole.log(`${'═'.repeat(76)}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

void main();
