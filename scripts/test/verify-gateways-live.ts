/**
 * verify:gateways — the payment gateways against their REAL APIs.
 *
 * ── WHY THIS IS A `verify:` AND NOT A `test:` ────────────────────────────────
 * `test:payments` is DB-free, network-free and deterministic: it proves our
 * signature arithmetic, our status-code policy and our structural invariants.
 * What it structurally cannot prove is anything about the other party — whether
 * NotchPay really sends `x-notch-signature`, whether it echoes our `reference`
 * back under that name, whether `cm.mtn` is the channel identifier it wants.
 *
 * Those four facts were written into the Phase 1 plan as *risks* precisely
 * because documentation is not a system. This script is how they stop being
 * risks. It talks to the live sandboxes and prints what actually comes back.
 *
 * ── STAGES, BECAUSE ONE OF THESE GATEWAYS MAY BE LIVE ────────────────────────
 * NotchPay is explicitly in sandbox and its test MSISDNs move no money. My-CoolPay
 * publishes a test public key that is NOT the one configured here, so the
 * configured account may be a real merchant app — in which case a payin sends a
 * real payment prompt to a real phone.
 *
 * So money-moving calls are opt-in, per gateway:
 *
 *   npm run verify:gateways                      read-only probes only (safe)
 *   npm run verify:gateways -- --notchpay-pay    NotchPay charge + status + refund
 *   npm run verify:gateways -- --mycoolpay-pay   My-CoolPay payin  ⚠ MAY BE REAL MONEY
 *   npm run verify:gateways -- --payout          payout/transfer probes ⚠ MOVES MONEY OUT
 *   npm run verify:gateways -- --amount=100      charge amount, default 100 XAF
 *
 * Nothing here writes to our database. It exercises the gateway adapters and
 * raw HTTP; no PaymentTransaction is created, so no fulfilment or earnings
 * split can fire off the back of it.
 */

process.env.LOG_STDOUT = 'false';

import dotenv from 'dotenv';
dotenv.config();

import crypto from 'crypto';
import { originalConsole as out } from '../../src/core/logging/sink-guard';
import { NOTCHPAY_CONFIG, MYCOOLPAY_CONFIG } from '../../src/modules/payments/config/payments.config';
import { PAYMENT_GATEWAYS } from '../../src/modules/payments/gateways/registry';
import { mintMerchantRef } from '../../src/modules/payments/domain/merchant-reference';
import { resolveCameroonOperator } from '../../src/modules/payments/domain/cm-operator';
import {
  notchPaySignature,
  myCoolPaySignature,
} from '../../src/modules/payments/domain/webhook-verification';

// ─── Flags ───────────────────────────────────────────────────────────────────

const flag = (name: string): boolean => process.argv.includes(`--${name}`);
const numArg = (name: string, fallback: number): number => {
  const raw = process.argv.find((a) => a.startsWith(`--${name}=`));
  const value = raw ? Number(raw.split('=')[1]) : NaN;
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const DO_NOTCHPAY_PAY = flag('notchpay-pay');
const DO_MYCOOLPAY_PAY = flag('mycoolpay-pay');
const DO_PAYOUT = flag('payout');
const AMOUNT = numArg('amount', 100);

/**
 * NotchPay sandbox MSISDNs. Deterministic outcomes, no money.
 * https://developer.notchpay.co/get-started/testing
 */
const NOTCHPAY_TEST = {
  mtnSuccess: '+237670000000',
  mtnInsufficientFunds: '+237670000001',
  orangeSuccess: '+237690000000',
};

/** The owner's own number and identity, supplied for My-CoolPay. */
const MYCOOLPAY_TEST = {
  phone: '237652705926',
  email: 'ulrichdilane770@gmail.com',
  name: 'kalynux',
};

// ─── Output helpers ──────────────────────────────────────────────────────────

let findings = 0;
let failures = 0;

function section(title: string): void {
  out.log(`\n${'─'.repeat(78)}\n  ${title}\n${'─'.repeat(78)}`);
}

/** Never print a secret. Enough to tell two keys apart, not enough to use one. */
function fingerprint(secret: string): string {
  if (!secret) return '(unset)';
  const digest = crypto.createHash('sha256').update(secret).digest('hex').slice(0, 8);
  return `${secret.slice(0, 12)}… len=${secret.length} sha=${digest}`;
}

function show(label: string, value: unknown): void {
  out.log(`    ${label.padEnd(26)} ${typeof value === 'string' ? value : JSON.stringify(value)}`);
}

function finding(text: string): void {
  findings++;
  out.log(`  🔎 ${text}`);
}

function ok(text: string): void {
  out.log(`  ✅ ${text}`);
}

function bad(text: string): void {
  failures++;
  out.error(`  ❌ ${text}`);
}

function skipped(text: string): void {
  out.log(`  ⏭️  ${text}`);
}

/** Raw HTTP with the response printed whatever the status — the point is to SEE it. */
async function http(
  label: string,
  url: string,
  init: RequestInit
): Promise<{ status: number; body: any }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let body: any;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { nonJsonBody: text.slice(0, 400) };
    }
    out.log(`    ${label} → HTTP ${response.status}`);
    out.log(`      ${JSON.stringify(body).slice(0, 900)}`);
    return { status: response.status, body };
  } catch (error: any) {
    out.error(`    ${label} → NETWORK ${error?.message ?? error}`);
    return { status: 0, body: null };
  } finally {
    clearTimeout(timer);
  }
}

// ═════════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  out.log('\n═══ verify:gateways — live sandbox probe ═══════════════════════════════════');

  section('0. Configuration (fingerprints only — no secret is printed)');
  show('NOTCHPAY_PUBLIC_KEY', fingerprint(NOTCHPAY_CONFIG.PUBLIC_KEY));
  show('NOTCHPAY_PRIVATE_KEY', fingerprint(NOTCHPAY_CONFIG.PRIVATE_KEY));
  show('NOTCHPAY_WEBHOOK_SECRET', fingerprint(NOTCHPAY_CONFIG.WEBHOOK_SECRET));
  show('NOTCHPAY_BASE_URL', NOTCHPAY_CONFIG.BASE_URL);
  show('MYCOOLPAY_PUBLIC_KEY', fingerprint(MYCOOLPAY_CONFIG.PUBLIC_KEY));
  show('MYCOOLPAY_PRIVATE_KEY', fingerprint(MYCOOLPAY_CONFIG.PRIVATE_KEY));
  show('MYCOOLPAY_BASE_URL', MYCOOLPAY_CONFIG.BASE_URL);

  // The three NotchPay keys must be three DIFFERENT values. Pasting the same
  // one twice is the single most likely setup mistake, and it fails at runtime
  // as a 401 that reads like a revoked account.
  const notchKeys = new Set([
    NOTCHPAY_CONFIG.PUBLIC_KEY,
    NOTCHPAY_CONFIG.PRIVATE_KEY,
    NOTCHPAY_CONFIG.WEBHOOK_SECRET,
  ]);
  if (notchKeys.size === 3) ok('NotchPay: three distinct keys configured');
  else bad('NotchPay: two of the three keys are the SAME value — check .env');

  if (NOTCHPAY_CONFIG.PUBLIC_KEY.includes('test')) ok('NotchPay key is a TEST key — sandbox');
  else finding('NotchPay key does NOT look like a test key — this may be LIVE money');

  if (MYCOOLPAY_CONFIG.PUBLIC_KEY === '118a4852-7df8-46d9-834b-23b4ef25aaab') {
    ok("My-CoolPay is using the vendor's published SANDBOX key");
  } else {
    finding(
      'My-CoolPay key is NOT their published sandbox key — treat this account as LIVE ' +
        'until the balance probe below says otherwise'
    );
  }

  await notchpay();
  await mycoolpay();
  await signatureSelfCheck();

  out.log(`\n${'═'.repeat(78)}`);
  out.log(`  ${findings} finding(s) to act on · ${failures} failure(s)`);
  out.log(`${'═'.repeat(78)}\n`);
}

// ═══ NotchPay ════════════════════════════════════════════════════════════════

async function notchpay(): Promise<void> {
  const base = NOTCHPAY_CONFIG.BASE_URL;
  const authHeaders = {
    Authorization: NOTCHPAY_CONFIG.PUBLIC_KEY,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  const grantHeaders = { ...authHeaders, 'X-Grant': NOTCHPAY_CONFIG.PRIVATE_KEY };

  section('1. NotchPay — authentication shape (read-only)');
  // Confirms RISK 1's premise: the public key authenticates, and X-Grant is
  // required on sensitive endpoints. If `Authorization` wanted the SECRET key
  // instead, this call 401s and everything downstream is wrong.
  const balance = await http('GET /balance (Authorization + X-Grant)', `${base}/balance`, {
    method: 'GET',
    headers: grantHeaders,
  });
  if (balance.status === 200) ok('public key in Authorization + private key in X-Grant is correct');
  else if (balance.status === 401) bad('401 on /balance — the key placement or the keys are wrong');
  else finding(`/balance answered ${balance.status} — see body above`);

  const balanceNoGrant = await http('GET /balance (no X-Grant)', `${base}/balance`, {
    method: 'GET',
    headers: authHeaders,
  });
  if (balanceNoGrant.status !== 200) {
    ok('X-Grant really is required on sensitive endpoints — our refund path sends it');
  } else {
    finding('X-Grant is NOT enforced on /balance — harmless, but the docs imply otherwise');
  }

  if (!DO_NOTCHPAY_PAY) {
    skipped('NotchPay charge/status/refund — pass --notchpay-pay (sandbox: no real money)');
    return;
  }

  section('2. NotchPay — initialize a payment');
  const merchantRef = mintMerchantRef('pt');
  show('our merchantRef', merchantRef);

  const init = await http('POST /payments', `${base}/payments`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      amount: AMOUNT,
      currency: 'XAF',
      phone: NOTCHPAY_TEST.mtnSuccess,
      email: MYCOOLPAY_TEST.email,
      description: 'verify:gateways probe',
      reference: merchantRef,
    }),
  });

  const trx = init.body?.transaction ?? {};
  const gatewayRef: string | undefined = trx.reference ?? trx.id;
  if (!gatewayRef) {
    bad('initialize returned no transaction reference — cannot continue');
    return;
  }
  ok(`initialize returned gatewayRef=${gatewayRef}`);

  // RISK 2 — which field carries OUR reference back?
  const echoField = Object.entries(trx).find(([, v]) => v === merchantRef)?.[0]
    ?? Object.entries(init.body ?? {}).find(([, v]) => v === merchantRef)?.[0];
  if (echoField) {
    ok(`RISK 2 RESOLVED — our reference comes back as \`${echoField}\``);
  } else {
    finding(
      'RISK 2 — our reference is NOT echoed in the initialize response. Check the WEBHOOK ' +
        'body instead; the merchantRef lookup falls back to (gateway, gatewayRef) meanwhile.'
    );
  }

  section('3. NotchPay — direct charge (the second call)');
  // RISK 3 — the channel identifier. `POST /payments/{ref}` with cm.mtn.
  const charge = await http(
    'POST /payments/{ref} channel=cm.mtn',
    `${base}/payments/${encodeURIComponent(gatewayRef)}`,
    {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        channel: 'cm.mtn',
        data: { phone: NOTCHPAY_TEST.mtnSuccess },
      }),
    }
  );
  if (charge.status >= 200 && charge.status < 300) {
    ok('RISK 3 RESOLVED — `cm.mtn` is accepted as the channel identifier');
  } else {
    finding(`RISK 3 — cm.mtn rejected (HTTP ${charge.status}). The channel map needs the real id.`);
  }

  section('4. NotchPay — status query, polled until it settles');
  // Sandbox does NOT settle synchronously: the charge answers `processing` and
  // reaches `complete` roughly half a minute later. That is the whole reason
  // `PaymentReconciliationWorker` exists, and it is worth seeing rather than
  // assuming — a probe that checked once would have reported "never settles".
  let statusWord = '';
  for (let attempt = 1; attempt <= 8; attempt++) {
    const status = await http(
      `GET /payments/{ref} (poll ${attempt})`,
      `${base}/payments/${encodeURIComponent(gatewayRef)}`,
      { method: 'GET', headers: authHeaders }
    );
    statusWord = String(status.body?.transaction?.status ?? status.body?.status ?? '');
    if (['complete', 'failed', 'canceled', 'cancelled', 'expired'].includes(statusWord)) break;
    await new Promise((r) => setTimeout(r, 6000));
  }
  show('final status word', statusWord);
  if (statusWord === 'complete') {
    ok('the sandbox charge settled — `complete` is in our status map as SUCCEEDED');
  } else {
    finding(`charge did not settle within ~48s (last: "${statusWord}") — the sweep would catch it`);
  }

  section('5. NotchPay — through OUR adapter (the real code path)');
  const adapter = PAYMENT_GATEWAYS.get('NOTCHPAY')!;
  const result = await adapter.initiatePayment({
    orderId: 'probe-order',
    userId: 'probe-user',
    amount: AMOUNT,
    currency: 'XAF',
    channel: { phoneNumber: NOTCHPAY_TEST.orangeSuccess, phoneOperator: 'ORANGE' },
    merchantRef: mintMerchantRef('pt'),
  });
  show('adapter success', result.success);
  show('adapter status', result.status);
  show('adapter gatewayRef', result.gatewayRef);
  show('adapter instructions', result.instructions ?? null);
  if (result.success) ok('our NotchPay adapter completes a real two-step charge');
  else bad(`our adapter failed: ${result.error}`);

  section('6. NotchPay — refund, against a SETTLED charge');
  // `GET /refunds` is checked first on purpose. If the read succeeds with the
  // same credentials that the write refuses, the refusal is a permission on the
  // ACTION rather than anything to do with our keys or our body.
  const refundList = await http('GET /refunds', `${base}/refunds`, {
    method: 'GET',
    headers: grantHeaders,
  });
  const refund = await http('POST /refunds', `${base}/refunds`, {
    method: 'POST',
    headers: grantHeaders,
    body: JSON.stringify({ payment: gatewayRef, reason: 'verify:gateways probe' }),
  });

  if (refund.status >= 200 && refund.status < 300) {
    ok('NotchPay refunds work on this account — the real refund path is live');
  } else if (refund.status === 403 && refundList.status === 200) {
    finding(
      'NotchPay REFUNDS ARE DISABLED on this account: GET /refunds is 200 with the same ' +
        'credentials, POST is 403 for every body shape. Handled as `unsupported` → ' +
        'REFUND_GATEWAY_NOT_SUPPORTED → the manual-payout ticket. Ask NotchPay to enable ' +
        'refunds; the code needs no change when they do.'
    );
  } else {
    finding(`refund answered ${refund.status} — see body above`);
  }

  // Through OUR adapter, so the 403 → `unsupported` mapping is exercised rather
  // than assumed. This is the branch that decides whether a vendor sees a 502
  // or the documented "refund by hand" outcome.
  const adapterRefund = await adapter.refundPayment!({
    gatewayRef,
    amount: AMOUNT,
    currency: 'XAF',
    reason: 'verify:gateways probe',
  });
  show('adapter success', adapterRefund.success);
  show('adapter unsupported', adapterRefund.unsupported ?? false);
  show('adapter error', adapterRefund.error ?? '—');
  if (adapterRefund.success) {
    ok('our adapter completed a real NotchPay refund');
  } else if (adapterRefund.unsupported) {
    ok('our adapter reports UNSUPPORTED, not a failure — routes to the manual-payout ticket');
  } else {
    bad('our adapter reported a generic failure — a vendor would see a 502 for a policy refusal');
  }

  if (DO_PAYOUT) {
    section('7. NotchPay — transfers (withdrawal reconnaissance)');
    // NOT part of Phase 1. Disbursement is deliberately unbuilt — the payout
    // pipeline is a human transferring money and pasting a reference. This
    // probe exists to learn the shape before that decision is taken.
    await http('GET /transfers', `${base}/transfers`, { method: 'GET', headers: grantHeaders });
    finding('transfers is reconnaissance only — jovi-mall builds no disbursement path yet');
  } else {
    skipped('NotchPay transfers — pass --payout');
  }
}

// ═══ My-CoolPay ══════════════════════════════════════════════════════════════

async function mycoolpay(): Promise<void> {
  const base = `${MYCOOLPAY_CONFIG.BASE_URL}/${MYCOOLPAY_CONFIG.PUBLIC_KEY}`;
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
  const privateHeaders = { ...headers, 'X-PRIVATE-KEY': MYCOOLPAY_CONFIG.PRIVATE_KEY };

  section('8. My-CoolPay — balance (read-only, and the live/test tell)');
  const balance = await http('GET /balance', `${base}/balance`, {
    method: 'GET',
    headers: privateHeaders,
  });
  if (balance.status === 200) {
    ok('public key path + X-PRIVATE-KEY header is correct');
    finding(
      `account balance is ${JSON.stringify(balance.body?.balance)} — a non-zero real balance ` +
        'means this is a LIVE merchant account, not a sandbox'
    );
  } else if (balance.status === 401 || balance.status === 403) {
    finding(`/balance answered ${balance.status} — payout/balance may be IP-restricted (max 3 IPs)`);
  } else {
    finding(`/balance answered ${balance.status}`);
  }

  if (!DO_MYCOOLPAY_PAY) {
    skipped(
      'My-CoolPay payin — pass --mycoolpay-pay. ⚠ This sends a real payment prompt to ' +
        `${MYCOOLPAY_TEST.phone} and may move REAL money.`
    );
  } else {
    section(`9. My-CoolPay — payin (${AMOUNT} XAF to ${MYCOOLPAY_TEST.phone})`);
    const merchantRef = mintMerchantRef('pt');
    show('our merchantRef', merchantRef);

    const payin = await http('POST /payin', `${base}/payin`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        transaction_amount: AMOUNT,
        transaction_currency: 'XAF',
        transaction_reason: 'verify:gateways probe',
        app_transaction_ref: merchantRef,
        customer_phone_number: MYCOOLPAY_TEST.phone,
        customer_name: MYCOOLPAY_TEST.name,
        customer_email: MYCOOLPAY_TEST.email,
        customer_lang: 'fr',
      }),
    });

    const ref: string | undefined = payin.body?.transaction_ref;
    const action: string | undefined = payin.body?.action;
    show('action', String(action));
    show('ussd', String(payin.body?.ussd ?? '—'));

    if (action === 'REQUIRE_OTP') {
      ok('RESOLVED — REQUIRE_OTP is real; `instructions.requiresOtp` and the authorize route are needed');
    } else if (action === 'PENDING') {
      ok('PENDING with a USSD code — the ordinary branch');
    } else if (payin.status >= 400) {
      bad(`payin refused (HTTP ${payin.status})`);
    }

    if (ref) {
      section('10. My-CoolPay — checkStatus');
      const status = await http(
        'GET /checkStatus/{ref}',
        `${base}/checkStatus/${encodeURIComponent(ref)}`,
        { method: 'GET', headers }
      );
      const body = status.body ?? {};
      show('transaction_status', String(body.transaction_status));
      show('app_transaction_ref', String(body.app_transaction_ref));
      show('transaction_operator', String(body.transaction_operator));

      if (body.app_transaction_ref === merchantRef) {
        ok('our merchantRef round-trips as `app_transaction_ref` — callback routing will work');
      } else {
        bad('our merchantRef did NOT round-trip — callback routing would fall back to gatewayRef');
      }

      // The callback signature is computed over these exact fields. Deriving it
      // from a real status body proves the field NAMES are what we sign over,
      // which is the half of RISK 4 that a document cannot settle.
      const expected = myCoolPaySignature(
        {
          transaction_ref: body.transaction_ref,
          transaction_type: body.transaction_type,
          transaction_amount: body.transaction_amount,
          transaction_currency: body.transaction_currency,
          transaction_operator: body.transaction_operator,
        },
        MYCOOLPAY_CONFIG.PRIVATE_KEY
      );
      show('signature we would expect', expected);
      finding(
        'Compare that digest against the `signature` on the real callback when it lands. ' +
          'If it matches, the field set and order are confirmed.'
      );
    }
  }

  if (DO_PAYOUT) {
    section('11. My-CoolPay — payout (withdrawal reconnaissance)');
    // ⚠ Sends money OUT. Also IP-allowlisted to at most 3 pre-authorised
    // servers, so from a developer machine this is expected to be refused —
    // which is itself the useful finding for the disbursement decision.
    // The operator is DERIVED from the number, not hardcoded. `652…` is an MTN
    // prefix, so the obvious `CM_OM` literal would have sent an Orange payout to
    // an MTN line — a refusal that tells us nothing about the integration. This
    // also cross-checks our own prefix table against a real number.
    const operator = resolveCameroonOperator(MYCOOLPAY_TEST.phone);
    show('resolved operator', String(operator));
    if (!operator) {
      bad('our prefix table could not resolve the payout number — skipping');
      return;
    }
    const payout = await http('POST /payout', `${base}/payout`, {
      method: 'POST',
      headers: privateHeaders,
      body: JSON.stringify({
        transaction_amount: AMOUNT,
        transaction_currency: 'XAF',
        transaction_reason: 'verify:gateways probe',
        transaction_operator: operator === 'MTN' ? 'CM_MOMO' : 'CM_OM',
        customer_phone_number: MYCOOLPAY_TEST.phone,
        customer_name: MYCOOLPAY_TEST.name,
        app_transaction_ref: mintMerchantRef('pt'),
      }),
    });
    if (payout.status === 401 || payout.status === 403) {
      ok('payout is IP-restricted as documented — a disbursement path needs allowlisted egress');
    } else {
      finding(`payout answered ${payout.status} — record this before designing disbursement`);
    }
  } else {
    skipped('My-CoolPay payout — pass --payout. ⚠ Moves money OUT of the account.');
  }
}

// ═══ Signature self-check ════════════════════════════════════════════════════

async function signatureSelfCheck(): Promise<void> {
  section('12. Our verifiers accept a correctly-signed callback');

  // Not a network call: it proves that the digest we COMPUTE is the digest we
  // ACCEPT, end to end through the real gateway objects. If a provider's live
  // callback is later refused, this narrows the fault to their side.
  const notchpay = PAYMENT_GATEWAYS.get('NOTCHPAY')!;
  const body = Buffer.from(
    JSON.stringify({ type: 'payment.complete', data: { transaction: { reference: 'trx.probe', status: 'complete' } } })
  );
  const verified = notchpay.verifyWebhook({
    rawBody: body,
    headers: { 'x-notch-signature': notchPaySignature(body, NOTCHPAY_CONFIG.WEBHOOK_SECRET) },
  });
  if (verified.ok) ok('NotchPay: a callback signed with the configured Hash Key verifies');
  else bad(`NotchPay: our own signature was REFUSED (${verified.reason}) — the hash key is wrong`);

  const mycoolpay = PAYMENT_GATEWAYS.get('MYCOOLPAY')!;
  const fields = {
    transaction_ref: 'probe-ref',
    transaction_type: 'PAYIN',
    transaction_amount: 100,
    transaction_currency: 'XAF',
    transaction_operator: 'CM_OM',
  };
  const mcpBody = Buffer.from(
    JSON.stringify({
      application: MYCOOLPAY_CONFIG.PUBLIC_KEY,
      ...fields,
      transaction_status: 'SUCCESS',
      signature: myCoolPaySignature(fields, MYCOOLPAY_CONFIG.PRIVATE_KEY),
    })
  );
  const mcpVerified = mycoolpay.verifyWebhook({ rawBody: mcpBody, headers: {} });
  if (mcpVerified.ok) ok('My-CoolPay: a callback signed with the configured private key verifies');
  else bad(`My-CoolPay: our own signature was REFUSED (${mcpVerified.reason})`);
}

main().catch((error) => {
  out.error('[verify:gateways] failed:', error);
  process.exit(1);
});
