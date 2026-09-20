import { existsSync } from 'fs';
import path from 'path';
import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { InAppSurfaceKind, TTL_SECONDS } from '../services/inapp-surface.store';
import { inAppCopy } from './inapp-copy';
import { miniAppDirection } from './miniapp-copy';

/**
 * One page handler for all five in-app screens.
 *
 * ── WHY ONE, WHEN THERE ARE FIVE SCREENS ────────────────────────────────────
 * The headers below are the entire reason. Serving a page inside Telegram means overriding
 * three things helmet sets globally, and every one of them fails *silently* when forgotten:
 * a blank white screen, with no error on this side and no message the customer can act on.
 * Five copies of that block is five chances to omit one line, and the omission is invisible
 * until somebody opens the screen on a real handset.
 *
 * So the headers are written once and the only per-screen difference is which HTML file is
 * sent. Each screen's *data* endpoint belongs to the stream that builds it; this file does
 * not know what any screen contains.
 *
 * ── THE MOUNT IS THE SECURITY DECISION, AND IT IS INHERITED ─────────────────
 * `/api/bot/miniapp/**` presents neither `INTERNAL_SERVICE_TOKEN` nor `BOT_WEBHOOK_SECRET` —
 * a browser cannot hold either without handing every viewer the whole bot surface. The opaque
 * handle in the URL is the only credential, and `InAppSurfaceStore.read` checks its **kind**
 * as well as its owner, so a listing handle cannot be replayed against checkout.
 */
export class InAppPageController {
    /**
     * `GET /api/bot/miniapp/s/:kind/:handle` — the page.
     *
     * ⚠ **The kind is validated against a closed set BEFORE it reaches `path.join`.** It is a
     * URL segment interpolated into a filename, which without this check is a path-traversal
     * primitive — `%2e%2e%2f…` walking out of `public/`. Express decodes `:kind` for us, so the
     * allowlist is the whole defence and it must stay an allowlist rather than a sanitiser.
     *
     * ⚠ **It does NOT check the handle**, deliberately, exactly as the old rail's page does
     * not. An unknown or lapsed handle still gets the HTML, which then renders its own
     * "ask me again" state from its data call. Refusing here would mean a raw 404 inside a
     * Telegram WebView — an unstyled browser error, in a language the customer may not read,
     * with nothing to tap.
     */
    static page = asyncHandler(async (req: Request, res: Response) => {
        const kind = asScreenKind(req.params.kind);
        if (!kind) {
            res.status(404).type('text').send('Unknown screen');
            return;
        }

        /**
         * ⚠ **A route-scoped CSP that OVERRIDES helmet's, and without it the page is blank.**
         *
         * `app.use(helmet())` sets `default-src 'self'` with no `unsafe-inline`. These pages
         * carry an inline `<script>` and load Telegram's own `telegram-web-app.js`, which is
         * the only way a Mini App learns its theme and can close itself. Under the default
         * policy both are refused and the customer sees an empty white screen.
         *
         * ⚠ **`style-src` carries `'self'` as well as `'unsafe-inline'`, and the `'self'` is
         * the new half.** The old rail inlined all of its CSS, so its policy had no `'self'`
         * there — and a shared `shell.css` under that policy is blocked with no error anywhere
         * on this side, producing an unstyled page that reads as "the shop is broken" rather
         * than as a misconfiguration.
         *
         * Written as the narrowest thing that works rather than as a relaxation: no
         * `form-action`, no `base-uri`, and `connect-src 'self'` so a page can only ever talk
         * back to this API. `img-src` is broad because a product photograph legitimately comes
         * from object storage or a CDN on any origin, and these pages hold nothing an image
         * could exfiltrate.
         */
        res.setHeader(
            'Content-Security-Policy',
            [
                "default-src 'none'",
                "script-src 'self' 'unsafe-inline' https://telegram.org",
                "style-src 'self' 'unsafe-inline'",
                'img-src https: http: data:',
                "connect-src 'self'",
                "font-src 'self'",
                "base-uri 'none'",
                "form-action 'none'",
                // Telegram Desktop and Web embed a Mini App in a frame on their own origin.
                'frame-ancestors https://web.telegram.org https://*.telegram.org',
            ].join('; '),
        );

        /**
         * ⚠ helmet stamps `X-Frame-Options: DENY` and `Cross-Origin-Resource-Policy:
         * same-origin` globally. The first is honoured by browsers that ignore
         * `frame-ancestors` and would blank the page in Telegram Web; the second blocks the
         * embed outright. Both are relaxed for these documents only.
         */
        res.removeHeader('X-Frame-Options');
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        // Identical document per kind, but the URL is not — keep it out of shared caches so a
        // proxy cannot serve one customer's URL to another's request.
        res.setHeader('Cache-Control', 'no-store');

        const file = path.join(__dirname, 'public', `${kind}.html`);

        /**
         * ⚠ **A screen whose page has not been built yet answers honestly rather than 500ing.**
         *
         * The routes and the tool contract land before the screens do, deliberately: a stream
         * adding its own route would break every other session's `npm run dev`. The cost is a
         * window in which a kind is routable and its HTML is absent, and `res.sendFile` on a
         * missing path is an unhandled stream error, not a 404.
         *
         * `503` rather than `404`: the screen is a real part of the contract that is not
         * serving yet, which is what that status means. The body is plain text because there
         * is no page to render it in.
         */
        if (!existsSync(file)) {
            res.status(503).type('text').send('This screen is not available yet.');
            return;
        }

        res.type('html');
        /**
         * ⚠ `__dirname`-relative, which is why `modules/bot-surface/miniapp/public` is on the
         * build-assets manifest. `tsc` emits `.js` and imported `.json` and nothing else, so
         * an HTML or CSS file under `src/` reaches `dist/` only because `copy-build-assets.ts`
         * copies that directory — the exact split that once left every Handlebars email
         * template missing from every container image. The directory is already listed, so a
         * new file inside it needs no manifest change; a new sibling directory would.
         */
        res.sendFile(file);
    });

    /**
     * `GET /api/bot/miniapp/shell.css` — the one stylesheet behind every screen.
     *
     * ⚠ **This route is the whole reason `style-src` carries `'self'`.** Without both halves
     * the browser refuses the request, reports nothing to this side, and the customer gets an
     * unstyled page — which is read as "the shop is broken" rather than as a misconfiguration.
     *
     * ⚠ **It is NOT under `/s/`, deliberately.** One segment deep, so it cannot be confused
     * with `/s/:kind/:handle` (three) or the old rail's `/p/:handle` (two) at any depth — the
     * literal-behind-parameter trap this service has shipped twice. `express.static` was the
     * alternative and was declined: it would serve the whole `public/` directory, including
     * every screen's HTML, on paths that answer with no handle check and no CSP.
     *
     * ⚠ **Cached, unlike the pages.** A screen URL carries a credential and is `no-store`;
     * this file is identical for every customer and holds nothing. `sendFile` stamps an ETag,
     * so the five-minute window is a floor on revalidation rather than a stale ceiling — a
     * deploy reaches an open page within it.
     */
    static stylesheet = asyncHandler(async (_req: Request, res: Response) => {
        res.type('css');
        res.sendFile(path.join(__dirname, 'public', 'shell.css'), {
            maxAge: '5m',
            headers: { 'Cross-Origin-Resource-Policy': 'cross-origin' },
        });
    });

    /**
     * `GET /api/bot/miniapp/s/:kind/:handle/copy` — the words and the direction, before any data.
     *
     * ⚠ **Separate from each screen's data endpoint on purpose.** A page that cannot resolve
     * its handle still has to say so *in the customer's language*, and it cannot learn the
     * language from the thing that just failed. So the copy comes from the handle's language
     * where it resolves and from the request otherwise, and it never fails.
     *
     * ⚠ **It reveals nothing.** The response is a fixed table of translated UI strings plus a
     * text direction — no product, no order, no customer. An unknown handle therefore gets a
     * usable page rather than a refusal, which is the whole point.
     */
    static copy = asyncHandler(async (req: Request, res: Response) => {
        const kind = asScreenKind(req.params.kind);
        if (!kind) {
            res.status(404).json({ success: false });
            return;
        }

        /**
         * Read straight from the query rather than from the session.
         *
         * ⚠ **This is the one place a caller-supplied language is trusted, and it is safe
         * because of what it can reach**: `toBotCopyLanguage` folds anything it does not know
         * to English, and the only thing downstream is a lookup in a frozen table. There is no
         * record to read and nothing to widen. Resolving the handle first would mean a lapsed
         * page falls back to English to tell somebody, in English, that it has lapsed.
         */
        const language = typeof req.query.lang === 'string' ? req.query.lang : null;

        res.setHeader('Cache-Control', 'no-store');
        res.json({
            success: true,
            data: { language: language ?? 'en', direction: miniAppDirection(language), copy: inAppCopy(language) },
        });
    });
}

/**
 * The closed set of screens, as a type guard.
 *
 * ⚠ **An allowlist, never a sanitiser** — see the traversal note on `page`.
 *
 * ⚠ **DERIVED, because the hand-written list could not keep the promise its comment made.**
 * This read *"a sixth screen fails to compile here"*, and that was never true: a literal array
 * typed `readonly InAppSurfaceKind[]` is perfectly valid while missing a member, so a new
 * screen would have compiled, routed nowhere, and answered "no such screen" — the quietest
 * possible failure. `TTL_SECONDS` is a **total** `Record<InAppSurfaceKind, number>`, so a kind
 * added to the union fails to compile *there* and arrives here for free. The claim is now
 * carried by the code rather than by this paragraph.
 */
const SCREEN_KINDS: readonly InAppSurfaceKind[] = Object.freeze(
    Object.keys(TTL_SECONDS) as InAppSurfaceKind[],
);

function asScreenKind(raw: unknown): InAppSurfaceKind | null {
    return typeof raw === 'string' && (SCREEN_KINDS as readonly string[]).includes(raw)
        ? (raw as InAppSurfaceKind)
        : null;
}

/** ⚠ Exported for the suites, which assert this set against `InAppSurfaceKind`. */
export const __SCREEN_KINDS = SCREEN_KINDS;
