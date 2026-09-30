/**
 * verify:campay — the Campay adapter against Campay's REAL API (ADR-A08 P2.1, step 7).
 *
 * `test:campay` proves our arithmetic offline. This proves the other party: that the auth
 * scheme is what we send, that our reference is accepted and echoed, what the status words and
 * error bodies really look like, and that a callback's token verifies with our key.
 *
 * ── STAGES ───────────────────────────────────────────────────────────────────
 *   npm run verify:campay                                   R: read-only (safe, no money)
 *   npm run verify:campay -- --collect --phone=672745831    C: a charge (PIN prompt on that handset)
 *   npm run verify:campay -- --payout  --phone=672745831    P: a withdrawal (MONEY OUT of the float)
 *   npm run verify:campay -- --callback-file=body.json      W: verify a captured callback body
 *   --amount=5      charge / payout amount in XAF (default 5, hard cap 100)
 *   --ref-mode=uuid send external_reference as a UUID instead of the raw jm_ reference
 *   --idempotency   C: resend the first charge with the SAME reference and report what happens
 *   --live          required for any money stage when CAMPAY_BASE_URL is not the demo host
 *
 * ⛔ MONEY RULES, enforced here rather than trusted to whoever runs it:
 *   - money stages refuse any number other than the owner's two MTN lines;
 *   - amounts above 100 XAF are refused;
 *   - against a non-demo host a money stage refuses without --live.
 *
 * A green SKIP (exit 0) when Campay is not configured. Nothing here writes to our database.
 */

process.env.LOG_STDOUT = 'false';

import dotenv from 'dotenv';
dotenv.config();

// Before the config import freezes: an explicit --ref-mode overrides the environment for this run.
const refModeArg = process.argv.find((a) => a.startsWith('--ref-mode='))?.split('=')[1];
if (refModeArg === 'uuid' || refModeArg === 'raw') process.env.CAMPAY_REF_MODE = refModeArg;

import { readFileSync } from 'fs';
import { originalConsole as out } from '../src/core/logging/sink-guard';
import { AppError } from '../src/core/errors';
import { CAMPAY_CONFIG, CAMPAY_DEMO_BASE_URL, campayEnabled } from '../src/modules/payments/config/payments.config';
import { mintMerchantRef } from '../src/modules/payments/domain/merchant-reference';
import { toCameroonNationalNumber } from '../src/modules/payments/domain/cm-operator';
import {
  CampayGateway,
  campayErrorCode,
  campayReferenceFields,
} from '../src/modules/payments/gateways/campay.gateway';

// ─── Flags ───────────────────────────────────────────────────────────────────

const flag = (name: string): boolean => process.argv.includes(`--${name}`);
const arg = (name: string): string | null =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=') ?? null;

const DO_COLLECT = flag('collect');
const DO_PAYOUT = flag('payout');
const DO_IDEMPOTENCY = flag('idempotency');
const LIVE = flag('live');
const CALLBACK_FILE = arg('callback-file');
const AMOUNT = Number(arg('amount') ?? 5);
const PHONE = arg('phone');

/** The owner's own MTN lines: the ONLY destinations a money stage may use. */
const OWNER_NUMBERS = new Set(['672745831', '652705926']);
const MAX_AMOUNT_XAF = 100;

const IS_DEMO = CAMPAY_CONFIG.BASE_URL === CAMPAY_DEMO_BASE_URL;

// ─── Reporting ───────────────────────────────────────────────────────────────

let failures = 0;
const facts: Record<string, unknown> = {};

function stage(title: string): void {
  out.log(`\n── ${title} ${'─'.repeat(Math.max(0, 72 - title.length))}`);
}
function pass(msg: string): void {
  out.log(`  ✅ ${msg}`);
}
function fail(msg: string): void {
  failures++;
  out.error(`  ❌ ${msg}`);
}
function info(msg: string): void {
  out.log(`  ·  ${msg}`);
}
function record(key: string, value: unknown): void {
  facts[key] = value;
  info(`${key} = ${JSON.stringify(value)}`);
}
function describe(error: unknown): string {
  if (error instanceof AppError) return `${error.code} ${JSON.stringify(error.details ?? {})}`;
  return (error as Error)?.message ?? String(error);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Raw HTTP beside the adapter, for the questions whose answer IS the raw shape (error bodies,
 * unknown references). The token comes from the adapter's own /token/ exchange.
 */
async function raw(path: string, method: 'GET' | 'POST', token: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${CAMPAY_CONFIG.BASE_URL}${path}`, {
    method,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Token ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: any = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* keep the text */
  }
  return { status: res.status, body: parsed };
}

async function fetchToken(): Promise<string> {
  if (!CAMPAY_CONFIG.USERNAME && CAMPAY_CONFIG.PERMANENT_TOKEN) return CAMPAY_CONFIG.PERMANENT_TOKEN;
  const res = await fetch(`${CAMPAY_CONFIG.BASE_URL}/token/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ username: CAMPAY_CONFIG.USERNAME, password: CAMPAY_CONFIG.PASSWORD }),
  });
  const body: any = await res.json().catch(() => null);
  if (res.status !== 200 || typeof body?.token !== 'string') {
    // Campay's `message` and `code` never echo the credentials, so they are safe to print, and
    // they are the diagnosis: `malicious_payload_rejected` means a value still holds a
    // `<placeholder>` from a template (Campay refuses anything that looks like a tag).
    throw new Error(`POST /token/ answered ${res.status}: ${body?.code ?? ''} ${body?.message ?? ''}`.trim());
  }
  record('R2.token_expires_in_seconds', body.expires_in);
  return body.token;
}

/** Guard every money stage. Returns the national number, or null after reporting why not. */
function moneyTarget(stageName: string): string | null {
  const national = toCameroonNationalNumber(PHONE);
  if (!national || !OWNER_NUMBERS.has(national)) {
    fail(`${stageName}: --phone must be one of the owner's MTN numbers (${[...OWNER_NUMBERS].join(', ')}); refusing.`);
    return null;
  }
  if (!Number.isInteger(AMOUNT) || AMOUNT < 1 || AMOUNT > MAX_AMOUNT_XAF) {
    fail(`${stageName}: --amount must be an integer from 1 to ${MAX_AMOUNT_XAF} XAF; refusing.`);
    return null;
  }
  if (!IS_DEMO && !LIVE) {
    fail(`${stageName}: CAMPAY_BASE_URL is ${CAMPAY_CONFIG.BASE_URL}, not the demo host. Pass --live to move REAL money; refusing.`);
    return null;
  }
  return national;
}

/** Poll /transaction/{ref}/ until it leaves PENDING or the budget runs out. */
async function poll(gateway: CampayGateway, ref: string, budgetMs: number): Promise<any> {
  const deadline = Date.now() + budgetMs;
  let last: any = null;
  while (Date.now() < deadline) {
    const v = await gateway.verifyPayment({ gatewayRef: ref });
    last = v.rawResponse;
    info(`status ${v.rawResponse?.status ?? '(no answer)'} → ${v.status}`);
    if (v.status !== 'PENDING') return last;
    await sleep(5000);
  }
  return last;
}

// ─── Main ────────────────────────────────────────────────────────────────────

(async () => {
  out.log(`\nverify:campay → ${CAMPAY_CONFIG.BASE_URL}${IS_DEMO ? '  (DEMO)' : '  ⚠ NOT THE DEMO HOST'}`);

  stage('R1. Configuration');
  if (!campayEnabled()) {
    out.log('  ⏭  SKIP: Campay is not configured (CAMPAY_USERNAME + CAMPAY_PASSWORD or CAMPAY_PERMANENT_TOKEN, and CAMPAY_WEBHOOK_KEY).');
    process.exit(0);
  }
  pass(`configured (auth: ${CAMPAY_CONFIG.USERNAME ? 'username/password' : 'permanent token'}, ref mode: ${CAMPAY_CONFIG.REF_MODE})`);

  const gateway = new CampayGateway();

  stage('R2. Token exchange');
  let token: string;
  try {
    token = await fetchToken();
    pass('POST /token/ issued a token, sent back as `Authorization: Token …`');
  } catch (error) {
    fail(`token: ${describe(error)}`);
    return finish();
  }

  stage('R4. Balance (per carrier)');
  try {
    const res = await raw('/balance/', 'GET', token);
    const keys = ['total_balance', 'mtn_balance', 'orange_balance', 'currency'];
    record('R4.balance_keys', res.body ? Object.keys(res.body) : null);
    if (res.status === 200 && keys.every((k) => k in (res.body ?? {}))) {
      pass(`balance: total ${res.body.total_balance}, MTN ${res.body.mtn_balance}, Orange ${res.body.orange_balance} ${res.body.currency}`);
      const viaAdapter = await gateway.payoutBalance('XAF', '+237672745831');
      if (viaAdapter?.available === Number(res.body.mtn_balance)) pass('payoutBalance(XAF, MTN number) reports the MTN float');
      else fail(`payoutBalance(XAF, MTN number) = ${JSON.stringify(viaAdapter)}, expected the MTN float`);
    } else {
      fail(`GET /balance/ answered ${res.status} ${JSON.stringify(res.body)}`);
    }
  } catch (error) {
    fail(`balance: ${describe(error)}`);
  }

  stage('R5. An unknown reference');
  try {
    const res = await raw('/transaction/00000000-0000-4000-8000-000000000000/', 'GET', token);
    record('R5.unknown_reference', { status: res.status, body: res.body });
    const confirm = await gateway
      .confirmWebhookEvent({
        eventId: 'x', eventType: 'payment.successful', direction: 'collection',
        gatewayRef: '00000000-0000-4000-8000-000000000000', merchantRef: null,
        status: 'SUCCEEDED', amount: 1, currency: 'XAF', raw: null,
      })
      .then((r) => (r === null ? 'null (refused)' : `event with status ${r.status}`))
      .catch((e) => `threw ${describe(e)}`);
    record('R5.confirmWebhookEvent_on_unknown', confirm);
    if (confirm.startsWith('null')) pass('confirmWebhookEvent refuses a reference Campay does not know');
    else info('⚠ confirmWebhookEvent did not answer null: its 404 mapping must follow the status recorded above');
  } catch (error) {
    fail(`unknown reference: ${describe(error)}`);
  }

  stage('R6. Holder lookup');
  if (PHONE) {
    try {
      const national = toCameroonNationalNumber(PHONE);
      const res = await raw(`/holder_info/?phone_number=237${national}`, 'GET', token);
      record('R6.holder_info', { status: res.status, keys: res.body ? Object.keys(res.body) : null });
    } catch (error) {
      info(`holder_info: ${describe(error)}`);
    }
  } else {
    info('skipped (no --phone)');
  }

  stage('R7. The error envelope');
  if (IS_DEMO) {
    try {
      // A non-mobile number, so no handset can be prompted: Campay must refuse it outright.
      const res = await raw('/collect/', 'POST', token, {
        amount: '1', currency: 'XAF', from: '237100000000', description: 'verify:campay error-envelope probe',
      });
      record('R7.error_envelope', { status: res.status, body: res.body, errorCode: campayErrorCode(res.body) });
      if (res.status >= 400 && campayErrorCode(res.body)) pass(`an invalid number is refused with ${campayErrorCode(res.body)} at HTTP ${res.status}`);
      else info('⚠ no ER code found: payoutBlockedReason matches on ER codes, so read the body above');
    } catch (error) {
      fail(`error envelope: ${describe(error)}`);
    }
  } else {
    info('skipped off the demo host (it calls /collect/)');
  }

  if (DO_COLLECT) await collectStages(gateway, token);
  if (DO_PAYOUT) await payoutStages(gateway);
  if (CALLBACK_FILE) await callbackStage(gateway);

  finish();
})().catch((error) => {
  out.error('  ❌ THROW: verify:campay —', error);
  process.exit(1);
});

async function collectStages(gateway: CampayGateway, token: string): Promise<void> {
  stage(`C. Collection (${AMOUNT} XAF)`);
  const national = moneyTarget('collect');
  if (!national) return;

  const merchantRef = mintMerchantRef('pt');
  record('C1.ref_mode', CAMPAY_CONFIG.REF_MODE);
  record('C1.external_reference_sent', campayReferenceFields(merchantRef, CAMPAY_CONFIG.REF_MODE).external_reference);

  let init;
  try {
    init = await gateway.initiatePayment({
      orderId: 'VERIFY-CAMPAY', userId: 'verify-campay', amount: AMOUNT, currency: 'XAF', merchantRef,
      channel: { phoneNumber: `+237${national}` },
    });
  } catch (error) {
    record('C1.refused', describe(error));
    fail(`C1: /collect/ refused in ${CAMPAY_CONFIG.REF_MODE} mode. If the body names external_reference, re-run with --ref-mode=uuid.`);
    return;
  }
  if (!init.success) {
    fail(`C1: ${init.error}`);
    return;
  }
  pass(`C1: /collect/ accepted our reference in ${CAMPAY_CONFIG.REF_MODE} mode → Campay reference ${init.gatewayRef}`);
  record('C2.collect_response', init.rawResponse);
  record('C2.ussd_for_mtn', init.instructions?.ussdCode ?? null);

  out.log('\n  📱 Approve (or decline) the prompt on the handset now. Polling for up to 3 minutes…');
  const final = await poll(gateway, init.gatewayRef, 180_000);
  record('C3.final_record', final);
  if (final?.external_user === merchantRef) pass('C3: external_user echoes our jm_ reference unchanged');
  else fail(`C3: external_user came back as ${JSON.stringify(final?.external_user)}, expected ${merchantRef}`);
  record('C3.external_reference_echo', final?.external_reference ?? null);
  record('C3.amount_type', typeof final?.amount);

  if (DO_IDEMPOTENCY) {
    stage('C5. Idempotency on external_reference');
    try {
      const again = await raw('/collect/', 'POST', token, {
        amount: String(AMOUNT), currency: 'XAF', from: `237${national}`, description: 'verify:campay idempotency',
        ...campayReferenceFields(merchantRef, CAMPAY_CONFIG.REF_MODE),
      });
      record('C5.resend_same_reference', { status: again.status, body: again.body });
      if (again.body?.reference === init.gatewayRef) pass('C5: the same reference returned the FIRST transaction (idempotent)');
      else info('⚠ C5: a different answer. Check the handset for a SECOND prompt; do not approve it.');
    } catch (error) {
      record('C5.resend_same_reference', describe(error));
    }
  }
}

async function payoutStages(gateway: CampayGateway): Promise<void> {
  stage(`P. Payout (${AMOUNT} XAF) ⚠ money out of the Campay float`);
  const national = moneyTarget('payout');
  if (!national) return;

  const before = await gateway.payoutBalance('XAF', `+237${national}`).catch((e) => describe(e));
  record('P1.carrier_float_before', before);

  const reference = mintMerchantRef('po');
  const sent = await gateway
    .createPayout({ reference, amount: AMOUNT, currency: 'XAF', phone: `+237${national}`, name: 'verify:campay', description: 'verify:campay' })
    .catch((e) => ({ thrown: describe(e) }));
  record('P2.createPayout', sent);
  if ('success' in sent && sent.success && sent.gatewayRef) {
    pass(`P2: withdrawal accepted → ${sent.gatewayRef} (${sent.status})`);
    const final = await poll(gateway, sent.gatewayRef, 180_000);
    record('P5.final_record', final);
    if (final?.endpoint === 'withdraw') pass('P5: the record says endpoint "withdraw", so it parses as a payout');
    else fail(`P5: endpoint came back as ${JSON.stringify(final?.endpoint)}`);
  } else {
    fail('P2: the withdrawal was not accepted (see above). If it is a 403, allow API withdrawals in the Campay app.');
  }
}

async function callbackStage(gateway: CampayGateway): Promise<void> {
  stage('W. A captured callback');
  let body: Buffer;
  try {
    body = readFileSync(CALLBACK_FILE!);
  } catch (error) {
    fail(`cannot read ${CALLBACK_FILE}: ${describe(error)}`);
    return;
  }

  const parsed = JSON.parse(body.toString('utf8'));
  const [h, p] = String(parsed.signature ?? '').split('.');
  const decode = (s?: string) => {
    try {
      return s ? JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) : null;
    } catch {
      return null;
    }
  };
  record('W2.token_header', decode(h));
  record('W2.token_claims', decode(p));

  const verified = gateway.verifyWebhook({ rawBody: body, headers: {} });
  if (!verified.ok) {
    fail(`W4: verifyWebhook refused it: ${verified.reason}. Is CAMPAY_WEBHOOK_KEY this application's webhook key?`);
    return;
  }
  pass('W4: verifyWebhook accepts the captured body with our webhook key');

  const event = gateway.parseWebhookEvent(verified.payload);
  record('W5.parsed', event && { direction: event.direction, status: event.status, merchantRef: event.merchantRef });
  if (!event) return;

  const confirmed = await gateway.confirmWebhookEvent(event).catch((e) => describe(e));
  record('W6.confirmed', typeof confirmed === 'string' ? confirmed : confirmed && { status: confirmed.status, amount: confirmed.amount });
}

function finish(): void {
  out.log(`\n${'═'.repeat(76)}`);
  out.log('  Facts (paste into the report):');
  out.log(JSON.stringify(facts, null, 2).split('\n').map((l) => `  ${l}`).join('\n'));
  out.log(`  ${failures === 0 ? '✅ no failures' : `❌ ${failures} failure(s)`}`);
  out.log(`${'═'.repeat(76)}\n`);
  process.exit(failures > 0 ? 1 : 0);
}
