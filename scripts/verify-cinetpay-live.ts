/**
 * verify:cinetpay — the CinetPay adapter against CinetPay's REAL API (v1).
 *
 * `test:cinetpay` proves our arithmetic offline, against shapes copied from CinetPay's JS SDK.
 * This proves the other party: that login works with our pair, what a status lookup for an
 * unknown id looks like, whether our compact merchant id is accepted, whether the account has
 * "direct" mode (push) or redirects, and what a transfer answers.
 *
 * ── STAGES ───────────────────────────────────────────────────────────────────
 *   npm run verify:cinetpay                                  R: read-only (safe, no money)
 *   npm run verify:cinetpay -- --collect --phone=672745831   C: a charge (PIN prompt or a page link)
 *   npm run verify:cinetpay -- --status=<transaction_id>     S: read one charge back
 *   npm run verify:cinetpay -- --payout  --phone=672745831   P: a transfer (MONEY OUT of the float)
 *   --amount=100    charge / payout amount in XAF (default 100, CinetPay's minimum; hard cap 200)
 *   --live          required for any money stage when the key is a live (sk_live_) key
 *
 * ⛔ MONEY RULES, enforced here rather than trusted to whoever runs it:
 *   - with a live key, money stages refuse any number other than the owner's two lines
 *     (a sandbox key reaches no handset, so any Cameroon number is allowed; see moneyGuard);
 *   - amounts above 200 XAF are refused;
 *   - with a live key a money stage refuses without --live.
 *
 * A green SKIP (exit 0) when CinetPay is not configured. Nothing here writes to our database.
 * Responses are printed; the login request and response never are.
 */

process.env.LOG_STDOUT = 'false';

import dotenv from 'dotenv';
dotenv.config();

import { originalConsole as out } from '../src/core/logging/sink-guard';
import { AppError } from '../src/core/errors';
import { CINETPAY_CONFIG, CINETPAY_SANDBOX_BASE_URL } from '../src/modules/payments/config/payments.config';
import { mintMerchantRef } from '../src/modules/payments/domain/merchant-reference';
import { toCameroonNationalNumber } from '../src/modules/payments/domain/cm-operator';
import {
  CinetPayGateway,
  cinetpayStatusOf,
  toCinetpayMerchantId,
} from '../src/modules/payments/gateways/cinetpay.gateway';

const flag = (name: string): boolean => process.argv.includes(`--${name}`);
const arg = (name: string): string | null =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=') ?? null;

const OWNER_NUMBERS = new Set(['672745831', '652705926']);
const MAX_AMOUNT_XAF = 200;
const AMOUNT = Number(arg('amount') ?? '100');
const LIVE_KEY = CINETPAY_CONFIG.API_KEY.startsWith('sk_live_');

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

/**
 * The sandbox never reaches a handset: it simulates the outcome from the LAST FOUR digits
 * (SDK README): 0700 success · 0701 pending then success · 0703 failure · 0704 pending then
 * failure · 0706 pending forever. So with a sandbox key any Cameroon number is allowed, e.g.
 * 670070700 (MTN) or 690070703 (Orange). Real numbers stay owner-only with a live key.
 */
function moneyGuard(stage: string): string {
  const national = toCameroonNationalNumber(arg('phone'));
  if (!national) fail(`${stage}: --phone must be a Cameroon mobile number; refusing.`);
  if (!LIVE_KEY && national) return `+237${national}`;
  if (!national || !OWNER_NUMBERS.has(national)) {
    fail(`${stage}: --phone must be one of the owner's numbers (${[...OWNER_NUMBERS].join(', ')}); refusing.`);
  }
  if (!Number.isInteger(AMOUNT) || AMOUNT < 100 || AMOUNT > MAX_AMOUNT_XAF) {
    fail(`${stage}: --amount must be an integer from 100 to ${MAX_AMOUNT_XAF} XAF; refusing.`);
  }
  if (LIVE_KEY && !flag('live')) fail(`${stage}: this is a LIVE key and real money moves. Re-run with --live.`);
  return `+237${national}`;
}

(async () => {
  if (!CINETPAY_CONFIG.API_KEY || !CINETPAY_CONFIG.API_PASSWORD) {
    out.log('⏭  SKIP: CINETPAY_API_KEY / CINETPAY_API_PASSWORD are not set.');
    process.exit(0);
  }

  const gateway = new CinetPayGateway();
  // The adapter's authenticated call, so raw bodies can be shown. Private by design; this script is the exception.
  const call = (path: string, method: 'GET' | 'POST', body?: Record<string, unknown>) =>
    (gateway as any).call(path, method, body);

  out.log(`CinetPay ${CINETPAY_CONFIG.BASE_URL} (${CINETPAY_CONFIG.BASE_URL === CINETPAY_SANDBOX_BASE_URL ? 'SANDBOX' : 'LIVE host'}), key ${LIVE_KEY ? 'sk_live_' : CINETPAY_CONFIG.API_KEY.startsWith('sk_test_') ? 'sk_test_' : 'with no recognised prefix'}`);
  out.log(`notify_url: ${CINETPAY_CONFIG.NOTIFY_URL || '(none — set API_PUBLIC_URL or CINETPAY_NOTIFY_URL)'}`);

  // ── R ───────────────────────────────────────────────────────────────────
  out.log('\n═══ R: read-only ═══');
  try {
    show('R1 GET /v1/balances (login happens first; a failure here is the credential pair or the IP)', await call('/v1/balances', 'GET'));
  } catch (error) {
    show('R1 FAILED', describeError(error));
    fail('Cannot authenticate or read the balance. Check the key/password pair, the host, and whether CinetPay whitelists our IP.');
  }

  const unknownId = toCinetpayMerchantId(mintMerchantRef('pt'))!;
  for (const [label, path] of [
    ['R2 GET /v1/payment/{unknown merchant id}', `/v1/payment/${unknownId}`],
    ['R3 GET /v1/transfer/{unknown merchant id}', `/v1/transfer/${unknownId}`],
  ] as const) {
    try {
      const body = await call(path, 'GET');
      show(`${label} → status word ${cinetpayStatusOf(body)}`, body);
    } catch (error) {
      show(`${label} → threw`, describeError(error));
    }
  }

  // ── S ───────────────────────────────────────────────────────────────────
  const statusId = arg('status');
  if (statusId) {
    out.log('\n═══ S: read one charge back ═══');
    try {
      show(`S1 GET /v1/payment/${statusId}`, await call(`/v1/payment/${encodeURIComponent(statusId)}`, 'GET'));
      show('S2 the adapter\'s verdict', await gateway.verifyPayment({ gatewayRef: statusId }));
    } catch (error) {
      show('S FAILED', describeError(error));
    }
  }

  // ── C ───────────────────────────────────────────────────────────────────
  if (flag('collect')) {
    out.log('\n═══ C: a charge ═══');
    const phone = moneyGuard('C');
    const merchantRef = mintMerchantRef('pt');
    out.log(`merchantRef ${merchantRef} → merchant_transaction_id ${toCinetpayMerchantId(merchantRef)}`);
    try {
      const result = await gateway.initiatePayment({
        orderId: 'VERIFY-CINETPAY', userId: 'verify', amount: AMOUNT, currency: 'XAF', merchantRef,
        channel: { phoneNumber: phone, customerName: 'Verify CinetPay' },
      });
      show('C1 initiatePayment (rawResponse is CinetPay\'s body)', result);
      out.log(result.instructions?.redirectUrl
        ? '\n→ REDIRECT: this account has no direct mode for this operator. Open redirectUrl to pay.'
        : '\n→ PUSH: approve the prompt on the handset.');
      if (result.gatewayRef) {
        out.log(`\nRead it back after paying (or not):\n  npm run verify:cinetpay -- --status=${result.gatewayRef}`);
      }
    } catch (error) {
      show('C1 FAILED', describeError(error));
    }
  }

  // ── P ───────────────────────────────────────────────────────────────────
  if (flag('payout')) {
    out.log('\n═══ P: a transfer (money OUT) ═══');
    const phone = moneyGuard('P');
    const reference = mintMerchantRef('po');
    try {
      const result = await gateway.createPayout({ reference, amount: AMOUNT, currency: 'XAF', phone, name: 'Verify', description: 'verify:cinetpay' });
      show('P1 createPayout', result);
      if (result.gatewayRef) show('P2 verifyPayout', await gateway.verifyPayout({ gatewayRef: result.gatewayRef, reference }));
    } catch (error) {
      show('P1 THREW (outcome unknown — check the CinetPay dashboard)', describeError(error));
    }
  }

  out.log('\nDone.');
  process.exit(0);
})().catch((error) => {
  out.error('❌ verify:cinetpay runner —', error);
  process.exit(1);
});
