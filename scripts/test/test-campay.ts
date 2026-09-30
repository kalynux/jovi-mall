/**
 * test:campay — the Campay adapter, offline (ADR-A08 P2.1).
 *
 * What is asserted is what a reader cannot check by looking, and what fails quietly:
 *
 *   1. Conformance        — capabilities, and the members that must be ABSENT (refund, OTP)
 *   2. The callback token — HS256 pinned; wrong key, `none`, other algorithms and expiry refused
 *   3. verifyWebhook      — every refusal reason, and the accept
 *   4. Status mapping     — the documented words, and unknown → PENDING
 *   5. Numbers and refs   — 237… without `+`; jm_ ref always in external_user; uuid mode
 *   6. Parsing            — direction from `endpoint`; stable derived event ids
 *   7. ⛔ The forgery drill — a JWT-valid body claiming SUCCESSFUL, which Campay's own record
 *                          says FAILED, is confirmed as FAILED; contradictions are refused
 *   8. Calls on the wire  — `Token`, not `Bearer`; single-flight token; one 401 retry
 *   9. Payouts            — the per-carrier balance and the ER301 copy
 *  10. Boot rules         — config/env.ts, against synthetic environments
 *  11. Source scans       — structural invariants
 *
 * DB-free and network-free: `fetch` is replaced by a scripted stub. Run: npm run test:campay
 */

// Before the first import: the pino console bridge otherwise swallows this suite's output.
process.env.LOG_STDOUT = 'false';

// Fixtures, set BEFORE the config module is imported, because it freezes at import.
const FIXTURE_KEY = 'campay-fixture-webhook-key';
process.env.CAMPAY_USERNAME = 'fixture-user';
process.env.CAMPAY_PASSWORD = 'fixture-password';
process.env.CAMPAY_WEBHOOK_KEY = FIXTURE_KEY;
process.env.CAMPAY_BASE_URL = 'https://campay.test/api';
delete process.env.CAMPAY_REF_MODE;
delete process.env.CAMPAY_PAYOUTS_ENABLED;
delete process.env.CAMPAY_PERMANENT_TOKEN;

import jwt from 'jsonwebtoken';
import { readFileSync } from 'fs';
import { join } from 'path';
import { originalConsole } from '../../src/core/logging/sink-guard';
import { AppError } from '../../src/core/errors';
import { ERROR_CODES } from '../../src/core/error-codes';
import { validateEnv } from '../../src/config/env';
import { mintMerchantRef } from '../../src/modules/payments/domain/merchant-reference';
import {
  campayCallbackTokenValid,
  directionOfEventType,
} from '../../src/modules/payments/domain/webhook-verification';
import {
  CampayGateway,
  normalizeCampayStatus,
  campayMsisdn,
  campayReferenceFields,
  campayMerchantRef,
  campayUssdFor,
  campayEventFrom,
  campayErrorCode,
} from '../../src/modules/payments/gateways/campay.gateway';

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

const tokenRoute: [RegExp, Route] = [/\/token\/$/, () => ({ status: 200, body: { token: 'tok-1', expires_in: 3600 } })];

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

/** A body shaped like Campay's POST callback, signed with `key`. */
function callbackBody(fields: Record<string, unknown>, key = FIXTURE_KEY): Buffer {
  const signature = jwt.sign({ source: 'CamPay' }, key, { algorithm: 'HS256', expiresIn: 600 });
  return Buffer.from(JSON.stringify({ ...fields, signature }));
}

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
  const gateway = new CampayGateway();

  // ─── 1 ──────────────────────────────────────────────────────────────────────
  section('1. Conformance');

  assert('name is CAMPAY', () => gateway.name === 'CAMPAY');
  assert('MTN and ORANGE are PUSH, requiring the phone number', () =>
    (['MTN', 'ORANGE'] as const).every((p) => {
      const cap = gateway.capabilities.collect[p];
      return cap?.flow === 'PUSH' && cap.requires.length === 1 && cap.requires[0] === 'phoneNumber';
    }));
  assert('no CARD and no MOOV are declared', () =>
    gateway.capabilities.collect.CARD === undefined && gateway.capabilities.collect.MOOV === undefined);
  assert('settlesAsync is true, so the reconciliation sweep covers Campay rows', () =>
    gateway.capabilities.settlesAsync === true);
  assert('refundPayment is ABSENT: Campay has no refund API, and the absence is the contract', () =>
    typeof (gateway as any).refundPayment !== 'function' && typeof (gateway as any).refundAvailable !== 'function');
  assert('authorizePayment is ABSENT: there is no OTP step', () =>
    typeof (gateway as any).authorizePayment !== 'function');
  assert('confirmWebhookEvent, createPayout, payoutAvailable and payoutBalance are implemented', () =>
    ['confirmWebhookEvent', 'createPayout', 'payoutAvailable', 'payoutBalance'].every(
      (m) => typeof (gateway as any)[m] === 'function'
    ));
  assert('payouts are OFF unless CAMPAY_PAYOUTS_ENABLED=true', () => gateway.payoutAvailable() === false);

  // ─── 2 ──────────────────────────────────────────────────────────────────────
  section('2. The callback token');

  const good = jwt.sign({ source: 'CamPay' }, FIXTURE_KEY, { algorithm: 'HS256', expiresIn: 600 });
  const header = (alg: string) => Buffer.from(JSON.stringify({ alg, typ: 'JWT' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({ source: 'CamPay', iat: Math.floor(Date.now() / 1000) })).toString('base64url');

  assert('a token signed HS256 with our webhook key is accepted', () => campayCallbackTokenValid(good, FIXTURE_KEY));
  assert('the same token under a different key is refused', () => !campayCallbackTokenValid(good, 'another-key'));
  assert('alg:none is refused', () => !campayCallbackTokenValid(`${header('none')}.${claims}.`, FIXTURE_KEY));
  assert('HS512 is refused even with our key: the algorithm is pinned', () =>
    !campayCallbackTokenValid(jwt.sign({ source: 'CamPay' }, FIXTURE_KEY, { algorithm: 'HS512' }), FIXTURE_KEY));
  assert('an expired token is refused', () =>
    !campayCallbackTokenValid(
      jwt.sign({ source: 'CamPay', exp: Math.floor(Date.now() / 1000) - 3600 }, FIXTURE_KEY, { algorithm: 'HS256' }),
      FIXTURE_KEY
    ));
  assert('a token expired 30 s ago is inside the clock tolerance', () =>
    campayCallbackTokenValid(
      jwt.sign({ source: 'CamPay', exp: Math.floor(Date.now() / 1000) - 30 }, FIXTURE_KEY, { algorithm: 'HS256' }),
      FIXTURE_KEY
    ));
  assert('an empty key accepts nothing, even a token signed with an empty key', () =>
    !campayCallbackTokenValid(good, ''));
  assert('non-strings and garbage are refused, never thrown', () =>
    [undefined, null, 42, {}, '', 'not.a.jwt'].every((v) => campayCallbackTokenValid(v, FIXTURE_KEY) === false));

  // ─── 3 ──────────────────────────────────────────────────────────────────────
  section('3. verifyWebhook');

  const ref = '85ac913b-bf64-49c5-979e-d175f058a6af';
  const ourRef = mintMerchantRef('pt');
  const successBody = callbackBody({
    status: 'SUCCESSFUL', reference: ref, amount: '100', currency: 'XAF', operator: 'MTN',
    endpoint: 'collect', external_reference: ourRef, external_user: ourRef,
  });

  const accepted = gateway.verifyWebhook({ rawBody: successBody, headers: {} });
  assert('a correctly signed POST body is accepted', () => accepted.ok === true);
  assert('a body that is not raw bytes is unparsable (express.raw not mounted)', () => {
    const r = gateway.verifyWebhook({ rawBody: { status: 'SUCCESSFUL' }, headers: {} });
    return !r.ok && r.reason === 'unparsable';
  });
  assert('non-JSON bytes are unparsable', () => {
    const r = gateway.verifyWebhook({ rawBody: Buffer.from('status=SUCCESSFUL&reference=x'), headers: {} });
    return !r.ok && r.reason === 'unparsable';
  });
  assert('a body with no signature field is missing_signature', () => {
    const r = gateway.verifyWebhook({ rawBody: Buffer.from(JSON.stringify({ status: 'SUCCESSFUL', reference: ref })), headers: {} });
    return !r.ok && r.reason === 'missing_signature';
  });
  assert('a body signed with another key is bad_signature', () => {
    const r = gateway.verifyWebhook({ rawBody: callbackBody({ status: 'SUCCESSFUL', reference: ref }, 'attacker-key'), headers: {} });
    return !r.ok && r.reason === 'bad_signature';
  });

  // ─── 4 ──────────────────────────────────────────────────────────────────────
  section('4. Status mapping');

  assert('PENDING / SUCCESSFUL / FAILED map to PENDING / SUCCEEDED / FAILED, any case', () =>
    normalizeCampayStatus('PENDING') === 'PENDING'
      && normalizeCampayStatus('SUCCESSFUL') === 'SUCCEEDED'
      && normalizeCampayStatus('successful') === 'SUCCEEDED'
      && normalizeCampayStatus('FAILED') === 'FAILED');
  assert('an unknown word, empty or null maps to PENDING, never FAILED', () =>
    ['REVERSED?', '', null, undefined, 'EXPIRED_MAYBE'].every((w) => normalizeCampayStatus(w) === 'PENDING'));

  // ─── 5 ──────────────────────────────────────────────────────────────────────
  section('5. Numbers and references');

  assert('E.164, bare 237… and national all become 237XXXXXXXXX with no +', () =>
    ['+237 670 00 00 00', '237670000000', '670000000'].every((n) => campayMsisdn(n) === '237670000000'));
  assert('a number that is not a Cameroon mobile is null, never guessed', () =>
    campayMsisdn('+33612345678') === null && campayMsisdn('') === null && campayMsisdn(undefined) === null);
  assert('raw mode: external_reference and external_user both carry the jm_ reference', () => {
    const f = campayReferenceFields(ourRef, 'raw');
    return f.external_reference === ourRef && f.external_user === ourRef;
  });
  assert('uuid mode: external_reference is a well-formed UUID4 and external_user still carries jm_', () => {
    const f = campayReferenceFields(ourRef, 'uuid');
    return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(f.external_reference)
      && f.external_user === ourRef;
  });
  assert('uuid mode is deterministic for one reference (a retry resends the same value)', () =>
    campayReferenceFields(ourRef, 'uuid').external_reference === campayReferenceFields(ourRef, 'uuid').external_reference);
  assert('our reference is read from external_user first, and only a jm_ value counts', () =>
    campayMerchantRef({ external_user: ourRef, external_reference: 'something-else' }) === ourRef
      && campayMerchantRef({ external_user: 'None', external_reference: 'None' }) === null
      && campayMerchantRef({ external_reference: ourRef }) === ourRef);
  assert('a bare operator code (what the live demo answered, 2026-09-30) passes through unchanged', () =>
    campayUssdFor('*126#', 'MTN') === '*126#' && campayUssdFor(' #150*50# ', 'ORANGE') === '#150*50#');
  assert('the two-operator USSD sentence is split per operator', () =>
    campayUssdFor('*126# for MTN or #150*50# for ORANGE', 'MTN') === '*126#'
      && campayUssdFor('*126# for MTN or #150*50# for ORANGE', 'ORANGE') === '#150*50#'
      && campayUssdFor('dial something', 'MTN') === undefined
      && campayUssdFor(undefined, 'MTN') === undefined);
  assert('an ER code is found in a body whatever field carries it', () =>
    campayErrorCode({ error_code: 'ER301' }) === 'ER301'
      && campayErrorCode({ message: 'ER102 Unsupported Carrier' }) === 'ER102'
      && campayErrorCode({ message: 'nothing here' }) === null);

  // ─── 6 ──────────────────────────────────────────────────────────────────────
  section('6. Parsing');

  const collectEvent = accepted.ok ? gateway.parseWebhookEvent(accepted.payload) : null;
  const withdrawEvent = campayEventFrom(
    { status: 'SUCCESSFUL', reference: ref, endpoint: 'withdraw', external_user: 'jm_po_' + 'a'.repeat(32) },
    null
  );
  assert('a collect callback is a collection, carrying our reference and Campay\'s', () =>
    collectEvent?.direction === 'collection'
      && collectEvent.gatewayRef === ref
      && collectEvent.merchantRef === ourRef
      && collectEvent.status === 'SUCCEEDED');
  assert('⛔ a withdraw callback is a PAYOUT, and its event type agrees with directionOfEventType', () =>
    withdrawEvent?.direction === 'payout'
      && directionOfEventType(withdrawEvent.eventType) === 'payout'
      && withdrawEvent.merchantRef?.startsWith('jm_po_') === true);
  assert('the derived event id is stable across a redelivery of the same verdict', () =>
    campayEventFrom({ reference: ref, status: 'SUCCESSFUL' }, 1)?.eventId
      === campayEventFrom({ reference: ref, status: 'successful' }, 2)?.eventId);
  assert('…and different between two verdicts on one transaction', () =>
    campayEventFrom({ reference: ref, status: 'PENDING' }, 1)?.eventId
      !== campayEventFrom({ reference: ref, status: 'SUCCESSFUL' }, 1)?.eventId);
  assert('a body with no reference is not actionable (null)', () =>
    campayEventFrom({ status: 'SUCCESSFUL' }, null) === null);

  // The shape of a REAL demo record (verify:campay, 2026-09-30), signature and ids replaced.
  const liveShape = campayEventFrom({
    reference: '93a4f188-f422-47ff-856e-4a1aa92f3f7e', status: 'SUCCESSFUL', amount: '5.00', currency: 'XAF',
    operator: 'MTN', code: 'D260930D0013RR', operator_reference: '19008026883', endpoint: 'collect',
    external_reference: ourRef, external_user: ourRef, app_amount: '4.00', phone_number: '237672745831',
    reason: 'None',
  }, null);
  assert('the live record shape parses: a collection, SUCCEEDED, our jm_ reference, amount "5.00" kept for amountsEqual', () =>
    liveShape?.direction === 'collection' && liveShape.status === 'SUCCEEDED'
      && liveShape.merchantRef === ourRef && liveShape.amount === '5.00' && liveShape.currency === 'XAF');

  // ─── 7 ──────────────────────────────────────────────────────────────────────
  section('7. ⛔ The forgery drill');

  // A genuinely FAILED transaction. The attacker replays a valid token with status rewritten.
  const forgedBody = callbackBody({
    status: 'SUCCESSFUL', reference: ref, amount: '100', currency: 'XAF',
    endpoint: 'collect', external_reference: ourRef, external_user: ourRef,
  });
  const campayRecord = {
    reference: ref, status: 'FAILED', amount: 100.0, currency: 'XAF', operator: 'MTN',
    endpoint: 'collect', external_reference: ourRef, external_user: ourRef, reason: 'declined',
  };
  script([tokenRoute, [/\/transaction\//, () => ({ status: 200, body: campayRecord })]]);

  const forgedVerified = gateway.verifyWebhook({ rawBody: forgedBody, headers: {} });
  const forgedParsed = forgedVerified.ok ? gateway.parseWebhookEvent(forgedVerified.payload) : null;
  const forgedConfirmed = forgedParsed ? await gateway.confirmWebhookEvent(forgedParsed) : null;

  assert('the gap is real: a JWT-valid body claiming SUCCESSFUL passes verifyWebhook', () =>
    forgedVerified.ok === true && forgedParsed?.status === 'SUCCEEDED');
  assert('⛔ the fix works: confirmWebhookEvent reports Campay\'s FAILED, not the body\'s SUCCESSFUL', () =>
    forgedConfirmed?.status === 'FAILED');
  assert('the confirmed event takes amount and currency from Campay\'s record', () =>
    forgedConfirmed?.amount === 100 && forgedConfirmed?.currency === 'XAF');
  assert('the confirmed event id is derived from the CONFIRMED status (dedup keys on the truth)', () =>
    forgedConfirmed?.eventId === campayEventFrom(campayRecord, null)?.eventId
      && forgedConfirmed?.eventId !== forgedParsed?.eventId);
  assert('the confirmation re-read Campay (one /transaction/ call, by the callback\'s reference)', () =>
    seen.filter((s) => s.url.endsWith(`/transaction/${ref}/`)).length === 1);

  script([tokenRoute, [/\/transaction\//, () => ({ status: 200, body: { ...campayRecord, external_user: 'jm_pt_' + 'b'.repeat(32), external_reference: 'x' } })]]);
  const crossedRef = forgedParsed ? await gateway.confirmWebhookEvent(forgedParsed) : 'unreached';
  assert('a record naming a DIFFERENT merchant reference is refused (null)', () => crossedRef === null);

  script([tokenRoute, [/\/transaction\//, () => ({ status: 200, body: { ...campayRecord, endpoint: 'withdraw' } })]]);
  const crossedDirection = forgedParsed ? await gateway.confirmWebhookEvent(forgedParsed) : 'unreached';
  assert('a record in the OTHER direction is refused (a collect callback cannot settle a withdrawal)', () =>
    crossedDirection === null);

  script([tokenRoute, [/\/transaction\//, () => ({ status: 404, body: { message: 'Not found' } })]]);
  const unknownRef = forgedParsed ? await gateway.confirmWebhookEvent(forgedParsed) : 'unreached';
  assert('a reference Campay does not know (404) is refused, not retried forever', () => unknownRef === null);

  script([tokenRoute, [/\/transaction\//, () => ({ status: 500, body: {} })]]);
  const outage = forgedParsed ? await thrown(() => gateway.confirmWebhookEvent(forgedParsed)) : null;
  assert('a Campay outage THROWS, so the route answers 5xx and the sweep backstops', () =>
    isAppError(outage, ERROR_CODES.CAMPAY_REQUEST_FAILED));

  script([tokenRoute, [/\/transaction\//, () => 'network-error']]);
  const unreachable = forgedParsed ? await thrown(() => gateway.confirmWebhookEvent(forgedParsed)) : null;
  assert('an unreachable Campay throws CAMPAY_UNREACHABLE', () => isAppError(unreachable, ERROR_CODES.CAMPAY_UNREACHABLE));

  // A WITHDRAWAL callback, confirmed: the path a payout settles by.
  const withdrawRef = '029e82b2-8450-4ab6-8543-915776063114';
  const payoutRef = mintMerchantRef('po');
  const withdrawRecord = {
    reference: withdrawRef, status: 'SUCCESSFUL', amount: '3.00', currency: 'XAF', operator: 'MTN',
    endpoint: 'withdraw', external_reference: payoutRef, external_user: payoutRef, reason: 'None',
  };
  const withdrawCallback = gateway.verifyWebhook({ rawBody: callbackBody(withdrawRecord), headers: {} });
  const withdrawParsed = withdrawCallback.ok ? gateway.parseWebhookEvent(withdrawCallback.payload) : null;

  script([tokenRoute, [/\/transaction\//, () => ({ status: 200, body: withdrawRecord })]]);
  const withdrawConfirmed = withdrawParsed ? await gateway.confirmWebhookEvent(withdrawParsed) : null;
  assert('a confirmed withdrawal is a PAYOUT, SUCCEEDED, carrying our jm_po_ reference (what settlePayout looks up)', () =>
    withdrawConfirmed?.direction === 'payout'
      && withdrawConfirmed.status === 'SUCCEEDED'
      && withdrawConfirmed.merchantRef === payoutRef
      && withdrawConfirmed.gatewayRef === withdrawRef
      && directionOfEventType(withdrawConfirmed.eventType) === 'payout');
  assert('…confirmed by re-reading /transaction/ with the withdrawal\'s own reference', () =>
    seen.some((s) => s.url.endsWith(`/transaction/${withdrawRef}/`)));

  script([tokenRoute, [/\/transaction\//, () => ({ status: 200, body: { ...withdrawRecord, status: 'FAILED', reason: 'ER301' } })]]);
  const withdrawFailed = withdrawParsed ? await gateway.confirmWebhookEvent(withdrawParsed) : null;
  assert('a withdrawal callback claiming SUCCESSFUL that Campay records as FAILED confirms FAILED (the hold stays)', () =>
    withdrawFailed?.direction === 'payout' && withdrawFailed.status === 'FAILED');

  // ─── 8 ──────────────────────────────────────────────────────────────────────
  section('8. Calls on the wire');

  const fresh = new CampayGateway();
  script([tokenRoute, [/\/collect\/$/, () => ({ status: 200, body: { reference: ref, ussd_code: '*126# for MTN or #150*50# for ORANGE', operator: 'mtn' } })]]);
  const init = await fresh.initiatePayment({
    orderId: 'ORD-1', userId: 'u1', amount: 100, currency: 'XAF', merchantRef: ourRef,
    channel: { phoneNumber: '+237670000000' },
  });
  const collectCall = seen.find((s) => s.url.endsWith('/collect/'));

  assert('the token is fetched with the username/password, then sent as `Token`, never `Bearer`', () =>
    seen[0]?.url.endsWith('/token/') === true
      && seen[0].body?.username === 'fixture-user'
      && collectCall?.headers.Authorization === 'Token tok-1');
  assert('/collect/ receives 237… with no +, an integer string amount, and XAF', () =>
    collectCall?.body.from === '237670000000' && collectCall.body.amount === '100' && collectCall.body.currency === 'XAF');
  assert('/collect/ carries our jm_ reference in external_user (and, in raw mode, external_reference)', () =>
    collectCall?.body.external_user === ourRef && collectCall.body.external_reference === ourRef);
  assert('initiatePayment answers PENDING with Campay\'s reference and the MTN half of the USSD text', () =>
    init.success && init.status === 'PENDING' && init.gatewayRef === ref && init.instructions?.ussdCode === '*126#');

  script([tokenRoute]);
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

  // Single flight: two calls at once on a cold gateway mint ONE token.
  const cold = new CampayGateway();
  script([tokenRoute, [/\/transaction\//, () => ({ status: 200, body: { reference: ref, status: 'PENDING' } })]]);
  await Promise.all([cold.verifyPayment({ gatewayRef: ref }), cold.verifyPayment({ gatewayRef: ref })]);
  assert('two concurrent calls on a cold gateway fetch the token ONCE', () =>
    seen.filter((s) => s.url.endsWith('/token/')).length === 1);

  // One 401 → drop the token, fetch a new one, retry once.
  let tokenCount = 0;
  let txCount = 0;
  script([
    [/\/token\/$/, () => ({ status: 200, body: { token: `tok-${++tokenCount}`, expires_in: 3600 } })],
    [/\/transaction\//, (s) => (++txCount === 1 ? { status: 401, body: {} } : { status: 200, body: { reference: ref, status: s.headers.Authorization === 'Token tok-2' ? 'SUCCESSFUL' : 'PENDING' } })],
  ]);
  const retried = await new CampayGateway().verifyPayment({ gatewayRef: ref });
  assert('a 401 refreshes the token and retries once, with the NEW token', () =>
    retried.status === 'SUCCEEDED' && tokenCount === 2 && txCount === 2);

  script([tokenRoute, [/\/transaction\//, () => 'network-error']]);
  const blind = await new CampayGateway().verifyPayment({ gatewayRef: ref });
  assert('a verification that could not be performed is PENDING, never FAILED', () =>
    blind.status === 'PENDING' && blind.success === false);

  // ─── 9 ──────────────────────────────────────────────────────────────────────
  section('9. Payouts');

  const balances = { total_balance: 900, mtn_balance: 700, orange_balance: 200, currency: 'XAF' };
  script([tokenRoute, [/\/balance\/$/, () => ({ status: 200, body: balances })]]);
  const mtnFloat = await gateway.payoutBalance('XAF', '+237670000000');
  const orangeFloat = await gateway.payoutBalance('XAF', '+237690000000');
  const totalFloat = await gateway.payoutBalance('XAF');
  const usdFloat = await gateway.payoutBalance('USD');
  assert('with an MTN destination the balance is the MTN float', () => mtnFloat?.available === 700);
  assert('with an Orange destination it is the Orange float', () => orangeFloat?.available === 200);
  assert('with no destination it is the account total', () => totalFloat?.available === 900);
  assert('a currency other than XAF has no Campay float (null)', () => usdFloat === null);

  const poRef = mintMerchantRef('po');
  script([tokenRoute, [/\/withdraw\/$/, () => ({ status: 200, body: { reference: ref, status: 'PENDING' } })]]);
  const sent = await gateway.createPayout({ reference: poRef, amount: 50, currency: 'XAF', phone: '+237670000000', name: 'Test' });
  const withdrawCall = seen.find((s) => s.url.endsWith('/withdraw/'));
  assert('a withdrawal sends to 237… with our payout reference as the idempotency key', () =>
    withdrawCall?.body.to === '237670000000' && withdrawCall.body.external_reference === poRef
      && withdrawCall.body.external_user === poRef && withdrawCall.body.amount === '50');
  assert('an accepted withdrawal is success + PENDING, never settled on acceptance', () =>
    sent.success && sent.status === 'PENDING' && sent.gatewayRef === ref);

  script([tokenRoute, [/\/withdraw\/$/, () => ({ status: 400, body: { message: 'Insufficient balance', error_code: 'ER301' } })]]);
  const short = await gateway.createPayout({ reference: poRef, amount: 50, currency: 'XAF', phone: '+237690000000', name: 'Test' });
  assert('ER301 is `unsupported` with copy naming the carrier float', () =>
    short.unsupported === true && /Orange float/.test(short.message ?? ''));

  script([tokenRoute]);
  const unplaceable = await gateway.createPayout({ reference: poRef, amount: 50, currency: 'XAF', phone: '+33612345678', name: 'Test' });
  assert('a destination we cannot place is refused without calling Campay', () =>
    unplaceable.unsupported === true && seen.length === 0);

  script([tokenRoute, [/\/withdraw\/$/, () => ({ status: 500, body: {} })]]);
  const fault = await thrown(() => gateway.createPayout({ reference: poRef, amount: 50, currency: 'XAF', phone: '+237670000000', name: 'Test' }));
  assert('an unexplained 5xx on a withdrawal THROWS rather than being called unsupported', () =>
    isAppError(fault, ERROR_CODES.CAMPAY_REQUEST_FAILED));

  // ─── 10 ─────────────────────────────────────────────────────────────────────
  section('10. Boot rules (config/env.ts)');

  const base = { NODE_ENV: 'development' } as NodeJS.ProcessEnv;
  const problems = (env: Record<string, string>) => validateEnv({ ...base, ...env } as NodeJS.ProcessEnv);
  const errorOn = (env: Record<string, string>, variable: string) =>
    problems(env).some((p) => p.level === 'error' && p.variable === variable);
  const warningOn = (env: Record<string, string>, variable: string) =>
    problems(env).some((p) => p.level === 'warning' && p.variable === variable);

  assert('a username without its password refuses the boot', () =>
    errorOn({ CAMPAY_USERNAME: 'u', CAMPAY_WEBHOOK_KEY: 'k' }, 'CAMPAY_PASSWORD'));
  assert('credentials without the webhook key refuse the boot', () =>
    errorOn({ CAMPAY_USERNAME: 'u', CAMPAY_PASSWORD: 'p' }, 'CAMPAY_WEBHOOK_KEY'));
  assert('the permanent token alone also requires the webhook key', () =>
    errorOn({ CAMPAY_PERMANENT_TOKEN: 't' }, 'CAMPAY_WEBHOOK_KEY'));
  assert('a complete demo configuration in development raises nothing about Campay', () =>
    !problems({ CAMPAY_USERNAME: 'u', CAMPAY_PASSWORD: 'p', CAMPAY_WEBHOOK_KEY: 'k' }).some((p) => p.variable.startsWith('CAMPAY_')));
  assert('production + credentials + the DEFAULT (demo) base URL warns', () =>
    warningOn({ NODE_ENV: 'production', CAMPAY_USERNAME: 'u', CAMPAY_PASSWORD: 'p', CAMPAY_WEBHOOK_KEY: 'k' }, 'CAMPAY_BASE_URL'));
  assert('production + the live base URL does not warn', () =>
    !warningOn({ NODE_ENV: 'production', CAMPAY_USERNAME: 'u', CAMPAY_PASSWORD: 'p', CAMPAY_WEBHOOK_KEY: 'k', CAMPAY_BASE_URL: 'https://www.campay.net/api' }, 'CAMPAY_BASE_URL'));
  assert('CAMPAY_REF_MODE outside raw|uuid is refused', () => errorOn({ CAMPAY_REF_MODE: 'guid' }, 'CAMPAY_REF_MODE'));
  assert('CAMPAY_PAYOUTS_ENABLED=yes is refused (booleans are true|false|1|0)', () =>
    errorOn({ CAMPAY_PAYOUTS_ENABLED: 'yes' }, 'CAMPAY_PAYOUTS_ENABLED'));
  assert('payouts enabled with no credential refuses the boot', () =>
    errorOn({ CAMPAY_PAYOUTS_ENABLED: 'true' }, 'CAMPAY_PAYOUTS_ENABLED'));

  // ─── 11 ─────────────────────────────────────────────────────────────────────
  section('11. Source scans');

  const source = readFileSync(join(__dirname, '..', '..', 'src', 'modules', 'payments', 'gateways', 'campay.gateway.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert('the adapter never builds a `Bearer` header', () => !/['"`]Bearer /.test(source));
  assert('the adapter defines no refundPayment (a stub would make the orchestrator guard dead)', () =>
    !/\brefundPayment\s*\(/.test(source));
  assert('the webhook check goes through the pinned verifier, never jwt.decode', () =>
    source.includes('campayCallbackTokenValid(') && !/jwt\.decode|jsonwebtoken/.test(source));

  originalConsole.log(`\n${'═'.repeat(76)}`);
  originalConsole.log(`  ${passed} passed, ${failed} failed`);
  originalConsole.log(`${'═'.repeat(76)}\n`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((error) => {
  originalConsole.error('  ❌ THROW: test:campay runner —', error);
  process.exit(1);
});
