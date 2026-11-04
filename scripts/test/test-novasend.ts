/**
 * test:novasend — the NovaSend adapter and its per-route amount limits, offline. What the adapter
 * expects of NovaSend is what the live test of 2026-11-04 proved, which differs from its docs.
 *
 * What is asserted is what a reader cannot check by looking, and what fails quietly:
 *
 *   1. Conformance          — capabilities (MTN and Orange both PUSH, both limited), and the
 *                            members that must be ABSENT (refund, OTP step, balance)
 *   2. verifyWebhook        — the HMAC over the body: missing, wrong, right (raw and re-serialised)
 *   3. Status mapping       — NovaSend's inconsistent words; unknown → PENDING
 *   4. Events + ⛔ forgery  — direction, refund records ignored, a signed SUCCESS re-read by NovaSend's id
 *   5. Pay-ins on the wire  — Basic auth, deterministic UUID idempotency key, no Orange code, Moon SARL, refusals
 *   6. Payouts              — the body, 4xx refusals vs unknown outcomes, read-back by id, 409 never resends
 *   7. Routing with NovaSend active — /options, no code asked for, the amount limits, the bot pre-check;
 *      and the dormant `CODE_FIRST` machinery, against a synthetic capability
 *   8. Bot copy             — `{ussd}` filled from the refusal, never blank
 *   9. Boot rules           — config/env.ts, against synthetic environments
 *  10. Source scans         — structural invariants
 *
 * DB-free and network-free: `fetch` is replaced by a scripted stub, the payment settings are a
 * seeded cache. Run: npm run test:novasend
 */

// Before the first import: the pino console bridge otherwise swallows this suite's output.
process.env.LOG_STDOUT = 'false';

// Fixtures, set BEFORE the config module is imported, because it freezes at import.
const SECRET = 'novasend-fixture-webhook-secret';
process.env.NOVASEND_API_KEY = 'ns-key';
process.env.NOVASEND_API_SECRET = 'ns-secret';
process.env.NOVASEND_WEBHOOK_SECRET = SECRET;
process.env.NOVASEND_BASE_URL = 'https://novasend.test';
process.env.NOVASEND_RETURN_URL = 'https://shop.test';
process.env.NOVASEND_SANDBOX_SCENARIO = 'completed';
// The seeded settings must not be refreshed from Mongo mid-suite.
process.env.PAYMENT_SETTINGS_CACHE_TTL_MS = '600000';
delete process.env.NOVASEND_PAYOUTS_ENABLED;

import crypto from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { originalConsole } from '../../src/core/logging/sink-guard';
import { AppError } from '../../src/core/errors';
import { ERROR_CODES } from '../../src/core/error-codes';
import { validateEnv } from '../../src/config/env';
import { mintMerchantRef } from '../../src/modules/payments/domain/merchant-reference';
import { gatewayWebhookPath } from '../../src/modules/payments/gateways/gateway.interface';
import { PAYMENT_GATEWAYS, gatewaySupportsRefund, gatewaySupportsPayout, buildRoutingFacts } from '../../src/modules/payments/gateways/registry';
import { DEFAULT_PAYMENT_SETTINGS, checkAmountLimits, effectiveProviders } from '../../src/modules/payments/domain/payment-routing';
import { __resetPaymentSettingsCacheForTests } from '../../src/modules/payments/services/payment-settings.service';
import {
  assertAmountWithinRoute,
  checkChargeRequestOrThrow,
  isCustomerChargeRefusal,
  resolveCollectionRoute,
} from '../../src/modules/payments/services/payment-routing.service';
import { buildPaymentOptions } from '../../src/modules/payments/services/payment-options.service';
import { PaymentChannelSchema, PaymentCodeSchema } from '../../src/modules/payments/validators/payment.validators';
import {
  mobileMoneyRoute,
  paymentCodeAsk,
  routeNeedsPreChargeFacts,
} from '../../src/modules/bot-surface/miniapp/surfaces/checkout-payer';
import { customerMessageFor } from '../../src/modules/bot-surface/domain/bot-error-copy';
import { handsetStepOf, instructionLines } from '../../src/modules/bot-surface/domain/checkout-chat-reply';
import { SENSITIVE_FIELD_NAMES } from '../../src/core/audit/redact';
import {
  NovaSendGateway,
  NOVASEND_CM_LIMITS,
  NOVASEND_PAYEE_NAME,
  normalizeNovasendStatus,
  novasendEventFrom,
  novasendIdempotencyKey,
  novasendInstructions,
  novasendMsisdn,
  novasendPayoutVerdict,
  novasendProvider,
  novasendReferenceSafe,
  novasendSignatureMatches,
} from '../../src/modules/payments/gateways/novasend.gateway';

let passed = 0;
let failed = 0;

function assert(name: string, fn: () => boolean): void {
  // Never an async callback: a Promise is always truthy.
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

// ─── The scripted fetch ──────────────────────────────────────────────────────

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
}
type Reply = { status: number; body: unknown } | 'network-error';
type Route = (seen: Seen) => Reply;

let seen: Seen[] = [];
let routes: Array<{ match: RegExp; reply: Route }> = [];

function script(table: Array<[RegExp, Route]>): void {
  seen = [];
  routes = table.map(([match, reply]) => ({ match, reply }));
}

globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input);
  const entry: Seen = {
    url,
    method: String(init?.method ?? 'GET'),
    headers: { ...(init?.headers ?? {}) },
    body: init?.body ? JSON.parse(String(init.body)) : undefined,
  };
  seen.push(entry);
  const route = routes.find((r) => r.match.test(url));
  const reply = route ? route.reply(entry) : { status: 599, body: { unscripted: url } };
  if (reply === 'network-error') throw new TypeError('fetch failed');
  return new Response(JSON.stringify(reply.body), { status: reply.status });
}) as typeof fetch;

async function thrown(fn: () => Promise<unknown>): Promise<any> {
  try {
    await fn();
    return null;
  } catch (error) {
    return error;
  }
}

function thrownSync(fn: () => unknown): any {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}

const isAppError = (e: any, code: string): boolean => e instanceof AppError && e.code === code;
const sign = (raw: string | Buffer, secret = SECRET) => crypto.createHmac('sha256', secret).update(raw).digest('hex');
const LIVE_ID = 'tr_fixture';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A NovaSend pay-in record, shaped like the docs' example. */
function payinRecord(reference: string, status: string, extra: Record<string, unknown> = {}) {
  return {
    id: LIVE_ID, type: 'payin', reference, status, confirmationRequired: false,
    confirmationStatus: 'none', paymentUrl: null, isDirect: true, payFee: false,
    createdAt: '2026-10-05T10:00:00.000Z', amount: 5000, fee: 80, chargedAmount: 5080,
    currency: 'XAF', failure: null, ...extra,
  };
}

const MTN = '+237670000000';
const ORANGE = '+237691550800';

(async () => {
  const gateway = new NovaSendGateway();

  // ─── 1 ──────────────────────────────────────────────────────────────────────
  section('1. Conformance');

  assert('name is NOVASEND, and the registry holds this adapter', () =>
    gateway.name === 'NOVASEND' && PAYMENT_GATEWAYS.get('NOVASEND') instanceof NovaSendGateway);
  assert('MTN is PUSH, needs a number, limited to 301–500,000', () => {
    const c = gateway.capabilities.collect.MTN;
    return c?.flow === 'PUSH' && c.requires.join() === 'phoneNumber' && c.limits?.min === 301 && c.limits?.max === 500_000;
  });
  assert('ORANGE is PUSH too: a number and nothing else, no code to dial for (live, 2026-11-04)', () => {
    const c = gateway.capabilities.collect.ORANGE;
    return c?.flow === 'PUSH' && c.requires.join() === 'phoneNumber' && c.codeUssd === undefined
      && c.limits?.min === 301 && c.limits?.max === 500_000;
  });
  assert('no CARD, settles asynchronously', () => !gateway.capabilities.collect.CARD && gateway.capabilities.settlesAsync);
  assert('refundPayment, authorizePayment and payoutBalance are ABSENT', () =>
    typeof (gateway as any).refundPayment === 'undefined'
      && typeof (gateway as any).authorizePayment === 'undefined'
      && typeof (gateway as any).payoutBalance === 'undefined'
      && !gatewaySupportsRefund('NOVASEND'));
  assert('payouts are implemented but OFF until NOVASEND_PAYOUTS_ENABLED', () =>
    typeof gateway.createPayout === 'function' && typeof gateway.verifyPayout === 'function'
      && !gatewaySupportsPayout('NOVASEND'));
  assert('the webhook path is derived, never listed: /api/webhooks/novasend', () =>
    gatewayWebhookPath('NOVASEND') === '/api/webhooks/novasend');
  assert('the routing facts call it configured (key pair + webhook secret)', () => buildRoutingFacts().NOVASEND.configured);

  // ─── 2 ──────────────────────────────────────────────────────────────────────
  section('2. verifyWebhook — HMAC-SHA256 over the body');

  const ref = mintMerchantRef('pt');
  const compact = JSON.stringify(payinRecord(ref, 'success'));
  const spaced = JSON.stringify(payinRecord(ref, 'success'), null, 2);

  assert('neither signature header → missing_signature', () => {
    const v = gateway.verifyWebhook({ rawBody: Buffer.from(compact), headers: {} });
    return !v.ok && v.reason === 'missing_signature';
  });
  assert('a signature on X-Webhook-Signature verifies (the docs\' header name)', () =>
    gateway.verifyWebhook({ rawBody: Buffer.from(compact), headers: { 'x-webhook-signature': sign(compact) } }).ok);
  assert('a wrong signature on X-Webhook-Signature → bad_signature, naming the header and not its value', () => {
    const forged = sign(compact, 'other');
    const v = gateway.verifyWebhook({ rawBody: Buffer.from(compact), headers: { 'x-webhook-signature': forged } });
    return !v.ok && v.reason === 'bad_signature' && v.detail === 'presented on x-webhook-signature' && !v.detail.includes(forged);
  });
  assert('both headers, one wrong → the good one still verifies, whichever it is', () =>
    gateway.verifyWebhook({ rawBody: Buffer.from(compact), headers: { 'x-signature-value': sign(compact, 'other'), 'x-webhook-signature': sign(compact) } }).ok
    && gateway.verifyWebhook({ rawBody: Buffer.from(compact), headers: { 'x-signature-value': sign(compact), 'x-webhook-signature': sign(compact, 'other') } }).ok);
  assert('both headers, both wrong → bad_signature', () => {
    const v = gateway.verifyWebhook({ rawBody: Buffer.from(compact), headers: { 'x-signature-value': sign(compact, 'other'), 'x-webhook-signature': sign(compact, 'another') } });
    return !v.ok && v.reason === 'bad_signature';
  });
  assert('the verified header is logged by NAME and its value is never logged', () => {
    const lines: string[] = [];
    const realInfo = console.info;
    console.info = (...args: unknown[]) => { lines.push(args.join(' ')); };
    const signature = sign(compact);
    try {
      gateway.verifyWebhook({ rawBody: Buffer.from(compact), headers: { 'x-webhook-signature': signature } });
    } finally {
      console.info = realInfo;
    }
    return lines.length === 1 && lines[0] === '[NOVASENDWebhook] signature verified on x-webhook-signature' && !lines[0].includes(signature);
  });
  assert('a signature made with another secret → bad_signature', () => {
    const v = gateway.verifyWebhook({ rawBody: Buffer.from(compact), headers: { 'x-signature-value': sign(compact, 'other') } });
    return !v.ok && v.reason === 'bad_signature';
  });
  assert('a signature over the RAW bytes verifies (the SDK\'s form)', () =>
    gateway.verifyWebhook({ rawBody: Buffer.from(spaced), headers: { 'x-signature-value': sign(spaced) } }).ok);
  assert('a signature over JSON.stringify(body) verifies (the docs\' form), even when the bytes are spaced', () =>
    gateway.verifyWebhook({ rawBody: Buffer.from(spaced), headers: { 'x-signature-value': sign(JSON.stringify(JSON.parse(spaced))) } }).ok);
  assert('an upper-case hex signature verifies', () =>
    gateway.verifyWebhook({ rawBody: Buffer.from(compact), headers: { 'x-signature-value': sign(compact).toUpperCase() } }).ok);
  assert('a body changed after signing → bad_signature', () => {
    const tampered = compact.replace('"success"', '"failed"');
    return !gateway.verifyWebhook({ rawBody: Buffer.from(tampered), headers: { 'x-signature-value': sign(compact) } }).ok;
  });
  assert('a parsed (non-Buffer) body → unparsable, never verified against re-serialised bytes', () => {
    const v = gateway.verifyWebhook({ rawBody: JSON.parse(compact), headers: { 'x-signature-value': sign(compact) } });
    return !v.ok && v.reason === 'unparsable';
  });
  assert('signature helper: raw match', () => novasendSignatureMatches(Buffer.from(compact), JSON.parse(compact), sign(compact), SECRET));

  // ─── 3 ──────────────────────────────────────────────────────────────────────
  section('3. Status mapping');

  assert('processing / pending / none / accepted → PENDING', () =>
    ['processing', 'pending', 'none', 'accepted', 'created'].every((w) => normalizeNovasendStatus(w) === 'PENDING'));
  assert('success / processed / completed → SUCCEEDED (case-insensitive)', () =>
    ['success', 'processed', 'COMPLETED', 'Successful'].every((w) => normalizeNovasendStatus(w) === 'SUCCEEDED'));
  assert('failed / expired / declined → FAILED; cancelled → CANCELLED', () =>
    ['failed', 'expired', 'declined', 'rejected'].every((w) => normalizeNovasendStatus(w) === 'FAILED')
      && normalizeNovasendStatus('canceled') === 'CANCELLED');
  assert('an unknown word is PENDING, never FAILED', () =>
    normalizeNovasendStatus('mystery') === 'PENDING' && normalizeNovasendStatus(undefined) === 'PENDING');

  // ─── 4 ──────────────────────────────────────────────────────────────────────
  section('4. Events, and ⛔ the forgery drill');

  const payoutRef = mintMerchantRef('po');
  assert('a payin record is a collection: our reference is the merchantRef, NovaSend\'s id the gatewayRef', () => {
    const e = novasendEventFrom(payinRecord(ref, 'success'), null);
    return e?.direction === 'collection' && e.merchantRef === ref && e.gatewayRef === LIVE_ID && e.status === 'SUCCEEDED' && e.currency === 'XAF';
  });
  assert('a payout record is a payout', () =>
    novasendEventFrom({ type: 'payout', reference: payoutRef, status: 'processed' }, null)?.direction === 'payout');
  assert('a record with no type falls back to our reference\'s kind (jm_po_ → payout, jm_rf_ → payout)', () =>
    novasendEventFrom({ reference: payoutRef, status: 'success' }, null)?.direction === 'payout'
      && novasendEventFrom({ reference: mintMerchantRef('rf'), status: 'success' }, null)?.direction === 'payout'
      && novasendEventFrom({ reference: ref, status: 'success' }, null)?.direction === 'collection');
  assert('a REFUND record is not acted on (the platform never calls NovaSend\'s refund)', () =>
    novasendEventFrom({ type: 'refund', reference: 'rf_x', status: 'completed' }, null) === null);
  assert('no reference → null', () => novasendEventFrom({ status: 'success' }, null) === null);
  assert('event ids: stable for one status, distinct across statuses', () => {
    const a = novasendEventFrom(payinRecord(ref, 'processing'), null)!.eventId;
    const b = novasendEventFrom(payinRecord(ref, 'processing'), null)!.eventId;
    const c = novasendEventFrom(payinRecord(ref, 'success'), null)!.eventId;
    return a === b && a !== c;
  });

  // A correctly-signed callback claims success; NovaSend's own record says it failed.
  const claimed = gateway.parseWebhookEvent(payinRecord(ref, 'success'))!;
  script([[/\/v1\/payin\//, () => ({ status: 200, body: payinRecord(ref, 'failed', { failure: { message: 'Insufficient funds' } }) })]]);
  const confirmed = await gateway.confirmWebhookEvent(claimed);
  assert('⛔ the record, not the callback, is what is acted on (SUCCESS claimed, FAILED recorded)', () =>
    confirmed?.status === 'FAILED' && seen[0]?.url.endsWith(`/v1/payin/${LIVE_ID}`) && seen[0]?.method === 'GET');

  script([[/\/v1\/payin\//, () => ({ status: 200, body: payinRecord(mintMerchantRef('pt'), 'success') })]]);
  const other = await gateway.confirmWebhookEvent(claimed);
  assert('another reference → null (nothing settles)', () => other === null);

  script([[/\/v1\/payin\//, () => ({ status: 200, body: { ...payinRecord(ref, 'success'), type: 'payout' } })]]);
  const crossed = await gateway.confirmWebhookEvent(claimed);
  assert('payin callback, payout record → null', () => crossed === null);

  script([[/\/v1\/payin\//, () => ({ status: 404, body: { code: 'transaction_does_not_exist' } })]]);
  const unknown = await gateway.confirmWebhookEvent(claimed);
  assert('a reference NovaSend does not know → null', () => unknown === null);

  script([[/\/v1\/payin\//, () => ({ status: 500, body: {} })]]);
  const outage = await thrown(() => gateway.confirmWebhookEvent(claimed));
  assert('NovaSend failing → THROWS (the webhook answers 5xx; the sweep is the backstop)', () =>
    isAppError(outage, ERROR_CODES.NOVASEND_REQUEST_FAILED));

  const payoutClaim = novasendEventFrom({ id: 'tr_payout', type: 'payout', reference: payoutRef, status: 'success' }, null)!;
  script([[/\/v1\/payout\//, () => ({ status: 200, body: { id: 'tr_payout', type: 'payout', reference: payoutRef, status: 'processed' } })]]);
  const payoutConfirmed = await gateway.confirmWebhookEvent(payoutClaim);
  assert('a payout callback is re-read on /v1/payout/{id}, the route live answers (never /v1/direct/payout)', () =>
    payoutConfirmed?.status === 'SUCCEEDED' && seen[0]?.url.endsWith('/v1/payout/tr_payout') && payoutConfirmed.merchantRef === payoutRef);

  const idless = gateway.parseWebhookEvent({ type: 'payin', reference: ref, status: 'success' })!;
  script([[/\/v1\/payin\//, () => ({ status: 404, body: { code: 'transaction_does_not_exist' } })]]);
  const idlessConfirmed = await gateway.confirmWebhookEvent(idless);
  assert('a notification with no id is looked up by reference, 404s as live does, and settles nothing (the sweep will)', () =>
    idless.gatewayRef === ref && idless.merchantRef === ref && idlessConfirmed === null);


  // ─── 5 ──────────────────────────────────────────────────────────────────────
  section('5. Pay-ins on the wire');

  assert('provider words: MTN → MOMO, ORANGE → ORANGE', () => novasendProvider('MTN') === 'MOMO' && novasendProvider('ORANGE') === 'ORANGE');
  assert('msisdn is E.164 (+237 + 9 digits), from any spelling of a CM number', () =>
    novasendMsisdn('670000000') === '+237670000000' && novasendMsisdn('+237 670 000 000') === '+237670000000'
      && novasendMsisdn('+33612345678') === null);
  assert('the idempotency key is a version-5 UUID, deterministic per reference and purpose', () => {
    const a = novasendIdempotencyKey('payin', ref);
    return UUID.test(a) && a === novasendIdempotencyKey('payin', ref)
      && a !== novasendIdempotencyKey('payout', ref) && a !== novasendIdempotencyKey('payin', mintMerchantRef('pt'));
  });
  assert('reference rule: 1–128 characters, no control characters', () =>
    novasendReferenceSafe(ref) && !novasendReferenceSafe('') && !novasendReferenceSafe('a'.repeat(129)) && !novasendReferenceSafe('a\nb'));

  const mtnRef = mintMerchantRef('pt');
  script([[/\/v1\/direct\/payin$/, () => ({ status: 201, body: payinRecord(mtnRef, 'processing') })]]);
  const mtn = await gateway.initiatePayment({
    orderId: 'o1', userId: 'u1', amount: 5000, currency: 'XAF', merchantRef: mtnRef,
    channel: { phoneNumber: MTN, phoneOperator: 'MTN', customerName: 'Ada' },
  });
  const sent = seen[0];
  assert('MTN: accepted as PENDING, gatewayRef = NovaSend\'s id, the only value its status route answers to', () =>
    mtn.success && mtn.status === 'PENDING' && mtn.gatewayRef === LIVE_ID);
  assert('MTN: Basic base64(KEY:SECRET), POST /v1/direct/payin', () =>
    sent?.method === 'POST' && sent.headers.Authorization === `Basic ${Buffer.from('ns-key:ns-secret').toString('base64')}`);
  assert('MTN: X-Idempotency-Key is the derived UUID for this reference', () =>
    sent?.headers['X-Idempotency-Key'] === novasendIdempotencyKey('payin', mtnRef));
  assert('MTN: the documented body — reference, customerName, payin{amount, msisdn, MOMO, CM}, action URLs', () =>
    sent?.body.reference === mtnRef && sent.body.customerName === 'Ada'
      && sent.body.payin.amount === 5000 && sent.body.payin.msisdn === MTN
      && sent.body.payin.provider === 'MOMO' && sent.body.payin.country === 'CM'
      && sent.body.payin.otp === undefined
      && sent.body.action.successUrl === 'https://shop.test/payment/success');
  assert('MTN: no sandboxScenario while the base URL is not the sandbox host', () => sent?.body.sandboxScenario === undefined);
  assert('MTN: instructions name the handset step, and no redirect', () =>
    mtn.instructions?.ussdCode === '*126#' && !mtn.instructions?.redirectUrl);
  assert('MTN: the customer is told who is asking, in the message and as data', () =>
    NOVASEND_PAYEE_NAME === 'Moon SARL' && mtn.instructions?.payeeName === 'Moon SARL' && (mtn.instructions?.message ?? '').includes('Moon SARL'));

  const orangeRef = mintMerchantRef('pt');
  script([[/\/v1\/direct\/payin$/, () => ({ status: 201, body: payinRecord(orangeRef, 'processing') })]]);
  const orange = await gateway.initiatePayment({
    orderId: 'o2', userId: 'u1', amount: 5000, currency: 'XAF', merchantRef: orangeRef,
    channel: { phoneNumber: ORANGE, phoneOperator: 'ORANGE' },
  });
  assert('ORANGE: charged with no code at all, provider ORANGE, no payin.otp (live, 2026-11-04)', () =>
    orange.success && seen[0]?.body.payin.provider === 'ORANGE' && !('otp' in seen[0].body.payin));
  assert('ORANGE: the customer is told to dial #150*50# and to look for Moon SARL', () =>
    orange.instructions?.ussdCode === '#150*50#' && orange.instructions?.payeeName === 'Moon SARL'
      && (orange.instructions?.message ?? '').includes('#150*50#') && (orange.instructions?.message ?? '').includes('Moon SARL'));
  assert('both messages fit the bot\'s 200-character instruction clip, so the name is never cut off', () =>
    (orange.instructions?.message ?? '').length <= 200 && (mtn.instructions?.message ?? '').length <= 200);

  const staleRef = mintMerchantRef('pt');
  script([[/\/v1\/direct\/payin$/, () => ({ status: 201, body: payinRecord(staleRef, 'processing') })]]);
  const stale = await gateway.initiatePayment({
    orderId: 'o3', userId: 'u1', amount: 5000, currency: 'XAF', merchantRef: staleRef,
    channel: { phoneNumber: ORANGE, phoneOperator: 'ORANGE', paymentCode: '1234' },
  });
  assert('ORANGE: a code a stale client still sends is ignored, neither forwarded nor echoed', () =>
    stale.success && !('otp' in seen[0].body.payin) && !JSON.stringify(seen[0].body).includes('1234') && !JSON.stringify(stale).includes('1234'));

  script([[/\/v1\/direct\/payin$/, () => ({ status: 400, body: { code: 'country_not_found', message: 'nope' } })]]);
  const other4xx = await thrown(() => gateway.initiatePayment({
    orderId: 'o5', userId: 'u1', amount: 5000, currency: 'XAF', merchantRef: mintMerchantRef('pt'),
    channel: { phoneNumber: ORANGE, phoneOperator: 'ORANGE' },
  }));
  assert('any other 4xx stays NOVASEND_REQUEST_FAILED (a 502, details kept for the row)', () =>
    isAppError(other4xx, ERROR_CODES.NOVASEND_REQUEST_FAILED) && other4xx.details?.status === 400);
  script([]);
  const tooMuch = await thrown(() => gateway.initiatePayment({
    orderId: 'o6', userId: 'u1', amount: 600_000, currency: 'XAF', merchantRef: mintMerchantRef('pt'),
    channel: { phoneNumber: MTN, phoneOperator: 'MTN' },
  }));
  assert('600,000 XAF → PAYMENT_AMOUNT_OUT_OF_RANGE, nothing sent', () =>
    isAppError(tooMuch, ERROR_CODES.PAYMENT_AMOUNT_OUT_OF_RANGE) && seen.length === 0 && tooMuch.details?.max === 500_000);

  const usd = await thrown(() => gateway.initiatePayment({
    orderId: 'o7', userId: 'u1', amount: 50, currency: 'USD', merchantRef: mintMerchantRef('pt'),
    channel: { phoneNumber: MTN, phoneOperator: 'MTN' },
  }));
  assert('a currency other than XAF is refused', () => isAppError(usd, ERROR_CODES.PAYMENT_CURRENCY_NOT_SUPPORTED));

  const failRef = mintMerchantRef('pt');
  script([[/\/v1\/direct\/payin$/, () => ({ status: 200, body: payinRecord(failRef, 'failed', { failure: { message: 'Number not registered' } }) })]]);
  const deadOnArrival = await gateway.initiatePayment({
    orderId: 'o8', userId: 'u1', amount: 5000, currency: 'XAF', merchantRef: failRef,
    channel: { phoneNumber: MTN, phoneOperator: 'MTN' },
  });
  assert('a pay-in NovaSend answers "failed" at once is success:false with its reason', () =>
    !deadOnArrival.success && deadOnArrival.status === 'FAILED' && /not registered/.test(deadOnArrival.error ?? ''));

  assert('instructions: paymentUrl becomes redirectUrl ONLY when confirmationRequired', () =>
    novasendInstructions('MTN', { confirmationRequired: true, paymentUrl: 'https://business.novasend.app/link/X' }).redirectUrl === 'https://business.novasend.app/link/X'
      && !novasendInstructions('MTN', { confirmationRequired: false, paymentUrl: 'https://business.novasend.app/link/X' }).redirectUrl
      && !novasendInstructions('MTN', { confirmationRequired: true, paymentUrl: 'javascript:alert(1)' }).redirectUrl);

  script([[/\/v1\/payin\//, () => ({ status: 200, body: payinRecord(mtnRef, 'processed', { amount: '301.00' }) })]]);
  const verified = await gateway.verifyPayment({ gatewayRef: LIVE_ID });
  assert('verifyPayment reads GET /v1/payin/{id}: processed → SUCCEEDED', () =>
    verified.status === 'SUCCEEDED' && seen[0]?.url.endsWith(`/v1/payin/${LIVE_ID}`));
  script([[/\/v1\/payin\//, () => 'network-error']]);
  const unreachable = await gateway.verifyPayment({ gatewayRef: LIVE_ID });
  assert('verifyPayment that cannot ask → PENDING, never FAILED', () => unreachable.status === 'PENDING');

  // ─── 6 ──────────────────────────────────────────────────────────────────────
  section('6. Payouts');

  const payoutInput = { reference: payoutRef, amount: 10_000, currency: 'XAF', phone: MTN, name: 'Vendor' };
  script([[/\/v1\/direct\/payout$/, () => ({ status: 201, body: { id: 'tr_payout', type: 'payout', reference: payoutRef, status: 'processing' } })]]);
  const sentPayout = await gateway.createPayout(payoutInput);
  assert('accepted: gatewayRef = NovaSend\'s id, status PENDING', () =>
    sentPayout.success && sentPayout.gatewayRef === 'tr_payout' && sentPayout.status === 'PENDING');
  assert('the documented body: reference, customerName, payout{amount, msisdn, MOMO, CM}', () =>
    seen[0]?.body.reference === payoutRef && seen[0].body.customerName === 'Vendor'
      && seen[0].body.payout?.amount === 10_000 && seen[0].body.payout?.msisdn === MTN
      && seen[0].body.payout?.provider === 'MOMO' && seen[0].body.payout?.country === 'CM');
  assert('the payout\'s idempotency key is derived from its reference (a retry presents the same one)', () =>
    seen[0]?.headers['X-Idempotency-Key'] === novasendIdempotencyKey('payout', payoutRef));

  script([[/\/v1\/direct\/payout$/, () => ({ status: 403, body: { code: 'wallet_not_enough_cash', message: 'Solde insuffisant' } })]]);
  const broke = await gateway.createPayout(payoutInput);
  assert('a 403 short float (as documented) is a refusal that sent nothing, worded for an administrator', () =>
    !broke.success && !broke.unsupported && /enough/.test(broke.message ?? ''));
  script([[/\/v1\/direct\/payout$/, () => ({ status: 403, body: { message: 'client_not_enough_cash' } })]]);
  const brokeByMessage = await gateway.createPayout(payoutInput);
  assert('a short float named only in `message` (how the SDK reads errors) is still a short float', () =>
    !brokeByMessage.success && !brokeByMessage.unsupported && /enough/.test(brokeByMessage.message ?? ''));

  script([[/\/v1\/direct\/payout$/, () => ({ status: 403, body: { code: 'api_token_invalid' } })]]);
  const forbidden = await gateway.createPayout(payoutInput);
  assert('a credential refusal is `unsupported` (credentials / account), nothing sent', () => !forbidden.success && forbidden.unsupported === true);
  script([[/\/v1\/direct\/payout$/, () => ({ status: 403, body: { message: 'transaction_error' } })]]);
  const txError = await gateway.createPayout(payoutInput);
  assert('any other 403 is a plain refusal naming NovaSend\'s code, not a credentials diagnosis', () =>
    !txError.success && !txError.unsupported && /transaction_error/.test(txError.message ?? '') && !/NOVASEND_API_KEY/.test(txError.message ?? ''));

  script([
    [/\/v1\/direct\/payout$/, () => ({ status: 409, body: { code: 'transaction_is_already_processed' } })],
    [/\/v1\/payout\//, () => ({ status: 200, body: { id: 'tr_payout', type: 'payout', reference: payoutRef, status: 'processed' } })],
  ]);
  const already = await gateway.createPayout(payoutInput);
  assert('a 409 whose record can be read reports it, with NovaSend\'s id — never sends twice', () =>
    already.success && already.status === 'SUCCEEDED' && already.gatewayRef === 'tr_payout' && seen.filter((s) => s.method === 'POST').length === 1);

  script([
    [/\/v1\/direct\/payout$/, () => ({ status: 409, body: { code: 'transaction_is_already_processed' } })],
    [/\/v1\/payout\//, () => ({ status: 404, body: { code: 'transaction_does_not_exist' } })],
  ]);
  const conflict = await thrown(() => gateway.createPayout(payoutInput));
  assert('a 409 whose record cannot be read (live: no id, and our reference is 404) THROWS: unknown, stays processing, never resends', () =>
    isAppError(conflict, ERROR_CODES.NOVASEND_REQUEST_FAILED) && seen.filter((s) => s.method === 'POST').length === 1);

  script([[/\/v1\/payout\//, () => ({ status: 200, body: { id: 'tr_payout', type: 'payout', reference: payoutRef, status: 'processed', amount: '301.00' } })]]);
  const swept = await gateway.verifyPayout({ gatewayRef: 'tr_payout', reference: payoutRef });
  assert('verifyPayout reads GET /v1/payout/{id}, preferring the id over our reference', () =>
    swept.status === 'SUCCEEDED' && swept.gatewayRef === 'tr_payout' && seen[0]?.url.endsWith('/v1/payout/tr_payout'));
  script([[/\/v1\/payout\//, () => ({ status: 404, body: { code: 'transaction_does_not_exist' } })]]);
  const unread = await gateway.verifyPayout({ gatewayRef: '', reference: payoutRef });
  assert('a payout with no stored id stays PENDING + inconclusive: a 404 never reads as failed, so it is never resent', () =>
    unread.status === 'PENDING' && !!unread.inconclusive);

  script([[/\/v1\/direct\/payout$/, () => ({ status: 502, body: {} })]]);
  const fault = await thrown(() => gateway.createPayout(payoutInput));
  assert('a 5xx THROWS (outcome unknown, stays processing)', () => isAppError(fault, ERROR_CODES.NOVASEND_REQUEST_FAILED));
  script([[/\/v1\/direct\/payout$/, () => 'network-error']]);
  const silent = await thrown(() => gateway.createPayout(payoutInput));
  assert('no answer THROWS (outcome unknown)', () => isAppError(silent, ERROR_CODES.NOVASEND_UNREACHABLE));

  script([]);
  const big = await gateway.createPayout({ ...payoutInput, amount: 750_000 });
  assert('a payout over 500,000 is refused `unsupported` without calling NovaSend', () =>
    !big.success && big.unsupported === true && seen.length === 0 && /500000/.test(big.message ?? ''));
  const foreign = await gateway.createPayout({ ...payoutInput, phone: '+33612345678' });
  assert('a destination we cannot place is refused without calling NovaSend', () => foreign.unsupported === true && seen.length === 0);

  assert('verdict: our payout record → its status', () =>
    novasendPayoutVerdict({ type: 'payout', reference: payoutRef, status: 'processed' }, payoutRef).status === 'SUCCEEDED');
  assert('verdict: a payin record is PENDING + inconclusive', () =>
    !!novasendPayoutVerdict({ type: 'payin', reference: payoutRef, status: 'success' }, payoutRef).inconclusive);
  assert('verdict: another payout\'s record is PENDING + inconclusive', () =>
    !!novasendPayoutVerdict({ type: 'payout', reference: mintMerchantRef('po'), status: 'success' }, payoutRef).inconclusive);
  assert('verdict: neither type nor reference proves nothing', () =>
    !!novasendPayoutVerdict({ status: 'success' }, payoutRef).inconclusive);
  assert('verdict: FAILED carries NovaSend\'s reason', () =>
    novasendPayoutVerdict({ type: 'payout', reference: payoutRef, status: 'failed', failure: { message: 'Invalid account' } }, payoutRef).reason === 'Invalid account');

  // ─── 7 ──────────────────────────────────────────────────────────────────────
  section('7. Routing with NovaSend active');

  __resetPaymentSettingsCacheForTests({ ...DEFAULT_PAYMENT_SETTINGS, collection_aggregator: 'NOVASEND' } as any, true);
  const effective = effectiveProviders({ ...DEFAULT_PAYMENT_SETTINGS, collection_aggregator: 'NOVASEND' } as any, buildRoutingFacts());
  const options = buildPaymentOptions(effective, null);
  const orangeOption = options.providers.find((p) => p.provider === 'ORANGE');
  const mtnOption = options.providers.find((p) => p.provider === 'MTN');
  assert('/options: ORANGE is PUSH, its only field is the number, no codeUssd', () =>
    orangeOption?.flow === 'PUSH' && orangeOption.fields.join() === 'phoneNumber' && orangeOption.codeUssd === undefined
      && orangeOption.mayRequireOtp === false);
  assert('/options: limits projected on both, from 301', () =>
    mtnOption?.limits?.max === 500_000 && orangeOption?.limits?.min === 301 && mtnOption.codeUssd === undefined);
  assert('/options: a capability field is never spread (no `requires` key on the wire)', () =>
    !('requires' in (orangeOption as object)));

  assert('ORANGE with the number alone passes the charge check', () =>
    checkChargeRequestOrThrow('ORANGE', { phoneNumber: ORANGE }, resolveCollectionRoute('ORANGE').capability).ok);

  // No gateway is CODE_FIRST today. The machinery stays for one that is, and is pinned against a capability built here.
  const codeFirst = { flow: 'CODE_FIRST', requires: ['phoneNumber', 'paymentCode'], codeUssd: '#144*82#' } as any;
  const codeRequired = thrownSync(() => checkChargeRequestOrThrow('ORANGE', { phoneNumber: ORANGE }, codeFirst));
  assert('dormant CODE_FIRST: the number but no code → 422 PAYMENT_CODE_REQUIRED {ussd, spent:false}', () =>
    isAppError(codeRequired, ERROR_CODES.PAYMENT_CODE_REQUIRED) && codeRequired.statusCode === 422
      && codeRequired.details?.ussd === '#144*82#' && codeRequired.details?.spent === false);
  assert('dormant CODE_FIRST: no number AND no code → the door\'s own missing-number answer', () => {
    const r = checkChargeRequestOrThrow('ORANGE', {}, codeFirst);
    return !r.ok && 'missing' in r && r.missing.join() === 'phoneNumber';
  });
  assert('dormant CODE_FIRST: with the code, the check passes', () =>
    checkChargeRequestOrThrow('ORANGE', { phoneNumber: ORANGE, paymentCode: '1234' }, codeFirst).ok);
  assert('MTN needs no code', () => checkChargeRequestOrThrow('MTN', { phoneNumber: MTN }, resolveCollectionRoute('MTN').capability).ok);

  assert('checkAmountLimits: inside / below / above', () => {
    const cap = resolveCollectionRoute('MTN').capability;
    return checkAmountLimits(cap, 500_000).ok && !checkAmountLimits(cap, 300).ok && checkAmountLimits(cap, 301).ok && !checkAmountLimits(cap, 500_001).ok;
  });
  const overLimit = thrownSync(() => assertAmountWithinRoute(resolveCollectionRoute('MTN'), 750_000));
  assert('assertAmountWithinRoute → 422 PAYMENT_AMOUNT_OUT_OF_RANGE {amount, min, max, spent:false}', () =>
    isAppError(overLimit, ERROR_CODES.PAYMENT_AMOUNT_OUT_OF_RANGE) && overLimit.statusCode === 422
      && overLimit.details?.amount === 750_000 && overLimit.details?.spent === false && /500,000 FCFA/.test(overLimit.message));

  assert('bot pre-check: Orange routes with no code, whether or not the caller asks about one', () =>
    mobileMoneyRoute(ORANGE, false).provider === 'ORANGE'
      && mobileMoneyRoute(ORANGE, false, null, { paymentCode: null }).provider === 'ORANGE'
      && mobileMoneyRoute(ORANGE, true, null, { paymentCode: '' }).provider === 'ORANGE');
  const preAmount = thrownSync(() => mobileMoneyRoute(MTN, false, null, { amount: 600_000 }));
  assert('bot pre-check: an amount over the limit → PAYMENT_AMOUNT_OUT_OF_RANGE, spent:false', () =>
    isAppError(preAmount, ERROR_CODES.PAYMENT_AMOUNT_OUT_OF_RANGE) && preAmount.details?.spent === false);
  assert('with NovaSend active the door still pre-checks the amount limits, and no bot asks for a code', () =>
    routeNeedsPreChargeFacts() && paymentCodeAsk() === null);

  __resetPaymentSettingsCacheForTests(DEFAULT_PAYMENT_SETTINGS, true);
  assert('…false / null with the default (NotchPay): no other aggregator\'s door does extra work', () =>
    !routeNeedsPreChargeFacts() && paymentCodeAsk() === null);

  assert('PaymentCodeSchema: 4–8 digits, spaces removed; letters refused', () =>
    PaymentCodeSchema.parse(' 12 34 ') === '1234' && !PaymentCodeSchema.safeParse('12a4').success
      && !PaymentCodeSchema.safeParse('123').success && !PaymentCodeSchema.safeParse('123456789').success);
  assert('the HTTP channel accepts `paymentCode`', () =>
    PaymentChannelSchema.parse({ phoneNumber: ORANGE, paymentCode: '1234' }).paymentCode === '1234');
  assert('`paymentCode` is a redacted field name in the audit log', () => SENSITIVE_FIELD_NAMES.has('paymentcode'));
  assert('these refusals are customer refusals; a provider failure is not', () =>
    isCustomerChargeRefusal(codeRequired) && isCustomerChargeRefusal(overLimit) && !isCustomerChargeRefusal(fault));
  assert('NOVASEND_CM_LIMITS is the declared range', () => NOVASEND_CM_LIMITS.min === 301 && NOVASEND_CM_LIMITS.max === 500_000);

  // ─── 8 ──────────────────────────────────────────────────────────────────────
  section('8. Bot copy');

  assert('PAYMENT_CODE_REQUIRED: the USSD from details is in the sentence, every language', () =>
    ['en', 'fr', 'pt', 'es', 'ar'].every((l) =>
      customerMessageFor(ERROR_CODES.PAYMENT_CODE_REQUIRED, 'business_rule', l, { ussd: '#144*82#' }).includes('#144*82#')));
  assert('no USSD in details → a worded fallback, never a blank or a literal {ussd}', () => {
    const t = customerMessageFor(ERROR_CODES.PAYMENT_CODE_REJECTED, 'business_rule', 'fr');
    return !t.includes('{ussd}') && t.includes('code de paiement Orange Money');
  });
  assert('a USSD value that is not *, # and digits is not substituted', () =>
    !customerMessageFor(ERROR_CODES.PAYMENT_CODE_REQUIRED, 'business_rule', 'en', { ussd: '<b>hi</b>' }).includes('<b>'));
  assert('PAYMENT_AMOUNT_OUT_OF_RANGE has its own sentence', () =>
    /support/i.test(customerMessageFor(ERROR_CODES.PAYMENT_AMOUNT_OUT_OF_RANGE, 'business_rule', 'en')));

  const orangeStep = novasendInstructions('ORANGE', {});
  assert('the chat relays the Orange step whole: the code to dial and Moon SARL', () => {
    const lines = instructionLines(orangeStep).join(' ');
    return lines.includes('#150*50#') && lines.includes('Moon SARL');
  });
  assert('the in-app checkout gets that step, and only from a gateway that names a payee', () =>
    handsetStepOf(orangeStep) === orangeStep.message
      && handsetStepOf({ message: 'Confirm the payment on your phone', ussdCode: '*126#' }) === null
      && handsetStepOf(null) === null);
  const pageFile = (name: string) => readFileSync(join(__dirname, '..', '..', 'src', 'modules', 'bot-surface', 'miniapp', 'public', name), 'utf8');
  assert('⛔ both in-app pages show the step and return before they close, or an Orange customer never learns to dial', () => {
    const co = pageFile('co.html');
    const bp = pageFile('bp.html');
    return co.indexOf('say(handsetStep, false);') > 0 && co.indexOf('say(handsetStep, false);') < co.indexOf('tg.close(); } catch', co.indexOf('say(handsetStep, false);'))
      && bp.indexOf('state(given.message, false);') > 0 && bp.indexOf('state(given.message, false);') < bp.indexOf('tg.close();', bp.indexOf('state(given.message, false);'));
  });

  // ─── 9 ──────────────────────────────────────────────────────────────────────
  section('9. Boot rules (config/env.ts)');

  const base = { NODE_ENV: 'development' } as NodeJS.ProcessEnv;
  const problems = (env: Record<string, string>) => validateEnv({ ...base, ...env } as NodeJS.ProcessEnv);
  const errorOn = (env: Record<string, string>, variable: string) =>
    problems(env).some((p) => p.level === 'error' && p.variable === variable);
  const warningOn = (env: Record<string, string>, variable: string) =>
    problems(env).some((p) => p.level === 'warning' && p.variable === variable);
  const complete = { NOVASEND_API_KEY: 'k', NOVASEND_API_SECRET: 's', NOVASEND_WEBHOOK_SECRET: 'w', STOREFRONT_URL: 'https://shop.test' };

  assert('a key without its secret (or the reverse) refuses the boot', () =>
    errorOn({ NOVASEND_API_KEY: 'k' }, 'NOVASEND_API_SECRET') && errorOn({ NOVASEND_API_SECRET: 's' }, 'NOVASEND_API_KEY'));
  assert('credentials without the webhook secret refuse a PRODUCTION boot, and warn in development', () =>
    errorOn({ NODE_ENV: 'production', NOVASEND_API_KEY: 'k', NOVASEND_API_SECRET: 's' }, 'NOVASEND_WEBHOOK_SECRET')
      && warningOn({ NOVASEND_API_KEY: 'k', NOVASEND_API_SECRET: 's' }, 'NOVASEND_WEBHOOK_SECRET'));
  assert('a complete sandbox configuration in development raises nothing about NovaSend', () =>
    !problems(complete).some((p) => p.variable.startsWith('NOVASEND_')));
  assert('payouts enabled without the key pair refuses the boot', () =>
    errorOn({ NOVASEND_PAYOUTS_ENABLED: 'true' }, 'NOVASEND_PAYOUTS_ENABLED'));
  assert('an unknown sandbox scenario refuses the boot', () =>
    errorOn({ ...complete, NOVASEND_SANDBOX_SCENARIO: 'maybe' }, 'NOVASEND_SANDBOX_SCENARIO'));
  assert('production + the default (sandbox) base URL warns; the live host does not', () =>
    warningOn({ ...complete, NODE_ENV: 'production' }, 'NOVASEND_BASE_URL')
      && !warningOn({ ...complete, NODE_ENV: 'production', NOVASEND_BASE_URL: 'https://business.novasend.app' }, 'NOVASEND_BASE_URL'));
  assert('NOVASEND_PAYOUTS_ENABLED=yes is refused (booleans are true|false|1|0)', () =>
    errorOn({ NOVASEND_PAYOUTS_ENABLED: 'yes' }, 'NOVASEND_PAYOUTS_ENABLED'));

  // ─── 10 ─────────────────────────────────────────────────────────────────────
  section('10. Source scans');

  const strip = (text: string) => text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  const src = (...parts: string[]) => strip(readFileSync(join(__dirname, '..', '..', 'src', ...parts), 'utf8'));
  const adapter = src('modules', 'payments', 'gateways', 'novasend.gateway.ts');
  assert('the adapter defines no refundPayment (a stub would make the orchestrator guard dead)', () =>
    !/\brefundPayment\s*\(/.test(adapter));
  assert('the signature is compared in constant time, never with ===', () =>
    adapter.includes('timingSafeEqualString(given, overRaw)') && !/given\s*===|===\s*overRaw/.test(adapter));
  assert('the adapter never sends an otp, and has no route left on /v1/direct/payout/{…}', () =>
    !/\botp\b/.test(adapter) && !/\/v1\/direct\/payout\/\$\{/.test(adapter));
  assert('the request body is never put into error details', () =>
    !/details[^;]*\bbody:\s*body\b/.test(adapter) && !/\{\s*status:\s*response\.status,\s*body:\s*body/.test(adapter));
  assert('sandboxScenario is only ever added through the sandbox-host guard', () =>
    (adapter.match(/sandboxScenario\s*=/g) ?? []).length === 1 && adapter.includes('NOVASEND_SANDBOX_BASE_URL'));
  const orchestrator = src('modules', 'payments', 'services', 'payment-orchestrator.service.ts');
  assert('every charge method passes its amount into route() (5 sites), none calls route() bare', () =>
    (orchestrator.match(/charge\.route\(\w[\w.]*\)/g) ?? []).length === 5 && !/charge\.route\(\)/.test(orchestrator));
  assert('every charge method lets customer refusals through before folding into PAYMENT_INITIATION_FAILED', () =>
    (orchestrator.match(/isCustomerChargeRefusal\(error\)\) throw error/g) ?? []).length === 5);

  originalConsole.log(`\n${'═'.repeat(76)}`);
  originalConsole.log(`  ${passed} passed, ${failed} failed`);
  originalConsole.log(`${'═'.repeat(76)}\n`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((error) => {
  originalConsole.error('  ❌ THROW: test:novasend runner —', error);
  process.exit(1);
});
