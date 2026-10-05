/**
 * test:pawapay — the PawaPay adapter, offline.
 *
 * What is asserted is what a reader cannot check by looking, and what fails quietly:
 *
 *   1. Conformance          — capabilities, and the members that must be ABSENT (refund, OTP)
 *   2. Derived ids          — deterministic, UUIDv4-shaped, distinct per purpose / reference / attempt
 *   3. Status mapping       — PawaPay's words; unknown → PENDING
 *   4. Deposits on the wire — the body, ACCEPTED / DUPLICATE_IGNORED, every refusal, ⛔ unknown outcomes
 *   5. verifyPayment        — FOUND / NOT_FOUND / unreachable
 *   6. ⛔ Signatures         — RFC 9421, against a locally generated key pair and an
 *                            INDEPENDENTLY built signature base
 *   7. ⛔ The forgery drill  — a signed callback claiming COMPLETED is replaced by PawaPay's record
 *   8. Payouts              — `recipient`, refusals vs unknown outcomes, ⛔ the FAILED-id walk
 *   9. Boot rules           — config/env.ts, against synthetic environments
 *  10. Source scans         — structural invariants
 *
 * DB-free and network-free: `fetch` is replaced by a scripted stub. Run: npm run test:pawapay
 */

// Before the first import: the pino console bridge otherwise swallows this suite's output.
process.env.LOG_STDOUT = 'false';

// Fixtures, set BEFORE the config module is imported, because it freezes at import.
process.env.PAWAPAY_API_TOKEN = 'pawapay-fixture-token';
process.env.PAWAPAY_BASE_URL = 'https://pawapay.test';
delete process.env.PAWAPAY_PAYOUTS_ENABLED;
delete process.env.PAWAPAY_CALLBACK_PUBLIC_KEY;
delete process.env.PAWAPAY_CALLBACK_AUTHORITY;
delete process.env.API_PUBLIC_URL;

import crypto from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { originalConsole } from '../../src/core/logging/sink-guard';
import { AppError } from '../../src/core/errors';
import { ERROR_CODES } from '../../src/core/error-codes';
import { categoryFor } from '../../src/core/error-category';
import { validateEnv } from '../../src/config/env';
import { mintMerchantRef } from '../../src/modules/payments/domain/merchant-reference';
import { gatewayWebhookPath } from '../../src/modules/payments/gateways/gateway.interface';
import { isCustomerChargeRefusal } from '../../src/modules/payments/services/payment-routing.service';
import { PAYMENT_GATEWAYS, gatewaySupportsRefund, gatewaySupportsPayout } from '../../src/modules/payments/gateways/registry';
import {
  PawaPayGateway,
  PAWAPAY_MAX_PAYOUT_ATTEMPTS,
  pawapayPaymentId,
  isUuid,
  normalizePawapayStatus,
  pawapayMsisdn,
  pawapayProvider,
  pawapayMerchantRef,
  pawapayEventFrom,
  pawapayPayoutVerdict,
  pawapayLimitsFrom,
  verifyPawapaySignature,
  contentDigestMatches,
  splitSfDictionary,
} from '../../src/modules/payments/gateways/pawapay.gateway';

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

// ─── Keys and signing (independent of the adapter's own base builder) ────────

const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const ecPem = ec.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const other = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const KEY_ID = 'HTTP_EC_P256_KEY:1';
const HOST = 'api.wimall.test';
const PATH = gatewayWebhookPath('PAWAPAY');
const NOW = Math.floor(Date.now() / 1000);

interface SignOptions {
  key?: crypto.KeyObject;
  keyId?: string;
  authority?: string;
  path?: string;
  created?: number;
  expires?: number;
  encoding?: 'der' | 'ieee-p1363';
  components?: string[];
  digestAlg?: 'sha-256' | 'sha-512';
}

/** A callback as PawaPay sends it: body bytes + headers, signed per RFC 9421 § 2.5. */
function signedCallback(body: string, o: SignOptions = {}): { raw: Buffer; headers: Record<string, string> } {
  const raw = Buffer.from(body, 'utf8');
  const digestAlg = o.digestAlg ?? 'sha-512';
  const digest = `${digestAlg}=:${crypto.createHash(digestAlg === 'sha-512' ? 'sha512' : 'sha256').update(raw).digest('base64')}:`;
  const headers: Record<string, string> = {
    host: HOST,
    'content-type': 'application/json; charset=UTF-8',
    'content-digest': digest,
    'signature-date': '2026-10-05T10:00:00.000000Z',
  };
  const components = o.components ?? ['@method', '@authority', '@path', 'signature-date', 'content-digest', 'content-type'];
  const created = o.created ?? NOW;
  const expires = o.expires ?? NOW + 60;
  const params = `(${components.map((c) => `"${c}"`).join(' ')});alg="ecdsa-p256-sha256";keyid="${o.keyId ?? KEY_ID}";created=${created};expires=${expires}`;
  const values: Record<string, string> = {
    '@method': 'POST',
    '@authority': o.authority ?? HOST,
    '@path': o.path ?? PATH,
  };
  const lines = components.map((c) => `"${c}": ${values[c] ?? headers[c]}`);
  lines.push(`"@signature-params": ${params}`);
  const signature = crypto
    .sign('sha256', Buffer.from(lines.join('\n'), 'utf8'), { key: o.key ?? ec.privateKey, dsaEncoding: o.encoding ?? 'der' })
    .toString('base64');
  headers['signature-input'] = `sig-pp=${params}`;
  headers.signature = `sig-pp=:${signature}:`;
  return { raw, headers };
}

const keyFor = (id: string | null) => (id === KEY_ID ? ec.publicKey : null);
const check = (cb: { raw: Buffer; headers: Record<string, string> }, authorities = [HOST]) =>
  verifyPawapaySignature({ rawBody: cb.raw, headers: cb.headers, keyFor, authorities, paths: [PATH], nowSeconds: NOW });

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

/** Every script also answers the public-key fetch every call triggers in the background. */
function script(table: Array<[RegExp, Route]>): void {
  seen = [];
  routes = [
    [/\/v2\/public-key\/http$/, () => ({ status: 200, body: [{ id: KEY_ID, key: ecPem }] })] as [RegExp, Route],
    ...table,
  ].map(([match, reply]) => ({ match, reply }));
}
/** What the adapter sent, minus the background key fetch. */
const calls = () => seen.filter((s) => !s.url.endsWith('/v2/public-key/http'));

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

const DEPOSITS = /\/v2\/deposits$/;
const DEPOSIT = /\/v2\/deposits\/[0-9a-f-]+$/;
const PAYOUTS = /\/v2\/payouts$/;
const PAYOUT = /\/v2\/payouts\/[0-9a-f-]+$/;
const found = (data: Record<string, unknown>): Reply => ({ status: 200, body: { status: 'FOUND', data } });
const notFound: Reply = { status: 200, body: { status: 'NOT_FOUND' } };
const rejected = (code: string, message = '', status = 200): Reply => ({
  status,
  body: { status: 'REJECTED', failureReason: { failureCode: code, failureMessage: message } },
});

function initPayload(ref: string, phone = '670000000', currency = 'XAF', amount = 5000) {
  return {
    orderId: '66f000000000000000000001',
    userId: '66f000000000000000000002',
    amount,
    currency,
    channel: { phoneNumber: phone },
    merchantRef: ref,
  };
}

(async () => {
  const gateway = new PawaPayGateway();

  // ─── 1 ──────────────────────────────────────────────────────────────────────
  section('1. Conformance');

  assert('name is PAWAPAY, and the registry holds this adapter', () =>
    gateway.name === 'PAWAPAY' && PAYMENT_GATEWAYS.get('PAWAPAY') instanceof PawaPayGateway);
  assert('MTN and ORANGE are PUSH and require a phone number; MOOV and CARD are not declared', () => {
    const c = gateway.capabilities.collect;
    return c.MTN?.flow === 'PUSH' && c.ORANGE?.flow === 'PUSH'
      && c.MTN.requires.includes('phoneNumber') && c.ORANGE.requires.includes('phoneNumber')
      && c.MOOV === undefined && c.CARD === undefined;
  });
  assert('limits as measured on the account (verify:pawapay R1): MTN 1–1,000,000, Orange 1–500,000 XAF', () => {
    const c = gateway.capabilities.collect;
    return c.MTN?.limits?.min === 1 && c.MTN.limits.max === 1_000_000
      && c.ORANGE?.limits?.min === 1 && c.ORANGE.limits.max === 500_000;
  });
  assert('settles asynchronously (the reconciliation sweep covers it)', () => gateway.capabilities.settlesAsync === true);
  assert('no refundPayment and no authorizePayment (refunds are payouts; no OTP step)', () =>
    typeof (gateway as any).refundPayment === 'undefined' && typeof (gateway as any).authorizePayment === 'undefined'
      && gatewaySupportsRefund('PAWAPAY') === false);
  assert('confirmWebhookEvent, createPayout, verifyPayout and payoutBalance are implemented', () =>
    typeof gateway.confirmWebhookEvent === 'function' && typeof gateway.createPayout === 'function'
      && typeof gateway.verifyPayout === 'function' && typeof gateway.payoutBalance === 'function');
  assert('payouts are OFF by default (PAWAPAY_PAYOUTS_ENABLED unset)', () =>
    gateway.payoutAvailable() === false && gatewaySupportsPayout('PAWAPAY') === false);
  assert('the webhook path is derived: /api/webhooks/pawapay', () => PATH === '/api/webhooks/pawapay');
  assert('PAWAPAY_* errors are external_service at 5xx', () =>
    categoryFor(ERROR_CODES.PAWAPAY_REQUEST_FAILED, 502) === 'external_service'
      && categoryFor(ERROR_CODES.PAWAPAY_UNREACHABLE, 503) === 'external_service');

  // ─── 2 ──────────────────────────────────────────────────────────────────────
  section('2. Derived ids');

  const ref = mintMerchantRef('pt');
  const id = pawapayPaymentId('deposit', ref);
  assert('deterministic: the same reference gives the same id', () => pawapayPaymentId('deposit', ref) === id);
  assert('UUID-shaped, version 4, RFC 4122 variant', () =>
    isUuid(id) && id[14] === '4' && ['8', '9', 'a', 'b'].includes(id[19]));
  assert('a different reference gives a different id', () => pawapayPaymentId('deposit', mintMerchantRef('pt')) !== id);
  assert('deposit and payout ids of one reference differ', () => pawapayPaymentId('payout', ref) !== id);
  assert('each payout attempt gets its own id; attempt 0 is the plain id', () => {
    const po = mintMerchantRef('po');
    const ids = [0, 1, 2].map((a) => pawapayPaymentId('payout', po, a));
    return new Set(ids).size === 3 && ids[0] === pawapayPaymentId('payout', po) && ids.every(isUuid);
  });
  assert('MSISDN is 237 + 9 digits; provider codes are MTN_MOMO_CMR / ORANGE_CMR', () =>
    pawapayMsisdn('+237 670 00 00 00') === '237670000000' && pawapayMsisdn('12') === null
      && pawapayProvider('MTN') === 'MTN_MOMO_CMR' && pawapayProvider('ORANGE') === 'ORANGE_CMR');

  // ─── 3 ──────────────────────────────────────────────────────────────────────
  section('3. Status mapping');

  assert('COMPLETED → SUCCEEDED, FAILED → FAILED', () =>
    normalizePawapayStatus('COMPLETED') === 'SUCCEEDED' && normalizePawapayStatus('FAILED') === 'FAILED');
  assert('ACCEPTED / ENQUEUED / SUBMITTED / PROCESSING / IN_RECONCILIATION → PENDING', () =>
    ['ACCEPTED', 'ENQUEUED', 'SUBMITTED', 'PROCESSING', 'IN_RECONCILIATION'].every((w) => normalizePawapayStatus(w) === 'PENDING'));
  assert('an unknown word is PENDING, never FAILED', () =>
    normalizePawapayStatus('SOMETHING_NEW') === 'PENDING' && normalizePawapayStatus(undefined) === 'PENDING');

  // ─── 4 ──────────────────────────────────────────────────────────────────────
  section('4. Deposits on the wire');

  {
    const r = mintMerchantRef('pt');
    script([[DEPOSITS, () => ({ status: 200, body: { depositId: pawapayPaymentId('deposit', r), status: 'ACCEPTED', nextStep: 'FINAL_STATUS' } })]]);
    const result = await gateway.initiatePayment(initPayload(r, '670000000'));
    const sent = calls()[0];
    assert('POST /v2/deposits with the bearer token', () =>
      sent?.method === 'POST' && sent.url === 'https://pawapay.test/v2/deposits'
        && sent.headers.Authorization === 'Bearer pawapay-fixture-token');
    assert('body: derived depositId, amount as an integer STRING, XAF, MMO payer with MSISDN + provider', () =>
      sent.body.depositId === pawapayPaymentId('deposit', r) && sent.body.amount === '5000' && sent.body.currency === 'XAF'
        && sent.body.payer.type === 'MMO' && sent.body.payer.accountDetails.phoneNumber === '237670000000'
        && sent.body.payer.accountDetails.provider === 'MTN_MOMO_CMR');
    assert('our reference travels as clientReferenceId AND metadata.jmRef (a callback carries only metadata)', () =>
      sent.body.clientReferenceId === r && Array.isArray(sent.body.metadata) && sent.body.metadata[0].jmRef === r);
    assert('no customerMessage is sent (PawaPay defaults it to our registered name)', () => !('customerMessage' in sent.body));
    assert('ACCEPTED → success, PENDING, gatewayRef = the depositId, PIN instructions', () =>
      result.success && result.status === 'PENDING' && result.gatewayRef === pawapayPaymentId('deposit', r)
        && result.instructions?.ussdCode === '*126#');
  }
  {
    const r = mintMerchantRef('pt');
    script([[DEPOSITS, () => ({ status: 200, body: { status: 'ACCEPTED' } })]]);
    const result = await gateway.initiatePayment(initPayload(r, '690000000', 'XAF', 1234.9));
    const sent = calls()[0];
    assert('an Orange number goes as ORANGE_CMR; a fractional amount is truncated (no decimals in CMR)', () =>
      sent.body.payer.accountDetails.provider === 'ORANGE_CMR' && sent.body.amount === '1234' && result.instructions?.ussdCode === '#150*50#');
  }
  {
    const r = mintMerchantRef('pt');
    script([[DEPOSITS, () => ({ status: 200, body: { status: 'DUPLICATE_IGNORED' } })]]);
    const result = await gateway.initiatePayment(initPayload(r));
    assert('DUPLICATE_IGNORED (the same reference resent) → success, PENDING, same id', () =>
      result.success && result.status === 'PENDING' && result.gatewayRef === pawapayPaymentId('deposit', r));
  }
  {
    script([[DEPOSITS, () => rejected('AMOUNT_OUT_OF_BOUNDS', "The amount needs to be more than '100' and less than '1000000' for provider 'MTN_MOMO_CMR'.")]]);
    const e = await thrown(() => gateway.initiatePayment(initPayload(mintMerchantRef('pt'))));
    assert('REJECTED AMOUNT_OUT_OF_BOUNDS → 422 PAYMENT_AMOUNT_OUT_OF_RANGE with the limits PawaPay stated, spent:false', () =>
      isAppError(e, ERROR_CODES.PAYMENT_AMOUNT_OUT_OF_RANGE) && e.statusCode === 422
        && e.details.min === 100 && e.details.max === 1000000 && e.details.spent === false);
    assert('limits parse; an unrecognised message gives null', () =>
      pawapayLimitsFrom("more than '200' and less than '500000'")?.max === 500000 && pawapayLimitsFrom('nope') === null);
  }
  {
    script([[DEPOSITS, () => rejected('PROVIDER_TEMPORARILY_UNAVAILABLE', 'down')]]);
    const e = await thrown(() => gateway.initiatePayment(initPayload(mintMerchantRef('pt'))));
    assert('PROVIDER_TEMPORARILY_UNAVAILABLE → 422 PAYMENT_PROVIDER_UNAVAILABLE, temporary, spent:false', () =>
      isAppError(e, ERROR_CODES.PAYMENT_PROVIDER_UNAVAILABLE) && e.statusCode === 422
        && e.details.temporary === true && e.details.spent === false && e.details.provider === 'MTN');
    assert('⛔ …and it reaches the customer AS ITSELF ("try the other network"), not as a generic failure (owner 2026-10-06)', () =>
      isCustomerChargeRefusal(e));
  }
  {
    script([[DEPOSITS, () => rejected('INVALID_PHONE_NUMBER', 'bad', 400)]]);
    const e = await thrown(() => gateway.initiatePayment(initPayload(mintMerchantRef('pt'))));
    assert('HTTP 400 INVALID_PHONE_NUMBER → 422 PAYMENT_OPERATOR_UNDETERMINED', () =>
      isAppError(e, ERROR_CODES.PAYMENT_OPERATOR_UNDETERMINED) && e.statusCode === 422);
  }
  {
    script([[DEPOSITS, () => rejected('AUTHENTICATION_ERROR', 'bad token', 403)]]);
    const e = await thrown(() => gateway.initiatePayment(initPayload(mintMerchantRef('pt'))));
    assert('HTTP 403 AUTHENTICATION_ERROR → 502 PAWAPAY_REQUEST_FAILED (an operator problem, not the shopper\'s)', () =>
      isAppError(e, ERROR_CODES.PAWAPAY_REQUEST_FAILED) && e.statusCode === 502 && e.details.failureCode === 'AUTHENTICATION_ERROR');
    assert('the bearer token never appears in error details', () => !JSON.stringify(e.details ?? {}).includes('pawapay-fixture-token'));
  }
  {
    const r = mintMerchantRef('pt');
    script([
      [DEPOSITS, () => ({ status: 500, body: { failureReason: { failureCode: 'UNKNOWN_ERROR' } } })],
      [DEPOSIT, () => notFound],
    ]);
    const result = await gateway.initiatePayment(initPayload(r));
    assert('⛔ 500 UNKNOWN_ERROR → asks PawaPay; NOT_FOUND → FAILED (never reached PawaPay, nothing charged)', () =>
      !result.success && result.status === 'FAILED' && calls().some((s) => s.method === 'GET' && DEPOSIT.test(s.url)));
  }
  {
    const r = mintMerchantRef('pt');
    script([
      [DEPOSITS, () => ({ status: 500, body: {} })],
      [DEPOSIT, () => found({ depositId: pawapayPaymentId('deposit', r), status: 'ACCEPTED' })],
    ]);
    const result = await gateway.initiatePayment(initPayload(r));
    assert('⛔ 500 then FOUND ACCEPTED → success, PENDING (the deposit exists; never failed and resent)', () =>
      result.success && result.status === 'PENDING' && result.gatewayRef === pawapayPaymentId('deposit', r));
  }
  {
    const r = mintMerchantRef('pt');
    script([
      [DEPOSITS, () => 'network-error'],
      [DEPOSIT, () => 'network-error'],
    ]);
    const result = await gateway.initiatePayment(initPayload(r));
    assert('⛔ no answer and the lookup fails too → left PENDING with the id, for the sweep', () =>
      result.success && result.status === 'PENDING' && result.gatewayRef === pawapayPaymentId('deposit', r));
  }
  {
    script([]);
    const usd = await thrown(() => gateway.initiatePayment(initPayload(mintMerchantRef('pt'), '670000000', 'USD')));
    const nexttel = await thrown(() => gateway.initiatePayment(initPayload(mintMerchantRef('pt'), '660000000')));
    assert('a non-XAF charge → 422 PAYMENT_CURRENCY_NOT_SUPPORTED; an unknown prefix → PAYMENT_OPERATOR_UNDETERMINED; nothing sent', () =>
      isAppError(usd, ERROR_CODES.PAYMENT_CURRENCY_NOT_SUPPORTED) && isAppError(nexttel, ERROR_CODES.PAYMENT_OPERATOR_UNDETERMINED)
        && calls().length === 0);
  }

  // ─── 5 ──────────────────────────────────────────────────────────────────────
  section('5. verifyPayment');

  {
    const depositId = pawapayPaymentId('deposit', mintMerchantRef('pt'));
    script([[DEPOSIT, () => found({ depositId, status: 'COMPLETED', amount: '5000', currency: 'XAF' })]]);
    const ok = await gateway.verifyPayment({ gatewayRef: depositId });
    script([[DEPOSIT, () => notFound]]);
    const missing = await gateway.verifyPayment({ gatewayRef: depositId });
    script([[DEPOSIT, () => 'network-error']]);
    const down = await gateway.verifyPayment({ gatewayRef: depositId });
    assert('FOUND COMPLETED → SUCCEEDED', () => ok.success && ok.status === 'SUCCEEDED');
    assert('NOT_FOUND → FAILED (PawaPay: safe to fail)', () => !missing.success && missing.status === 'FAILED');
    assert('unreachable → PENDING, never FAILED', () => !down.success && down.status === 'PENDING');
  }

  // ─── 6 ──────────────────────────────────────────────────────────────────────
  section('6. ⛔ Signatures (RFC 9421)');

  const body = JSON.stringify({ depositId: id, status: 'COMPLETED', amount: '5000', currency: 'XAF', metadata: { jmRef: ref } });
  {
    const good = signedCallback(body);
    assert('a correctly signed callback verifies', () => check(good).ok);
    assert('the IEEE-P1363 (raw r||s) ECDSA encoding verifies too', () => check(signedCallback(body, { encoding: 'ieee-p1363' })).ok);
    assert('a sha-256 Content-Digest is accepted as well as sha-512', () => check(signedCallback(body, { digestAlg: 'sha-256' })).ok);

    const tamperedBody = { raw: Buffer.from(body.replace('COMPLETED', 'FAILED__')), headers: good.headers };
    const r1 = check(tamperedBody);
    assert('a body changed after signing is refused (Content-Digest)', () => !r1.ok && r1.reason === 'bad_signature' && /Content-Digest/.test(r1.detail));

    const tamperedHeader = { raw: good.raw, headers: { ...good.headers, 'content-type': 'text/plain' } };
    assert('a signed header changed after signing is refused', () => !check(tamperedHeader).ok);

    assert('a signature over another host is refused', () => !check(signedCallback(body, { authority: 'evil.test' })).ok);
    assert('the host is matched against EVERY candidate authority (proxy Host vs public host)', () =>
      check(signedCallback(body, { authority: 'public.wimall.test' }), [HOST, 'public.wimall.test']).ok);
    assert('a signature over another path is refused', () => !check(signedCallback(body, { path: '/api/webhooks/notchpay' })).ok);
    assert('a signature by another key is refused', () => !check(signedCallback(body, { key: other.privateKey })).ok);

    const unknown = check(signedCallback(body, { keyId: 'HTTP_EC_P256_KEY:2' }));
    assert('an unknown keyid is refused AND flagged so the keys are refreshed', () =>
      !unknown.ok && unknown.reason === 'bad_signature' && unknown.unknownKeyId === true);

    const expired = check(signedCallback(body, { created: NOW - 3600, expires: NOW - 3000 }));
    assert('an expired signature is refused', () => !expired.ok && /expired/.test(expired.detail));
    assert('a signature created in the future is refused', () => !check(signedCallback(body, { created: NOW + 3600, expires: NOW + 3700 })).ok);

    const uncovered = check(signedCallback(body, { components: ['@method', '@authority', '@path', 'content-type'] }));
    assert('a signature that does not cover content-digest is refused (the body would be unprotected)', () =>
      !uncovered.ok && /content-digest/.test(uncovered.detail));

    const unsigned = check({ raw: good.raw, headers: { host: HOST, 'content-type': 'application/json' } });
    assert('⛔ an UNSIGNED callback is refused missing_signature (owner decision: signed callbacks only)', () =>
      !unsigned.ok && unsigned.reason === 'missing_signature');
  }
  assert('Content-Digest: absent or unsupported-only is a mismatch', () =>
    !contentDigestMatches(null, Buffer.from('x')) && !contentDigestMatches('md5=:abc:', Buffer.from('x')));
  assert('SF dictionary split keeps commas inside quotes and inner lists', () => {
    const d = splitSfDictionary('a=("x" "y");k="p,q", b=:Zm9v:');
    return d.get('a') === '("x" "y");k="p,q"' && d.get('b') === ':Zm9v:';
  });

  {
    // Through the gateway: the keys come from GET /v2/public-key/http.
    script([]);
    await gateway.refreshPublicKeys(true);
    const cb = signedCallback(body);
    const v = gateway.verifyWebhook({ rawBody: cb.raw, headers: cb.headers });
    assert('verifyWebhook accepts a signed callback with the key fetched from /v2/public-key/http', () =>
      v.ok === true && gateway.callbackKeysLoaded() === 1);
    const noRaw = gateway.verifyWebhook({ rawBody: JSON.parse(body), headers: cb.headers });
    assert('verifyWebhook without the raw bytes → unparsable', () => !noRaw.ok && noRaw.reason === 'unparsable');
    const wrongKey = signedCallback(body, { keyId: 'HTTP_EC_P256_KEY:9' });
    const u = gateway.verifyWebhook({ rawBody: wrongKey.raw, headers: wrongKey.headers });
    assert('verifyWebhook refuses an unknown keyid bad_signature', () => !u.ok && u.reason === 'bad_signature');
  }

  // ─── 7 ──────────────────────────────────────────────────────────────────────
  section('7. ⛔ Parse and the forgery drill');

  {
    const pt = mintMerchantRef('pt');
    const depositId = pawapayPaymentId('deposit', pt);
    const callback = { depositId, status: 'COMPLETED', amount: '5000', currency: 'XAF', metadata: { jmRef: pt } };
    const event = gateway.parseWebhookEvent(callback)!;
    assert('a deposit callback → a collection event with our reference from metadata', () =>
      event.direction === 'collection' && event.gatewayRef === depositId && event.merchantRef === pt
        && event.status === 'SUCCEEDED' && event.eventType === 'payment.completed');

    const po = mintMerchantRef('po');
    const payoutEvent = pawapayEventFrom({ payoutId: pawapayPaymentId('payout', po), status: 'FAILED', metadata: { jmRef: po } }, null)!;
    assert('a payout callback → a payout event (transfer.*)', () =>
      payoutEvent.direction === 'payout' && payoutEvent.merchantRef === po && payoutEvent.eventType === 'transfer.failed');
    const rf = mintMerchantRef('rf');
    assert('a refund sent as a payout (rf) is money out too', () =>
      pawapayEventFrom({ payoutId: pawapayPaymentId('payout', rf), status: 'COMPLETED', metadata: { jmRef: rf } }, null)?.direction === 'payout');
    assert('a refund callback (refundId) is not ours to act on → null', () =>
      pawapayEventFrom({ refundId: id, status: 'COMPLETED' }, null) === null);
    assert('a deposit naming a money-out reference is a contradiction → null', () =>
      pawapayEventFrom({ depositId, status: 'COMPLETED', metadata: { jmRef: po } }, null) === null);
    assert('a payout naming a collection reference is a contradiction → null', () =>
      pawapayEventFrom({ payoutId: depositId, status: 'COMPLETED', metadata: { jmRef: pt } }, null) === null);
    assert('the reference is read from metadata (array or object) or clientReferenceId; a non-jm value is ignored', () =>
      pawapayMerchantRef({ metadata: [{ jmRef: pt }] }) === pt && pawapayMerchantRef({ clientReferenceId: pt }) === pt
        && pawapayMerchantRef({ clientReferenceId: 'INV-1' }) === null);
    assert('the event id is stable per (direction, id, status)', () =>
      gateway.parseWebhookEvent(callback)!.eventId === event.eventId
        && gateway.parseWebhookEvent({ ...callback, status: 'FAILED' })!.eventId !== event.eventId);

    script([[DEPOSIT, () => found({ depositId, status: 'FAILED', amount: '5000', currency: 'XAF', clientReferenceId: pt, metadata: { jmRef: pt } })]]);
    const confirmed = await gateway.confirmWebhookEvent(event);
    assert('⛔ a signed callback claiming COMPLETED is replaced by PawaPay\'s record (FAILED)', () =>
      confirmed?.status === 'FAILED' && confirmed.merchantRef === pt && calls()[0].url.endsWith(`/v2/deposits/${depositId}`));

    script([[DEPOSIT, () => notFound]]);
    const unknownRecord = await gateway.confirmWebhookEvent(event);
    assert('NOT_FOUND → null', () => unknownRecord === null);

    script([[DEPOSIT, () => found({ depositId, status: 'COMPLETED', metadata: { jmRef: mintMerchantRef('pt') } })]]);
    const otherRef = await gateway.confirmWebhookEvent(event);
    assert('record with a different jmRef → null', () => otherRef === null);

    script([[DEPOSIT, () => ({ status: 503, body: {} })]]);
    const e = await thrown(() => gateway.confirmWebhookEvent(event));
    assert('PawaPay unreachable on the re-read → THROWS (5xx, PawaPay retries)', () => isAppError(e, ERROR_CODES.PAWAPAY_REQUEST_FAILED));

    const payoutCb = pawapayEventFrom({ payoutId: pawapayPaymentId('payout', po), status: 'COMPLETED', metadata: { jmRef: po } }, null)!;
    script([[PAYOUT, () => found({ payoutId: pawapayPaymentId('payout', po), status: 'COMPLETED', metadata: { jmRef: po } })]]);
    const confirmedPayout = await gateway.confirmWebhookEvent(payoutCb);
    assert('a payout callback is re-read on /v2/payouts, never /v2/deposits', () =>
      confirmedPayout?.status === 'SUCCEEDED' && calls()[0].url.includes('/v2/payouts/'));
  }

  // ─── 8 ──────────────────────────────────────────────────────────────────────
  section('8. Payouts');

  const payoutPayload = (reference: string, phone = '670000000') => ({ reference, amount: 10_000, currency: 'XAF', phone, name: 'Vendor' });
  {
    const po = mintMerchantRef('po');
    script([[PAYOUTS, () => ({ status: 200, body: { status: 'ACCEPTED' } })]]);
    const result = await gateway.createPayout(payoutPayload(po));
    const sent = calls()[0];
    assert('POST /v2/payouts with the derived payoutId and a `recipient` (the spec), never `payer` (a guide typo)', () =>
      sent.body.payoutId === pawapayPaymentId('payout', po) && sent.body.recipient?.accountDetails?.provider === 'MTN_MOMO_CMR'
        && !('payer' in sent.body) && sent.body.amount === '10000' && sent.body.metadata[0].jmRef === po);
    assert('ACCEPTED → success, PENDING, gatewayRef = attempt-0 id', () =>
      result.success && result.status === 'PENDING' && result.gatewayRef === pawapayPaymentId('payout', po));
  }
  {
    const po = mintMerchantRef('po');
    script([
      [PAYOUTS, () => ({ status: 200, body: { status: 'DUPLICATE_IGNORED' } })],
      [PAYOUT, () => found({ payoutId: pawapayPaymentId('payout', po), status: 'COMPLETED', metadata: { jmRef: po } })],
    ]);
    const result = await gateway.createPayout(payoutPayload(po));
    assert('⛔ a resend of a payout that COMPLETED → reported, nothing sent again', () =>
      result.success && result.status === 'SUCCEEDED' && calls().filter((s) => s.method === 'POST').length === 1);
  }
  {
    const po = mintMerchantRef('po');
    const id0 = pawapayPaymentId('payout', po, 0);
    const id1 = pawapayPaymentId('payout', po, 1);
    script([
      [PAYOUTS, (s) => ({ status: 200, body: { status: s.body.payoutId === id0 ? 'DUPLICATE_IGNORED' : 'ACCEPTED' } })],
      [PAYOUT, () => found({ payoutId: id0, status: 'FAILED', failureReason: { failureCode: 'RECIPIENT_NOT_FOUND' } })],
    ]);
    const result = await gateway.createPayout(payoutPayload(po));
    const posts = calls().filter((s) => s.method === 'POST');
    assert('⛔ a retry after a FINAL failure is sent under the NEXT derived id', () =>
      result.success && result.gatewayRef === id1 && posts.length === 2 && posts[1].body.payoutId === id1);
  }
  {
    const po = mintMerchantRef('po');
    script([
      [PAYOUTS, () => ({ status: 200, body: { status: 'DUPLICATE_IGNORED' } })],
      [PAYOUT, () => 'network-error'],
    ]);
    const e = await thrown(() => gateway.createPayout(payoutPayload(po)));
    assert('⛔ a duplicate whose state cannot be read → THROWS (unknown; never a second id)', () =>
      e instanceof AppError && calls().filter((s) => s.method === 'POST').length === 1);
  }
  {
    const po = mintMerchantRef('po');
    script([
      [PAYOUTS, () => ({ status: 200, body: { status: 'DUPLICATE_IGNORED' } })],
      [PAYOUT, () => found({ payoutId: 'x', status: 'FAILED' })],
    ]);
    const result = await gateway.createPayout(payoutPayload(po));
    assert(`after ${PAWAPAY_MAX_PAYOUT_ATTEMPTS} failed ids the payout is refused, nothing sent`, () =>
      !result.success && calls().filter((s) => s.method === 'POST').length === PAWAPAY_MAX_PAYOUT_ATTEMPTS);
  }
  {
    script([[PAYOUTS, () => rejected('PAYOUTS_NOT_ALLOWED', 'not enabled')]]);
    const notAllowed = await gateway.createPayout(payoutPayload(mintMerchantRef('po')));
    script([[PAYOUTS, () => rejected('AUTHENTICATION_ERROR', '', 403)]]);
    const auth = await gateway.createPayout(payoutPayload(mintMerchantRef('po')));
    script([[PAYOUTS, () => rejected('PAWAPAY_WALLET_OUT_OF_FUNDS', '')]]);
    const broke = await gateway.createPayout(payoutPayload(mintMerchantRef('po')));
    assert('REJECTED PAYOUTS_NOT_ALLOWED → success:false, unsupported (nothing sent)', () =>
      !notAllowed.success && notAllowed.unsupported === true && notAllowed.gatewayRef === null);
    assert('HTTP 403 → success:false, unsupported', () => !auth.success && auth.unsupported === true);
    assert('wallet out of funds → success:false, retryable (not unsupported), says top up', () =>
      !broke.success && !broke.unsupported && /top it up/.test(broke.message ?? ''));
  }
  {
    script([[PAYOUTS, () => ({ status: 500, body: { failureReason: { failureCode: 'UNKNOWN_ERROR' } } })]]);
    const e500 = await thrown(() => gateway.createPayout(payoutPayload(mintMerchantRef('po'))));
    script([[PAYOUTS, () => 'network-error']]);
    const eNet = await thrown(() => gateway.createPayout(payoutPayload(mintMerchantRef('po'))));
    assert('⛔ 500 UNKNOWN_ERROR → THROWS (outcome unknown, stays processing)', () => isAppError(e500, ERROR_CODES.PAWAPAY_REQUEST_FAILED));
    assert('⛔ no answer → THROWS PAWAPAY_UNREACHABLE', () => isAppError(eNet, ERROR_CODES.PAWAPAY_UNREACHABLE));
  }
  {
    script([]);
    const foreign = await gateway.createPayout(payoutPayload(mintMerchantRef('po'), '660000000'));
    assert('a non-MTN/Orange destination → unsupported, nothing sent', () =>
      !foreign.success && foreign.unsupported === true && calls().length === 0);
  }
  {
    const po = mintMerchantRef('po');
    const id0 = pawapayPaymentId('payout', po, 0);
    const id1 = pawapayPaymentId('payout', po, 1);
    script([[PAYOUT, () => found({ payoutId: id0, status: 'COMPLETED', metadata: { jmRef: po } })]]);
    const done = await gateway.verifyPayout({ gatewayRef: id0, reference: po });
    script([[PAYOUT, () => notFound]]);
    const never = await gateway.verifyPayout({ gatewayRef: id0, reference: po });
    script([[PAYOUT, () => found({ payoutId: id0, status: 'COMPLETED', metadata: { jmRef: mintMerchantRef('po') } })]]);
    const notOurs = await gateway.verifyPayout({ gatewayRef: id0, reference: po });
    script([[PAYOUT, () => 'network-error']]);
    const down = await gateway.verifyPayout({ gatewayRef: id0, reference: po });
    script([[PAYOUT, (s) =>
      s.url.endsWith(id0) ? found({ payoutId: id0, status: 'FAILED', metadata: { jmRef: po } })
        : s.url.endsWith(id1) ? found({ payoutId: id1, status: 'COMPLETED', metadata: { jmRef: po } })
          : notFound]]);
    const walked = await gateway.verifyPayout({ gatewayRef: '', reference: po });
    assert('verifyPayout: COMPLETED → SUCCEEDED', () => done.status === 'SUCCEEDED' && done.gatewayRef === id0);
    assert('verifyPayout: NOT_FOUND → FAILED (never reached PawaPay; a retry reuses the id)', () => never.status === 'FAILED');
    assert('verifyPayout: a record naming another reference → PENDING, inconclusive', () =>
      notOurs.status === 'PENDING' && Boolean(notOurs.inconclusive));
    assert('verifyPayout: unreachable → PENDING, inconclusive', () => down.status === 'PENDING' && Boolean(down.inconclusive));
    assert('⛔ verifyPayout with no stored id walks the derived ids and reports the LAST one PawaPay knows', () =>
      walked.status === 'SUCCEEDED' && walked.gatewayRef === id1);
    assert('a payout verdict needs a payout record', () => pawapayPayoutVerdict({ depositId: id0, status: 'COMPLETED' }, po).status === 'PENDING');
  }
  {
    script([[/\/v2\/wallet-balances/, () => ({ status: 200, body: { balances: [{ country: 'CMR', currency: 'XAF', balance: '125000.0', provider: '' }] } })]]);
    const balance = await gateway.payoutBalance('XAF');
    assert('payoutBalance reads the CMR XAF wallet', () =>
      balance?.available === 125000 && balance.currency === 'XAF' && calls()[0].url.endsWith('/v2/wallet-balances?country=CMR'));
  }

  // ─── 9 ──────────────────────────────────────────────────────────────────────
  section('9. Boot rules (config/env.ts)');

  const base = { NODE_ENV: 'development' } as NodeJS.ProcessEnv;
  const problems = (env: Record<string, string>) => validateEnv({ ...base, ...env } as NodeJS.ProcessEnv);
  const errorOn = (env: Record<string, string>, variable: string) =>
    problems(env).some((p) => p.level === 'error' && p.variable === variable);
  const warningOn = (env: Record<string, string>, variable: string) =>
    problems(env).some((p) => p.level === 'warning' && p.variable === variable);

  assert('PAWAPAY_PAYOUTS_ENABLED=true without a token is an error', () =>
    errorOn({ PAWAPAY_PAYOUTS_ENABLED: 'true' }, 'PAWAPAY_PAYOUTS_ENABLED')
      && !errorOn({ PAWAPAY_PAYOUTS_ENABLED: 'true', PAWAPAY_API_TOKEN: 't' }, 'PAWAPAY_PAYOUTS_ENABLED'));
  assert('a pinned callback key that is not a PEM is an error; a PEM is not', () =>
    errorOn({ PAWAPAY_CALLBACK_PUBLIC_KEY: 'abc' }, 'PAWAPAY_CALLBACK_PUBLIC_KEY')
      && !errorOn({ PAWAPAY_CALLBACK_PUBLIC_KEY: ecPem.replace(/\n/g, '\\n') }, 'PAWAPAY_CALLBACK_PUBLIC_KEY'));
  assert('production + a token + the sandbox base URL warns', () =>
    warningOn({ NODE_ENV: 'production', PAWAPAY_API_TOKEN: 't' }, 'PAWAPAY_BASE_URL'));
  assert('production + the live base URL does not warn', () =>
    !warningOn({ NODE_ENV: 'production', PAWAPAY_API_TOKEN: 't', PAWAPAY_BASE_URL: 'https://api.pawapay.io' }, 'PAWAPAY_BASE_URL'));
  assert('PAWAPAY_PAYOUTS_ENABLED=yes is refused (booleans are true|false|1|0)', () =>
    errorOn({ PAWAPAY_PAYOUTS_ENABLED: 'yes' }, 'PAWAPAY_PAYOUTS_ENABLED'));
  assert('PAWAPAY_REQUEST_TIMEOUT_MS must be an integer', () =>
    errorOn({ PAWAPAY_REQUEST_TIMEOUT_MS: 'soon' }, 'PAWAPAY_REQUEST_TIMEOUT_MS'));

  // ─── 10 ─────────────────────────────────────────────────────────────────────
  section('10. Source scans');

  const source = readFileSync(join(__dirname, '..', '..', 'src', 'modules', 'payments', 'gateways', 'pawapay.gateway.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert('the adapter defines no refundPayment (a stub would make the orchestrator guard dead)', () =>
    !/\brefundPayment\s*\(/.test(source));
  assert('createPayout sends `recipient`, never `payer`', () => {
    const fn = source.slice(source.indexOf('async createPayout'), source.indexOf('async refreshPublicKeys'));
    return /recipient:\s*\{/.test(fn) && !/payer:\s*\{/.test(fn);
  });
  assert('the adapter reads no process.env (config only — test:payment-settings § 6)', () => !/process\.env/.test(source));
  assert('the bearer token is never copied into error details', () => !/details[^;]*API_TOKEN/.test(source));

  originalConsole.log(`\n${'═'.repeat(76)}`);
  originalConsole.log(`  ${passed} passed, ${failed} failed`);
  originalConsole.log(`${'═'.repeat(76)}\n`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((error) => {
  originalConsole.error('  ❌ THROW: test:pawapay runner —', error);
  process.exit(1);
});
