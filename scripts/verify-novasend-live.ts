/**
 * verify:novasend — the NovaSend adapter against NovaSend's REAL API (sandbox by default).
 *
 * `test:novasend` proves our side offline, against the shapes in NovaSend's documentation. This
 * proves the other party — and NovaSend's documentation contradicts itself, so every stage below
 * exists to settle one of the open questions in `NovaSendGateway`'s header:
 *
 *   - do the credentials authenticate, and what does an unknown reference answer?   (stage R)
 *   - is our `jm_…` reference accepted, with a derived-UUID idempotency key?        (stage C)
 *   - does a resend of the same reference charge twice?                            (stage C --resend)
 *   - which status words do pay-ins and payouts really use?                         (C, S, P with --scenario)
 *   - does Orange Cameroon need `payin.otp`, and what does a wrong one answer?      (C --phone=<orange> [--code])
 *   - is the payout body key `payout` (docs) or `payin` (SDK)?                      (stage P)
 *
 * ── STAGES ───────────────────────────────────────────────────────────────────
 *   npm run verify:novasend                                         R: read-only (safe, no money)
 *   npm run verify:novasend -- --collect --phone=670000000          C: a direct pay-in (MTN)
 *   npm run verify:novasend -- --collect --phone=655000000 --code=1234   C: Orange, with a payment code
 *   npm run verify:novasend -- --collect --phone=670000000 --resend C: the same reference twice
 *   npm run verify:novasend -- --status=<jm_ref> [--payout]         S: read one transaction back
 *   npm run verify:novasend -- --payout --phone=670000000           P: a payout (MONEY OUT on live)
 *   --scenario=completed|failed|pending   the sandbox outcome (ignored on the live host)
 *   --amount=200    amount in XAF (default 200, NovaSend's Cameroon minimum; hard cap 200)
 *   --live          required for any money stage when NOVASEND_BASE_URL is not the sandbox
 *
 * ⛔ MONEY RULES: on the live host, money stages refuse any number but the owner's two lines,
 * amounts above 200 XAF, and any run without --live. ⚠ 200 XAF is NovaSend's Cameroon MINIMUM and
 * is above the owner's usual 100 XAF test cap (docs/RUNBOOK.md): a live run needs the owner's
 * explicit go for 200. A green SKIP when NovaSend is not configured.
 * Credentials and payment codes are never printed.
 */

process.env.LOG_STDOUT = 'false';

import dotenv from 'dotenv';
dotenv.config();

const flag = (name: string): boolean => process.argv.includes(`--${name}`);
const arg = (name: string): string | null =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=') ?? null;

// Before the config module freezes: the sandbox outcome for this run.
const scenario = arg('scenario');
if (scenario) process.env.NOVASEND_SANDBOX_SCENARIO = scenario;

const OWNER_NUMBERS = new Set(['672745831', '652705926']);
const MAX_AMOUNT_XAF = 200;
const AMOUNT = Number(arg('amount') ?? '200');

(async () => {
  const { originalConsole: out } = await import('../src/core/logging/sink-guard');
  const { AppError } = await import('../src/core/errors');
  const { NOVASEND_CONFIG, NOVASEND_SANDBOX_BASE_URL } = await import('../src/modules/payments/config/payments.config');
  const { mintMerchantRef } = await import('../src/modules/payments/domain/merchant-reference');
  const { toCameroonNationalNumber, resolveCameroonOperator } = await import('../src/modules/payments/domain/cm-operator');
  const { NovaSendGateway, novasendCredentialsSet } = await import('../src/modules/payments/gateways/novasend.gateway');

  const SANDBOX = NOVASEND_CONFIG.BASE_URL === NOVASEND_SANDBOX_BASE_URL;

  function fail(message: string): never {
    out.error(`\n❌ ${message}\n`);
    process.exit(1);
  }

  function show(label: string, value: unknown): void {
    out.log(`\n── ${label}`);
    out.log(JSON.stringify(value, null, 2));
  }

  function describeError(error: unknown): unknown {
    if (error instanceof AppError) return { code: error.code, message: error.message, details: error.details };
    return { message: (error as Error)?.message ?? String(error) };
  }

  function moneyGuard(stage: string): string {
    const national = toCameroonNationalNumber(arg('phone'));
    if (!national) fail(`${stage}: --phone must be a Cameroon mobile number; refusing.`);
    if (!Number.isInteger(AMOUNT) || AMOUNT < 200 || AMOUNT > MAX_AMOUNT_XAF) {
      fail(`${stage}: --amount must be an integer from 200 to ${MAX_AMOUNT_XAF} XAF; refusing.`);
    }
    if (SANDBOX) return `+237${national}`;
    if (!OWNER_NUMBERS.has(national)) fail(`${stage}: on the LIVE host --phone must be one of the owner's numbers; refusing.`);
    if (!flag('live')) fail(`${stage}: this is the LIVE host and real money moves. Re-run with --live.`);
    return `+237${national}`;
  }

  /** A raw read, for the probes the adapter deliberately hides (it maps errors to PENDING). */
  async function rawGet(path: string): Promise<{ status: number; body: unknown }> {
    const auth = Buffer.from(`${NOVASEND_CONFIG.API_KEY}:${NOVASEND_CONFIG.API_SECRET}`).toString('base64');
    const res = await fetch(`${NOVASEND_CONFIG.BASE_URL}${path}`, {
      headers: { Accept: 'application/json', 'Accept-Language': 'en', Authorization: `Basic ${auth}` },
    });
    const text = await res.text();
    let body: unknown = text;
    try { body = text ? JSON.parse(text) : null; } catch { /* keep the text */ }
    return { status: res.status, body };
  }

  out.log(`\nverify:novasend — ${SANDBOX ? 'SANDBOX' : '⚠ LIVE'} host ${NOVASEND_CONFIG.BASE_URL}`);
  if (!novasendCredentialsSet()) {
    out.log('\n✅ SKIP — NOVASEND_API_KEY / NOVASEND_API_SECRET are not set in .env. Nothing was called.\n');
    process.exit(0);
  }
  out.log(`   webhook secret: ${NOVASEND_CONFIG.WEBHOOK_SECRET ? 'set' : 'NOT set (notifications would be refused)'}`);
  out.log(`   sandbox scenario: ${SANDBOX ? (NOVASEND_CONFIG.SANDBOX_SCENARIO || '(NovaSend default)') : 'n/a on live'}`);

  const gateway = new NovaSendGateway();

  // ── R: read-only ──────────────────────────────────────────────────────────
  const probeRef = mintMerchantRef('pt');
  const unknownPayin = await rawGet(`/v1/payin/${probeRef}`);
  show(`R1 GET /v1/payin/<unknown jm_ ref> → HTTP ${unknownPayin.status}`, unknownPayin.body);
  if (unknownPayin.status === 401 || unknownPayin.status === 403) {
    fail('NovaSend refused the credentials. Check NOVASEND_API_KEY / NOVASEND_API_SECRET (and that they are the SANDBOX pair for the sandbox host).');
  }
  const unknownPayout = await rawGet(`/v1/direct/payout/${mintMerchantRef('po')}`);
  show(`R2 GET /v1/direct/payout/<unknown jm_ ref> → HTTP ${unknownPayout.status}`, unknownPayout.body);

  // ── S: read one back ─────────────────────────────────────────────────────
  const statusRef = arg('status');
  if (statusRef) {
    const path = flag('payout') ? `/v1/direct/payout/${encodeURIComponent(statusRef)}` : `/v1/payin/${encodeURIComponent(statusRef)}`;
    const record = await rawGet(path);
    show(`S GET ${path} → HTTP ${record.status}`, record.body);
  }

  // ── C: a pay-in ──────────────────────────────────────────────────────────
  if (flag('collect')) {
    const phone = moneyGuard('collect');
    const operator = resolveCameroonOperator(phone);
    const merchantRef = mintMerchantRef('pt');
    const code = arg('code');
    const payload = {
      orderId: 'verify-novasend',
      userId: 'verify-novasend',
      amount: AMOUNT,
      currency: 'XAF',
      merchantRef,
      channel: {
        phoneNumber: phone,
        phoneOperator: operator ?? undefined,
        customerName: 'wi-mall verify',
        ...(code ? { paymentCode: code } : {}),
      },
    };
    out.log(`\nC pay-in ${AMOUNT} XAF → ${operator ?? 'unknown network'} ${phone.slice(0, 7)}•••, reference ${merchantRef}${code ? ' (with a payment code)' : ''}`);
    try {
      const first = await gateway.initiatePayment(payload);
      show('C1 initiatePayment', { ...first, rawResponse: first.rawResponse });
      if (flag('resend')) {
        const second = await gateway.initiatePayment(payload);
        show('C2 the SAME reference again (idempotency)', { ...second, rawResponse: second.rawResponse });
      }
      const back = await rawGet(`/v1/payin/${merchantRef}`);
      show(`C3 GET /v1/payin/${merchantRef} → HTTP ${back.status}`, back.body);
      out.log(`\n   Re-read later: npm run verify:novasend -- --status=${merchantRef}`);
    } catch (error) {
      show('C initiatePayment THREW', describeError(error));
    }
  }

  // ── P: a payout ──────────────────────────────────────────────────────────
  if (flag('payout') && !statusRef) {
    const phone = moneyGuard('payout');
    const reference = mintMerchantRef('po');
    out.log(`\nP payout ${AMOUNT} XAF → ${phone.slice(0, 7)}•••, reference ${reference}`);
    try {
      const sent = await gateway.createPayout({ reference, amount: AMOUNT, currency: 'XAF', phone, name: 'wi-mall verify' });
      show('P1 createPayout', sent);
      const back = await rawGet(`/v1/direct/payout/${reference}`);
      show(`P2 GET /v1/direct/payout/${reference} → HTTP ${back.status}`, back.body);
      const verdict = await gateway.verifyPayout({ gatewayRef: reference, reference });
      show('P3 verifyPayout', verdict);
      out.log(`\n   Re-read later: npm run verify:novasend -- --status=${reference} --payout`);
    } catch (error) {
      show('P createPayout THREW (outcome unknown)', describeError(error));
    }
  }

  out.log('\n✅ done — compare each answer with the open questions at the top of novasend.gateway.ts.\n');
  process.exit(0);
})().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('❌ verify:novasend runner —', error);
  process.exit(1);
});
