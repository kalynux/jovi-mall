import crypto from 'crypto';
import type { PaymentGatewayStatus } from '../gateways/gateway.interface';

/**
 * Inbound webhook verification — the primitives, kept pure.
 *
 * This is jovi-mall's first *inbound* HMAC verifier. The service has signed
 * outbound webhooks since the geo-tracker integration
 * (`tracking-dispatch.worker.ts:159`), but every inbound gateway callback was
 * accepted unverified: `webhook.routes.ts` read `x-notchpay-signature` and
 * `x-mycoolpay-signature` into a variable, passed them to `handleWebhook`, and
 * that method never referenced the argument.
 *
 * ── WHY THESE ARE PURE FUNCTIONS ─────────────────────────────────────────────
 * Every secret is a parameter, never read from the environment here. That is
 * what lets `test:payments` drive the real digest arithmetic against fixture
 * keys and known-good vectors, rather than asserting that some code exists —
 * which is the failure mode a hand-rolled crypto check is most prone to.
 */

/** Why a callback was refused. Each maps to its own HTTP status at the route. */
export type WebhookRefusal =
  /** The gateway is not configured, so no signature CAN be checked. Refuse, never skip. */
  | 'missing_secret'
  /** The provider sent no signature header/field at all. */
  | 'missing_signature'
  /** A signature was presented and it did not match. */
  | 'bad_signature'
  /** The body was absent, was not raw bytes, or was not JSON. */
  | 'unparsable'
  /** The callback names an application that is not ours (My-CoolPay's `application`). */
  | 'wrong_application'
  /** The callback did not come from the provider's published source address. */
  | 'untrusted_source';

export type WebhookVerification =
  | { ok: true; payload: Record<string, unknown>; rawBody: Buffer }
  | { ok: false; reason: WebhookRefusal; detail?: string };

/**
 * A gateway callback reduced to the fields the orchestrator acts on.
 *
 * `eventId` is the dedup key and is REQUIRED. Where a provider mints one we
 * use it; where it does not (My-CoolPay sends no event id) we derive a stable
 * one from the fields that define the event. It must be stable across
 * redeliveries of the same event and different across genuinely different
 * ones — a hash of the whole body satisfies neither, which is exactly why
 * `PaymentTransaction.gatewayPayloadHash` never worked as replay protection.
 */
export interface NormalizedWebhookEvent {
  eventId: string;
  eventType: string;
  /** The gateway's own transaction id. */
  gatewayRef: string;
  /** Our reference, echoed back. Null when the provider did not return it. */
  merchantRef: string | null;
  status: PaymentGatewayStatus;
  /** What the provider says was paid — cross-checked against our snapshot. */
  amount: number | string | null;
  currency: string | null;
  raw: unknown;
}

/**
 * Constant-time compare.
 *
 * Both sides are hashed first so a length mismatch does not short-circuit —
 * `crypto.timingSafeEqual` throws on unequal lengths, and that throw is itself
 * a leak. Copied in shape from `api/middlewares/admin-caller.middleware.ts:149`,
 * the safer of the two idioms already in this codebase.
 */
export function timingSafeEqualString(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ── NotchPay ────────────────────────────────────────────────────────────────

/**
 * NotchPay's callback signature: HMAC-SHA256 of the **raw JSON bytes**, hex,
 * keyed by the dashboard's Hash Key (`hsk_...`).
 *
 * Raw bytes, not a re-serialised object: round-tripping through
 * `JSON.parse`/`JSON.stringify` normalises whitespace and unicode escapes, and
 * any of that changes the digest. This is why `app.ts` mounts `express.raw` on
 * the NotchPay path.
 */
export function notchPaySignature(rawBody: Buffer | string, hashKey: string): string {
  return crypto.createHmac('sha256', hashKey).update(rawBody).digest('hex');
}

/**
 * The header NotchPay signs into.
 *
 * `x-notch-signature` is what the current documentation specifies. The former
 * code in this repo read `x-notchpay-signature`, which never matched anything
 * because nothing was ever compared — the alias is accepted so a dashboard
 * still sending the older spelling is not silently refused. Drop the alias
 * once the sandbox confirms which one arrives.
 */
export const NOTCHPAY_SIGNATURE_HEADERS = ['x-notch-signature', 'x-notchpay-signature'] as const;

// ── My-CoolPay ──────────────────────────────────────────────────────────────

/** The five values My-CoolPay concatenates, in the order its own SDK concatenates them. */
export interface MyCoolPaySignatureFields {
  transaction_ref: unknown;
  transaction_type: unknown;
  transaction_amount: unknown;
  transaction_currency: unknown;
  transaction_operator: unknown;
}

/**
 * My-CoolPay's callback signature.
 *
 *   md5(transaction_ref + transaction_type + transaction_amount
 *       + transaction_currency + transaction_operator + PRIVATE_KEY)
 *
 * concatenated with no delimiter, matching `checkCallbackIntegrity()` in their
 * official PHP SDK.
 *
 * MD5 over an undelimited concatenation is a weak construction, and it is
 * theirs rather than a choice made here. Three things compensate, and none is
 * optional: the `application` field must equal our public key, the amount and
 * currency are cross-checked against our own stored snapshot before anything
 * is marked paid, and the source IP can be pinned. A forged signature alone
 * therefore cannot move money to a value the attacker picks.
 */
export function myCoolPaySignature(fields: MyCoolPaySignatureFields, privateKey: string): string {
  const base =
    String(fields.transaction_ref ?? '') +
    String(fields.transaction_type ?? '') +
    String(fields.transaction_amount ?? '') +
    String(fields.transaction_currency ?? '') +
    String(fields.transaction_operator ?? '') +
    privateKey;
  return crypto.createHash('md5').update(base).digest('hex');
}

/**
 * Derive a dedup key for a provider that mints no event id.
 *
 * Stable across a redelivery of the same event (same transaction, same status)
 * and distinct across the real transitions of one transaction
 * (PENDING then SUCCESS) — precisely the property the old whole-body hash
 * lacked, since a body carrying a timestamp changed on every redelivery and a
 * replay therefore looked new.
 */
export function deriveEventId(parts: readonly (string | number | null | undefined)[]): string {
  return crypto
    .createHash('sha256')
    .update(parts.map((p) => String(p ?? '')).join('|'))
    .digest('hex');
}

/**
 * Read a header case-insensitively, tolerating the array form Node uses for
 * repeated headers.
 */
export function headerValue(
  headers: Record<string, string | string[] | undefined>,
  names: readonly string[]
): string | null {
  for (const name of names) {
    const raw = headers[name] ?? headers[name.toLowerCase()];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

/**
 * Parse the raw body, refusing rather than throwing.
 *
 * A non-Buffer body here means the raw parser is not mounted for this path — a
 * configuration fault that must be loud, because the signature check that
 * follows would otherwise compare against re-serialised bytes and refuse every
 * genuine callback.
 */
export function parseRawJson(
  body: unknown
): { ok: true; value: Record<string, unknown> } | { ok: false } {
  if (!Buffer.isBuffer(body) || body.length === 0) return { ok: false };
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false };
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}
