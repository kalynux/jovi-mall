import { toPublicMediaUrl } from '../../domain/product-card';

/**
 * A stored picture's URL, for a **browser** — the Telegram Mini App's image rule, and only its.
 *
 * ── ⚠ WHY THE MINI APP HAS ITS OWN RULE ─────────────────────────────────────
 * `toPublicMediaUrl` exists because Telegram and Meta fetch media *server-side*, so a URL on a
 * loopback, RFC1918 or carrier-NAT host is a rejected send rather than a slow image. On an
 * in-app screen the fetcher is the customer's own phone, inside a WebView, and what it can
 * reach is a different question — on a development machine it can reach exactly the private
 * host that rule rejects.
 *
 * So the origin rewrite is kept — it is what makes the URL correct in production, where the
 * origin this service knows itself by is not the one the world reaches — and the rejection is
 * not: a raw URL a browser may be able to load beats no picture at all, and the page draws an
 * empty frame either way if it cannot.
 *
 * ── ⚠ WHY THIS IS NOT IN THE SHARED READS ───────────────────────────────────
 * `product-listing.read.ts` and `product-detail.read.ts` hand over the RAW stored URL
 * (`imageSourceUrl`) and apply no rule, deliberately. The rule depends on who fetches:
 *
 *   - a browser → this function;
 *   - a platform fetching server-side → `toPublicMediaUrl`, null when unreachable;
 *   - a WhatsApp Flow → **base64 bytes inside the response, not a URL at all** (Meta's component
 *     reference: Image `src` is "Base64 of an image").
 *
 * Baking this rule into a read would hand a Flow a URL it cannot use.
 */
export function browserImageUrl(source: string | null): string | null {
    return toPublicMediaUrl(source) ?? source;
}
