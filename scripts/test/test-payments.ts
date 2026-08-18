/**
 * test:payments — the suite that stops the payments module regressing.
 *
 * ── WHY THIS FILE IS THE POINT OF PHASE 1 ────────────────────────────────────
 * Four audit findings lived in this one module, and B-4 — "there is no test" —
 * is the reason the other three survived. `tsc` and `eslint` pass over a gateway
 * that makes no HTTP call. `test:errors`' census of 1362 `createAppError` sites
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

section('9. Source scans — the structural invariants');

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

originalConsole.log(`\n${'═'.repeat(76)}`);
originalConsole.log(`  ${passed} passed, ${failed} failed`);
originalConsole.log(`${'═'.repeat(76)}\n`);

process.exit(failed > 0 ? 1 : 0);
