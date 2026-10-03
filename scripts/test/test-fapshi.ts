/**
 * test:fapshi — the Fapshi adapter, offline.
 *
 * What is asserted is what a reader cannot check by looking, and what fails quietly:
 *
 *   1. Conformance         — capabilities, and the members that must be ABSENT (refund, OTP)
 *   2. verifyWebhook       — the static secret: missing, wrong, right; the raw body
 *   3. Status mapping      — Fapshi's five words; unknown → PENDING
 *   4. ⛔ The forgery drill — a callback with the right secret claiming SUCCESSFUL is confirmed
 *                           against Fapshi's record, with the right service's credentials
 *   5. Calls on the wire   — the two header pairs, the direct-pay body, the status cache
 *   6. Payouts             — ⛔ the no-double-send lookup, 4xx refusals vs unknown outcomes
 *   7. Boot rules          — config/env.ts, against synthetic environments
 *   8. Source scans        — structural invariants
 *
 * DB-free and network-free: `fetch` is replaced by a scripted stub. Run: npm run test:fapshi
 */

// Before the first import: the pino console bridge otherwise swallows this suite's output.
process.env.LOG_STDOUT = 'false';

// Fixtures, set BEFORE the config module is imported, because it freezes at import.
const SECRET = 'fapshi-fixture-webhook-secret';
process.env.FAPSHI_API_USER = 'collect-user';
process.env.FAPSHI_API_KEY = 'collect-key';
process.env.FAPSHI_PAYOUT_API_USER = 'payout-user';
process.env.FAPSHI_PAYOUT_API_KEY = 'payout-key';
process.env.FAPSHI_WEBHOOK_SECRET = SECRET;
process.env.FAPSHI_BASE_URL = 'https://fapshi.test';
delete process.env.FAPSHI_PAYOUTS_ENABLED;

import { readFileSync } from 'fs';
import { join } from 'path';
import { originalConsole } from '../../src/core/logging/sink-guard';
import { AppError } from '../../src/core/errors';
import { ERROR_CODES } from '../../src/core/error-codes';
import { validateEnv } from '../../src/config/env';
import { mintMerchantRef } from '../../src/modules/payments/domain/merchant-reference';
import { directionOfEventType } from '../../src/modules/payments/domain/webhook-verification';
import { gatewayWebhookPath } from '../../src/modules/payments/gateways/gateway.interface';
import { PAYMENT_GATEWAYS, gatewaySupportsRefund, gatewaySupportsPayout } from '../../src/modules/payments/gateways/registry';
import {
  FapshiGateway,
  normalizeFapshiStatus,
  fapshiMedium,
  fapshiIdSafe,
  fapshiMerchantRef,
  fapshiEventFrom,
  fapshiPayoutVerdict,
} from '../../src/modules/payments/gateways/fapshi.gateway';

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

const isAppError = (e: any, code: string): boolean => e instanceof AppError && e.code === code;

(async () => {
  const gateway = new FapshiGateway();

  // ─── 1 ──────────────────────────────────────────────────────────────────────
  section('1. Conformance');

  assert('name is FAPSHI, and the registry holds this adapter', () =>
    gateway.name === 'FAPSHI' && PAYMENT_GATEWAYS.get('FAPSHI') instanceof FapshiGateway);
  assert('MTN and ORANGE are PUSH and require a phone number; MOOV and CARD are not declared', () => {
    const c = gateway.capabilities.collect;
    return c.MTN?.flow === 'PUSH' && c.ORANGE?.flow === 'PUSH'
      && c.MTN.requires.includes('phoneNumber') && c.ORANGE.requires.includes('phoneNumber')
      && c.MOOV === undefined && c.CARD === undefined;
  });
  assert('settlesAsync is true (the reconciliation sweep covers it)', () => gateway.capabilities.settlesAsync === true);
  assert('refundPayment is ABSENT → refunds route to the manual path', () =>
    typeof (gateway as any).refundPayment === 'undefined' && gatewaySupportsRefund('FAPSHI') === false);
  assert('authorizePayment is ABSENT (no OTP step)', () => typeof (gateway as any).authorizePayment === 'undefined');
  assert('confirmWebhookEvent is implemented (the secret covers no body field)', () =>
    typeof gateway.confirmWebhookEvent === 'function');
  assert('payouts are implemented but OFF by default (FAPSHI_PAYOUTS_ENABLED unset)', () =>
    typeof gateway.createPayout === 'function' && gatewaySupportsPayout('FAPSHI') === false);
  assert('the webhook path is /api/webhooks/fapshi', () => gatewayWebhookPath('FAPSHI') === '/api/webhooks/fapshi');

  // ─── 2 ──────────────────────────────────────────────────────────────────────
  section('2. verifyWebhook');

  const ourRef = mintMerchantRef('pt');
  const transId = 'll7J2fl4';
  const callback = {
    transId, status: 'SUCCESSFUL', medium: 'mobile money', serviceName: 'Wi-Mall', transType: 'Collection',
    amount: 500, revenue: 490, externalId: ourRef, dateInitiated: '2026-10-02', dateConfirmed: '2026-10-02',
  };
  const rawBody = Buffer.from(JSON.stringify(callback));

  const accepted = gateway.verifyWebhook({ rawBody, headers: { 'x-wh-secret': SECRET } });
  assert('the right secret in x-wh-secret and a JSON body is accepted', () => accepted.ok === true);
  assert('no x-wh-secret → missing_signature', () => {
    const v = gateway.verifyWebhook({ rawBody, headers: {} });
    return !v.ok && v.reason === 'missing_signature';
  });
  assert('a wrong secret → bad_signature', () => {
    const v = gateway.verifyWebhook({ rawBody, headers: { 'x-wh-secret': 'guess' } });
    return !v.ok && v.reason === 'bad_signature';
  });
  assert('a parsed (non-Buffer) body is unparsable — express.raw must be mounted', () => {
    const v = gateway.verifyWebhook({ rawBody: callback, headers: { 'x-wh-secret': SECRET } });
    return !v.ok && v.reason === 'unparsable';
  });
  assert('a non-JSON body is unparsable', () => {
    const v = gateway.verifyWebhook({ rawBody: Buffer.from('nope'), headers: { 'x-wh-secret': SECRET } });
    return !v.ok && v.reason === 'unparsable';
  });

  const parsed = accepted.ok ? gateway.parseWebhookEvent(accepted.payload) : null;
  assert('the parsed callback is a COLLECTION carrying our full jm_ reference (externalId fits as-is)', () =>
    parsed?.direction === 'collection' && parsed.merchantRef === ourRef && parsed.gatewayRef === transId);
  assert('transType Payout makes it a payout, whose event type reads as one', () => {
    const e = fapshiEventFrom({ ...callback, transType: 'Payout', externalId: mintMerchantRef('po') }, null);
    return e?.direction === 'payout' && directionOfEventType(e.eventType) === 'payout';
  });
  assert('with no transType, a jm_po_ reference decides payout', () =>
    fapshiEventFrom({ transId: 'x1', status: 'PENDING', externalId: mintMerchantRef('po') }, null)?.direction === 'payout');
  assert('a record with no transId parses to null', () => fapshiEventFrom({ status: 'SUCCESSFUL' }, null) === null);
  assert('a non-jm_ externalId is not taken as our reference', () =>
    fapshiMerchantRef({ externalId: 'ORDER-123' }) === null && fapshiMerchantRef({ externalId: ourRef }) === ourRef);

  // ─── 3 ──────────────────────────────────────────────────────────────────────
  section('3. Status mapping');

  assert('SUCCESSFUL → SUCCEEDED', () => normalizeFapshiStatus('SUCCESSFUL') === 'SUCCEEDED');
  assert('FAILED and EXPIRED → FAILED', () => normalizeFapshiStatus('FAILED') === 'FAILED' && normalizeFapshiStatus('EXPIRED') === 'FAILED');
  assert('CREATED and PENDING → PENDING', () => normalizeFapshiStatus('CREATED') === 'PENDING' && normalizeFapshiStatus('PENDING') === 'PENDING');
  assert('unknown and missing → PENDING (ignorance, never FAILED)', () =>
    ['WHATEVER', '', null, undefined].every((s) => normalizeFapshiStatus(s) === 'PENDING'));
  assert('medium: MTN → "mobile money", ORANGE → "orange money"', () =>
    fapshiMedium('MTN') === 'mobile money' && fapshiMedium('ORANGE') === 'orange money');
  assert('our jm_ references fit Fapshi\'s id rule; foreign shapes do not', () =>
    fapshiIdSafe(ourRef) && fapshiIdSafe(mintMerchantRef('po')) && !fapshiIdSafe('a b') && !fapshiIdSafe('x'.repeat(101)));

  // ─── 4 ──────────────────────────────────────────────────────────────────────
  section('4. ⛔ The forgery drill');

  // The secret is right; the body lies. Fapshi's own record says FAILED.
  const failedRecord = { ...callback, status: 'FAILED', amount: 500 };
  script([[/\/payment-status\//, () => ({ status: 200, body: failedRecord })]]);
  const confirmed = parsed ? await gateway.confirmWebhookEvent(parsed) : null;
  assert('⛔ a callback claiming SUCCESSFUL that Fapshi records as FAILED confirms FAILED', () =>
    confirmed?.status === 'FAILED' && confirmed.merchantRef === ourRef);
  assert('the confirmation read GET /payment-status/{transId} with the COLLECTION pair', () =>
    seen.length === 1 && seen[0].url === `https://fapshi.test/payment-status/${transId}`
      && seen[0].headers.apiuser === 'collect-user' && seen[0].headers.apikey === 'collect-key');
  assert('the confirmed event id is derived from the CONFIRMED status', () =>
    !!confirmed && !!parsed && confirmed.eventId !== parsed.eventId);

  script([[/\/payment-status\//, () => ({ status: 200, body: { ...callback, externalId: mintMerchantRef('pt') } })]]);
  const crossedRef = parsed ? await gateway.confirmWebhookEvent(parsed) : 'unreached';
  assert('a record naming a DIFFERENT externalId is refused (null)', () => crossedRef === null);

  script([[/\/payment-status\//, () => ({ status: 200, body: { ...callback, transType: 'Payout' } })]]);
  const crossedDirection = parsed ? await gateway.confirmWebhookEvent(parsed) : 'unreached';
  assert('a record in the OTHER direction is refused (a collection callback cannot settle a payout)', () =>
    crossedDirection === null);

  script([[/\/payment-status\//, () => ({ status: 404, body: { message: 'Transaction not found' } })]]);
  const unknown = parsed ? await gateway.confirmWebhookEvent(parsed) : 'unreached';
  script([[/\/payment-status\//, () => ({ status: 400, body: { message: 'Invalid request URL' } })]]);
  const malformed = parsed ? await gateway.confirmWebhookEvent(parsed) : 'unreached';
  assert('a transId Fapshi does not know is refused: 404 (unknown) or 400 (malformed), both measured', () =>
    unknown === null && malformed === null);

  script([[/\/payment-status\//, () => ({ status: 500, body: {} })]]);
  const outage = parsed ? await thrown(() => gateway.confirmWebhookEvent(parsed)) : null;
  assert('a Fapshi outage THROWS (route answers 5xx; the sweep settles it, Fapshi never resends)', () =>
    isAppError(outage, ERROR_CODES.FAPSHI_REQUEST_FAILED));

  script([[/\/payment-status\//, () => 'network-error']]);
  const unreachable = parsed ? await thrown(() => gateway.confirmWebhookEvent(parsed)) : null;
  assert('an unreachable Fapshi throws FAPSHI_UNREACHABLE', () => isAppError(unreachable, ERROR_CODES.FAPSHI_UNREACHABLE));

  const payoutRef = mintMerchantRef('po');
  const payoutCallback = { transId: 'po12345a', status: 'SUCCESSFUL', transType: 'Payout', amount: 100, externalId: payoutRef, userId: payoutRef };
  const payoutParsed = gateway.parseWebhookEvent(payoutCallback);
  script([[/\/payment-status\//, () => ({ status: 200, body: payoutCallback })]]);
  const payoutConfirmed = payoutParsed ? await gateway.confirmWebhookEvent(payoutParsed) : null;
  assert('a payout callback is confirmed with the PAYOUT pair and settles as a payout', () =>
    payoutConfirmed?.direction === 'payout' && payoutConfirmed.status === 'SUCCEEDED'
      && payoutConfirmed.merchantRef === payoutRef && seen[0]?.headers.apiuser === 'payout-user');

  // ─── 5 ──────────────────────────────────────────────────────────────────────
  section('5. Calls on the wire');

  script([[/\/direct-pay$/, () => ({ status: 200, body: { message: 'Request successful', transId: 'dp123456', dateInitiated: '2026-10-02' } })]]);
  const init = await gateway.initiatePayment({
    orderId: 'ORD-1', userId: '64f0c0ffee0000000000abcd', amount: 500, currency: 'XAF', merchantRef: ourRef,
    channel: { phoneNumber: '+237 6 70 00 00 00', customerName: 'Jean Dupont', customerEmail: 'not-an-email' },
  });
  const charge = seen.find((s) => s.url.endsWith('/direct-pay'));
  assert('direct-pay goes out with the COLLECTION apiuser/apikey headers', () =>
    charge?.headers.apiuser === 'collect-user' && charge.headers.apikey === 'collect-key' && charge.method === 'POST');
  assert('…the 9-digit national phone, the medium, an integer amount and our jm_ reference as externalId', () =>
    charge?.body.phone === '670000000' && charge.body.medium === 'mobile money'
      && charge.body.amount === 500 && charge.body.externalId === ourRef);
  assert('…the customer\'s userId and name; a malformed email is left out', () =>
    charge?.body.userId === '64f0c0ffee0000000000abcd' && charge.body.name === 'Jean Dupont' && !('email' in charge.body));
  assert('a direct-pay answers PENDING with Fapshi\'s transId and a USSD hint', () =>
    init.success && init.status === 'PENDING' && init.gatewayRef === 'dp123456' && init.instructions?.ussdCode === '*126#');

  script([[/\/direct-pay$/, () => ({ status: 403, body: { message: 'Direct pay is not activated for this service' } })]]);
  const disabled = await thrown(() => gateway.initiatePayment({
    orderId: 'o', userId: 'u', amount: 500, currency: 'XAF', merchantRef: ourRef, channel: { phoneNumber: '690000000' },
  }));
  assert('a 403 (direct pay not activated, or an IP off the whitelist) surfaces as FAPSHI_REQUEST_FAILED', () =>
    isAppError(disabled, ERROR_CODES.FAPSHI_REQUEST_FAILED));

  script([]);
  const badCurrency = await thrown(() => gateway.initiatePayment({
    orderId: 'o', userId: 'u', amount: 500, currency: 'EUR', merchantRef: ourRef, channel: { phoneNumber: '670000000' },
  }));
  assert('a non-XAF charge is refused before any call', () =>
    isAppError(badCurrency, ERROR_CODES.PAYMENT_CURRENCY_NOT_SUPPORTED) && seen.length === 0);
  const badNumber = await thrown(() => gateway.initiatePayment({
    orderId: 'o', userId: 'u', amount: 500, currency: 'XAF', merchantRef: ourRef, channel: { phoneNumber: '+33612345678' },
  }));
  assert('a number we cannot place is refused before any call', () =>
    isAppError(badNumber, ERROR_CODES.PAYMENT_OPERATOR_UNDETERMINED) && seen.length === 0);

  // The status cache: Fapshi allows 6 reads per minute per transId.
  const cached = new FapshiGateway();
  script([[/\/payment-status\//, () => ({ status: 200, body: { transId: 'pend0001', status: 'PENDING' } })]]);
  await cached.verifyPayment({ gatewayRef: 'pend0001' });
  await cached.verifyPayment({ gatewayRef: 'pend0001' });
  await cached.verifyPayment({ gatewayRef: 'pend0001' });
  assert('three quick verify polls of a PENDING charge reach Fapshi ONCE (rate limit: 6/min per transId)', () =>
    seen.length === 1);
  script([[/\/payment-status\//, () => ({ status: 200, body: { transId: 'pend0001', status: 'SUCCESSFUL' } })]]);
  const evt = gateway.parseWebhookEvent({ transId: 'pend0001', status: 'SUCCESSFUL', transType: 'Collection' })!;
  const fresh = await cached.confirmWebhookEvent(evt);
  assert('…but a webhook confirmation never uses the cache (it reads fresh)', () =>
    seen.length === 1 && fresh?.status === 'SUCCEEDED');

  script([[/\/payment-status\//, () => ({ status: 429, body: { message: 'Too many requests' } })]]);
  const limited = await new FapshiGateway().verifyPayment({ gatewayRef: 'pend0002' });
  assert('a 429 on verify is PENDING, never FAILED', () => limited.status === 'PENDING' && !limited.success);

  // ─── 6 ──────────────────────────────────────────────────────────────────────
  section('6. Payouts');

  script([[/\/balance$/, () => ({ status: 200, body: { service: 'payouts', balance: 15000, currency: 'XAF' } })]]);
  const float = await gateway.payoutBalance('XAF');
  assert('the balance is read with the PAYOUT pair', () =>
    float?.available === 15000 && seen[0]?.headers.apiuser === 'payout-user');
  script([]);
  const usd = await gateway.payoutBalance('USD');
  assert('a currency other than XAF has no Fapshi float: null, without calling Fapshi', () => usd === null && seen.length === 0);

  script([
    [/\/transaction\//, () => ({ status: 200, body: [] })],
    [/\/payout$/, () => ({ status: 200, body: { message: 'Request successful', transId: 'po999999', dateInitiated: '2026-10-02' } })],
  ]);
  const sent = await gateway.createPayout({ reference: payoutRef, amount: 100, currency: 'XAF', phone: '+237690000000', name: 'Test', description: 'Payout P-1' });
  const lookup = seen[0];
  const send = seen.find((s) => s.url.endsWith('/payout'));
  assert('⛔ before sending, earlier attempts are looked up: GET /transaction/{our reference} on the payout service', () =>
    lookup?.url === `https://fapshi.test/transaction/${payoutRef}` && lookup.method === 'GET' && lookup.headers.apiuser === 'payout-user');
  assert('the payout carries our reference as BOTH userId and externalId, the national phone and orange money', () =>
    send?.body.userId === payoutRef && send.body.externalId === payoutRef
      && send.body.phone === '690000000' && send.body.medium === 'orange money' && send.body.amount === 100);
  assert('an accepted payout is success + PENDING with Fapshi\'s transId, never settled on acceptance', () =>
    sent.success && sent.status === 'PENDING' && sent.gatewayRef === 'po999999');

  script([
    [/\/transaction\//, () => ({ status: 200, body: [{ transId: 'po111111', status: 'SUCCESSFUL', transType: 'Payout', externalId: payoutRef }] })],
    [/\/payout$/, () => ({ status: 200, body: { transId: 'SHOULD-NOT-SEND' } })],
  ]);
  const resent = await gateway.createPayout({ reference: payoutRef, amount: 100, currency: 'XAF', phone: '+237690000000', name: 'Test' });
  assert('⛔ a resend whose earlier attempt SUCCEEDED reports it and sends NOTHING', () =>
    resent.success && resent.status === 'SUCCEEDED' && resent.gatewayRef === 'po111111' && !seen.some((s) => s.url.endsWith('/payout')));

  script([
    [/\/transaction\//, () => ({ status: 200, body: [{ transId: 'po222222', status: 'PENDING', transType: 'Payout', externalId: payoutRef }] })],
    [/\/payout$/, () => ({ status: 200, body: { transId: 'SHOULD-NOT-SEND' } })],
  ]);
  const inFlight = await gateway.createPayout({ reference: payoutRef, amount: 100, currency: 'XAF', phone: '+237690000000', name: 'Test' });
  assert('⛔ a resend whose earlier attempt is still PENDING reports it and sends NOTHING', () =>
    inFlight.success && inFlight.status === 'PENDING' && inFlight.gatewayRef === 'po222222' && !seen.some((s) => s.url.endsWith('/payout')));

  script([
    [/\/transaction\//, () => ({ status: 200, body: [{ transId: 'po333333', status: 'FAILED', transType: 'Payout', externalId: payoutRef }] })],
    [/\/payout$/, () => ({ status: 200, body: { transId: 'po444444' } })],
  ]);
  const retried = await gateway.createPayout({ reference: payoutRef, amount: 100, currency: 'XAF', phone: '+237690000000', name: 'Test' });
  assert('a resend whose only earlier attempt FAILED is sent again', () =>
    retried.success && retried.gatewayRef === 'po444444' && seen.some((s) => s.url.endsWith('/payout')));

  script([
    [/\/transaction\//, () => ({ status: 404, body: { message: 'Not found' } })],
    [/\/payout$/, () => ({ status: 200, body: { transId: 'po555555' } })],
  ]);
  const fresh404 = await gateway.createPayout({ reference: payoutRef, amount: 100, currency: 'XAF', phone: '+237690000000', name: 'Test' });
  assert('a 404 from the lookup means "never sent" and the payout goes out', () => fresh404.success && fresh404.gatewayRef === 'po555555');

  script([
    [/\/transaction\//, () => 'network-error'],
    [/\/payout$/, () => ({ status: 200, body: { transId: 'SHOULD-NOT-SEND' } })],
  ]);
  const blindLookup = await gateway.createPayout({ reference: payoutRef, amount: 100, currency: 'XAF', phone: '+237690000000', name: 'Test' });
  assert('⛔ when the lookup cannot be made, NOTHING is sent and the answer is a retryable failure', () =>
    !blindLookup.success && !blindLookup.unsupported && /Nothing was sent/.test(blindLookup.message ?? '')
      && !seen.some((s) => s.url.endsWith('/payout')));

  script([
    [/\/transaction\//, () => ({ status: 200, body: [] })],
    [/\/payout$/, () => ({ status: 403, body: { message: 'Payout not enabled' } })],
  ]);
  const forbidden = await gateway.createPayout({ reference: payoutRef, amount: 100, currency: 'XAF', phone: '+237670000000', name: 'Test' });
  assert('a 403 on /payout is unsupported (not enabled live, wrong pair, or IP whitelist), nothing sent', () =>
    !forbidden.success && forbidden.unsupported === true && /enabled/.test(forbidden.message ?? ''));

  script([
    [/\/transaction\//, () => ({ status: 200, body: [] })],
    [/\/payout$/, () => ({ status: 400, body: { message: 'Insufficient balance' } })],
  ]);
  const badReq = await gateway.createPayout({ reference: payoutRef, amount: 100, currency: 'XAF', phone: '+237670000000', name: 'Test' });
  assert('a 400 on /payout is a refusal that sent nothing, carrying Fapshi\'s message', () =>
    !badReq.success && !badReq.unsupported && /Insufficient balance/.test(badReq.message ?? ''));

  script([
    [/\/transaction\//, () => ({ status: 200, body: [] })],
    [/\/payout$/, () => ({ status: 502, body: {} })],
  ]);
  const fault = await thrown(() => gateway.createPayout({ reference: payoutRef, amount: 100, currency: 'XAF', phone: '+237670000000', name: 'Test' }));
  assert('a 5xx on /payout THROWS (outcome unknown, stays processing)', () => isAppError(fault, ERROR_CODES.FAPSHI_REQUEST_FAILED));

  script([
    [/\/transaction\//, () => ({ status: 200, body: [] })],
    [/\/payout$/, () => 'network-error'],
  ]);
  const timeout = await thrown(() => gateway.createPayout({ reference: payoutRef, amount: 100, currency: 'XAF', phone: '+237670000000', name: 'Test' }));
  assert('no answer from /payout THROWS (outcome unknown)', () => isAppError(timeout, ERROR_CODES.FAPSHI_UNREACHABLE));

  script([]);
  const unplaceable = await gateway.createPayout({ reference: payoutRef, amount: 100, currency: 'XAF', phone: '+33612345678', name: 'T' });
  assert('a destination we cannot place is refused without calling Fapshi', () => unplaceable.unsupported === true && seen.length === 0);

  assert('payout verdict: our payout record → its status', () =>
    fapshiPayoutVerdict({ transId: 'p', status: 'SUCCESSFUL', transType: 'Payout', externalId: payoutRef }, payoutRef).status === 'SUCCEEDED');
  assert('payout verdict: a Collection record is PENDING + inconclusive, never acted on', () => {
    const v = fapshiPayoutVerdict({ transId: 'p', status: 'SUCCESSFUL', transType: 'Collection', externalId: payoutRef }, payoutRef);
    return v.status === 'PENDING' && !!v.inconclusive;
  });
  assert('payout verdict: another payout\'s record is PENDING + inconclusive', () =>
    !!fapshiPayoutVerdict({ transId: 'p', status: 'SUCCESSFUL', transType: 'Payout', externalId: mintMerchantRef('po') }, payoutRef).inconclusive);
  assert('payout verdict: a record stating neither type nor reference proves nothing', () =>
    !!fapshiPayoutVerdict({ transId: 'p', status: 'SUCCESSFUL' }, payoutRef).inconclusive);
  assert('payout verdict: FAILED carries Fapshi\'s reason', () =>
    fapshiPayoutVerdict({ transId: 'p', status: 'FAILED', transType: 'Payout', reason: 'Invalid account' }, payoutRef).reason === 'Invalid account');

  script([[/\/payment-status\//, () => ({ status: 200, body: { transId: 'po999999', status: 'SUCCESSFUL', transType: 'Payout', externalId: payoutRef } })]]);
  const swept = await gateway.verifyPayout({ gatewayRef: 'po999999', reference: payoutRef });
  assert('verifyPayout reads with the PAYOUT pair and returns the verdict', () =>
    swept.status === 'SUCCEEDED' && seen[0]?.headers.apiuser === 'payout-user');

  // ─── 7 ──────────────────────────────────────────────────────────────────────
  section('7. Boot rules (config/env.ts)');

  const base = { NODE_ENV: 'development' } as NodeJS.ProcessEnv;
  const problems = (env: Record<string, string>) => validateEnv({ ...base, ...env } as NodeJS.ProcessEnv);
  const errorOn = (env: Record<string, string>, variable: string) =>
    problems(env).some((p) => p.level === 'error' && p.variable === variable);
  const warningOn = (env: Record<string, string>, variable: string) =>
    problems(env).some((p) => p.level === 'warning' && p.variable === variable);
  const complete = { FAPSHI_API_USER: 'u', FAPSHI_API_KEY: 'k', FAPSHI_WEBHOOK_SECRET: 's' };

  assert('an apiuser without its apikey refuses the boot (both pairs)', () =>
    errorOn({ FAPSHI_API_USER: 'u', FAPSHI_WEBHOOK_SECRET: 's' }, 'FAPSHI_API_KEY')
      && errorOn({ ...complete, FAPSHI_PAYOUT_API_KEY: 'k2' }, 'FAPSHI_PAYOUT_API_USER'));
  assert('credentials without the webhook secret refuse a PRODUCTION boot', () =>
    errorOn({ NODE_ENV: 'production', FAPSHI_API_USER: 'u', FAPSHI_API_KEY: 'k' }, 'FAPSHI_WEBHOOK_SECRET'));
  assert('…and only warn in development (sandbox accounts cannot set a secret yet)', () =>
    warningOn({ FAPSHI_API_USER: 'u', FAPSHI_API_KEY: 'k' }, 'FAPSHI_WEBHOOK_SECRET')
      && !errorOn({ FAPSHI_API_USER: 'u', FAPSHI_API_KEY: 'k' }, 'FAPSHI_WEBHOOK_SECRET'));
  assert('a complete sandbox configuration in development raises nothing about Fapshi', () =>
    !problems(complete).some((p) => p.variable.startsWith('FAPSHI_')));
  assert('the SAME apiuser for collection and payout refuses the boot on LIVE (one service cannot do both)', () =>
    errorOn({ ...complete, FAPSHI_BASE_URL: 'https://live.fapshi.com', FAPSHI_PAYOUT_API_USER: 'u', FAPSHI_PAYOUT_API_KEY: 'k' }, 'FAPSHI_PAYOUT_API_USER'));
  assert('…but is allowed on the sandbox (a new account has a single sandbox pair)', () =>
    !errorOn({ ...complete, FAPSHI_PAYOUT_API_USER: 'u', FAPSHI_PAYOUT_API_KEY: 'k' }, 'FAPSHI_PAYOUT_API_USER'));
  assert('payouts enabled without the payout pair refuses the boot', () =>
    errorOn({ ...complete, FAPSHI_PAYOUTS_ENABLED: 'true' }, 'FAPSHI_PAYOUTS_ENABLED'));
  assert('production + the default (sandbox) base URL warns', () =>
    warningOn({ ...complete, NODE_ENV: 'production' }, 'FAPSHI_BASE_URL'));
  assert('production + the live base URL does not warn', () =>
    !warningOn({ ...complete, NODE_ENV: 'production', FAPSHI_BASE_URL: 'https://live.fapshi.com' }, 'FAPSHI_BASE_URL'));
  assert('FAPSHI_PAYOUTS_ENABLED=yes is refused (booleans are true|false|1|0)', () =>
    errorOn({ FAPSHI_PAYOUTS_ENABLED: 'yes' }, 'FAPSHI_PAYOUTS_ENABLED'));

  // ─── 8 ──────────────────────────────────────────────────────────────────────
  section('8. Source scans');

  const source = readFileSync(join(__dirname, '..', '..', 'src', 'modules', 'payments', 'gateways', 'fapshi.gateway.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert('the adapter defines no refundPayment (a stub would make the orchestrator guard dead)', () =>
    !/\brefundPayment\s*\(/.test(source));
  assert('the webhook secret is compared in constant time, never with ===', () =>
    source.includes('timingSafeEqualString(presented, secret)') && !/presented\s*===|===\s*secret/.test(source));
  assert('createPayout looks earlier attempts up BEFORE the POST /payout', () => {
    const body = source.slice(source.indexOf('async createPayout'));
    return body.indexOf('payoutsFor(') > -1 && body.indexOf('payoutsFor(') < body.indexOf("'/payout'");
  });
  assert('credential headers are never copied into error details', () => !/details[^;]*apikey/.test(source));

  originalConsole.log(`\n${'═'.repeat(76)}`);
  originalConsole.log(`  ${passed} passed, ${failed} failed`);
  originalConsole.log(`${'═'.repeat(76)}\n`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((error) => {
  originalConsole.error('  ❌ THROW: test:fapshi runner —', error);
  process.exit(1);
});
