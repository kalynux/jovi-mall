/**
 * HTTP intake settings: what the app trusts about a request before any route sees it.
 *
 * These three are grouped because they are the same decision from three angles — how much
 * of a request we are willing to accept, and how much of what it claims about itself we are
 * willing to believe.
 */

/**
 * Whether Express may believe `X-Forwarded-For` when resolving `req.ip`.
 *
 * ── Why this has to exist at all ──────────────────────────────────────────────
 * The rate limiter's anonymous bucket is keyed on `req.ip`. Behind an ingress with this
 * OFF, every request reports the proxy's address, so the whole internet shares one bucket
 * and the platform throttles itself. With it ON but nothing actually stripping the header,
 * any caller can spoof an address per request and never be limited at all.
 *
 * There is no safe default that covers both, which is why this is configuration and why it
 * is **off** unless set: an unlimited attacker is a worse failure than a shared bucket, and
 * a deployment that has a proxy knows it has one.
 *
 * Accepts Express's own vocabulary — `true`, `false`, a hop count (`'1'`), or a subnet
 * (`'loopback'`, `'10.0.0.0/8'`). A hop count is usually the right answer: it says how many
 * proxies you actually run rather than trusting the whole chain.
 */
export const TRUST_PROXY: boolean | number | string = (() => {
    const raw = process.env.TRUST_PROXY?.trim();
    if (!raw || raw === 'false') return false;
    if (raw === 'true') return true;
    const hops = Number(raw);
    return Number.isInteger(hops) && hops >= 0 ? hops : raw;
})();

/**
 * Ceiling on a parsed JSON or urlencoded body.
 *
 * `express.json()` was previously called with no options, so this was body-parser's 100 kb
 * default: a real ceiling that nothing in the service could name, and whose rejection had
 * no branch in the error handler — so exceeding it produced `500 Something went wrong`.
 *
 * 1 MB matches wi-admin. It is generous for JSON; the paths that genuinely move bulk are
 * multipart uploads, which go through multer with its own limits and never reach here.
 */
export const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT ?? '1mb';

/**
 * Ceiling on ONE path: `POST /api/internal/bot/files/inbound` (Step 7b).
 *
 * ── WHY THE GLOBAL LIMIT COULD NOT SIMPLY BE RAISED ─────────────────────────
 * A photo a customer sends in a chat reaches us as base64 inside a JSON body, because the
 * automation layer is the only party that can fetch it from Meta or Telegram and n8n's
 * HTTP node speaks JSON. Base64 inflates by a third, so a 5 MB image — the largest
 * WhatsApp will deliver — is 6.7 MB on the wire and the 1 MB global ceiling refuses it.
 *
 * Raising `JSON_BODY_LIMIT` instead would hand every one of the several hundred other
 * routes a twelve-megabyte body budget to defend, for one route's benefit. The path-scoped
 * parser is the same shape `app.ts` already uses for the gateway webhooks, which need raw
 * bytes on three literal paths and nowhere else.
 *
 * ⚠ **This is the backstop, not the refusal a customer reads.** Exceeding it is a bare 413
 * from body-parser with no error code for a chat to relay. `BOT_INBOUND_FILE_MAX_BYTES`
 * (8 MB, applied to the DECODED buffer) is the limit that produces a sentence, and it is
 * deliberately lower so it always fires first.
 */
export const BOT_FILE_BODY_LIMIT = process.env.BOT_FILE_BODY_LIMIT ?? '12mb';

/**
 * Ceiling on a raw gateway webhook body, deliberately larger than the JSON one.
 *
 * A Stripe event carrying a fully expanded object is legitimate traffic we cannot ask the
 * sender to shrink, and a 413 here does not inconvenience a caller — it loses a payment
 * notification.
 */
export const WEBHOOK_BODY_LIMIT = process.env.WEBHOOK_BODY_LIMIT ?? '2mb';

/**
 * Origins a BROWSER may make credentialed cross-origin requests from.
 *
 * Empty by default, and that is the safe direction: an unset allowlist means browser
 * clients on other origins are refused, which is visible and fixable, while the previous
 * `origin: true` meant every origin was accepted, which was invisible and was not.
 *
 * Comma-separated, exact match, no wildcards and no suffix matching — `https://evil-jovi.com`
 * must not inherit `https://jovi.com`'s trust because a `.endsWith` looked convenient.
 */
export const ALLOWED_ORIGINS: readonly string[] = Object.freeze(
    (process.env.ALLOWED_ORIGINS ?? '')
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
);
