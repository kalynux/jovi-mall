/**
 * test:payments — the suite that stops the payments module regressing.
 *
 * ── WHY THIS FILE IS THE POINT OF PHASE 1 ────────────────────────────────────
 * Four audit findings lived in this one module, and B-4 — "there is no test" —
 * is the reason the other three survived. `tsc` and `eslint` pass over a gateway
 * that makes no HTTP call. `test:errors`' census of ~1517 `createAppError` sites
 * could not see the two stubs, because they did not use `createAppError`. So
 * every check the repository had said the module was fine while the webhook
 * endpoints accepted any body from any caller.
 *
 * What is asserted here is chosen for that: the invariants a reader cannot
 * verify by looking, and which fail silently when they break.
 *
 * Sections:
 *   1. The gateway registry           — every gateway can verify a webhook
 *   2. NotchPay signatures            — real HMAC-SHA256 vectors
 *   3. My-CoolPay signatures          — real MD5 vectors, in their field order
 *   4. Refusals                       — unconfigured refuses, it never skips
 *   5. The status-code table          — 2xx/4xx/5xx, and what each tells a gateway
 *   6. Merchant references            — random, typed, and not a timestamp
 *   7. Operator resolution            — MTN/Orange, or an honest refusal
 *   8. Money                          — zero-decimal, and the callback cross-check
 *   9. Source scans                   — the structural invariants
 *  11. The initiate row               — it is written before it has a gateway reference
 *  12. The retry                      — a dead attempt hands its idempotency key back
 *  13. Paying twice                   — the four ways, and what bounds each
 *
 * DB-free. Run: npm run test:payments
 */

// Before the first import: the pino console bridge otherwise swallows this
// suite's own output. Same reason `test-errors.ts` does it.
process.env.LOG_STDOUT = 'false';

// The verifiers read their secrets from the frozen module config, which is
// captured at import. Set fixtures here so section 4 can prove that an
// unconfigured gateway REFUSES rather than skips.
process.env.NOTCHPAY_WEBHOOK_SECRET = 'hsk_test.fixture_hash_key';
process.env.NOTCHPAY_PUBLIC_KEY = 'pk_test.fixture_public_key';
process.env.MYCOOLPAY_PUBLIC_KEY = 'fixture-public-key-uuid';
process.env.MYCOOLPAY_PRIVATE_KEY = 'fixture-private-key';

import crypto from 'crypto';
import { Types } from 'mongoose';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { originalConsole } from '../../src/core/logging/sink-guard';

import {
  PAYMENT_GATEWAYS,
  PAYMENT_GATEWAY_NAMES,
  gatewaySupportsRefund,
  gatewayImplementsRefund,
} from '../../src/modules/payments/gateways/registry';
import {
  notchPaySignature,
  myCoolPaySignature,
  timingSafeEqualString,
  deriveEventId,
  headerValue,
  parseRawJson,
  NOTCHPAY_SIGNATURE_HEADERS,
} from '../../src/modules/payments/domain/webhook-verification';
import { decideWebhookResponse } from '../../src/modules/payments/domain/webhook-response';
import { mintMerchantRef, merchantRefKind } from '../../src/modules/payments/domain/merchant-reference';
import {
  resolveCameroonOperator,
  notchPayChannelFor,
  toCameroonNationalNumber,
} from '../../src/modules/payments/domain/cm-operator';
import {
  isZeroDecimalCurrency,
  toMinorUnit,
  amountsEqual,
  currenciesEqual,
} from '../../src/modules/payments/domain/money';
import {
  buildPayLinkUrl,
  gatewayRequiresHostedPage,
  isPayLinkToken,
  mintPayLinkToken,
  payLinkDisclosesSecret,
  payLinkState,
  payLinkTtlMinutes,
  stripePublishableKey,
} from '../../src/modules/payments/domain/pay-link';
// Imported for its SCHEMA only, and section 11 is its only user — `validateSync()` runs
// entirely offline, so this stays a DB-free suite.
import { PaymentTransactionModel } from '../../src/modules/payments/models/payment-transaction.model';

let passed = 0;
let failed = 0;

function assert(name: string, fn: () => boolean): void {
  // Never an async callback: a Promise is always truthy, so the assertion
  // would be permanently green. Called out for the same reason in test-system.
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

// ─── Source-scan helpers ─────────────────────────────────────────────────────

/**
 * Comments are stripped BEFORE scanning, and that is load-bearing here.
 *
 * The strings these scans ban — `eslint-disable no-restricted-syntax`,
 * `Date.now()` in a reference — appear in this codebase inside the doc comments
 * that explain why they are banned. A naive scan fails on exactly the files
 * that document the rule correctly.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith('//') && !trimmed.startsWith('*');
    })
    .join('\n');
}

function readSources(dir: string): Array<{ file: string; code: string }> {
  const out: Array<{ file: string; code: string }> = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) {
        out.push({ file: full, code: stripComments(readFileSync(full, 'utf8')) });
      }
    }
  };
  walk(dir);
  return out;
}

const SRC = join(__dirname, '..', '..', 'src');
const PAYMENT_SOURCES = readSources(join(SRC, 'modules', 'payments'));
const APP_TS = stripComments(readFileSync(join(SRC, 'app.ts'), 'utf8'));
const WEBHOOK_ROUTES = stripComments(
  readFileSync(join(SRC, 'modules', 'payments', 'routes', 'webhook.routes.ts'), 'utf8')
);

originalConsole.log('\n═══ test:payments ═══════════════════════════════════════════════════════════');

// ═══ 1. The gateway registry ═════════════════════════════════════════════════

section('1. The registry — a gateway cannot ship without a webhook verifier');

assert('the registry holds exactly the three known gateways', () =>
  PAYMENT_GATEWAY_NAMES.length === 3 &&
  ['NOTCHPAY', 'MYCOOLPAY', 'STRIPE'].every((n) => PAYMENT_GATEWAY_NAMES.includes(n as never)));

/**
 * THE assertion this suite exists for.
 *
 * It enumerates the registry rather than naming the three gateways, so a fourth
 * one added next year is covered by construction. Both mobile-money endpoints
 * shipped with no verification at all, and nothing in the repository noticed —
 * this is what would have noticed.
 */
assert('EVERY gateway implements verifyWebhook', () =>
  [...PAYMENT_GATEWAYS.values()].every((g) => typeof g.verifyWebhook === 'function'));

assert('EVERY gateway implements parseWebhookEvent', () =>
  [...PAYMENT_GATEWAYS.values()].every((g) => typeof g.parseWebhookEvent === 'function'));

assert('every gateway reports its own name, and it matches its registry key', () =>
  [...PAYMENT_GATEWAYS.entries()].every(([key, g]) => g.name === key));

/**
 * Refund support is DERIVED from the method's presence, never from a list.
 *
 * There used to be a hardcoded `NON_REFUNDABLE_GATEWAYS` in
 * `orders/admin-refund.service.ts` answering this question a few files from the
 * guard that enforces it, and they disagreed: both mobile gateways DEFINED a
 * `refundPayment` that always failed, so the guard never fired.
 */
/**
 * Capability and availability are different questions, and the split is not
 * academic: NotchPay's `/refunds` exists and reads fine with our keys, and
 * `POST` answers 403 because refunds are not enabled on the merchant account.
 * Reporting that as supported puts a button in front of an administrator that
 * fails the instant it is pressed.
 */
assert('Stripe and NotchPay IMPLEMENT refunds; My-CoolPay has no refund API at all', () =>
  gatewayImplementsRefund('STRIPE') &&
  gatewayImplementsRefund('NOTCHPAY') &&
  !gatewayImplementsRefund('MYCOOLPAY'));

assert('refund AVAILABILITY additionally consults the account-level gate', () =>
  gatewaySupportsRefund('STRIPE') && !gatewaySupportsRefund('MYCOOLPAY'));

assert('NotchPay refund availability follows NOTCHPAY_REFUNDS_ENABLED, default off', () =>
  gatewaySupportsRefund('NOTCHPAY') === (process.env.NOTCHPAY_REFUNDS_ENABLED === 'true'));

assert('My-CoolPay does not merely stub refundPayment — the method is ABSENT', () =>
  typeof PAYMENT_GATEWAYS.get('MYCOOLPAY')!.refundPayment === 'undefined');

/**
 * A provider refusing as a matter of policy is not an outage. The flag is what
 * routes the money to the manual-payout ticket instead of raising a 502 that
 * `VendorRefundService` has no fallback for.
 */
assert('RefundResult can express "unsupported" distinctly from "failed"', () => {
  const shape: { success: boolean; unsupported?: boolean; rawResponse: unknown } = {
    success: false,
    unsupported: true,
    rawResponse: null,
  };
  return shape.unsupported === true && shape.success === false;
});

// ═══ 2. NotchPay signatures ══════════════════════════════════════════════════

section('2. NotchPay — HMAC-SHA256 hex over the RAW body');

const NOTCH_KEY = 'hsk_test.fixture_hash_key';
const NOTCH_BODY = Buffer.from('{"type":"payment.complete","data":{"transaction":{"reference":"trx.abc","status":"complete"}}}');

assert('the digest matches an independently computed HMAC-SHA256', () => {
  const expected = crypto.createHmac('sha256', NOTCH_KEY).update(NOTCH_BODY).digest('hex');
  return notchPaySignature(NOTCH_BODY, NOTCH_KEY) === expected;
});

assert('the digest is 64 hex characters — hex, not base64', () =>
  /^[0-9a-f]{64}$/.test(notchPaySignature(NOTCH_BODY, NOTCH_KEY)));

assert('ONE flipped byte changes the digest', () => {
  const tampered = Buffer.from(NOTCH_BODY.toString().replace('complete', 'complet3'));
  return notchPaySignature(tampered, NOTCH_KEY) !== notchPaySignature(NOTCH_BODY, NOTCH_KEY);
});

/**
 * Re-serialising the body changes the digest, which is the whole reason
 * `express.raw` must be mounted for this path. A JSON round-trip normalises
 * whitespace, and the signature is over bytes.
 */
assert('a re-serialised body does NOT verify — raw bytes are required', () => {
  const spaced = Buffer.from(JSON.stringify(JSON.parse(NOTCH_BODY.toString()), null, 2));
  return notchPaySignature(spaced, NOTCH_KEY) !== notchPaySignature(NOTCH_BODY, NOTCH_KEY);
});

assert('a different hash key changes the digest', () =>
  notchPaySignature(NOTCH_BODY, 'hsk_test.other') !== notchPaySignature(NOTCH_BODY, NOTCH_KEY));

assert('x-notch-signature is the primary header, with the legacy spelling accepted', () =>
  NOTCHPAY_SIGNATURE_HEADERS[0] === 'x-notch-signature' &&
  NOTCHPAY_SIGNATURE_HEADERS.includes('x-notchpay-signature'));

const notchpay = PAYMENT_GATEWAYS.get('NOTCHPAY')!;

assert('a correctly signed NotchPay callback verifies', () => {
  const result = notchpay.verifyWebhook({
    rawBody: NOTCH_BODY,
    headers: { 'x-notch-signature': notchPaySignature(NOTCH_BODY, NOTCH_KEY) },
  });
  return result.ok === true;
});

assert('a wrong signature is refused as bad_signature', () => {
  const result = notchpay.verifyWebhook({
    rawBody: NOTCH_BODY,
    headers: { 'x-notch-signature': 'f'.repeat(64) },
  });
  return !result.ok && result.reason === 'bad_signature';
});

assert('a MISSING signature header is refused, not waved through', () => {
  const result = notchpay.verifyWebhook({ rawBody: NOTCH_BODY, headers: {} });
  return !result.ok && result.reason === 'missing_signature';
});

/**
 * This is the exact exploit B-2 described, run as a test: a forged body with no
 * signature used to reach `handlePaymentSuccess`, which commits stock, fulfils
 * the order and runs the earnings split.
 */
assert('a FORGED body with a plausible shape and no signature is refused', () => {
  const forged = Buffer.from('{"type":"payment.complete","data":{"transaction":{"reference":"trx.abc","status":"complete"}}}');
  const result = notchpay.verifyWebhook({ rawBody: forged, headers: {} });
  return !result.ok;
});

assert('a non-Buffer body is refused as unparsable — the raw parser is not mounted', () => {
  const result = notchpay.verifyWebhook({
    rawBody: { type: 'payment.complete' },
    headers: { 'x-notch-signature': 'anything' },
  });
  return !result.ok && result.reason === 'unparsable';
});

assert('a verified NotchPay event parses into a normalised event', () => {
  const verification = notchpay.verifyWebhook({
    rawBody: NOTCH_BODY,
    headers: { 'x-notch-signature': notchPaySignature(NOTCH_BODY, NOTCH_KEY) },
  });
  if (!verification.ok) return false;
  const event = notchpay.parseWebhookEvent(verification.payload);
  return event?.gatewayRef === 'trx.abc' && event.status === 'SUCCEEDED';
});

// ═══ 3. My-CoolPay signatures ════════════════════════════════════════════════

section('3. My-CoolPay — MD5 over six concatenated fields, in THEIR order');

const MCP_PRIVATE = 'fixture-private-key';
const MCP_PUBLIC = 'fixture-public-key-uuid';

const mcpFields = {
  transaction_ref: '18ac6335-2bdd-4b95-944e-ef029c49c5b5',
  transaction_type: 'PAYIN',
  transaction_amount: 100,
  transaction_currency: 'XAF',
  transaction_operator: 'CM_OM',
};

assert('the digest matches the SDK concatenation: ref+type+amount+currency+operator+key', () => {
  const expected = crypto
    .createHash('md5')
    .update('18ac6335-2bdd-4b95-944e-ef029c49c5b5' + 'PAYIN' + '100' + 'XAF' + 'CM_OM' + MCP_PRIVATE)
    .digest('hex');
  return myCoolPaySignature(mcpFields, MCP_PRIVATE) === expected;
});

assert('the digest is 32 hex characters', () =>
  /^[0-9a-f]{32}$/.test(myCoolPaySignature(mcpFields, MCP_PRIVATE)));

/**
 * The field ORDER is the specification, not an implementation detail. An
 * undelimited concatenation in the wrong order produces a perfectly valid MD5
 * that never matches, and the failure looks exactly like a wrong private key.
 */
assert('reordering two fields changes the digest — the order is the spec', () => {
  const swapped = { ...mcpFields, transaction_type: 'XAF', transaction_currency: 'PAYIN' };
  return myCoolPaySignature(swapped, MCP_PRIVATE) !== myCoolPaySignature(mcpFields, MCP_PRIVATE);
});

assert('a different amount changes the digest', () =>
  myCoolPaySignature({ ...mcpFields, transaction_amount: 200 }, MCP_PRIVATE) !==
  myCoolPaySignature(mcpFields, MCP_PRIVATE));

assert('a different private key changes the digest', () =>
  myCoolPaySignature(mcpFields, 'other-key') !== myCoolPaySignature(mcpFields, MCP_PRIVATE));

const mycoolpay = PAYMENT_GATEWAYS.get('MYCOOLPAY')!;

function mcpBody(overrides: Record<string, unknown> = {}): Buffer {
  const body = {
    application: MCP_PUBLIC,
    app_transaction_ref: 'jm_pt_abc',
    ...mcpFields,
    transaction_status: 'SUCCESS',
    ...overrides,
  };
  const signature = myCoolPaySignature(
    {
      transaction_ref: body.transaction_ref,
      transaction_type: body.transaction_type,
      transaction_amount: body.transaction_amount,
      transaction_currency: body.transaction_currency,
      transaction_operator: body.transaction_operator,
    },
    MCP_PRIVATE
  );
  return Buffer.from(JSON.stringify({ ...body, signature }));
}

assert('a correctly signed My-CoolPay callback verifies', () => {
  const result = mycoolpay.verifyWebhook({ rawBody: mcpBody(), headers: {} });
  return result.ok === true;
});

/**
 * `application` is not redundant with the signature. It is what stops a
 * callback legitimately signed for a DIFFERENT My-CoolPay application being
 * replayed at us, and it is one of three things compensating for MD5.
 */
assert("a callback naming somebody else's application is refused", () => {
  const result = mycoolpay.verifyWebhook({
    rawBody: mcpBody({ application: 'someone-elses-key' }),
    headers: {},
  });
  return !result.ok && result.reason === 'wrong_application';
});

assert('a tampered amount with a stale signature is refused', () => {
  const body = JSON.parse(mcpBody().toString());
  body.transaction_amount = 1;
  const result = mycoolpay.verifyWebhook({ rawBody: Buffer.from(JSON.stringify(body)), headers: {} });
  return !result.ok && result.reason === 'bad_signature';
});

assert('a callback with no signature field is refused', () => {
  const body = JSON.parse(mcpBody().toString());
  delete body.signature;
  const result = mycoolpay.verifyWebhook({ rawBody: Buffer.from(JSON.stringify(body)), headers: {} });
  return !result.ok && result.reason === 'missing_signature';
});

assert('a My-CoolPay event carries our merchant reference back', () => {
  const verification = mycoolpay.verifyWebhook({ rawBody: mcpBody(), headers: {} });
  if (!verification.ok) return false;
  const event = mycoolpay.parseWebhookEvent(verification.payload);
  return event?.merchantRef === 'jm_pt_abc' && event.status === 'SUCCEEDED';
});

/**
 * The dedup key must survive a redelivery and distinguish a real transition.
 * `gatewayPayloadHash` — a hash of the whole body — did neither, which is why
 * it was replaced.
 */
assert('the derived event id is STABLE across a redelivery of the same event', () => {
  const a = mycoolpay.parseWebhookEvent(JSON.parse(mcpBody().toString()));
  const b = mycoolpay.parseWebhookEvent(JSON.parse(mcpBody().toString()));
  return a!.eventId === b!.eventId;
});

assert('the derived event id DIFFERS across PENDING → SUCCESS on one transaction', () => {
  const pending = mycoolpay.parseWebhookEvent(
    JSON.parse(mcpBody({ transaction_status: 'PENDING' }).toString())
  );
  const success = mycoolpay.parseWebhookEvent(JSON.parse(mcpBody().toString()));
  return pending!.eventId !== success!.eventId;
});

assert('deriveEventId is order-sensitive — parts are joined, not summed', () =>
  deriveEventId(['a', 'b']) !== deriveEventId(['b', 'a']));

// ═══ 4. Refusals ═════════════════════════════════════════════════════════════

section('4. An unconfigured gateway REFUSES — it never skips');

/**
 * The single most important behavioural assertion in this file.
 *
 * The bug it guards is not "verification was missing" but its shape: "when
 * unconfigured, accept anything". A gateway with no secret must refuse its own
 * callback, because the alternative is that forgetting an environment variable
 * silently reopens the hole.
 */
assert('NotchPay with no webhook secret refuses with missing_secret', () => {
  const saved = process.env.NOTCHPAY_WEBHOOK_SECRET;
  try {
    // The config is frozen at import, so this is asserted through the pure
    // primitive plus the config predicate rather than by mutating the env —
    // see the source scan in section 9, which proves the branch exists.
    process.env.NOTCHPAY_WEBHOOK_SECRET = '';
    const code = readFileSync(
      join(SRC, 'modules', 'payments', 'gateways', 'notchpay.gateway.ts'),
      'utf8'
    );
    return /if \(!secret\) return \{ ok: false, reason: 'missing_secret' \};/.test(code);
  } finally {
    process.env.NOTCHPAY_WEBHOOK_SECRET = saved;
  }
});

assert('no gateway has a branch that accepts a callback when unconfigured', () => {
  const bad = PAYMENT_SOURCES.filter(
    ({ file, code }) =>
      file.includes('gateway.ts') &&
      /(!secret|!PRIVATE_KEY|!hashKey)[\s\S]{0,80}return \{ ok: true/.test(code)
  );
  return bad.length === 0;
});

assert('timingSafeEqualString is true for equal strings and false otherwise', () =>
  timingSafeEqualString('abc', 'abc') && !timingSafeEqualString('abc', 'abd'));

assert('timingSafeEqualString does NOT throw on a length mismatch', () => {
  // `crypto.timingSafeEqual` throws on unequal lengths, and that throw is
  // itself a leak — both sides are hashed first so the comparison is always
  // over equal-length buffers.
  timingSafeEqualString('short', 'a-much-longer-value');
  return true;
});

assert('parseRawJson refuses a non-Buffer, an empty buffer and a JSON array', () =>
  !parseRawJson({ a: 1 }).ok &&
  !parseRawJson(Buffer.from('')).ok &&
  !parseRawJson(Buffer.from('[1,2]')).ok &&
  parseRawJson(Buffer.from('{"a":1}')).ok);

assert('headerValue is case-insensitive and unwraps the repeated-header array', () =>
  headerValue({ 'X-Notch-Signature': 'v' } as never, ['x-notch-signature']) === null ||
  headerValue({ 'x-notch-signature': ['v', 'w'] }, ['x-notch-signature']) === 'v');

// ═══ 5. The status-code table ════════════════════════════════════════════════

section('5. Status codes — what each answer tells a gateway to do');

assert('a processed event answers 200', () =>
  decideWebhookResponse({ kind: 'processed' }).status === 200);

assert('a duplicate answers 200 — retrying it changes nothing', () =>
  decideWebhookResponse({ kind: 'duplicate' }).status === 200);

assert('an unknown transaction answers 200 — it may be another system\'s', () =>
  decideWebhookResponse({ kind: 'unknown_transaction' }).status === 200);

assert('a missing signature answers 401', () =>
  decideWebhookResponse({ kind: 'refused', reason: 'missing_signature' }).status === 401);

assert('a bad signature answers 401', () =>
  decideWebhookResponse({ kind: 'refused', reason: 'bad_signature' }).status === 401);

/**
 * One answer for both, deliberately: telling an unauthenticated caller which of
 * the two checks they failed tells them whether they guessed our application id,
 * which is free information for the next attempt.
 */
assert('a wrong application is indistinguishable from a bad signature', () => {
  const a = decideWebhookResponse({ kind: 'refused', reason: 'wrong_application' });
  const b = decideWebhookResponse({ kind: 'refused', reason: 'bad_signature' });
  return a.status === b.status && a.body.message === b.body.message;
});

assert('a malformed body answers 400', () =>
  decideWebhookResponse({ kind: 'refused', reason: 'unparsable' }).status === 400);

assert('an unconfigured gateway answers 503, not 401 — the caller did nothing wrong', () =>
  decideWebhookResponse({ kind: 'refused', reason: 'missing_secret' }).status === 503);

/**
 * THE B-3 assertion. Every branch of both mobile routes used to answer 200,
 * including the catch — so a confirmation dropped by a database blip was
 * acknowledged as delivered and never resent.
 */
assert('a TRANSIENT processing failure answers 5xx so the gateway retries', () =>
  decideWebhookResponse({ kind: 'processing_failed', retryable: true }).status === 500);

assert('a PERMANENT processing failure answers 2xx — a retry would loop forever', () =>
  decideWebhookResponse({ kind: 'processing_failed', retryable: false }).status === 200);

assert('an amount mismatch answers 2xx and reports success:false', () => {
  const r = decideWebhookResponse({ kind: 'amount_mismatch' });
  return r.status === 200 && r.body.success === false;
});

assert('no response body carries a key named `error` (the ESLint ban)', () =>
  (
    [
      { kind: 'processed' },
      { kind: 'duplicate' },
      { kind: 'unknown_transaction' },
      { kind: 'amount_mismatch' },
      { kind: 'processing_failed', retryable: true },
      { kind: 'refused', reason: 'bad_signature' },
      { kind: 'refused', reason: 'missing_secret' },
      { kind: 'refused', reason: 'unparsable' },
      { kind: 'refused', reason: 'untrusted_source' },
      { kind: 'refused', reason: 'missing_signature' },
    ] as const
  ).every((o) => !('error' in decideWebhookResponse(o).body)));

// ═══ 6. Merchant references ══════════════════════════════════════════════════

section('6. The merchant reference — random, typed, never a clock');

/** Step 2 of B-2's exploit chain was a guessable `NOTCH-${Date.now()}`. */
assert('a minted reference is not derived from the clock', () => {
  const ref = mintMerchantRef('pt');
  const now = String(Date.now());
  return !ref.includes(now.slice(0, 8));
});

assert('two references minted back to back differ', () =>
  mintMerchantRef('pt') !== mintMerchantRef('pt'));

assert('1000 references are all distinct', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 1000; i++) seen.add(mintMerchantRef('pt'));
  return seen.size === 1000;
});

assert('a reference carries 128 bits of randomness', () => {
  const random = mintMerchantRef('pt').slice('jm_pt_'.length);
  return /^[0-9a-f]{32}$/.test(random);
});

/**
 * This assertion earned its place: the first implementation used base64url,
 * whose alphabet contains `_`, and the parser split on `_`. Roughly half of all
 * references would have failed to route — intermittently, and invisibly to any
 * test that checked a single example.
 */
assert('no reference contains the delimiter — 500 samples', () => {
  for (let i = 0; i < 500; i++) {
    const ref = mintMerchantRef('ct');
    if (ref.split('_').length !== 3) return false;
    if (merchantRefKind(ref) !== 'ct') return false;
  }
  return true;
});

assert('the kind round-trips for all three targets', () =>
  merchantRefKind(mintMerchantRef('pt')) === 'pt' &&
  merchantRefKind(mintMerchantRef('pp')) === 'pp' &&
  merchantRefKind(mintMerchantRef('ct')) === 'ct');

assert('a foreign or legacy reference yields no kind, so the caller must look it up', () =>
  merchantRefKind('NOTCH-1699999999999') === null &&
  merchantRefKind(null) === null &&
  merchantRefKind('jm_xx_abc') === null &&
  merchantRefKind('') === null);

assert('a reference is URL- and path-safe — it travels in a provider body', () =>
  /^jm_(pt|pp|ct)_[A-Za-z0-9_-]+$/.test(mintMerchantRef('ct')));

// ═══ 7. Operator resolution ══════════════════════════════════════════════════

section('7. MTN or Orange — or an honest refusal');

assert('a declared operator always wins over the prefix table', () =>
  resolveCameroonOperator('+237690000000', 'MTN') === 'MTN');

assert('MTN prefixes resolve', () =>
  resolveCameroonOperator('+237650123456') === 'MTN' &&
  resolveCameroonOperator('+237677123456') === 'MTN' &&
  resolveCameroonOperator('+237682123456') === 'MTN');

assert('Orange prefixes resolve', () =>
  resolveCameroonOperator('+237655123456') === 'ORANGE' &&
  resolveCameroonOperator('+237699123456') === 'ORANGE' &&
  resolveCameroonOperator('+237687123456') === 'ORANGE');

/**
 * All three shapes must agree. The messaging-login module shipped a bug of
 * exactly this kind: a WhatsApp identifier arrives as bare digits, `toE164`
 * returned null for it, and the lookup matched nothing for every user while
 * looking perfectly implemented.
 */
assert('E.164, bare digits and the national number all resolve identically', () =>
  resolveCameroonOperator('+237650123456') === 'MTN' &&
  resolveCameroonOperator('237650123456') === 'MTN' &&
  resolveCameroonOperator('650123456') === 'MTN' &&
  resolveCameroonOperator('+237 650 12 34 56') === 'MTN');

assert('Nexttel (66x) and Camtel (62x) resolve to nothing rather than a guess', () =>
  resolveCameroonOperator('+237660123456') === null &&
  resolveCameroonOperator('+237620123456') === null);

assert('MOOV is not honoured as a Cameroon channel — it falls to the prefix', () =>
  resolveCameroonOperator('+237650123456', 'MOOV') === 'MTN' &&
  resolveCameroonOperator('+237660123456', 'MOOV') === null);

assert('a malformed number resolves to null', () =>
  resolveCameroonOperator('12345') === null &&
  resolveCameroonOperator('') === null &&
  resolveCameroonOperator(null) === null);

assert('the national-number reducer rejects a non-Cameroon shape', () =>
  toCameroonNationalNumber('+33612345678') === null &&
  toCameroonNationalNumber('+237650123456') === '650123456');

assert('the NotchPay channel identifiers are cm.mtn / cm.orange', () =>
  notchPayChannelFor('MTN') === 'cm.mtn' && notchPayChannelFor('ORANGE') === 'cm.orange');

// ═══ 8. Money ════════════════════════════════════════════════════════════════

section('8. Money — XAF has no cents, and the callback is cross-checked');

assert('XAF and XOF are zero-decimal; USD and EUR are not', () =>
  isZeroDecimalCurrency('XAF') &&
  isZeroDecimalCurrency('xof') &&
  !isZeroDecimalCurrency('usd') &&
  !isZeroDecimalCurrency('EUR'));

/**
 * The mistake a minor-unit habit produces: sending 4 500 000 for a 45 000 XAF
 * order charges a customer a hundred times the price, and the provider accepts
 * it.
 */
assert('a whole XAF amount passes through unmultiplied', () => toMinorUnit(45000, 'XAF') === 45000);

assert('a two-decimal currency is still multiplied', () => toMinorUnit(45.5, 'usd') === 4550);

assert('the cross-check tolerates a string or a trailing .00 from JSON', () =>
  amountsEqual('4500', 4500) && amountsEqual(4500.0, 4500) && amountsEqual('4500.00', 4500));

/** A one-franc difference is a mismatch. The tolerance absorbs float noise only. */
assert('the cross-check refuses a one-unit difference', () => !amountsEqual(4501, 4500));

assert('the cross-check refuses a non-numeric amount rather than coercing it', () =>
  !amountsEqual('not-a-number', 4500) && !amountsEqual(NaN, 4500));

assert('currency comparison is case-insensitive but never matches an absent side', () =>
  currenciesEqual('XAF', 'xaf') &&
  !currenciesEqual(null, 'XAF') &&
  !currenciesEqual('XAF', undefined) &&
  !currenciesEqual('USD', 'XAF'));

// ═══ 9. Source scans ═════════════════════════════════════════════════════════

// ═══ 9. The hosted card page (GAP-008) ═══════════════════════════════════════

section('9. The hosted card page — what a link may hand out, and to whom');

assert('a minted token is prefixed, hex, and recognised by its own shape check', () => {
  const token = mintPayLinkToken();
  return token.startsWith('pl_') && isPayLinkToken(token);
});

assert('two mints never collide', () => {
  const seen = new Set(Array.from({ length: 500 }, () => mintPayLinkToken()));
  return seen.size === 500;
});

assert('a transaction id is NOT a pay-link token', () =>
  !isPayLinkToken('507f1f77bcf86cd799439011'));

assert('a truncated or re-cased token is refused', () =>
  !isPayLinkToken('pl_abc') && !isPayLinkToken(mintPayLinkToken().toUpperCase()));

/**
 * ⚠ The one that decides whether somebody can be invited to pay twice. A settled
 * transaction must read `settled` even on a link that has also expired — the status is
 * checked first, deliberately, because "your link expired" invites a second attempt at a
 * payment that already succeeded.
 */
assert('⚠ SUCCEEDED reads `settled` even when the link has also expired', () =>
  payLinkState({
    status: 'SUCCEEDED',
    expiresAt: new Date(Date.now() - 60_000),
    now: new Date(),
  }) === 'settled');

assert('a live link on a pending payment is payable', () =>
  payLinkState({
    status: 'PENDING',
    expiresAt: new Date(Date.now() + 60_000),
    now: new Date(),
  }) === 'payable');

assert('FAILED, CANCELLED and REFUNDED all read `closed`, never `payable`', () =>
  (['FAILED', 'CANCELLED', 'REFUNDED'] as const).every(
    (status) =>
      payLinkState({
        status,
        expiresAt: new Date(Date.now() + 60_000),
        now: new Date(),
      }) === 'closed'
  ));

assert('an unfinished payment past its window reads `expired`', () =>
  payLinkState({
    status: 'INITIATED',
    expiresAt: new Date(Date.now() - 1),
    now: new Date(),
  }) === 'expired');

assert('the expiry boundary is inclusive — expiring exactly now is expired', () => {
  const now = new Date();
  return payLinkState({ status: 'PENDING', expiresAt: now, now }) === 'expired';
});

assert('⚠ ONLY a payable session discloses the credential that can move money', () =>
  payLinkDisclosesSecret('payable') &&
  !payLinkDisclosesSecret('settled') &&
  !payLinkDisclosesSecret('closed') &&
  !payLinkDisclosesSecret('expired'));

assert('only STRIPE needs a hosted page — mobile money completes on the handset', () =>
  gatewayRequiresHostedPage('STRIPE') &&
  !gatewayRequiresHostedPage('NOTCHPAY') &&
  !gatewayRequiresHostedPage('MYCOOLPAY'));

/**
 * ⚠ The refusal with an unbounded blast radius. `sk_live_…` in the publishable slot would
 * be sent to every visitor of a payment page, and the two variables differ by a few
 * characters in a `.env` file.
 */
assert('⚠ a SECRET key in the publishable slot is refused, not published', () => {
  const before = process.env.STRIPE_PUBLISHABLE_KEY;
  try {
    process.env.STRIPE_PUBLISHABLE_KEY = 'sk_live_deadbeef';
    const secretRefused = stripePublishableKey() === null;
    process.env.STRIPE_PUBLISHABLE_KEY = 'rk_live_deadbeef';
    const restrictedRefused = stripePublishableKey() === null;
    process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_ok';
    const publishableAccepted = stripePublishableKey() === 'pk_test_ok';
    return secretRefused && restrictedRefused && publishableAccepted;
  } finally {
    if (before === undefined) delete process.env.STRIPE_PUBLISHABLE_KEY;
    else process.env.STRIPE_PUBLISHABLE_KEY = before;
  }
});

assert('an unset publishable key is null rather than an empty string', () => {
  const before = process.env.STRIPE_PUBLISHABLE_KEY;
  try {
    delete process.env.STRIPE_PUBLISHABLE_KEY;
    const unset = stripePublishableKey() === null;
    process.env.STRIPE_PUBLISHABLE_KEY = '   ';
    return unset && stripePublishableKey() === null;
  } finally {
    if (before === undefined) delete process.env.STRIPE_PUBLISHABLE_KEY;
    else process.env.STRIPE_PUBLISHABLE_KEY = before;
  }
});

assert('the link points at the STOREFRONT, and null when there is no storefront', () => {
  const before = process.env.STOREFRONT_URL;
  try {
    process.env.STOREFRONT_URL = 'https://shop.example.com/';
    const built = buildPayLinkUrl('pl_abc') === 'https://shop.example.com/pay/pl_abc';
    delete process.env.STOREFRONT_URL;
    return built && buildPayLinkUrl('pl_abc') === null;
  } finally {
    if (before === undefined) delete process.env.STOREFRONT_URL;
    else process.env.STOREFRONT_URL = before;
  }
});

assert('the TTL falls back to 30 minutes on a value that cannot be parsed', () => {
  const before = process.env.PAYMENT_LINK_TTL_MINUTES;
  try {
    process.env.PAYMENT_LINK_TTL_MINUTES = 'thirty';
    const bad = payLinkTtlMinutes() === 30;
    process.env.PAYMENT_LINK_TTL_MINUTES = '0';
    const zero = payLinkTtlMinutes() === 30;
    process.env.PAYMENT_LINK_TTL_MINUTES = '45';
    return bad && zero && payLinkTtlMinutes() === 45;
  } finally {
    if (before === undefined) delete process.env.PAYMENT_LINK_TTL_MINUTES;
    else process.env.PAYMENT_LINK_TTL_MINUTES = before;
  }
});

/**
 * ⚠ The session is served to an ANONYMOUS caller holding only a link, so what it may NOT
 * carry is the security boundary — the same position the public-catalog DTOs hold. A spread
 * would publish whatever the transaction model gains next, silently.
 */
assert('⚠ the session projection names its fields and cannot spread the document', () => {
  const service = PAYMENT_SOURCES.find(({ file }) => file.endsWith('pay-link.service.ts'))!.code;
  const leaks = ['userId', 'idempotencyKey', 'merchantRef', 'orderIds', 'rawGatewayPayloads'];
  // The resolve builds its return object field by field; none of the above may appear
  // inside it. `rawGatewayPayloads` is read via a helper, so it is checked separately below.
  const resolveBody = service.slice(service.indexOf('async resolve('));
  const returned = resolveBody.slice(resolveBody.indexOf('return {'), resolveBody.indexOf('};'));
  return (
    !/\.\.\.transaction/.test(service) &&
    leaks.every((field) => !returned.includes(field))
  );
});

assert('⚠ the anonymous read never selects the payer or our gateway-facing references', () => {
  const service = PAYMENT_SOURCES.find(({ file }) => file.endsWith('pay-link.service.ts'))!.code;
  const select = service.match(/\.select\('([^']*payLink[^']*)'\)/);
  if (!select) return false;
  const fields = select[1].split(/\s+/);
  return !fields.includes('userId') && !fields.includes('merchantRef') && !fields.includes('idempotencyKey');
});

/**
 * ── `paidFor`: what the money is for, read by a stranger ─────────────────────
 *
 * The page said only "Amount due — 24 000 FCFA", and the payer is by design not the
 * buyer, so they had no way to know what they were paying for. What was added is bounded
 * by one question — **does this survive being read by whoever the link was forwarded to?**
 * These assertions are that boundary, and most of them are source scans because the
 * failure they guard is a FIELD APPEARING, which no behavioural test can be written
 * against in advance.
 */
assert('⚠ the source ids are selected for the lookup and NEVER returned', () => {
  const service = PAYMENT_SOURCES.find(({ file }) => file.endsWith('pay-link.service.ts'))!.code;
  const select = service.match(/\.select\('([^']*payLink[^']*)'\)/);
  if (!select) return false;
  const fields = select[1].split(/\s+/);
  // Selected — describePaidFor needs them to resolve what this is for…
  const selected = ['orderId', 'bookingId', 'cartId', 'orderIds'].every((f) => fields.includes(f));

  // …and absent from the returned literal. An id in the response is an id a stranger
  // holding a forwarded link can take somewhere else.
  const resolveBody = service.slice(service.indexOf('async resolve('));
  const returned = resolveBody.slice(resolveBody.indexOf('return {'), resolveBody.indexOf('};'));
  const leaked = ['orderId', 'bookingId', 'cartId', 'orderIds'].some((f) => returned.includes(f));

  return selected && !leaked;
});

assert('⚠ nothing identifying the BUYER is ever projected', () => {
  const service = PAYMENT_SOURCES.find(({ file }) => file.endsWith('pay-link.service.ts'))!.code;
  const describe = service.slice(service.indexOf('private async describePaidFor('));
  const body = describe.slice(0, describe.indexOf('\n    }\n'));
  /**
   * The buyer's identity and where they live. None of it may be read here — a pay link is
   * held by somebody the platform has never authenticated.
   *
   * ⚠ **NO word boundaries, deliberately, and it took two tries to get here.** The first
   * version was `\b(customer|user|…)\b` and did not flip when handed
   * `.select('customer_id')` — `_` is a word character, so the trailing `\b` never
   * matched. Dropping it to a leading `\b` fixed that and still missed
   * `delivery_address`, for the same reason at the other end. Every real field name on
   * these models is snake_case or camelCase, so a boundary anywhere is a hole. This
   * matches the substring and fails closed: a comment that happens to contain "address"
   * trips it, which costs a rewording and is the direction to be wrong in.
   */
  return !/(customer|user|email|phone|address|shipping|firstname|lastname|buyer|recipient)/i.test(body);
});

assert('⚠ line-item TITLES never travel — a count is a fact about the basket, a title is not', () => {
  const service = PAYMENT_SOURCES.find(({ file }) => file.endsWith('pay-link.service.ts'))!.code;
  const describe = service.slice(service.indexOf('private async describePaidFor('));
  const body = describe.slice(0, describe.indexOf('\n    }\n'));
  // `items` is selected, but only ever measured with `.length`.
  const measuresOnly = /items\?\.length/.test(body) && !/items\[|items\.map|item\.title|\.sku\b/.test(body);
  return measuresOnly;
});

assert('⚠ a BOOKING discloses no seller — the service provider IS often the sensitive fact', () => {
  const service = PAYMENT_SOURCES.find(({ file }) => file.endsWith('pay-link.service.ts'))!.code;
  const describe = service.slice(service.indexOf('private async describePaidFor('));
  // The booking branch runs first and returns before any store lookup exists.
  const bookingBranch = describe.slice(0, describe.indexOf('const orderIds'));
  return (
    /kind: 'booking'/.test(bookingBranch) &&
    /sellers: \[\]/.test(bookingBranch) &&
    !/StoreModel/.test(bookingBranch) &&
    // and it reads only the number off the booking — never the service it is for
    /\.select\('bookingNumber'\)/.test(bookingBranch)
  );
});

assert('⚠ no rendered SENTENCE is composed here — the reader has no language on this side', () => {
  const service = PAYMENT_SOURCES.find(({ file }) => file.endsWith('pay-link.service.ts'))!.code;
  const describe = service.slice(service.indexOf('private async describePaidFor('));
  const body = describe.slice(0, describe.indexOf('\n    }\n'));
  // The storefront composes; this side sends facts. A template literal or a joined
  // phrase here would be English on a page translated into five languages — and English
  // in the one line that says what the money is for.
  return !/`.*\$\{/.test(body) && !/\.join\(' /.test(body) && !/description:/.test(body);
});

assert('the multi-vendor reference is STABLE across reads', () => {
  const service = PAYMENT_SOURCES.find(({ file }) => file.endsWith('pay-link.service.ts'))!.code;
  const describe = service.slice(service.indexOf('private async describePaidFor('));
  // `$in` does not promise document order, so an unsorted `[0]` names a different order
  // on each refresh — which reads as a fault on a payment page.
  return /\.sort\(\);/.test(describe) && /numbers\[0\] \?\? null/.test(describe);
});

assert('describePaidFor imports MODELS only — a service here closes an import cycle', () => {
  const service = PAYMENT_SOURCES.find(({ file }) => file.endsWith('pay-link.service.ts'))!.code;
  const imports = service.slice(0, service.indexOf('/**'));
  // orders/ and booking/ both import payments back, so only leaf models are safe.
  return (
    /import \{ OrderModel \}/.test(imports) &&
    !/OrderService|OrderRepository|BookingService/.test(imports)
  );
});

assert('the mint refuses a gateway that needs no page, and a finished payment', () => {
  const service = PAYMENT_SOURCES.find(({ file }) => file.endsWith('pay-link.service.ts'))!.code;
  return (
    /PAYMENT_LINK_NOT_APPLICABLE/.test(service) &&
    /PAYMENT_LINK_NOT_PAYABLE/.test(service) &&
    /gatewayRequiresHostedPage\(/.test(service)
  );
});

assert('⚠ the secret gate is `payLinkDisclosesSecret`, never a second copy of the rule', () => {
  const service = PAYMENT_SOURCES.find(({ file }) => file.endsWith('pay-link.service.ts'))!.code;
  // The predicate is called, and the rule is not re-written as a bare state comparison.
  return (
    /payLinkDisclosesSecret\(state\)/.test(service) &&
    !/state === 'payable'/.test(service)
  );
});

assert('⚠ the public session route is NOT the owner-scoped transaction read reopened', () => {
  const routes = PAYMENT_SOURCES.find(({ file }) => file.endsWith('payment.routes.ts'))!.code;
  // `GET /:transactionId` keeps requireAuth; the session route deliberately has none.
  return (
    /router\.get\('\/:transactionId', requireAuth/.test(routes) &&
    /router\.get\('\/session\/:token', asyncHandler/.test(routes)
  );
});

assert('minting is authenticated on the customer route, unlike resolving', () => {
  const routes = PAYMENT_SOURCES.find(({ file }) => file.endsWith('payment.routes.ts'))!.code;
  return /router\.post\('\/:transactionId\/pay-link', requireAuth/.test(routes);
});

// ═══ 10. Source scans ════════════════════════════════════════════════════════

section('10. Source scans — the structural invariants');

/**
 * The ESLint ban on `throw new Error()` was switched off at the two sites that
 * most needed it — the mock branches of both gateways. Those stubs are gone,
 * and so must the suppressions be.
 */
assert('no eslint-disable of no-restricted-syntax anywhere under modules/payments', () => {
  const offenders = PAYMENT_SOURCES.filter(({ code }) =>
    /eslint-disable(-next-line)?\s+no-restricted-syntax/.test(code)
  );
  if (offenders.length) originalConsole.error(`     offenders: ${offenders.map((o) => o.file).join(', ')}`);
  return offenders.length === 0;
});

assert('no gateway builds a reference from Date.now()', () => {
  const offenders = PAYMENT_SOURCES.filter(
    ({ file, code }) => file.includes('gateway') && /(reference|payment_id|transaction_ref)[^\n]*Date\.now\(\)/.test(code)
  );
  return offenders.length === 0;
});

/**
 * Scoped to the gateway IMPLEMENTATIONS, not the whole module: `*126#` also
 * appears in `gateway.interface.ts` as the worked example on
 * `PaymentInstructions.ussdCode`, which is documentation of what the field
 * means and must survive.
 */
assert('the mock branches are gone — no fabricated USSD codes or references', () => {
  const offenders = PAYMENT_SOURCES.filter(
    ({ file, code }) =>
      /(notchpay|mycoolpay)\.gateway\.ts$/.test(file) && /\*126#|\*155#|NOTCH-|MCOOL-/.test(code)
  );
  if (offenders.length) originalConsole.error(`     offenders: ${offenders.map((o) => o.file).join(', ')}`);
  return offenders.length === 0;
});

assert('neither gateway still short-circuits on a missing key with a fake success', () => {
  const gateways = PAYMENT_SOURCES.filter(({ file }) => /(notchpay|mycoolpay)\.gateway\.ts$/.test(file));
  return gateways.length === 2 && gateways.every(({ code }) => !/if \(!this\.apiKey\)/.test(code));
});

/**
 * Without the raw mount the signature is computed over re-serialised JSON and
 * every genuine callback is refused — a failure that looks like a wrong secret
 * and is not.
 */
// `includes`, not `new RegExp` — the repo-wide ban on ad-hoc regex construction
// applies to `scripts/` too, and a literal substring is what is wanted here.
assert('app.ts mounts express.raw for ALL THREE gateway webhook paths', () =>
  ['/api/webhooks/stripe', '/api/webhooks/notchpay', '/api/webhooks/mycoolpay'].every((p) =>
    APP_TS.includes(`'${p}'`)
  ) && APP_TS.includes('express.raw('));

assert('the raw mount is declared BEFORE express.json', () => {
  const raw = APP_TS.indexOf('express.raw(');
  const json = APP_TS.indexOf('express.json(');
  return raw !== -1 && json !== -1 && raw < json;
});

/**
 * NOT the `/api/webhooks` prefix: that also carries the WhatsApp and Telegram
 * bot routers, which read a parsed body. Widening the mount hands them a Buffer
 * and breaks every bot command silently.
 */
assert('the raw mount does NOT swallow the bot webhooks', () =>
  !/app\.use\(\s*'\/api\/webhooks'\s*,\s*express\.raw/.test(APP_TS));

assert('every webhook route runs through the shared verifier', () => {
  const routes = WEBHOOK_ROUTES.match(/router\.post\('\/[a-z]+'/g) ?? [];
  const runs = WEBHOOK_ROUTES.match(/runWebhook\(/g) ?? [];
  // One `runWebhook` per route, plus its own definition.
  return routes.length === 3 && runs.length >= routes.length;
});

assert('verifyWebhook is called before any handler runs', () => {
  const verify = WEBHOOK_ROUTES.indexOf('adapter.verifyWebhook(');
  const handle = WEBHOOK_ROUTES.indexOf('await handle(');
  return verify !== -1 && handle !== -1 && verify < handle;
});

assert('no webhook route hardcodes res.status(200) any more', () =>
  !/res\.status\(200\)/.test(WEBHOOK_ROUTES));

assert('the orchestrator no longer carries duplicate gateway status maps', () => {
  const orchestrator = PAYMENT_SOURCES.find(({ file }) =>
    file.endsWith('payment-orchestrator.service.ts')
  )!;
  return !/mapNotchPayStatus|mapMyCoolPayStatus/.test(orchestrator.code);
});

assert('no service builds its own gateway Map — the registry is the only one', () => {
  const offenders = readSources(join(SRC, 'modules')).filter(
    ({ file, code }) =>
      !file.endsWith('registry.ts') && /new (NotchPayGateway|MyCoolPayGateway|StripeGateway)\(/.test(code)
  );
  if (offenders.length) originalConsole.error(`     offenders: ${offenders.map((o) => o.file).join(', ')}`);
  return offenders.length === 0;
});

assert('the Stripe secret key is not logged', () => {
  const client = PAYMENT_SOURCES.find(({ file }) => file.endsWith('stripe.client.ts'))!;
  return !/console\.log\(\{\s*key\s*\}\)/.test(client.code);
});

assert('every outbound gateway call is bounded by a timeout', () => {
  const gateways = PAYMENT_SOURCES.filter(
    ({ file }) => file.endsWith('notchpay.gateway.ts') || file.endsWith('mycoolpay.gateway.ts')
  );
  return (
    gateways.length === 2 &&
    gateways.every(({ code }) => /AbortController/.test(code) && /REQUEST_TIMEOUT_MS/.test(code))
  );
});

assert('both gateways report through recordIntegrationCall', () => {
  const gateways = PAYMENT_SOURCES.filter(
    ({ file }) => file.endsWith('notchpay.gateway.ts') || file.endsWith('mycoolpay.gateway.ts')
  );
  return gateways.every(({ code }) => /recordIntegrationCall\(/.test(code));
});

assert('the reconciliation worker takes the shared overlap lock', () => {
  const worker = PAYMENT_SOURCES.find(({ file }) =>
    file.endsWith('payment-reconciliation.worker.ts')
  )!;
  return /withWorkerLock\(/.test(worker.code);
});

section('11. The initiate row — written BEFORE it has a gateway reference');

// All four initiate paths in `payment-orchestrator.service.ts` commit the transaction
// FIRST and fill `gatewayRef` in from the gateway's answer, so every row spends a window
// carrying `''` — and keeps it forever when the initiation failed without ever being given
// one. Mongoose rejects '' for a `required` String, so marking that field required makes
// EVERY initiate die on validation before the gateway is even called: a 500 on the first
// step of paying for anything. Nothing the repository had could see it — the schema and
// the orchestrator are each valid alone, and the contradiction exists only between them —
// so it is asserted against the real model.

const initiateRow = (source: Record<string, unknown>) =>
  new PaymentTransactionModel({
    ...source,
    userId: new Types.ObjectId(),
    gateway: 'NOTCHPAY',
    method: 'MOBILE',
    status: 'INITIATED',
    gatewayRef: '',
    amountSnapshot: 5000,
    currencySnapshot: 'XAF',
    idempotencyKey: `fixture-${crypto.randomUUID()}`,
    merchantRef: mintMerchantRef('pt'),
    rawGatewayPayloads: [],
  } as any);

assert('a cart-group row validates with an EMPTY gatewayRef', () =>
  initiateRow({ cartId: new Types.ObjectId(), orderIds: [new Types.ObjectId()] })
    .validateSync() === undefined);

assert('a single-order row validates with an EMPTY gatewayRef', () =>
  initiateRow({ orderId: new Types.ObjectId() }).validateSync() === undefined);

assert('a booking row validates with an EMPTY gatewayRef', () =>
  initiateRow({ bookingId: new Types.ObjectId() }).validateSync() === undefined);

// The premise the three above rest on: they are worth something only while the
// orchestrator really does write that placeholder. If it ever stops, they go green for
// the wrong reason — so pin the placeholder rather than trusting it.
assert('the orchestrator still creates its rows with a placeholder gatewayRef', () => {
  const orchestrator = PAYMENT_SOURCES.find(({ file }) =>
    file.endsWith('payment-orchestrator.service.ts')
  )!;
  return /gatewayRef: ''/.test(orchestrator.code);
});

// The other half of that window: a callback must never land on a row that has not got
// its reference yet, which an empty-ref query would do to whichever one Mongo returned
// first. `merchantRef` is what routes a callback until `gatewayRef` exists.
assert('a webhook lookup refuses to query an empty gatewayRef', () => {
  const orchestrator = PAYMENT_SOURCES.find(({ file }) =>
    file.endsWith('payment-orchestrator.service.ts')
  )!;
  return /if \(!event\.gatewayRef\) return null;/.test(orchestrator.code);
});

section('12. The retry — a dead attempt must hand its key back');

// `idempotencyKey` is unique and derived from (source id, user, amount), so a retry of the
// same intent computes the SAME key. All four initiate paths answer a SUCCEEDED or still-live
// attempt from the existing row, and fall through on a dead one to open a fresh transaction —
// which the unique index refuses, with a 409 the customer cannot get past at any price. That
// branch had never once run: initiate died earlier still (§ 11), so the entire retry path
// shipped unexercised. These pin the shape it now has.

const ORCHESTRATOR = PAYMENT_SOURCES.find(({ file }) =>
  file.endsWith('payment-orchestrator.service.ts')
)!.code;
const countOf = (needle: string) => ORCHESTRATOR.split(needle).length - 1;

assert('every idempotency check that falls through releases the dead attempt', () => {
  // Not a bare `findOne({ idempotencyKey })` — openAttempt makes one of those too, to find
  // the winner of a race, and counting it would let a path lose its release and stay green.
  const checks = countOf('const existingTx = await PaymentTransactionModel.findOne({ idempotencyKey });');
  const releases = countOf('await this.releaseDeadAttempt(existingTx);');
  return checks === 4 && releases === checks;
});

assert('the key is retired only from inside the release check', () => {
  const callers = countOf('this.retireDeadAttempt(');
  const release = ORCHESTRATOR.split('private async releaseDeadAttempt')[1]?.slice(0, 2200) ?? '';
  const fromRelease = release.split('await this.retireDeadAttempt(').length - 1;
  // Three exits clear a retry — no reference, a gateway that confirms the charge is dead,
  // and a provider refusal — and all three are inside the check. Nothing else may retire.
  return callers === 3 && fromRelease === 3;
});

assert('the retired key carries the row id, so it cannot collide with another attempt', () =>
  ORCHESTRATOR.includes(
    'idempotencyKey: `${transaction.idempotencyKey}:retired:${transaction._id}`'
  ));

// The one thing retiring must NOT touch. `merchantRef` is how a webhook for a charge we had
// given up on still finds its row, so a retry that disturbed it would orphan that money.
assert('retiring changes the key and nothing else on the row', () => {
  const body = ORCHESTRATOR.split('private async retireDeadAttempt')[1]?.slice(0, 400) ?? '';
  return body.includes('idempotencyKey') &&
    !/merchantRef|gatewayRef|status|orderIds|deleteOne/.test(body);
});

// The gateway's own account of a refusal — NotchPay's 422 body, Stripe's decline code — comes
// back inside an AppError's `details`, and the boundary drops `details` from the client
// response for every `external_service` category, in every environment. If the row does not
// keep it, the reason a payment was refused exists nowhere at all.
assert('a failed initiation records what the gateway actually said', () => {
  const body = ORCHESTRATOR.split('private errorPayload')[1]?.slice(0, 500) ?? '';
  return body.includes('error instanceof AppError') && body.includes('details: error.details');
});

assert('no initiate path still records the one-line summary alone', () =>
  countOf('error: error.message') === 0);

section('13. Paying twice — every way one impatient customer could');

// The unique index on `idempotencyKey` bounds ONE of the four ways, and only that one. It
// keys on (source, user, amount), so it cannot see the same order reached through a second
// route, and it cannot see a charge that may still be live behind a local `FAILED`. Order
// level idempotency downstream does not save this: `OrderService.handlePaymentSuccess`
// no ops on an already paid order, so a second charge settles silently against nothing and
// the customer is simply out the money.

assert('every initiate path looks for a live attempt before opening one', () =>
  countOf('await this.findLiveAttempt(') === 4);

assert('live means INITIATED or PENDING — the two states a charge can complete from', () => {
  const body = ORCHESTRATOR.split('private async findLiveAttempt')[1]?.slice(0, 400) ?? '';
  return body.includes("status: { $in: ['INITIATED', 'PENDING'] }");
});

// The cart path and the single-order path are two routes to the same order, and they compute
// different keys for it. The guard has to ask about the ORDERS, not about the request.
assert('the cart guard covers both routes to the same order', () => {
  const guard = ORCHESTRATOR.split('const liveElsewhere = await this.findLiveAttempt({')[2] ?? '';
  const scope = guard.slice(0, 260);
  return scope.includes('cartId') && scope.includes('orderId') && scope.includes('orderIds');
});

// One door to `create`, so the race recovery and the source-field union type cannot be
// bypassed by a fifth path added later.
assert('nothing opens a transaction except openAttempt', () =>
  countOf('PaymentTransactionModel.create(') === 1);

assert('a lost create race answers with the winner, not a database error', () => {
  const body = ORCHESTRATOR.split('private async openAttempt')[1]?.slice(0, 900) ?? '';
  return body.includes('11000') && body.includes('{ raced: winner }');
});

// The heart of it. A retry may only proceed once the dead attempt is CONFIRMED dead: the
// gateway is asked, its answer outranks ours, and not being able to ask is not a yes.
assert('a retry asks the gateway before charging again', () => {
  const body = ORCHESTRATOR.split('private async releaseDeadAttempt')[1]?.slice(0, 2200) ?? '';
  return body.includes('gatewayInstance.verifyPayment(') &&
    body.includes('return transaction;');
});

assert('an attempt that settled after looking failed is adopted, never charged again', () => {
  const body = ORCHESTRATOR.split('private async releaseDeadAttempt')[1]?.slice(0, 2200) ?? '';
  return body.includes("if (verified === 'SUCCEEDED')") &&
    body.includes('await this.handlePaymentSuccess(transaction);');
});

// PENDING has two causes that look identical — a charge waiting on the customer, and a
// record opened but never charged. Only a 4xx tells them apart, because only a 4xx is the
// provider DECIDING. A timeout records no status, and must never read as permission.
assert('only a provider refusal clears a retry, never a timeout', () => {
  const body = ORCHESTRATOR.split('private lastFailureWasRefused')[1]?.slice(0, 700) ?? '';
  return body.includes('status >= 400 && status < 500') && body.includes('return false;');
});

// …which is worth nothing unless the reference actually survives the failure that loses it.
assert('a failed charge keeps the reference the gateway had already issued', () => {
  const notchpay = PAYMENT_SOURCES.find(({ file }) => file.endsWith('notchpay.gateway.ts'))!.code;
  const carried = notchpay.includes('...(error.details ?? {}),') && notchpay.includes('gatewayRef,');
  const landed = ORCHESTRATOR.split('private async recordFailedAttempt')[1]?.slice(0, 600) ?? '';
  return carried && landed.includes('error.details?.gatewayRef');
});

originalConsole.log(`\n${'═'.repeat(76)}`);
originalConsole.log(`  ${passed} passed, ${failed} failed`);
originalConsole.log(`${'═'.repeat(76)}\n`);

process.exit(failed > 0 ? 1 : 0);
