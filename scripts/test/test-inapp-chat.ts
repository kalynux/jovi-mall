/**
 * Test: STREAM A — the chat doors that open an in-app screen.
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no framework).
 * DB-free.
 *
 * ── ⚠ WHY THIS IS ITS OWN FILE, AND WHY `test-bot-surface.ts` IS NOT TOUCHED ─
 * Five sessions are building the in-app surface **in one working tree, on one branch, with no
 * branching** — the repository rule is never to `git checkout` in a service repo, because
 * there is no recovery path. In that arrangement two sessions appending to one 4000-line
 * suite is not a merge conflict that somebody resolves; it is a **read-then-write race on
 * disk, and one session's work simply disappears.**
 *
 * So every shared file is either Stream 0's forever or exactly one stream's forever.
 * `test-bot-surface.ts` is touched by **nobody**. This file is **Stream A's alone**.
 *
 * ── WHAT IS ALREADY HERE ────────────────────────────────────────────────────
 * § 1 was written by Stream 0 and pins the contract Stream A inherits: three routes, three
 * tools, one URL shape and one degradation ladder. **It is not Stream A's to edit** — if an
 * assertion here fails, the contract moved, and the other four streams need telling.
 * § 2 is empty and is where Stream A's own assertions go.
 *
 * Run: npm run test:inapp-chat
 */
import fs from 'fs';
import path from 'path';
import { BOT_ROUTES, assertNoShadowedRoutes, assertToolNamesUnique } from '../../src/modules/bot-surface/domain/bot-route-table';
/**
 * ⚠ **Imported for its SIDE EFFECT, and that is the assertion.** `bot.routes.ts` calls
 * `assertHandlersCoverRoutes()` at module scope, in both directions — a row without a handler
 * and a handler without a row each throw. So this import either succeeds or the suite dies at
 * load, which is the same way `npm run dev` dies. Do not "tidy" it into a lazy require: the
 * linter forbids `require()` here, and a lazy load would move the check out of the path that
 * makes it meaningful.
 */
import botSurfaceRouter, { assertHandlersCoverRoutes } from '../../src/modules/bot-surface/bot.routes';
import { renderBotReplies } from '../../src/modules/bot-surface/domain/channel-reply';
import { inAppScreenUrl, inAppBaseUrl, __IN_APP_SCREEN_PATH } from '../../src/modules/bot-surface/domain/inapp-url';
import { BOT_COPY_LANGUAGES } from '../../src/modules/bot-surface/domain/bot-error-copy';

let passed = 0;
let failed = 0;

function assert(name: string, fn: () => boolean): void {
    let ok: boolean;
    try {
        ok = fn();
    } catch (err) {
        console.error(`  ❌ THROW: ${name} — ${(err as Error).message}`);
        failed++;
        return;
    }
    if (ok) {
        console.log(`  ✅ ${name}`);
        passed++;
    } else {
        console.error(`  ❌ FAIL: ${name}`);
        failed++;
    }
}

/** Restore the environment between cases — several of these move `BOT_MINIAPP_BASE_URL`. */
function withBase<T>(value: string | undefined, fn: () => T): T {
    const before = process.env.BOT_MINIAPP_BASE_URL;
    if (value === undefined) delete process.env.BOT_MINIAPP_BASE_URL;
    else process.env.BOT_MINIAPP_BASE_URL = value;
    try {
        return fn();
    } finally {
        if (before === undefined) delete process.env.BOT_MINIAPP_BASE_URL;
        else process.env.BOT_MINIAPP_BASE_URL = before;
    }
}

const TOOLS = ['inapp_open_listing', 'inapp_open_product', 'inapp_open_stores'];

function main(): void {
    console.log('\n══ § 1 · The contract Stream 0 froze (do not edit) ══');

    console.log('\n── The three routes ──');

    assert('all three in-app routes are declared', () =>
        TOOLS.every((tool) => BOT_ROUTES.some((r) => r.tool === tool)));

    /**
     * ⚠ A bot route is FOUR files in lockstep — the table row, the `HANDLERS` entry, the
     * controller that entry imports, and the tool catalogue. `assertHandlersCoverRoutes()`
     * runs at MODULE IMPORT and throws in both directions, so a mistake does not fail a test:
     * it breaks `npm run dev` for **every concurrent session at once**. That is the whole
     * reason Stream 0 landed every route before anyone fanned out.
     */
    assert('⛔ every route still has a handler (this guard breaks `npm run dev`, not a test)', () => {
        // Re-run it explicitly as well, so the failure names this assertion rather than
        // killing the suite at import with a stack trace and no context.
        assertHandlersCoverRoutes();
        return botSurfaceRouter !== undefined;
    });

    assert('all three are POST, mutating, and customer-scoped', () =>
        TOOLS.every((tool) => {
            const r = BOT_ROUTES.find((x) => x.tool === tool);
            return r?.method === 'POST' && r.mutating === true && r.requiresCustomerRole === true;
        }));

    /**
     * ⚠ `/inapp/stores` must be declared before `/inapp/products/:productId` — the
     * literal-behind-parameter defect this service has shipped twice (`/articles/index`
     * behind `/articles/:slug`, `/orders/groups/:cartId` behind `/orders/:id`). Both times
     * the handler existed, compiled, and was never reached.
     */
    assert('no route shadows another', () => {
        assertNoShadowedRoutes();
        return true;
    });

    assert('no two routes share a tool name', () => {
        assertToolNamesUnique();
        return true;
    });

    assert('every in-app tool has a full entry in the n8n tool catalogue', () => {
        const file = path.join(__dirname, '../../api-doc/n8n/tools/catalog.json');
        const catalog = JSON.parse(fs.readFileSync(file, 'utf8')) as { tools: { name: string }[] };
        return TOOLS.every((tool) => catalog.tools.some((t) => t.name === tool));
    });

    console.log('\n── The screen URL ──');

    assert('the screen mount is two segments deep, so it cannot shadow the old rail', () =>
        __IN_APP_SCREEN_PATH.split('/').filter(Boolean).length >= 2
        && !__IN_APP_SCREEN_PATH.includes('/p/'));

    /**
     * ⚠ **null is a configuration state, never a fault.** It means this deployment has no
     * in-app screens — which is true of production today, because `BOT_MINIAPP_BASE_URL` is
     * unset. Every caller must degrade rather than throw, so the degradation path is the one
     * that actually runs.
     */
    assert('no origin configured → no screen, and no throw', () =>
        withBase(undefined, () => inAppBaseUrl() === null && inAppScreenUrl('pl', 'ia_x', 'fr') === null));

    /**
     * ⚠ Telegram refuses a `web_app` button on any non-HTTPS scheme and refuses **the whole
     * `sendMessage`** with it — so a plain-HTTP origin does not produce a broken button, it
     * produces a turn where the customer is told nothing at all.
     */
    assert('⛔ a plain-HTTP origin yields no screen (Telegram would drop the whole message)', () =>
        withBase('http://localhost:8022', () => inAppScreenUrl('pl', 'ia_x', 'fr') === null));

    assert('an origin unreachable from the public internet yields no screen', () =>
        withBase('https://localhost:8022', () => inAppScreenUrl('pl', 'ia_x', 'fr') === null));

    /**
     * ⚠ **Without the language in the query every screen opens in English.** The page asks
     * `/copy` for its words before it has any data — deliberately, so a lapsed handle can
     * still say "ask me again" in the customer's own language — and that endpoint does not
     * resolve the handle. The URL is the only thing that can tell it.
     */
    assert('every screen URL carries the language', () =>
        withBase('https://api.test', () =>
            BOT_COPY_LANGUAGES.every((lang) =>
                inAppScreenUrl('pl', 'ia_x', lang) === `https://api.test${__IN_APP_SCREEN_PATH}/pl/ia_x?lang=${lang}`)));

    assert('the language is FOLDED, never passed through raw', () =>
        withBase('https://api.test', () =>
            inAppScreenUrl('pl', 'ia_x', 'pt-BR')?.endsWith('?lang=pt') === true
            && inAppScreenUrl('pl', 'ia_x', '../../etc')?.endsWith('?lang=en') === true
            && inAppScreenUrl('pl', 'ia_x', null)?.endsWith('?lang=en') === true));

    /**
     * ⚠ The kind is in the PATH as well as inside the session. The path routes the request;
     * the stored kind is what `InAppSurfaceStore.read` checks. A handle pasted onto the wrong
     * path fails the kind check rather than opening the wrong screen with the right data —
     * which matters most for `co`, the one handle that can place an order.
     */
    assert('the kind is in the path as well as in the session', () =>
        withBase('https://api.test', () =>
            (['pl', 'pd', 'ol', 'sl', 'co'] as const).every((k) =>
                inAppScreenUrl(k, 'ia_x', 'en')?.includes(`/${k}/ia_x`) === true)));

    console.log('\n── The `inapp` reply, on both channels ──');

    /**
     * ⚠ **Telegram-first is a decision, and an undocumented one gets its WhatsApp branch
     * deleted as dead code.** `channel-reply.ts` states the rule that every intent renders for
     * both channels in the same change; the `inapp` intent keeps that rule by degrading
     * deliberately rather than by throwing.
     */
    assert('the in-app intent is ONE message on both channels', () => {
        const intent = { kind: 'inapp' as const, text: 'Here they are', label: 'See all', url: 'https://app.test/s/pl/ia_x' };
        return renderBotReplies(intent, 'telegram', '1').length === 1
            && renderBotReplies(intent, 'whatsapp', '1').length === 1;
    });

    assert('Telegram gets web_app, which keeps the customer inside the chat', () => {
        const [reply] = renderBotReplies(
            { kind: 'inapp', text: 't', label: 'Open', url: 'https://app.test/s/pl/ia_x' },
            'telegram',
            '1',
        );
        const markup = reply.body.reply_markup as { inline_keyboard: Record<string, unknown>[][] };
        return markup.inline_keyboard[0][0].web_app !== undefined;
    });

    console.log('\n══ § 2 · Stream A\'s own assertions ══');
    console.log('  (none yet — append below this line, and nowhere else)\n');

    // ─────────────────────────────────────────────────────────────────────────
    //  ▼ STREAM A: your assertions go here.
    //
    //  Worth covering, in rough order of what would hurt most if it broke:
    //    · store browse with no screen configured falls back to the STOREFRONT LINK,
    //      never to a dead button — `inAppStoreListing` is a later milestone;
    //    · a listing door with neither a screen nor a storefront sets NO reply at all,
    //      so the model speaks rather than a control rendering with an empty target;
    //    · the three doors mint a session of the matching kind and no other;
    //    · a product door refuses a product the customer could not have been shown.
    // ─────────────────────────────────────────────────────────────────────────

    console.log(
        failed === 0
            ? `\n✅ ${passed} passed, 0 failed`
            : `\n❌ ${passed} passed, ${failed} failed`,
    );
    process.exit(failed === 0 ? 0 : 1);
}

main();
