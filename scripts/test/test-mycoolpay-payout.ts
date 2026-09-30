/**
 * test:mycoolpay-payout — My-CoolPay payouts (ADR-A08), offline. `fetch` is mocked; no key, no money.
 *
 *   1. Helpers      direction from transaction_type, the payout operator, the national number.
 *   2. createPayout "nothing was sent" (success:false) versus "outcome unknown" (throw), for every
 *                   branch: currency, network, the /balance pre-flight (timeout, 403, short float),
 *                   200, 202, a 4xx refusal, 409, 5xx, a transport failure, an unreadable 2xx.
 *   3. Balance      one XAF float; any other currency, or a failure, is null (never zero).
 *   4. Callbacks    a PAYOUT callback is direction 'payout'; confirmWebhookEvent refuses a record
 *                   of the other kind.
 *   5. verifyPayout the sweep's per-gateway check: PENDING + `inconclusive` unless it is a sure
 *                   verdict about THIS payout.
 *   6. The service  a send that throws after the claim stays `processing`, and the reason says
 *                   "outcome unknown", on the row and on the ticket.
 *   7. Config       default off, the boot rule, the template entry.
 *
 * Run: npm run test:mycoolpay-payout
 */

// The payment config reads its keys at IMPORT time: set them before anything below loads.
process.env.MYCOOLPAY_PUBLIC_KEY = 'mcp_public_fixture';
process.env.MYCOOLPAY_PRIVATE_KEY = 'mcp_private_fixture';
process.env.MYCOOLPAY_PAYOUTS_ENABLED = 'true';
process.env.MYCOOLPAY_BASE_URL = 'https://mcp.test/api';

/* eslint-disable @typescript-eslint/no-require-imports -- env fixtures must be set before these modules load */
import type { NormalizedWebhookEvent } from '../../src/modules/payments/domain/webhook-verification';

const { readFileSync } = require('fs') as typeof import('fs');
const { join } = require('path') as typeof import('path');
const { originalConsole } = require('../../src/core/logging/sink-guard');
const {
  MyCoolPayGateway,
  myCoolPayDirection,
  myCoolPayPayoutOperator,
  nationalCameroonNumber,
  DEFINITE_PAYOUT_REFUSALS,
} = require('../../src/modules/payments/gateways/mycoolpay.gateway');

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
    passed++;
    originalConsole.log(`  ✅ ${name}`);
  } else {
    failed++;
    originalConsole.error(`  ❌ FAIL: ${name}`);
  }
}

function section(title: string): void {
  originalConsole.log(`\n── ${title} ${'─'.repeat(Math.max(0, 72 - title.length))}`);
}

// ── A scripted fetch ─────────────────────────────────────────────────────────

interface Call { method: string; path: string; headers: Record<string, string>; body: any }
type Answer = { status: number; body: unknown } | 'timeout' | 'unreachable';

let calls: Call[] = [];
let script: Record<string, Answer> = {};

const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init: any) => {
  const method = String(init?.method ?? 'GET');
  const path = String(url).replace('https://mcp.test/api/mcp_public_fixture', '');
  calls.push({ method, path, headers: init?.headers ?? {}, body: init?.body ? JSON.parse(init.body) : null });
  const key = `${method} ${path.startsWith('/checkStatus/') ? '/checkStatus' : path}`;
  const answer = script[key];
  if (!answer || answer === 'unreachable') throw new TypeError('fetch failed');
  if (answer === 'timeout') {
    const e = new Error('This operation was aborted');
    e.name = 'AbortError';
    throw e;
  }
  return {
    status: answer.status,
    text: async () => JSON.stringify(answer.body),
  } as unknown as Response;
}) as typeof fetch;

function reset(next: Record<string, Answer>): void {
  calls = [];
  script = next;
}

const gateway = new MyCoolPayGateway();

const MTN = '+237670000000';
const ORANGE = '+237690000000';
const UNKNOWN_NETWORK = '+237222000000';
const REF = 'jm_po_' + 'a'.repeat(32);

const payout = (over: Record<string, unknown> = {}) => ({
  reference: REF,
  amount: 100,
  currency: 'XAF',
  phone: MTN,
  name: 'Fixture Owner',
  description: 'Payout XAF 100 to vendor',
  ...over,
});

const BALANCE_OK: Answer = { status: 200, body: { status: 'success', balance: 5000 } };
const posts = () => calls.filter((c) => c.path === '/payout');

type Outcome = { ok: true; value: any } | { ok: false; error: any };
async function run(fn: () => Promise<any>): Promise<Outcome> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  section('1. Helpers');

  assert('PAYOUT → payout; PAYIN, lower case or missing → collection unless it says payout', () =>
    myCoolPayDirection('PAYOUT') === 'payout' && myCoolPayDirection('payout') === 'payout'
    && myCoolPayDirection('PAYIN') === 'collection' && myCoolPayDirection(undefined) === 'collection');
  assert('MTN → CM_MOMO, Orange → CM_OM, an unknown prefix → null', () =>
    myCoolPayPayoutOperator(MTN) === 'CM_MOMO' && myCoolPayPayoutOperator(ORANGE) === 'CM_OM'
    && myCoolPayPayoutOperator(UNKNOWN_NETWORK) === null);
  assert('the number is sent as the nine national digits their docs use', () =>
    nationalCameroonNumber('+237670000000') === '670000000'
    && nationalCameroonNumber('237 67 00 00 000') === '670000000'
    && nationalCameroonNumber('670000000') === '670000000');
  assert('409 is NOT a definite refusal (a repeated reference may mean "already sent")', () =>
    !DEFINITE_PAYOUT_REFUSALS.has(409) && DEFINITE_PAYOUT_REFUSALS.has(400) && DEFINITE_PAYOUT_REFUSALS.has(403));
  assert('payoutAvailable: on with the flag and both keys', () => gateway.payoutAvailable() === true);

  // ───────────────────────────────────────────────────────────────────────────
  section('2. createPayout: "nothing was sent" versus "outcome unknown"');

  {
    reset({ 'GET /balance': BALANCE_OK, 'POST /payout': { status: 200, body: { status: 'success', message: 'Successful transaction !', transaction_ref: 'mcp-tr-1' } } });
    const out = await run(() => gateway.createPayout(payout()));
    const post = posts()[0];
    assert('200 → accepted: success, PENDING (not SUCCEEDED), their ref', () =>
      out.ok && out.value.success === true && out.value.status === 'PENDING' && out.value.gatewayRef === 'mcp-tr-1');
    assert('...after the /balance pre-flight', () => calls[0]?.path === '/balance' && calls[1]?.path === '/payout');
    assert('...both calls carry X-PRIVATE-KEY', () =>
      calls.every((c) => c.headers['X-PRIVATE-KEY'] === 'mcp_private_fixture'));
    assert('...the body: our reference, CM_MOMO, nine-digit number, XAF, the amount, no private key', () =>
      post?.body.app_transaction_ref === REF && post.body.transaction_operator === 'CM_MOMO'
      && post.body.customer_phone_number === '670000000' && post.body.transaction_currency === 'XAF'
      && post.body.transaction_amount === 100 && !('private_key' in post.body));
  }
  {
    reset({ 'GET /balance': BALANCE_OK, 'POST /payout': { status: 202, body: { status: 'success', message: 'Transaction in progress...', transaction_ref: 'mcp-tr-2' } } });
    const out = await run(() => gateway.createPayout(payout({ phone: ORANGE })));
    assert('202 → accepted the same way; an Orange number goes as CM_OM', () =>
      out.ok && out.value.success && out.value.gatewayRef === 'mcp-tr-2' && posts()[0]?.body.transaction_operator === 'CM_OM');
  }

  const refusedBeforeSending: Array<[string, Record<string, Answer>, Record<string, unknown>, boolean]> = [
    ['a non-XAF currency', { 'GET /balance': BALANCE_OK }, { currency: 'EUR' }, true],
    ['a number with no known network', { 'GET /balance': BALANCE_OK }, { phone: UNKNOWN_NETWORK }, true],
    ['a pre-flight TIMEOUT (the unregistered-IP symptom, measured live)', { 'GET /balance': 'timeout' }, {}, true],
    ['a pre-flight 403', { 'GET /balance': { status: 403, body: { status: 'error' } } }, {}, true],
    ['a float short of the amount', { 'GET /balance': { status: 200, body: { status: 'success', balance: 50 } } }, {}, false],
  ];
  for (const [label, next, over, unsupported] of refusedBeforeSending) {
    reset(next);
    const out = await run(() => gateway.createPayout(payout(over)));
    assert(`${label} → success:false${unsupported ? ', unsupported' : ''}, and NO payout call`, () =>
      out.ok && out.value.success === false && out.value.status === 'FAILED'
      && Boolean(out.value.unsupported) === unsupported && posts().length === 0);
  }
  {
    reset({ 'GET /balance': 'timeout' });
    const out = await run(() => gateway.createPayout(payout()));
    assert('the pre-flight timeout message names the IP registration and says nothing was sent', () =>
      out.ok && /IP/.test(out.value.message) && /Nothing was sent/i.test(out.value.message));
  }

  for (const [status, unsupported] of [[400, false], [422, false], [401, true], [403, true]] as const) {
    reset({ 'GET /balance': BALANCE_OK, 'POST /payout': { status, body: { status: 'error', message: `refused ${status}` } } });
    const out = await run(() => gateway.createPayout(payout()));
    assert(`payout call ${status} → a definite refusal: success:false with their message${unsupported ? ', unsupported' : ''}`, () =>
      out.ok && out.value.success === false && out.value.message === `refused ${status}`
      && Boolean(out.value.unsupported) === unsupported);
  }

  const unknownOutcomes: Array<[string, Answer]> = [
    ['a 409 (maybe a repeated reference that was already sent)', { status: 409, body: { status: 'error' } }],
    ['a 500', { status: 500, body: { status: 'error' } }],
    ['a timeout on the payout call itself', 'timeout'],
    ['an unreachable payout call', 'unreachable'],
    ['a 2xx with no transaction_ref', { status: 200, body: { status: 'success' } }],
    ['a 2xx that is not a success', { status: 200, body: { status: 'error', message: '?' } }],
  ];
  for (const [label, answer] of unknownOutcomes) {
    reset({ 'GET /balance': BALANCE_OK, 'POST /payout': answer });
    const out = await run(() => gateway.createPayout(payout()));
    assert(`${label} → THROWS (outcome unknown; the payout must stay processing)`, () => !out.ok);
  }

  // ───────────────────────────────────────────────────────────────────────────
  section('3. Balance');

  reset({ 'GET /balance': BALANCE_OK });
  const xaf = await gateway.payoutBalance('XAF', MTN);
  assert('XAF → { available, currency: XAF }, one float whatever the destination', () =>
    xaf?.available === 5000 && xaf?.currency === 'XAF');
  {
    reset({ 'GET /balance': BALANCE_OK });
    const eur = await gateway.payoutBalance('EUR');
    assert('EUR → null, no call made', () => eur === null && calls.length === 0);
    reset({ 'GET /balance': 'timeout' });
    const down = await gateway.payoutBalance('XAF');
    assert('a failure → null (unknown), never 0', () => down === null);
  }

  // ───────────────────────────────────────────────────────────────────────────
  section('4. Callbacks');

  const callback = (type: string, status: string) => ({
    application: 'mcp_public_fixture',
    app_transaction_ref: REF,
    transaction_ref: 'mcp-tr-9',
    transaction_type: type,
    transaction_amount: 100,
    transaction_currency: 'XAF',
    transaction_operator: 'CM_MOMO',
    transaction_status: status,
  });

  const payoutEvent: NormalizedWebhookEvent = gateway.parseWebhookEvent(callback('PAYOUT', 'SUCCESS'));
  const payinEvent: NormalizedWebhookEvent = gateway.parseWebhookEvent(callback('PAYIN', 'SUCCESS'));
  assert('a PAYOUT callback parses as direction payout, eventType PAYOUT.SUCCESS, our reference', () =>
    payoutEvent.direction === 'payout' && payoutEvent.eventType === 'PAYOUT.SUCCESS'
    && payoutEvent.merchantRef === REF && payoutEvent.status === 'SUCCEEDED');
  assert('a PAYIN callback is still a collection', () => payinEvent.direction === 'collection');

  {
    reset({ 'GET /checkStatus': { status: 200, body: { status: 'success', transaction_ref: 'mcp-tr-9', app_transaction_ref: REF, transaction_type: 'PAYIN', transaction_status: 'SUCCESS' } } });
    const confirmed = await gateway.confirmWebhookEvent(payoutEvent);
    assert('confirm: a PAYOUT callback whose record is a PAYIN → null (ignored)', () => confirmed === null);
  }
  {
    reset({ 'GET /checkStatus': { status: 200, body: { status: 'success', transaction_ref: 'mcp-tr-9', app_transaction_ref: REF, transaction_type: 'PAYOUT', transaction_status: 'FAILED' } } });
    const confirmed = await gateway.confirmWebhookEvent(payoutEvent);
    assert('confirm: the record is a PAYOUT → confirmed, with the RECORD\'s status (a forged SUCCESS is overruled)', () =>
      confirmed?.direction === 'payout' && confirmed.status === 'FAILED' && confirmed.eventType === 'PAYOUT.FAILED');
  }

  // ───────────────────────────────────────────────────────────────────────────
  section('5. verifyPayout (the payout sweep)');

  const verify = async (answer: Answer, reference: string | null = REF) => {
    reset({ 'GET /checkStatus': answer });
    return gateway.verifyPayout({ gatewayRef: 'mcp-tr-9', reference });
  };
  const record = (over: Record<string, unknown>) => ({
    status: 200,
    body: { status: 'success', transaction_ref: 'mcp-tr-9', app_transaction_ref: REF, transaction_type: 'PAYOUT', transaction_status: 'SUCCESS', ...over },
  });

  {
    const ok = await verify(record({}));
    assert('SUCCESS on a PAYOUT for this reference → SUCCEEDED, no inconclusive', () =>
      ok.status === 'SUCCEEDED' && ok.inconclusive === undefined && calls[0]?.path === '/checkStatus/mcp-tr-9');
    const fail = await verify(record({ transaction_status: 'FAILED', transaction_message: 'Insufficient funds' }));
    assert('FAILED → FAILED with their message as the reason', () => fail.status === 'FAILED' && fail.reason === 'Insufficient funds');
    const cancel = await verify(record({ transaction_status: 'CANCELED' }));
    assert('CANCELED → CANCELLED', () => cancel.status === 'CANCELLED' && Boolean(cancel.reason));
    const pending = await verify(record({ transaction_status: 'PENDING' }));
    assert('PENDING → PENDING, and it is not "inconclusive" (it was asked)', () =>
      pending.status === 'PENDING' && pending.inconclusive === undefined);
  }
  const leaveIt: Array<[string, Answer, string | null]> = [
    ['a PAYIN record', record({ transaction_type: 'PAYIN' }), REF],
    ['a record with no type', record({ transaction_type: undefined }), REF],
    ['another app_transaction_ref', record({ app_transaction_ref: 'jm_po_' + 'b'.repeat(32) }), REF],
    ['another transaction_ref', record({ transaction_ref: 'mcp-tr-OTHER' }), REF],
    ['an unrecognised status', record({ transaction_status: 'WEIRD' }), REF],
    ['a timeout', 'timeout', REF],
    ['a 500', { status: 500, body: {} }, REF],
  ];
  for (const [label, answer, reference] of leaveIt) {
    const out = await verify(answer, reference);
    assert(`${label} → PENDING ("leave it") with an inconclusive reason`, () =>
      out.status === 'PENDING' && typeof out.inconclusive === 'string' && out.inconclusive.length > 0);
  }
  {
    const noRef = await verify(record({}), null);
    assert('no reference of ours to compare → the verdict still stands', () => noRef.status === 'SUCCEEDED');
    reset({ 'GET /checkStatus': record({}) });
    await gateway.verifyPayout({ gatewayRef: 'mcp-tr-9', reference: REF });
    assert('the status check needs no X-PRIVATE-KEY (it is not behind the payout firewall)', () =>
      !('X-PRIVATE-KEY' in (calls[0]?.headers ?? {})));
  }

  // ───────────────────────────────────────────────────────────────────────────
  section('6. The payout service: an unknown outcome stays processing, and says so');

  {
    const { PayoutRequestService } = require('../../src/modules/earnings/services/payout-request.service');
    const {
      __resetPaymentSettingsCacheForTests,
      __setPaymentSettingsStoreForTests,
    } = require('../../src/modules/payments/services/payment-settings.service');
    const { DEFAULT_PAYMENT_SETTINGS } = require('../../src/modules/payments/domain/payment-routing');

    __setPaymentSettingsStoreForTests({
      ready: () => false, read: async () => null,
      create: async () => { throw new Error('not here'); }, compareAndSet: async () => null,
    });
    __resetPaymentSettingsCacheForTests({ ...DEFAULT_PAYMENT_SETTINGS, payout_aggregator: 'MYCOOLPAY' }, true);

    const row: Record<string, any> = {
      id: 'po1', _id: 'po1', status: 'pending', amount: 100, currency: 'XAF', owner_type: 'vendor',
      owner_id: { toString: () => 'owner1' }, requested_by_user_id: { toString: () => 'u1' },
      payout_method_snapshot: { method: 'mobile_money', mobile_money: { phone_number: MTN, account_name: 'Fixture' } },
      ticket_id: { toString: () => 'ticket1' }, transfer_reference: null, transfer_gateway: null,
      transfer_gateway_ref: null, transfer_failure_reason: null,
    };
    const notes: string[] = [];
    let failedWrites = 0;
    const repo = {
      findById: async () => row,
      beginTransfer: async (_id: string, ref: string, gw: string) => {
        row.status = 'processing'; row.transfer_reference ??= ref; row.transfer_gateway ??= gw; return row;
      },
      noteTransferOutcomeUnknown: async (_id: string, reason: string) => {
        if (row.status === 'processing') row.transfer_failure_reason = reason;
      },
      markTransferFailed: async (_id: string, reason: string) => {
        if (row.status !== 'processing') return null;
        failedWrites++; row.status = 'failed'; row.transfer_failure_reason = reason; return row;
      },
      setTransferGatewayRef: async () => undefined,
    };
    const service = new PayoutRequestService(repo, {}, {}, {}, {}, { createSystemNote: async (_t: string, n: string) => { notes.push(n); } });

    reset({ 'GET /balance': BALANCE_OK, 'POST /payout': 'timeout' });
    const out = await run(() => service.sendPayout('po1'));
    assert('the payout call timed out → sendPayout rethrows', () => !out.ok);
    assert('...the payout is still PROCESSING (no retry, no release is possible)', () => row.status === 'processing');
    assert('...stamped on MyCoolPay, with our reference', () => row.transfer_gateway === 'MYCOOLPAY' && typeof row.transfer_reference === 'string');
    assert('...the row\'s reason says OUTCOME UNKNOWN and names the dashboard and our reference', () =>
      /Outcome unknown/.test(row.transfer_failure_reason ?? '') && /dashboard/.test(row.transfer_failure_reason)
      && row.transfer_failure_reason.includes(row.transfer_reference));
    assert('...and the same reason is noted on the ticket', () => notes.some((n) => /Outcome unknown/.test(n)));
    assert('...and it was NEVER marked failed (that would let a retry or a reject through)', () => failedWrites === 0);

    row.status = 'pending'; row.transfer_reference = null; row.transfer_gateway = null; row.transfer_failure_reason = null;
    reset({ 'GET /balance': 'timeout' });
    const pre = await run(() => service.sendPayout('po1'));
    assert('a pre-flight timeout is NOT an unknown outcome: nothing was sent, so the payout is FAILED (retryable)', () =>
      pre.ok && row.status === 'failed' && failedWrites === 1
      && /IP/.test(row.transfer_failure_reason ?? '') && !/Outcome unknown/.test(row.transfer_failure_reason ?? '')
      && posts().length === 0);

    __setPaymentSettingsStoreForTests(null);
  }

  /**
   * ⚠ REPORTED, not asserted: the gap backend-b1 assigned to S4 (backend-47). A `processing`
   * payout that never got a gateway reference has no automatic exit (the sweep needs the
   * reference) and no manual one (markPaid / reject accept pending | failed only). Until that
   * lands, MYCOOLPAY_PAYOUTS_ENABLED stays false in production.
   */
  {
    const repoSrc = readFileSync(join(__dirname, '../../src/modules/earnings/repositories/payout-request.repository.ts'), 'utf8');
    const gapOpen = /MANUALLY_SETTLEABLE[^=]*=\s*\['pending',\s*'failed'\]/.test(repoSrc);
    originalConsole.log(gapOpen
      ? '  ⚠ OPEN (S4): no manual exit from `processing` for a payout with no gateway reference'
      : '  ℹ the manual-settle list changed: re-check the processing-exit gap and remove this note');
  }

  // ───────────────────────────────────────────────────────────────────────────
  section('7. Config');

  const read = (rel: string): string => readFileSync(join(__dirname, '../..', rel), 'utf8');
  const CONFIG = read('src/modules/payments/config/payments.config.ts');
  const ENV = read('src/config/env.ts');
  const EXAMPLE = read('.env.example');
  assert('MYCOOLPAY_PAYOUTS_ENABLED defaults to false', () =>
    CONFIG.includes("PAYOUTS_ENABLED: (process.env.MYCOOLPAY_PAYOUTS_ENABLED || 'false') === 'true'"));
  assert('the boot validator knows it is a boolean, and refuses it without both keys', () =>
    ENV.includes("'MYCOOLPAY_PAYOUTS_ENABLED'")
    && /get\('MYCOOLPAY_PAYOUTS_ENABLED'\) === 'true' && !\(has\('MYCOOLPAY_PUBLIC_KEY'\) && has\('MYCOOLPAY_PRIVATE_KEY'\)\)/.test(ENV));
  assert('.env.example documents it, off', () => EXAMPLE.includes('# MYCOOLPAY_PAYOUTS_ENABLED=false'));
}

main()
  .catch((err) => {
    originalConsole.error(`  ❌ THROW: suite — ${(err as Error).stack ?? err}`);
    failed++;
  })
  .finally(() => {
    globalThis.fetch = realFetch;
    originalConsole.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
  });
