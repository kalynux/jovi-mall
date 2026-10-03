/**
 * test:cinetpay — the CinetPay adapter (API v1), offline.
 *
 * What is asserted is what a reader cannot check by looking, and what fails quietly:
 *
 *   1. Conformance         — capabilities, and the members that must be ABSENT (refund, OTP)
 *   2. The merchant id     — our 38-char reference fits CinetPay's 30, and comes back EXACTLY
 *   3. verifyWebhook       — every refusal reason, JSON and form bodies, and the accept
 *   4. Status mapping      — CinetPay's words and codes; unknown → PENDING
 *   5. ⛔ The forgery drill — an unsigned notification is confirmed against CinetPay's record,
 *                           in the right direction, or refused
 *   6. Calls on the wire   — login, Bearer, the charge body, redirect vs push, token retries
 *   7. Payouts             — the transfer body, refusals that sent nothing, TRANSACTION_EXIST
 *   8. Boot rules          — config/env.ts, against synthetic environments
 *   9. Source scans        — structural invariants
 *
 * DB-free and network-free: `fetch` is replaced by a scripted stub. Run: npm run test:cinetpay
 */

// Before the first import: the pino console bridge otherwise swallows this suite's output.
process.env.LOG_STDOUT = 'false';

// Fixtures, set BEFORE the config module is imported, because it freezes at import.
process.env.CINETPAY_API_KEY = 'sk_test_fixture';
process.env.CINETPAY_API_PASSWORD = 'fixture-password';
process.env.CINETPAY_BASE_URL = 'https://cinetpay.test';
process.env.CINETPAY_NOTIFY_URL = 'https://api.example.test/api/webhooks/cinetpay';
process.env.CINETPAY_RETURN_URL = 'https://shop.example.test';
process.env.CINETPAY_FALLBACK_EMAIL = 'payments@example.test';
delete process.env.CINETPAY_PAYOUTS_ENABLED;
delete process.env.CINETPAY_DIRECT_PAY;

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
  CinetPayGateway,
  normalizeCinetpayStatus,
  cinetpayStatusOf,
  cinetpayTokenRejected,
  cinetpayPayoutRefusal,
  cinetpayTransferVerdict,
  parseCinetpayNotification,
  toCinetpayMerchantId,
  fromCinetpayMerchantId,
  cinetpayPhone,
  cinetpayPaymentMethod,
  cinetpayCustomerNames,
  cinetpayCustomerEmail,
} from '../../src/modules/payments/gateways/cinetpay.gateway';

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

const loginRoute: [RegExp, Route] = [
  /\/v1\/oauth\/login$/,
  () => ({ status: 200, body: { code: 200, status: 'OK', access_token: 'jwt-1', token_type: 'bearer', expires_in: 86400 } }),
];

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
  const gateway = new CinetPayGateway();

  // ─── 1 ──────────────────────────────────────────────────────────────────────
  section('1. Conformance');

  assert('name is CINETPAY, and the registry holds this adapter', () =>
    gateway.name === 'CINETPAY' && PAYMENT_GATEWAYS.get('CINETPAY') instanceof CinetPayGateway);
  assert('MTN and ORANGE are PUSH and require a phone number; MOOV and CARD are not declared', () => {
    const c = gateway.capabilities.collect;
    return c.MTN?.flow === 'PUSH' && c.ORANGE?.flow === 'PUSH'
      && c.MTN.requires.includes('phoneNumber') && c.ORANGE.requires.includes('phoneNumber')
      && c.MOOV === undefined && c.CARD === undefined;
  });
  assert('settlesAsync is true (the reconciliation sweep covers it)', () => gateway.capabilities.settlesAsync === true);
  assert('refundPayment is ABSENT (no refund API in v1) → refunds route to the manual path', () =>
    typeof (gateway as any).refundPayment === 'undefined' && gatewaySupportsRefund('CINETPAY') === false);
  assert('authorizePayment is ABSENT (no OTP step)', () => typeof (gateway as any).authorizePayment === 'undefined');
  assert('confirmWebhookEvent is implemented (the notification is unsigned)', () =>
    typeof gateway.confirmWebhookEvent === 'function');
  assert('payouts are implemented but OFF by default (CINETPAY_PAYOUTS_ENABLED unset)', () =>
    typeof gateway.createPayout === 'function' && gatewaySupportsPayout('CINETPAY') === false);
  assert('the webhook path is /api/webhooks/cinetpay', () => gatewayWebhookPath('CINETPAY') === '/api/webhooks/cinetpay');

  // ─── 2 ──────────────────────────────────────────────────────────────────────
  section('2. The merchant id (CinetPay caps merchant_transaction_id at 30)');

  const refs = (['pt', 'pp', 'ct', 'po'] as const).flatMap((k) => Array.from({ length: 50 }, () => mintMerchantRef(k)));
  assert('every freshly minted reference encodes to at most 30 characters', () =>
    refs.every((r) => (toCinetpayMerchantId(r)?.length ?? 99) <= 30));
  assert('…and decodes back to EXACTLY the original (200 random references, all four kinds)', () =>
    refs.every((r) => fromCinetpayMerchantId(toCinetpayMerchantId(r)) === r));
  assert('the edge values round-trip: all zeros and all f', () =>
    ['jm_pt_' + '0'.repeat(32), 'jm_po_' + 'f'.repeat(32)].every((r) => fromCinetpayMerchantId(toCinetpayMerchantId(r)) === r));
  assert('the kind survives encoding, so a payout id still reads as a payout', () =>
    toCinetpayMerchantId('jm_po_' + 'a'.repeat(32))!.startsWith('jmpo'));
  assert('a legacy or foreign reference does not encode (null), so it is never truncated', () =>
    toCinetpayMerchantId('NOTCH-1690000000000') === null && toCinetpayMerchantId('jm_pt_xyz') === null);
  assert('a value we could not have produced does not decode', () =>
    fromCinetpayMerchantId('MY-ORDER-001') === null
      && fromCinetpayMerchantId('jmzz' + '0'.repeat(25)) === null
      && fromCinetpayMerchantId('jmpt' + 'z'.repeat(25)) === null // > 128 bits
      && fromCinetpayMerchantId(42) === null);

  // ─── 3 ──────────────────────────────────────────────────────────────────────
  section('3. verifyWebhook');

  const ourRef = mintMerchantRef('pt');
  const ourId = toCinetpayMerchantId(ourRef)!;
  const txId = '4c9a7225819943fe9f1eab6ef5b573a5';
  const notification = {
    notify_token: '382a2329ae0647f896fa70283fa087cc',
    merchant_transaction_id: ourId,
    transaction_id: txId,
    user: { name: 'Doe John', email: 'john@example.test', phone_number: '+237670000000' },
  };
  const jsonBody = Buffer.from(JSON.stringify(notification));

  const accepted = gateway.verifyWebhook({ rawBody: jsonBody, headers: {} });
  assert('a JSON notification with a notify_token is accepted', () => accepted.ok === true);
  assert('a non-Buffer body is unparsable (express.raw not mounted)', () => {
    const v = gateway.verifyWebhook({ rawBody: notification, headers: {} });
    return !v.ok && v.reason === 'unparsable';
  });
  assert('garbage is unparsable', () => {
    const v = gateway.verifyWebhook({ rawBody: Buffer.from('not json at all'), headers: {} });
    return !v.ok && v.reason === 'unparsable';
  });
  assert('no notify_token → missing_signature', () => {
    const { notify_token: _omit, ...rest } = notification;
    const v = gateway.verifyWebhook({ rawBody: Buffer.from(JSON.stringify(rest)), headers: {} });
    return !v.ok && v.reason === 'missing_signature';
  });
  assert('a form-encoded notification parses to the same fields', () => {
    const form = Buffer.from(`notify_token=abc&merchant_transaction_id=${ourId}&transaction_id=${txId}`);
    const parsed = parseCinetpayNotification(form);
    return parsed?.notify_token === 'abc' && parsed.transaction_id === txId;
  });

  const parsed = accepted.ok ? gateway.parseWebhookEvent(accepted.payload) : null;
  assert('the parsed notification carries OUR full jm_ reference and CinetPay\'s id', () =>
    parsed?.merchantRef === ourRef && parsed.gatewayRef === txId && parsed.direction === 'collection');
  assert('…and a placeholder PENDING status: the notification states none', () => parsed?.status === 'PENDING');
  assert('a notification naming a merchant id that is not ours parses to null (ignored)', () =>
    gateway.parseWebhookEvent({ ...notification, merchant_transaction_id: 'MY-ORDER-001' }) === null);

  // ─── 4 ──────────────────────────────────────────────────────────────────────
  section('4. Status mapping');

  assert('SUCCESS → SUCCEEDED', () => normalizeCinetpayStatus('SUCCESS') === 'SUCCEEDED');
  assert('FAILED, EXPIRED, OTP_EXPIRED, INSUFFICIENT_BALANCE, USER_NOT_FOUND, USER_IS_BLOCKED → FAILED', () =>
    ['FAILED', 'EXPIRED', 'OTP_EXPIRED', 'INSUFFICIENT_BALANCE', 'USER_NOT_FOUND', 'USER_IS_BLOCKED']
      .every((s) => normalizeCinetpayStatus(s) === 'FAILED'));
  assert('INITIATED, PENDING, OTP_ERROR → PENDING', () =>
    ['INITIATED', 'PENDING', 'OTP_ERROR'].every((s) => normalizeCinetpayStatus(s) === 'PENDING'));
  assert('an unknown word, OK, TRANSACTION_EXIST and nothing → PENDING (ignorance, never FAILED)', () =>
    ['SOMETHING', 'OK', 'TRANSACTION_EXIST', '', null, undefined].every((s) => normalizeCinetpayStatus(s) === 'PENDING'));
  assert('a body with a code and no status word reads by code (100 → SUCCESS, 2010 → FAILED, 2011 → NOT_ALLOWED)', () =>
    cinetpayStatusOf({ code: 100 }) === 'SUCCESS' && cinetpayStatusOf({ code: 2010 }) === 'FAILED'
      && cinetpayStatusOf({ code: 2011 }) === 'NOT_ALLOWED');
  assert('a status word wins over the code', () => cinetpayStatusOf({ code: 200, status: 'ok' }) === 'OK');
  assert('expired and invalid tokens are recognised in a body', () =>
    cinetpayTokenRejected({ code: 1003 }) && cinetpayTokenRejected({ status: 'INVALID_TOKEN' }) && !cinetpayTokenRejected({ code: 200 }));

  // ─── 5 ──────────────────────────────────────────────────────────────────────
  section('5. ⛔ The forgery drill');

  // Anyone can POST a notification. What settles is CinetPay's own record, read back.
  const failedRecord = { code: 2010, status: 'FAILED', merchant_transaction_id: ourId, transaction_id: txId, description: 'declined' };
  script([loginRoute, [/\/v1\/payment\//, () => ({ status: 200, body: failedRecord })]]);
  const confirmedFailed = parsed ? await gateway.confirmWebhookEvent(parsed) : null;
  assert('a notification for a FAILED charge confirms FAILED — the body could not have claimed otherwise', () =>
    confirmedFailed?.status === 'FAILED' && confirmedFailed.merchantRef === ourRef);
  assert('the confirmation re-read GET /v1/payment/{CinetPay id}, with a Bearer token', () =>
    seen.some((s) => s.url.endsWith(`/v1/payment/${txId}`) && s.method === 'GET' && s.headers.Authorization === 'Bearer jwt-1'));

  const successRecord = { code: 100, status: 'SUCCESS', merchant_transaction_id: ourId, transaction_id: txId, amount: 500, currency: 'XAF' };
  script([loginRoute, [/\/v1\/payment\//, () => ({ status: 200, body: successRecord })]]);
  const confirmedOk = parsed ? await gateway.confirmWebhookEvent(parsed) : null;
  assert('a SUCCESS record confirms SUCCEEDED and carries the record\'s amount and currency', () =>
    confirmedOk?.status === 'SUCCEEDED' && confirmedOk.amount === 500 && confirmedOk.currency === 'XAF');
  assert('the confirmed event id differs from the notification\'s (dedup keys on the confirmed status)', () =>
    !!confirmedOk && !!parsed && confirmedOk.eventId !== parsed.eventId && confirmedOk.eventId !== confirmedFailed?.eventId);

  script([loginRoute, [/\/v1\/payment\//, () => ({ status: 200, body: { ...successRecord, amount: undefined } })]]);
  const noAmount = parsed ? await gateway.confirmWebhookEvent(parsed) : null;
  assert('a record with no amount confirms with amount null (the SDK\'s payment status has none)', () =>
    noAmount?.status === 'SUCCEEDED' && noAmount.amount === null);

  script([loginRoute, [/\/v1\/payment\//, () => ({ status: 200, body: { ...successRecord, merchant_transaction_id: toCinetpayMerchantId(mintMerchantRef('pt')) } })]]);
  const crossed = parsed ? await gateway.confirmWebhookEvent(parsed) : 'unreached';
  assert('a record naming a DIFFERENT merchant id is refused (null)', () => crossed === null);

  script([loginRoute, [/\/v1\/payment\//, () => ({ status: 200, body: { ...successRecord, transaction_id: 'another' } })]]);
  const otherTx = parsed ? await gateway.confirmWebhookEvent(parsed) : 'unreached';
  assert('a record naming a DIFFERENT CinetPay id is refused (null)', () => otherTx === null);

  script([loginRoute, [/\/v1\/payment\//, () => ({ status: 404, body: { code: 404, status: 'NOT_FOUND' } })]]);
  const unknown404 = parsed ? await gateway.confirmWebhookEvent(parsed) : 'unreached';
  script([loginRoute, [/\/v1\/payment\//, () => ({ status: 200, body: { code: 404, status: 'NOT_FOUND' } })]]);
  const unknown200 = parsed ? await gateway.confirmWebhookEvent(parsed) : 'unreached';
  // The shape CinetPay's sandbox ACTUALLY answers (verify:cinetpay R2, 2026-10-02).
  script([loginRoute, [/\/v1\/payment\//, () => ({ status: 422, body: { code: 404, status: 'NOT_FOUND', description: 'Not found' } })]]);
  const unknown422 = parsed ? await gateway.confirmWebhookEvent(parsed) : 'unreached';
  assert('an id CinetPay does not know is refused: HTTP 422 + code 404 (measured), HTTP 404, or code 404 in a 200', () =>
    unknown422 === null && unknown404 === null && unknown200 === null);
  script([loginRoute, [/\/v1\/payment\//, () => ({ status: 422, body: { code: 1004, status: 'INVALID_PARAMS' } })]]);
  const other422 = parsed ? await thrown(() => gateway.confirmWebhookEvent(parsed)) : null;
  assert('…but any OTHER 422 still throws (only "not found" is an answer)', () =>
    isAppError(other422, ERROR_CODES.CINETPAY_REQUEST_FAILED));

  script([loginRoute, [/\/v1\/payment\//, () => ({ status: 500, body: {} })]]);
  const outage = parsed ? await thrown(() => gateway.confirmWebhookEvent(parsed)) : null;
  assert('a CinetPay outage THROWS, so the route answers 5xx and the sweep backstops', () =>
    isAppError(outage, ERROR_CODES.CINETPAY_REQUEST_FAILED));

  script([loginRoute, [/\/v1\/payment\//, () => 'network-error']]);
  const unreachable = parsed ? await thrown(() => gateway.confirmWebhookEvent(parsed)) : null;
  assert('an unreachable CinetPay throws CINETPAY_UNREACHABLE', () => isAppError(unreachable, ERROR_CODES.CINETPAY_UNREACHABLE));

  // A TRANSFER notification: the direction comes from our reference kind, and so does the endpoint.
  const payoutRef = mintMerchantRef('po');
  const payoutId = toCinetpayMerchantId(payoutRef)!;
  const transferId = 'dc1f6d3d-432f-4333-924e-714df5e53dfa';
  const transferParsed = gateway.parseWebhookEvent({ notify_token: 't', merchant_transaction_id: payoutId, transaction_id: transferId });
  script([loginRoute, [/\/v1\/transfer\//, () => ({ status: 200, body: { code: 100, status: 'SUCCESS', merchant_transaction_id: payoutId, transaction_id: transferId, amount: '100', fee_amount: '2' } })]]);
  const transferConfirmed = transferParsed ? await gateway.confirmWebhookEvent(transferParsed) : null;
  assert('a payout notification is a PAYOUT, confirmed at /v1/transfer/{id}, SUCCEEDED, with our jm_po_ reference', () =>
    transferConfirmed?.direction === 'payout'
      && transferConfirmed.status === 'SUCCEEDED'
      && transferConfirmed.merchantRef === payoutRef
      && directionOfEventType(transferConfirmed.eventType) === 'payout'
      && seen.some((s) => s.url.endsWith(`/v1/transfer/${transferId}`))
      && !seen.some((s) => s.url.includes('/v1/payment/')));
  assert('a collection notification never reads /v1/transfer (checked above: payment path only)', () =>
    directionOfEventType(confirmedOk?.eventType) === 'collection');

  // ─── 6 ──────────────────────────────────────────────────────────────────────
  section('6. Calls on the wire');

  const initResponse = {
    code: 200, status: 'OK',
    payment_token: 'ptok', notify_token: 'ntok', transaction_id: txId, merchant_transaction_id: ourId,
    payment_url: 'https://secure.sandbox.cinetpay.net/payment/abc',
    details: { code: 2001, status: 'INITIATED', message: 'Confirmez sur votre téléphone', must_be_redirected: false },
  };
  const fresh = new CinetPayGateway();
  script([loginRoute, [/\/v1\/payment$/, () => ({ status: 200, body: initResponse })]]);
  const init = await fresh.initiatePayment({
    orderId: 'ORD-1', userId: 'u1', amount: 500, currency: 'XAF', merchantRef: ourRef,
    channel: { phoneNumber: '670000000', customerName: 'Jean' },
  });
  const login = seen[0];
  const charge = seen.find((s) => s.url.endsWith('/v1/payment'));
  assert('login posts api_key + api_password to /v1/oauth/login', () =>
    login?.url === 'https://cinetpay.test/v1/oauth/login'
      && login.body?.api_key === 'sk_test_fixture' && login.body?.api_password === 'fixture-password');
  assert('the charge is sent with `Authorization: Bearer <token>`', () => charge?.headers.Authorization === 'Bearer jwt-1');
  assert('the charge carries the ENCODED merchant id, an integer amount, XAF', () =>
    charge?.body.merchant_transaction_id === ourId && charge.body.amount === 500 && charge.body.currency === 'XAF');
  assert('…a +237 phone, MTN_CM for an MTN number, PUSH channel and direct_pay', () =>
    charge?.body.client_phone_number === '+237670000000' && charge.body.payment_method === 'MTN_CM'
      && charge.body.channel === 'PUSH' && charge.body.direct_pay === true);
  assert('…the configured notify, success and failed URLs', () =>
    charge?.body.notify_url === 'https://api.example.test/api/webhooks/cinetpay'
      && charge.body.success_url === 'https://shop.example.test' && charge.body.failed_url === 'https://shop.example.test');
  assert('…a padded surname and the fallback email for a customer with one name and no email', () =>
    charge?.body.client_first_name === 'Jean' && charge.body.client_last_name === 'Wi-Mall'
      && charge.body.client_email === 'payments@example.test');
  assert('a pushed charge answers PENDING with CinetPay\'s transaction id and no redirect', () =>
    init.success && init.status === 'PENDING' && init.gatewayRef === txId && !init.instructions?.redirectUrl);

  script([loginRoute, [/\/v1\/payment$/, () => ({ status: 200, body: { ...initResponse, details: { ...initResponse.details, must_be_redirected: true } } })]]);
  const redirected = await fresh.initiatePayment({
    orderId: 'ORD-1', userId: 'u1', amount: 500, currency: 'XAF', merchantRef: ourRef, channel: { phoneNumber: '+237690000000' },
  });
  assert('must_be_redirected hands the client CinetPay\'s page as redirectUrl (still PENDING)', () =>
    redirected.success && redirected.status === 'PENDING'
      && redirected.instructions?.redirectUrl === initResponse.payment_url);
  assert('an Orange number is sent as OM_CM', () => seen.find((s) => s.url.endsWith('/v1/payment'))?.body.payment_method === 'OM_CM');

  script([loginRoute, [/\/v1\/payment$/, () => ({ status: 200, body: { ...initResponse, details: { ...initResponse.details, status: 'SUCCESS' } } })]]);
  const instant = await fresh.initiatePayment({
    orderId: 'ORD-1', userId: 'u1', amount: 500, currency: 'XAF', merchantRef: ourRef, channel: { phoneNumber: '+237670000000' },
  });
  assert('even an immediate SUCCESS is reported PENDING: settlement comes from the confirmed path only', () =>
    instant.success && instant.status === 'PENDING');

  script([loginRoute, [/\/v1\/payment$/, () => ({ status: 200, body: { code: 1200, status: 'TRANSACTION_EXIST', description: 'La transaction existe déjà' } })]]);
  const refused = await fresh.initiatePayment({
    orderId: 'ORD-1', userId: 'u1', amount: 500, currency: 'XAF', merchantRef: ourRef, channel: { phoneNumber: '+237670000000' },
  });
  assert('an HTTP-200 body with an error code is a failed initiation carrying CinetPay\'s description', () =>
    !refused.success && refused.status === 'FAILED' && /existe/.test(refused.error ?? ''));

  script([loginRoute, [/\/v1\/payment$/, () => ({ status: 400, body: { code: 1004, status: 'INVALID_PARAMS', description: 'bad' } })]]);
  const http400 = await thrown(() => fresh.initiatePayment({
    orderId: 'ORD-1', userId: 'u1', amount: 500, currency: 'XAF', merchantRef: ourRef, channel: { phoneNumber: '+237670000000' },
  }));
  assert('an HTTP 4xx surfaces as CINETPAY_REQUEST_FAILED (external_service)', () =>
    isAppError(http400, ERROR_CODES.CINETPAY_REQUEST_FAILED));

  script([loginRoute]);
  const badCurrency = await thrown(() => fresh.initiatePayment({
    orderId: 'o', userId: 'u', amount: 10, currency: 'USD', merchantRef: ourRef, channel: { phoneNumber: '+237670000000' },
  }));
  assert('a non-XAF charge is refused before any call', () =>
    isAppError(badCurrency, ERROR_CODES.PAYMENT_CURRENCY_NOT_SUPPORTED) && seen.length === 0);
  const badNumber = await thrown(() => fresh.initiatePayment({
    orderId: 'o', userId: 'u', amount: 10, currency: 'XAF', merchantRef: ourRef, channel: { phoneNumber: '+33612345678' },
  }));
  assert('a number we cannot place is refused before any call', () =>
    isAppError(badNumber, ERROR_CODES.PAYMENT_OPERATOR_UNDETERMINED) && seen.length === 0);

  // Single flight: two calls at once on a cold gateway log in ONCE.
  const cold = new CinetPayGateway();
  script([loginRoute, [/\/v1\/payment\//, () => ({ status: 200, body: { code: 2002, status: 'PENDING', transaction_id: txId } })]]);
  await Promise.all([cold.verifyPayment({ gatewayRef: txId }), cold.verifyPayment({ gatewayRef: txId })]);
  assert('two concurrent calls on a cold gateway log in ONCE', () =>
    seen.filter((s) => s.url.endsWith('/v1/oauth/login')).length === 1);

  // An expired token in an HTTP-200 body → log in again, retry once with the NEW token.
  let logins = 0;
  let reads = 0;
  script([
    [/\/v1\/oauth\/login$/, () => ({ status: 200, body: { code: 200, status: 'OK', access_token: `jwt-${++logins}`, expires_in: 86400 } })],
    [/\/v1\/payment\//, (s) => (++reads === 1
      ? { status: 200, body: { code: 1003, status: 'EXPIRED_TOKEN', description: 'expired' } }
      : { status: 200, body: { code: 100, status: s.headers.Authorization === 'Bearer jwt-2' ? 'SUCCESS' : 'PENDING' } })],
  ]);
  const retried = await new CinetPayGateway().verifyPayment({ gatewayRef: txId });
  assert('an EXPIRED_TOKEN body refreshes the token and retries once, with the NEW token', () =>
    retried.status === 'SUCCEEDED' && logins === 2 && reads === 2);

  logins = 0;
  reads = 0;
  script([
    [/\/v1\/oauth\/login$/, () => ({ status: 200, body: { code: 200, status: 'OK', access_token: `jwt-${++logins}`, expires_in: 86400 } })],
    [/\/v1\/payment\//, () => (++reads === 1 ? { status: 401, body: {} } : { status: 200, body: { code: 100, status: 'SUCCESS' } })],
  ]);
  const retried401 = await new CinetPayGateway().verifyPayment({ gatewayRef: txId });
  assert('an HTTP 401 also refreshes and retries once', () => retried401.status === 'SUCCEEDED' && logins === 2 && reads === 2);

  script([[/\/v1\/oauth\/login$/, () => ({ status: 200, body: { code: 1005, status: 'INVALID_CREDENTIALS', description: 'bad creds' } })]]);
  const badLogin = await new CinetPayGateway().verifyPayment({ gatewayRef: txId });
  assert('a login with no token is a failed verification → PENDING, never FAILED', () =>
    badLogin.status === 'PENDING' && badLogin.success === false);

  script([[/\/v1\/oauth\/login$/, (s) => ({ status: 401, body: { echoed: s.body } })]]);
  const loginError = await thrown(() => new CinetPayGateway().payoutBalance('XAF'));
  assert('a refused login (401) never copies its body, which holds the api_password, into error details', () =>
    isAppError(loginError, ERROR_CODES.CINETPAY_REQUEST_FAILED)
      && !JSON.stringify(loginError.details ?? {}).includes('fixture-password'));

  script([loginRoute, [/\/v1\/payment\//, () => 'network-error']]);
  const blind = await new CinetPayGateway().verifyPayment({ gatewayRef: txId });
  assert('a verification that could not be performed is PENDING, never FAILED', () => blind.status === 'PENDING' && !blind.success);

  // ─── 7 ──────────────────────────────────────────────────────────────────────
  section('7. Payouts');

  script([loginRoute, [/\/v1\/balances$/, () => ({ status: 200, body: { code: 200, status: 'OK', available_balance: '249711.74', currency: 'XAF' } })]]);
  const float = await gateway.payoutBalance('XAF');
  const usdFloat = await gateway.payoutBalance('USD');
  assert('the balance is CinetPay\'s available_balance, as a number', () => float?.available === 249711.74 && float.currency === 'XAF');
  assert('a currency the account is not in has no float (null, never zero)', () => usdFloat === null);

  const transferPending = {
    code: 2002, status: 'PENDING', merchant_transaction_id: payoutId, transaction_id: transferId,
    notify_token: 'n', amount: '100', fee_amount: '0', phone_number: '+237690000000', currency: 'XAF',
  };
  script([loginRoute, [/\/v1\/transfer$/, () => ({ status: 200, body: transferPending })]]);
  const sent = await gateway.createPayout({ reference: payoutRef, amount: 100, currency: 'XAF', phone: '690000000', name: 'Test', description: 'Payout P-1' });
  const transferCall = seen.find((s) => s.url.endsWith('/v1/transfer'));
  assert('a transfer sends the encoded payout reference, +237 phone, OM_CM, an integer amount, the reason and notify URL', () =>
    transferCall?.body.merchant_transaction_id === payoutId && transferCall.body.phone_number === '+237690000000'
      && transferCall.body.payment_method === 'OM_CM' && transferCall.body.amount === 100
      && transferCall.body.reason === 'Payout P-1' && transferCall.body.notify_url === 'https://api.example.test/api/webhooks/cinetpay');
  assert('an accepted transfer is success + PENDING with CinetPay\'s id, never settled on acceptance', () =>
    sent.success && sent.status === 'PENDING' && sent.gatewayRef === transferId);

  script([loginRoute, [/\/v1\/transfer$/, () => ({ status: 403, body: { code: 2011, status: 'NOT_ALLOWED', description: 'IP not allowed' } })]]);
  const notAllowed = await gateway.createPayout({ reference: payoutRef, amount: 100, currency: 'XAF', phone: '+237670000000', name: 'T' });
  assert('NOT_ALLOWED (IP whitelist) is a refusal that sent nothing: unsupported, naming the whitelist', () =>
    !notAllowed.success && notAllowed.unsupported === true && /whitelist/.test(notAllowed.message ?? ''));

  script([loginRoute, [/\/v1\/transfer$/, () => ({ status: 200, body: { code: 2005, status: 'INSUFFICIENT_BALANCE', description: 'Solde insuffisant' } })]]);
  const short = await gateway.createPayout({ reference: payoutRef, amount: 100, currency: 'XAF', phone: '+237670000000', name: 'T' });
  assert('INSUFFICIENT_BALANCE in an HTTP-200 body is unsupported with balance copy', () =>
    !short.success && short.unsupported === true && /balance/.test(short.message ?? ''));

  // The shape the sandbox ACTUALLY answers (verify:cinetpay P1, 2026-10-02): the reason is nested.
  script([loginRoute, [/\/v1\/transfer$/, () => ({ status: 200, body: {
    code: 2010, status: 'FAILED', merchant_transaction_id: payoutId, transaction_id: `ER-T-1-${payoutId}`,
    amount: 100, fee_amount: 2, phone_number: '+237670070700', currency: 'XAF',
    details: { code: 2005, status: 'INSUFFICIENT_BALANCE', message: 'User has not enough balance to validate operation' },
  } })]]);
  const nested = await gateway.createPayout({ reference: payoutRef, amount: 100, currency: 'XAF', phone: '+237670070700', name: 'T' });
  assert('a top-level FAILED whose details say INSUFFICIENT_BALANCE (measured) is unsupported with balance copy', () =>
    !nested.success && nested.unsupported === true && /balance/.test(nested.message ?? ''));

  // A resend: CinetPay already holds this merchant id. Look it up rather than fail or send again.
  script([
    loginRoute,
    [/\/v1\/transfer$/, () => ({ status: 200, body: { code: 1200, status: 'TRANSACTION_EXIST', description: 'exists' } })],
    [/\/v1\/transfer\//, () => ({ status: 200, body: { ...transferPending, code: 100, status: 'SUCCESS' } })],
  ]);
  const resent = await gateway.createPayout({ reference: payoutRef, amount: 100, currency: 'XAF', phone: '+237690000000', name: 'T' });
  assert('⛔ TRANSACTION_EXIST on a resend reports the EXISTING transfer, never a failure (which could pay twice)', () =>
    resent.success && resent.status === 'SUCCEEDED' && resent.gatewayRef === transferId
      && seen.some((s) => s.url.endsWith(`/v1/transfer/${payoutId}`)));

  script([
    loginRoute,
    [/\/v1\/transfer$/, () => ({ status: 200, body: { code: 1200, status: 'TRANSACTION_EXIST' } })],
    [/\/v1\/transfer\//, () => ({ status: 404, body: { code: 404, status: 'NOT_FOUND' } })],
  ]);
  const lost = await thrown(() => gateway.createPayout({ reference: payoutRef, amount: 100, currency: 'XAF', phone: '+237690000000', name: 'T' }));
  assert('…and when the existing transfer cannot be read back, it THROWS (outcome unknown, stays processing)', () =>
    isAppError(lost, ERROR_CODES.CINETPAY_REQUEST_FAILED));

  script([loginRoute, [/\/v1\/transfer$/, () => ({ status: 500, body: {} })]]);
  const fault = await thrown(() => gateway.createPayout({ reference: payoutRef, amount: 100, currency: 'XAF', phone: '+237670000000', name: 'T' }));
  assert('an unexplained 5xx on a transfer THROWS rather than being called a refusal', () =>
    isAppError(fault, ERROR_CODES.CINETPAY_REQUEST_FAILED));

  script([loginRoute, [/\/v1\/transfer$/, () => 'network-error']]);
  const timeout = await thrown(() => gateway.createPayout({ reference: payoutRef, amount: 100, currency: 'XAF', phone: '+237670000000', name: 'T' }));
  assert('an unreachable CinetPay on a transfer THROWS (outcome unknown)', () => isAppError(timeout, ERROR_CODES.CINETPAY_UNREACHABLE));

  script([loginRoute, [/\/v1\/transfer$/, () => ({ status: 200, body: { code: 2002, status: 'PENDING' } })]]);
  const noId = await thrown(() => gateway.createPayout({ reference: payoutRef, amount: 100, currency: 'XAF', phone: '+237670000000', name: 'T' }));
  assert('an accepted-looking transfer with no transaction id THROWS (nothing to track it by)', () =>
    isAppError(noId, ERROR_CODES.CINETPAY_REQUEST_FAILED));

  script([loginRoute]);
  const unplaceable = await gateway.createPayout({ reference: payoutRef, amount: 100, currency: 'XAF', phone: '+33612345678', name: 'T' });
  assert('a destination we cannot place is refused without calling CinetPay', () =>
    unplaceable.unsupported === true && seen.length === 0);

  assert('the transfer verdict: our record → its status', () =>
    cinetpayTransferVerdict({ code: 100, status: 'SUCCESS', merchant_transaction_id: payoutId, transaction_id: transferId }, payoutRef).status === 'SUCCEEDED');
  assert('the transfer verdict: a record for ANOTHER payout is PENDING + inconclusive, never acted on', () => {
    const v = cinetpayTransferVerdict({ code: 100, status: 'SUCCESS', merchant_transaction_id: toCinetpayMerchantId(mintMerchantRef('po')), transaction_id: 'x' }, payoutRef);
    return v.status === 'PENDING' && !!v.inconclusive;
  });
  assert('the transfer verdict: NOT_FOUND and no record are PENDING + inconclusive', () =>
    !!cinetpayTransferVerdict({ code: 404, status: 'NOT_FOUND' }, payoutRef).inconclusive
      && !!cinetpayTransferVerdict(null, payoutRef).inconclusive);
  assert('the transfer verdict: FAILED carries a reason', () =>
    !!cinetpayTransferVerdict({ code: 2010, status: 'FAILED', merchant_transaction_id: payoutId, transaction_id: 'x' }, payoutRef).reason);

  script([loginRoute, [/\/v1\/transfer\//, () => 'network-error']]);
  const sweepBlind = await gateway.verifyPayout({ gatewayRef: transferId, reference: payoutRef });
  assert('verifyPayout that cannot reach CinetPay is PENDING + inconclusive', () =>
    sweepBlind.status === 'PENDING' && !!sweepBlind.inconclusive);

  assert('refusal table: a status that is not a definite refusal is null (so the caller decides)', () =>
    cinetpayPayoutRefusal('PENDING', '') === null && cinetpayPayoutRefusal(null, '') === null);

  // ─── helpers ────────────────────────────────────────────────────────────────
  assert('phone: national, 237… and +237 with spaces all become +237XXXXXXXXX; foreign is null', () =>
    cinetpayPhone('670000000') === '+237670000000' && cinetpayPhone('237670000000') === '+237670000000'
      && cinetpayPhone('+237 6 70 00 00 00') === '+237670000000' && cinetpayPhone('+33612345678') === null);
  assert('payment method: MTN → MTN_CM, ORANGE → OM_CM', () =>
    cinetpayPaymentMethod('MTN') === 'MTN_CM' && cinetpayPaymentMethod('ORANGE') === 'OM_CM');
  assert('names: two words split; none at all becomes Client Wi-Mall; a one-letter part is padded', () => {
    const two = cinetpayCustomerNames('Jean Paul Dupont');
    const none = cinetpayCustomerNames(undefined);
    const short = cinetpayCustomerNames('J D');
    return two.first === 'Jean' && two.last === 'Paul Dupont' && none.first === 'Client' && none.last === 'Wi-Mall'
      && short.first === 'Client' && short.last === 'Wi-Mall';
  });
  assert('email: a real one is kept, a malformed one is replaced by the fallback', () =>
    cinetpayCustomerEmail('a@b.cm', 'f@x.y') === 'a@b.cm' && cinetpayCustomerEmail('not-an-email', 'f@x.y') === 'f@x.y'
      && cinetpayCustomerEmail(undefined, 'f@x.y') === 'f@x.y');

  // ─── 8 ──────────────────────────────────────────────────────────────────────
  section('8. Boot rules (config/env.ts)');

  const base = { NODE_ENV: 'development' } as NodeJS.ProcessEnv;
  const problems = (env: Record<string, string>) => validateEnv({ ...base, ...env } as NodeJS.ProcessEnv);
  const errorOn = (env: Record<string, string>, variable: string) =>
    problems(env).some((p) => p.level === 'error' && p.variable === variable);
  const warningOn = (env: Record<string, string>, variable: string) =>
    problems(env).some((p) => p.level === 'warning' && p.variable === variable);
  const complete = {
    CINETPAY_API_KEY: 'sk_test_x', CINETPAY_API_PASSWORD: 'p',
    API_PUBLIC_URL: 'https://api.example.test', MAIL_SUPPORT_EMAIL: 'support@example.test',
  };

  assert('a key without its password refuses the boot', () => errorOn({ CINETPAY_API_KEY: 'sk_test_x' }, 'CINETPAY_API_PASSWORD'));
  assert('a password without its key refuses the boot', () => errorOn({ CINETPAY_API_PASSWORD: 'p' }, 'CINETPAY_API_KEY'));
  assert('a complete sandbox configuration in development raises nothing about CinetPay', () =>
    !problems(complete).some((p) => p.variable.startsWith('CINETPAY_')));
  assert('no API_PUBLIC_URL and no CINETPAY_NOTIFY_URL refuses the boot (no notification could arrive)', () =>
    errorOn({ CINETPAY_API_KEY: 'sk_test_x', CINETPAY_API_PASSWORD: 'p', MAIL_SUPPORT_EMAIL: 's@e.t', STOREFRONT_URL: 'https://s.e.t' }, 'CINETPAY_NOTIFY_URL'));
  assert('a notify URL over 120 characters refuses the boot', () =>
    errorOn({ ...complete, CINETPAY_NOTIFY_URL: `https://example.test/${'x'.repeat(120)}` }, 'CINETPAY_NOTIFY_URL'));
  assert('no fallback email anywhere refuses the boot', () =>
    errorOn({ CINETPAY_API_KEY: 'sk_test_x', CINETPAY_API_PASSWORD: 'p', API_PUBLIC_URL: 'https://api.example.test' }, 'CINETPAY_FALLBACK_EMAIL'));
  assert('a live key pointed at the sandbox host refuses the boot', () =>
    errorOn({ ...complete, CINETPAY_API_KEY: 'sk_live_x', CINETPAY_BASE_URL: 'https://api.cinetpay.net' }, 'CINETPAY_BASE_URL'));
  assert('a sandbox key pointed at the live host refuses the boot', () =>
    errorOn({ ...complete, CINETPAY_BASE_URL: 'https://api.cinetpay.co' }, 'CINETPAY_BASE_URL'));
  assert('a live key with no base URL is fine (derived to the live host)', () =>
    !errorOn({ ...complete, CINETPAY_API_KEY: 'sk_live_x' }, 'CINETPAY_BASE_URL'));
  assert('production + a sandbox key warns', () => warningOn({ ...complete, NODE_ENV: 'production' }, 'CINETPAY_API_KEY'));
  assert('a key with no recognised prefix warns', () => warningOn({ ...complete, CINETPAY_API_KEY: 'abc' }, 'CINETPAY_API_KEY'));
  assert('CINETPAY_PAYOUTS_ENABLED=yes is refused (booleans are true|false|1|0)', () =>
    errorOn({ CINETPAY_PAYOUTS_ENABLED: 'yes' }, 'CINETPAY_PAYOUTS_ENABLED'));
  assert('payouts enabled with no credential refuses the boot', () =>
    errorOn({ CINETPAY_PAYOUTS_ENABLED: 'true' }, 'CINETPAY_PAYOUTS_ENABLED'));

  // ─── 9 ──────────────────────────────────────────────────────────────────────
  section('9. Source scans');

  const read = (...parts: string[]) => readFileSync(join(__dirname, '..', '..', 'src', ...parts), 'utf8');
  const source = read('modules', 'payments', 'gateways', 'cinetpay.gateway.ts')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert('the adapter defines no refundPayment (a stub would make the orchestrator guard dead)', () =>
    !/\brefundPayment\s*\(/.test(source));
  assert('the login body never reaches error details (`body: isLogin ? null : parsed`)', () =>
    /body: isLogin \? null : parsed/.test(source));
  assert('initiatePayment never reports SUCCEEDED (only the confirmed path settles)', () => {
    const init = source.slice(source.indexOf('async initiatePayment'), source.indexOf('async verifyPayment'));
    return !/status: 'SUCCEEDED'/.test(init);
  });
  assert('the boot validator\'s default notify path is the registered webhook path', () =>
    read('config', 'env.ts').includes(`/api/webhooks/cinetpay`) && gatewayWebhookPath('CINETPAY') === '/api/webhooks/cinetpay');

  originalConsole.log(`\n${'═'.repeat(76)}`);
  originalConsole.log(`  ${passed} passed, ${failed} failed`);
  originalConsole.log(`${'═'.repeat(76)}\n`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((error) => {
  originalConsole.error('  ❌ THROW: test:cinetpay runner —', error);
  process.exit(1);
});
