import { inAppCopy } from '../../bot-surface/miniapp/inapp-copy';
import {
    FlowResponseBody,
    FlowScreenRequest,
    tokenUnusableBody,
} from './domain/flow-protocol';

/**
 * Serving a screen: from a decrypted request to the answer that goes back encrypted.
 *
 * ── WHY THIS IS SEPARATE FROM THE CONTROLLER ────────────────────────────────
 * The controller owns the protocol: signature, cipher, status codes, the bare base64 body. This
 * file owns the product: which session, which read, which screen. Keeping them apart means the
 * read adapters can be tested against a request object with no cipher in the way, and the
 * controller's protocol rules can't be touched by somebody adding a screen.
 *
 * ── ONE READ, ONE SET OF RULES, TWO RENDERINGS ──────────────────────────────
 * Each screen's data comes from the SAME exported read its Telegram page uses:
 * `readListingPage` / `readProductDetail` (Stream B) and `readCheckoutView` / `placeCheckout`
 * (Stream D). This module only reshapes their output into what a Flow screen declares. It must
 * never re-derive a price, a visibility rule, a mask or a stock verdict. A second copy of any of
 * those is a second set of rules that drifts from the first, on the channel nobody can open in
 * a browser to compare.
 *
 * ⚠ **Until those exports land, no screen is served**, and every request answers 427 with a
 * sentence rather than being guessed at. A Flow's data model is validated by Meta at publish
 * time, so a screen answered against a guessed shape means publishing twice.
 */

export type FlowScreenVerdict =
    | { status: 200; body: FlowResponseBody }
    /**
     * ⚠ **427 carries an encrypted `{ error_msg }` body, and the handset shows it.** Meta's
     * reference endpoint does exactly this. Without it the Flow ends on a blank failure the
     * customer can't act on.
     */
    | { status: 427; body: Record<string, unknown> };

/**
 * The 427 answer.
 *
 * ⚠ **English when the session is gone, and that is a known limit rather than an oversight.**
 * The customer's language lives on the session, and the session is exactly what an unusable
 * token has lost. The Telegram page gets around this by carrying `?lang=` in its URL; a Flow's
 * only identifier is the token itself. When a live session IS available, pass its language.
 */
export function tokenUnusable(language: string | null): FlowScreenVerdict {
    return { status: 427, body: tokenUnusableBody(inAppCopy(language).expired) };
}

export async function serveFlowScreen(request: FlowScreenRequest): Promise<FlowScreenVerdict> {
    if (!request.flowToken) return tokenUnusable(null);

    console.warn(
        `[WhatsAppFlows] no handler yet for screen '${request.screen ?? 'INIT'}' `
        + `(action '${request.action}')`,
    );
    return tokenUnusable(null);
}
