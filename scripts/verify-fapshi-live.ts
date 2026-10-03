/**
 * verify:fapshi — the Fapshi adapter against Fapshi's REAL API.
 *
 * `test:fapshi` proves our arithmetic offline, against the shapes in Fapshi's documentation.
 * This proves the other party: that both credential pairs authenticate, what an unknown id and
 * an empty payout history really look like, that direct pay is enabled, and what a payout answers.
 *
 * ── STAGES ───────────────────────────────────────────────────────────────────
 *   npm run verify:fapshi                                   R: read-only (safe, no money)
 *   npm run verify:fapshi -- --collect --phone=670000000    C: a direct-pay charge
 *   npm run verify:fapshi -- --status=<transId>             S: read one transaction back
 *   npm run verify:fapshi -- --payout  --phone=670000000    P: a payout (MONEY OUT on live)
 *   --amount=100    amount in XAF (default 100, Fapshi's minimum; hard cap 200)
 *   --live          required for any money stage when FAPSHI_BASE_URL is not the sandbox
 *
 * Sandbox test numbers (Fapshi docs): success 670000000 · 670000002 · 650000000 (MTN),
 * 690000000 · 690000002 · 656000000 (Orange); failure 670000001 · 670000003 · 650000001 (MTN),
 * 690000001 · 690000003 · 656000001 (Orange). Any other number: a RANDOM outcome.
 *
 * ⛔ MONEY RULES: on the live host, money stages refuse any number but the owner's two lines,
 * amounts above 200 XAF, and any run without --live. A green SKIP when Fapshi is not configured.
 * Credentials are never printed.
 */

process.env.LOG_STDOUT = 'false';

import dotenv from 'dotenv';
dotenv.config();

import { originalConsole as out } from '../src/core/logging/sink-guard';
import { AppError } from '../src/core/errors';
import { FAPSHI_CONFIG, FAPSHI_SANDBOX_BASE_URL } from '../src/modules/payments/config/payments.config';
import { mintMerchantRef } from '../src/modules/payments/domain/merchant-reference';
import { toCameroonNationalNumber } from '../src/modules/payments/domain/cm-operator';
import { FapshiGateway, fapshiPayoutCredentialsSet } from '../src/modules/payments/gateways/fapshi.gateway';

const flag = (name: string): boolean => process.argv.includes(`--${name}`);
const arg = (name: string): string | null =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=') ?? null;

const OWNER_NUMBERS = new Set(['672745831', '652705926']);
const MAX_AMOUNT_XAF = 200;
const AMOUNT = Number(arg('amount') ?? '100');
const SANDBOX = FAPSHI_CONFIG.BASE_URL === FAPSHI_SANDBOX_BASE_URL;

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
  if (!Number.isInteger(AMOUNT) || AMOUNT < 100 || AMOUNT > MAX_AMOUNT_XAF) {
    fail(`${stage}: --amount must be an integer from 100 to ${MAX_AMOUNT_XAF} XAF; refusing.`);
  }
  if (SANDBOX) return `+237${national}`;
  if (!national || !OWNER_NUMBERS.has(national)) fail(`${stage}: on the LIVE host --phone must be one of the owner's numbers; refusing.`);
  if (!flag('live')) fail(`${stage}: this is the LIVE host and real money moves. Re-run with --live.`);
  return `+237${national}`;
}

(async () => {
  if (!FAPSHI_CONFIG.API_USER || !FAPSHI_CONFIG.API_KEY) {
    out.log('⏭  SKIP: FAPSHI_API_USER / FAPSHI_API_KEY are not set.');
    process.exit(0);
  }

  const gateway = new FapshiGateway();
  // The adapter's call, so raw bodies can be shown. Private by design; this script is the exception.
  const call = (service: 'collection' | 'payout', path: string) => (gateway as any).call(service, path, 'GET');

  out.log(`Fapshi ${FAPSHI_CONFIG.BASE_URL} (${SANDBOX ? 'SANDBOX' : 'LIVE host'})`);
  out.log(`payout service: ${fapshiPayoutCredentialsSet() ? 'configured' : 'NOT configured'} · webhook secret: ${FAPSHI_CONFIG.WEBHOOK_SECRET ? 'set' : 'NOT set'}`);

  // ── R ───────────────────────────────────────────────────────────────────
  out.log('\n═══ R: read-only ═══');
  try {
    show('R1 GET /payment-status/{unknown} on the COLLECTION service (authenticates the pair)', await call('collection', '/payment-status/zzzzzzzz'));
  } catch (error) {
    show('R1 → threw (a 404 here is the expected "not found"; a 403 is bad credentials)', describeError(error));
  }
  if (fapshiPayoutCredentialsSet()) {
    try {
      show('R2 GET /balance on the PAYOUT service', await call('payout', '/balance'));
    } catch (error) {
      show('R2 FAILED', describeError(error));
    }
    const unused = mintMerchantRef('po');
    try {
      show(`R3 GET /transaction/{never-used reference} (what "no earlier send" looks like)`, await call('payout', `/transaction/${unused}`));
    } catch (error) {
      show('R3 → threw', describeError(error));
    }
  }

  // ── S ───────────────────────────────────────────────────────────────────
  const statusId = arg('status');
  if (statusId) {
    out.log('\n═══ S: read one transaction back ═══');
    try {
      show(`S1 GET /payment-status/${statusId}`, await call('collection', `/payment-status/${encodeURIComponent(statusId)}`));
      show('S2 the adapter\'s verdict', await gateway.verifyPayment({ gatewayRef: statusId }));
    } catch (error) {
      show('S FAILED (a payout id needs the payout pair: it is read with that one in the sweep)', describeError(error));
    }
  }

  // ── C ───────────────────────────────────────────────────────────────────
  if (flag('collect')) {
    out.log('\n═══ C: a direct-pay charge ═══');
    const phone = moneyGuard('C');
    try {
      const result = await gateway.initiatePayment({
        orderId: 'VERIFY-FAPSHI', userId: 'verify-fapshi', amount: AMOUNT, currency: 'XAF',
        merchantRef: mintMerchantRef('pt'), channel: { phoneNumber: phone, customerName: 'Verify Fapshi' },
      });
      show('C1 initiatePayment', result);
      if (result.gatewayRef) out.log(`\nRead it back:\n  npm run verify:fapshi -- --status=${result.gatewayRef}`);
    } catch (error) {
      show('C1 FAILED (a 403 on the LIVE host usually means direct pay is not yet enabled for the service)', describeError(error));
    }
  }

  // ── P ───────────────────────────────────────────────────────────────────
  if (flag('payout')) {
    out.log('\n═══ P: a payout ═══');
    if (!fapshiPayoutCredentialsSet()) fail('P: FAPSHI_PAYOUT_API_USER / FAPSHI_PAYOUT_API_KEY are not set.');
    const phone = moneyGuard('P');
    const reference = mintMerchantRef('po');
    try {
      const result = await gateway.createPayout({ reference, amount: AMOUNT, currency: 'XAF', phone, name: 'Verify', description: 'verify:fapshi' });
      show('P1 createPayout', result);
      if (result.gatewayRef) {
        show('P2 verifyPayout', await gateway.verifyPayout({ gatewayRef: result.gatewayRef, reference }));
        const again = await gateway.createPayout({ reference, amount: AMOUNT, currency: 'XAF', phone, name: 'Verify', description: 'verify:fapshi' });
        show('P3 ⛔ the SAME payout resent: must report the first transId and send nothing new', again);
        out.log(again.gatewayRef === result.gatewayRef ? '\n✅ no double send' : '\n❌ A SECOND TRANSFER WAS CREATED — check the dashboard');
      }
    } catch (error) {
      show('P1 THREW (outcome unknown — check the Fapshi dashboard)', describeError(error));
    }
  }

  out.log('\nDone.');
  process.exit(0);
})().catch((error) => {
  out.error('❌ verify:fapshi runner —', error);
  process.exit(1);
});
