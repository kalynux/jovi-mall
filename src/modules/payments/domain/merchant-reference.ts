import crypto from 'crypto';

/**
 * The reference WE mint and hand to a gateway, and which the gateway echoes
 * back on its callback.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * Two problems, one field.
 *
 * 1. **The old reference was guessable.** An unconfigured gateway fabricated
 *    `NOTCH-${Date.now()}` / `MCOOL-${Date.now()}`, and a millisecond timestamp
 *    is a few thousand candidates for a known minute. That was step 2 of the
 *    forged-webhook chain: guess a reference, POST an unverified callback,
 *    collect the fulfilment. Signature verification closes the chain on its
 *    own, but a reference an outsider can enumerate has no business existing
 *    either way.
 *
 *    Note what is NOT the fix: `idempotencyKey` is `sha256(orderId:userId:amount)`
 *    and stays exactly as it is — it is our own initiate-dedup key and its
 *    determinism is the point. It must not double as the gateway-facing
 *    reference, because all three of its inputs are knowable.
 *
 * 2. **Mobile-money billing had no route home.** A plan purchase or a credit
 *    top-up creates no `PaymentTransaction`, so a callback for one used to
 *    reach an orchestrator that looked the reference up in
 *    `payment_transaction`, found nothing, logged "unknown transaction" and
 *    answered success. Stripe escaped this because its callbacks carry the
 *    PaymentIntent's `metadata.purpose`; the mobile gateways echo a reference
 *    string and nothing else. Typing the reference is what gives them the same
 *    routing without a second lookup key.
 *
 * The prefix is a routing HINT, never an authorisation: the handler still
 * resolves the row and the row is what decides. A forged `jm_pp_...` finds no
 * plan purchase and settles nothing.
 */

/** What kind of row a merchant reference points at. */
export type MerchantRefKind =
  /** `payment_transaction` — orders, carts, bookings, booking balances. */
  | 'pt'
  /** `plan_purchases` — a billing plan bought by a vendor/agency/agent. */
  | 'pp'
  /** `credit_topups` — a credit wallet top-up. */
  | 'ct'
  /**
   * `payout_requests` — a payout the platform SENDS.
   *
   * The only kind naming money that LEAVES rather than arrives, which is why the webhook
   * processor refuses to settle a collection from a `po` reference or a payout from any of
   * the three above. See `direction` on `NormalizedWebhookEvent`.
   */
  | 'po';

const PREFIX = 'jm';
const KINDS: readonly MerchantRefKind[] = ['pt', 'pp', 'ct', 'po'];

/**
 * Mint a fresh reference: `jm_<kind>_<32 hex characters>`.
 *
 * 16 random bytes is 128 bits. The length matters less than the source —
 * `randomBytes`, never anything derived from a clock, a counter or a document
 * id.
 *
 * ── WHY HEX AND NOT base64url ────────────────────────────────────────────────
 * base64url is more compact and was the obvious first choice, and it is wrong
 * here for a reason worth recording: its alphabet includes `_` and `-`. This
 * value travels as `app_transaction_ref` in a My-CoolPay body and as
 * `reference` in a NotchPay one, is stored and echoed back by systems we do not
 * control, and — nearer to home — was being parsed by splitting on `_`. Roughly
 * half of all base64url strings of this length contain one, so half the
 * references would have failed to route, intermittently, in a way no unit test
 * that checked one example would ever have caught.
 *
 * Hex is [0-9a-f] and cannot collide with the delimiter or with any provider's
 * idea of a safe character. 38 characters total is nothing in a JSON body.
 */
export function mintMerchantRef(kind: MerchantRefKind): string {
  return `${PREFIX}_${kind}_${crypto.randomBytes(16).toString('hex')}`;
}

/**
 * Read the routing hint off a reference.
 *
 * Matched by PREFIX rather than by splitting on the delimiter — belt and
 * braces beside the hex alphabet above, so this stays correct even if the
 * random part's alphabet is ever widened again.
 *
 * Returns null for anything that is not one of ours — including every
 * reference minted before this field existed, which is why each caller must
 * fall back to looking the value up rather than trusting the hint.
 */
export function merchantRefKind(reference: string | null | undefined): MerchantRefKind | null {
  if (!reference) return null;
  for (const kind of KINDS) {
    if (reference.startsWith(`${PREFIX}_${kind}_`)) return kind;
  }
  return null;
}
