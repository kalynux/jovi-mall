/**
 * verify:pawapay — the PawaPay adapter against PawaPay's REAL API (the sandbox by default).
 *
 * `test:pawapay` proves our side offline, against the shapes in PawaPay's OpenAPI v2. This
 * proves the other party: that the token authenticates, what Cameroon's limits and PIN-prompt
 * style really are on OUR account (`active-conf`), that the derived UUIDs are accepted, that a
 * resend is `DUPLICATE_IGNORED`, and what deposits and payouts answer on the test numbers.
 *
 * ── STAGES ───────────────────────────────────────────────────────────────────
 *   npm run verify:pawapay                         R: read-only (active-conf, keys, wallet, unknown id)
 *   npm run verify:pawapay -- --collect            C: deposits on the sandbox test numbers + a resend
 *   npm run verify:pawapay -- --payout             P: payouts on the sandbox test numbers + a resend
 *   npm run verify:pawapay -- --status=<uuid>      S: read one deposit / payout back
 *   npm run verify:pawapay -- --resend-callback=<depositId>
 *                                                  B: ask PawaPay to resend a deposit's callback to the
 *                                                     URL configured in the dashboard (proves signing
 *                                                     end to end once a deployed server receives it)
 *   --phone=6XXXXXXXX --amount=100 --live          money stages on the LIVE host: the owner's numbers
 *                                                  only, ≤ 200 XAF, and --live required
 *
 * Sandbox test numbers (docs.pawapay.io/v2/docs/test_numbers, Cameroon):
 *   MTN    deposit 237653456789 COMPLETED · …039 PAYMENT_NOT_APPROVED · …129 SUBMITTED
 *          payout  237653456789 COMPLETED · …089 RECIPIENT_NOT_FOUND
 *   Orange deposit 237693456789 COMPLETED · …049 INSUFFICIENT_BALANCE · …129 SUBMITTED
 *          payout  237693456789 COMPLETED · …099 WALLET_LIMIT_REACHED
 *
 * ⛔ MONEY RULES: on the live host, money stages refuse any number but the owner's two lines,
 * amounts above 200 XAF, and any run without --live. A green SKIP when PawaPay is not configured.
 * The token is never printed.
 */

process.env.LOG_STDOUT = 'false';

import dotenv from 'dotenv';
dotenv.config();

import { originalConsole as out } from '../src/core/logging/sink-guard';
import { AppError } from '../src/core/errors';
import { PAWAPAY_CONFIG, PAWAPAY_SANDBOX_BASE_URL } from '../src/modules/payments/config/payments.config';
import { mintMerchantRef } from '../src/modules/payments/domain/merchant-reference';
import { toCameroonNationalNumber } from '../src/modules/payments/domain/cm-operator';
import { PawaPayGateway, pawapayPaymentId } from '../src/modules/payments/gateways/pawapay.gateway';

const flag = (name: string): boolean => process.argv.includes(`--${name}`);
const arg = (name: string): string | null =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=') ?? null;

const OWNER_NUMBERS = new Set(['672745831', '652705926']);
const MAX_LIVE_AMOUNT_XAF = 200;
const AMOUNT = Number(arg('amount') ?? '100');
const SANDBOX = PAWAPAY_CONFIG.BASE_URL === PAWAPAY_SANDBOX_BASE_URL;

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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The numbers a money stage may use: the sandbox test numbers, or on live the owner's one line. */
function moneyTargets(stage: string, sandboxNumbers: string[]): string[] {
  if (!Number.isInteger(AMOUNT) || AMOUNT < 1) fail(`${stage}: --amount must be a positive integer; refusing.`);
  if (SANDBOX) {
    const phone = arg('phone');
    return phone ? [phone] : sandboxNumbers;
  }
  const national = toCameroonNationalNumber(arg('phone'));
  if (!national || !OWNER_NUMBERS.has(national)) fail(`${stage}: on the LIVE host --phone must be one of the owner's numbers; refusing.`);
  if (AMOUNT > MAX_LIVE_AMOUNT_XAF) fail(`${stage}: on the LIVE host --amount must be at most ${MAX_LIVE_AMOUNT_XAF} XAF; refusing.`);
  if (!flag('live')) fail(`${stage}: this is the LIVE host and real money moves. Re-run with --live.`);
  return [`237${national}`];
}

(async () => {
  if (!PAWAPAY_CONFIG.API_TOKEN) {
    out.log('⏭  SKIP: PAWAPAY_API_TOKEN is not set.');
    process.exit(0);
  }

  const gateway = new PawaPayGateway();
  // The adapter's call, so raw bodies can be shown. Private by design; this script is the exception.
  const call = (path: string, method: 'GET' | 'POST' = 'GET', body?: Record<string, unknown>) =>
    (gateway as any).call(path, method, body, false);

  out.log(`PawaPay ${PAWAPAY_CONFIG.BASE_URL} (${SANDBOX ? 'SANDBOX' : 'LIVE host'}) · payouts ${PAWAPAY_CONFIG.PAYOUTS_ENABLED ? 'ENABLED' : 'disabled'} in this env`);

  // ── R ───────────────────────────────────────────────────────────────────
  out.log('\n═══ R: read-only ═══');
  try {
    const conf = await call('/v2/active-conf?country=CMR');
    show('R1 GET /v2/active-conf?country=CMR (authenticates the token)', conf);
    // The facts the adapter will pin: per provider and operation, limits + decimals + PIN prompt.
    const providers: any[] = conf?.countries?.find((c: any) => c?.country === 'CMR')?.providers ?? [];
    const summary = providers.map((p: any) => ({
      provider: p.provider,
      nameDisplayedToCustomer: p.nameDisplayedToCustomer,
      operations: Object.fromEntries(
        (p.currencies ?? []).flatMap((c: any) => Object.entries(c.operationTypes ?? {}).map(([op, v]: [string, any]) => [
          `${c.currency}/${op}`,
          { min: v?.minAmount, max: v?.maxAmount, decimals: v?.decimalsInAmount, status: v?.status, authType: v?.authType, pinPrompt: v?.pinPrompt, pinPromptRevivable: v?.pinPromptRevivable },
        ]))
      ),
    }));
    show('R1 → Cameroon, summarised (PIN THESE in the adapter: limits, pinPrompt)', summary);
  } catch (error) {
    show('R1 FAILED (a 401/403 is a wrong or missing token)', describeError(error));
  }
  try {
    await gateway.refreshPublicKeys(true);
    show('R2 GET /v2/public-key/http → keys held', { callbackKeysLoaded: gateway.callbackKeysLoaded() });
  } catch (error) {
    show('R2 FAILED', describeError(error));
  }
  try {
    show('R3 wallet (payoutBalance XAF)', await gateway.payoutBalance('XAF'));
  } catch (error) {
    show('R3 FAILED', describeError(error));
  }
  try {
    show('R4 GET /v2/deposits/{never-used id} (what NOT_FOUND looks like)', await call(`/v2/deposits/${pawapayPaymentId('deposit', mintMerchantRef('pt'))}`));
  } catch (error) {
    show('R4 → threw', describeError(error));
  }

  // ── S ───────────────────────────────────────────────────────────────────
  const statusId = arg('status');
  if (statusId) {
    out.log('\n═══ S: read one back ═══');
    for (const kind of ['deposits', 'payouts']) {
      try {
        show(`S GET /v2/${kind}/${statusId}`, await call(`/v2/${kind}/${encodeURIComponent(statusId)}`));
      } catch (error) {
        show(`S /v2/${kind} → threw`, describeError(error));
      }
    }
  }

  // ── B ───────────────────────────────────────────────────────────────────
  const resendId = arg('resend-callback');
  if (resendId) {
    out.log('\n═══ B: resend a deposit callback to the dashboard URL ═══');
    try {
      show(`B POST /v2/deposits/resend-callback/${resendId}`, await call(`/v2/deposits/resend-callback/${encodeURIComponent(resendId)}`, 'POST', {}));
      out.log('\nCheck the receiving server\'s log for "[PAWAPAYWebhook]": no "refused" line = the signature verified.');
    } catch (error) {
      show('B FAILED', describeError(error));
    }
  }

  // ── C ───────────────────────────────────────────────────────────────────
  if (flag('collect')) {
    out.log('\n═══ C: deposits ═══');
    const numbers = moneyTargets('C', ['237653456789', '237653456039', '237693456789', '237693456129']);
    for (const phone of numbers) {
      const merchantRef = mintMerchantRef('pt');
      const payload = {
        orderId: 'VERIFY-PAWAPAY', userId: 'verify-pawapay', amount: AMOUNT, currency: 'XAF',
        merchantRef, channel: { phoneNumber: `+${phone}`, customerName: 'Verify PawaPay' },
      };
      try {
        const result = await gateway.initiatePayment(payload);
        show(`C ${phone} initiatePayment`, { success: result.success, status: result.status, gatewayRef: result.gatewayRef, raw: result.rawResponse });
        if (!result.gatewayRef) continue;
        const again = await gateway.initiatePayment(payload);
        out.log(`   resend of the same reference → ${JSON.stringify(again.rawResponse?.status ?? again.status)} (expect DUPLICATE_IGNORED)`);
        let verdict = await gateway.verifyPayment({ gatewayRef: result.gatewayRef });
        for (let i = 0; i < 10 && verdict.status === 'PENDING'; i++) {
          await sleep(3000);
          verdict = await gateway.verifyPayment({ gatewayRef: result.gatewayRef });
        }
        show(`C ${phone} final verdict`, { status: verdict.status, record: verdict.rawResponse });
      } catch (error) {
        show(`C ${phone} → threw`, describeError(error));
      }
    }
  }

  // ── P ───────────────────────────────────────────────────────────────────
  if (flag('payout')) {
    out.log('\n═══ P: payouts ═══');
    const numbers = moneyTargets('P', ['237653456789', '237653456089', '237693456789']);
    for (const phone of numbers) {
      const reference = mintMerchantRef('po');
      const payload = { reference, amount: AMOUNT, currency: 'XAF', phone: `+${phone}`, name: 'Verify', description: 'verify:pawapay' };
      try {
        const result = await gateway.createPayout(payload);
        show(`P ${phone} createPayout`, result);
        if (!result.gatewayRef) continue;
        let verdict = await gateway.verifyPayout({ gatewayRef: result.gatewayRef, reference });
        for (let i = 0; i < 10 && verdict.status === 'PENDING'; i++) {
          await sleep(3000);
          verdict = await gateway.verifyPayout({ gatewayRef: result.gatewayRef, reference });
        }
        show(`P ${phone} final verdict`, verdict);
        const again = await gateway.createPayout(payload);
        show(`P ${phone} ⛔ the SAME payout resent (COMPLETED → same id reported; FAILED → the NEXT id is sent)`, again);
      } catch (error) {
        show(`P ${phone} THREW (outcome unknown — check the PawaPay dashboard)`, describeError(error));
      }
    }
  }

  out.log('\nDone.');
  process.exit(0);
})().catch((error) => {
  out.error('❌ verify:pawapay runner —', error);
  process.exit(1);
});
