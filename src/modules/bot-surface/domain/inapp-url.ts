import { isReachableByPlatformServers } from './product-card';
import { toBotCopyLanguage } from './bot-error-copy';
import type { InAppSurfaceKind } from '../services/inapp-surface.store';

/**
 * Where the in-app screens live, and whether this deployment has anywhere to put them.
 *
 * ── WHY THIS IS EXTRACTED RATHER THAN COPIED ────────────────────────────────
 * `product-display.service.ts` already resolves this origin for the old product rail, with
 * two checks that are easy to get right once and easy to forget the second time. Five screens
 * are about to need the same answer. Two readers of one environment variable is the drift this
 * codebase warns about repeatedly — and the failure here is silent in the worst way: a screen
 * that renders a button Telegram then refuses, losing the whole message rather than just the
 * control.
 *
 * So there is one implementation, and `product-display.service.ts` uses it too.
 *
 * ⚠ **The variable is read as a spelled-out property access, never through a helper taking
 * the name as an argument.** `test:env` re-derives the environment contract by scanning
 * source and recognises only a literal access or one of the seven named config helpers; a
 * local `read(…)` indirection is invisible to that census, so the variable would go
 * undocumented while the suite passed. It scans comments too, which is why this paragraph
 * describes the shape rather than demonstrating it.
 */

const trimmed = (value: string | undefined): string | null => {
    const out = (value ?? '').trim().replace(/\/+$/, '');
    return out.length > 0 ? out : null;
};

/**
 * The in-app origin, **only when Telegram would actually accept it.**
 *
 * Two checks, and both exist because of how Telegram fails rather than out of fastidiousness:
 *
 *   - ⚠ **HTTPS or nothing.** Telegram refuses a `web_app` button on any other scheme, and it
 *     refuses the **whole `sendMessage`** with it — so a plain-HTTP origin does not produce a
 *     broken button, it produces a turn where the customer is told nothing at all.
 *   - ⚠ **Reachable from the public internet.** The same test the product photographs go
 *     through. A screen on a Tailscale or loopback address opens for nobody but the developer
 *     who set it, and nothing on this side reports that.
 *
 * `null` is a configuration state and never a fault: it means this deployment has no in-app
 * screens, and every caller must degrade rather than throw. Today it IS null in production —
 * the variable is unset — which is why the degradation path is the one that actually runs.
 */
export function inAppBaseUrl(): string | null {
    const base = trimmed(process.env.BOT_MINIAPP_BASE_URL);
    if (!base) return null;
    if (!base.toLowerCase().startsWith('https://')) return null;
    return isReachableByPlatformServers(base) ? base : null;
}

/**
 * The mount the new screens are served from.
 *
 * ⚠ **Deliberately a different shape from the old rail's `/p/:handle`.** The two coexist while
 * the replacement is proven on a real handset, and a shared shape would mean one router
 * pattern deciding which controller answers — the literal-before-parameter trap this service
 * has already been bitten by twice. `/s/<kind>/<handle>` cannot collide with `/p/<handle>` at
 * any depth.
 */
const SCREEN_PATH = '/api/bot/miniapp/s';

/**
 * The absolute URL of one screen, or null when this deployment serves none.
 *
 * ⚠ **The kind is in the PATH as well as inside the session**, and the redundancy is
 * deliberate. The path segment routes the request; the stored kind is what
 * `InAppSurfaceStore.read` checks. A handle pasted onto the wrong path therefore fails the
 * kind check rather than opening the wrong screen with the right data — which matters most
 * for `co`, the one handle that can place an order.
 *
 * ⚠ **The language is in the QUERY, and without it every screen opens in English.** The page
 * asks `/s/<kind>/<handle>/copy` for its words *before* it has any data, precisely so that a
 * lapsed handle can still say "ask me again" in the customer's own language — and that
 * endpoint deliberately does not resolve the handle, so the only thing that can tell it the
 * language is the URL the customer tapped. Nothing was putting it there.
 *
 * It is a fold through `toBotCopyLanguage`, never the raw value: what goes on the wire is one
 * of five known tokens, so the page cannot be opened with a query string of somebody's
 * choosing. And it is not a credential — the handle is — so it costs nothing to expose.
 */
export function inAppScreenUrl(
    kind: InAppSurfaceKind,
    handle: string,
    language?: string | null,
): string | null {
    const base = inAppBaseUrl();
    if (!base) return null;
    return `${base}${SCREEN_PATH}/${kind}/${handle}?lang=${toBotCopyLanguage(language)}`;
}

/** ⚠ Exported for the suites, which assert the new mount cannot shadow the old rail's. */
export const __IN_APP_SCREEN_PATH = SCREEN_PATH;
