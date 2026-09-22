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
 * § 2 is Stream A's own, and now holds the chat-surfaces stream's door assertions (2026-09-22):
 * the order-history door as the owner met it, and the per-kind sentence over a screen button.
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
import { BotReplyIntent, renderBotReplies } from '../../src/modules/bot-surface/domain/channel-reply';
import { inAppScreenUrl, inAppBaseUrl, __IN_APP_SCREEN_PATH } from '../../src/modules/bot-surface/domain/inapp-url';
import { BOT_COPY_LANGUAGES } from '../../src/modules/bot-surface/domain/bot-error-copy';
import { botChrome } from '../../src/modules/bot-surface/domain/bot-chrome-copy';
import { botStorefrontLink, surfacePath } from '../../src/modules/bot-surface/domain/bot-list-window';
import { inAppSurfaceStore } from '../../src/modules/bot-surface/services/inapp-surface.store';
import {
    BotInAppController,
    ORDERS_SCREEN_DOOR,
    screenPromptOf,
} from '../../src/modules/bot-surface/controllers/bot-inapp.controller';
import { ORDER_ACTION_HANDLERS } from '../../src/modules/bot-surface/controllers/bot-order.controller';
import type { Request, Response } from 'express';

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

/**
 * The three rungs of the degradation ladder, as configuration: an in-app origin, only a
 * storefront, or neither. Both variables are read at CALL time, so a door that awaits needs them
 * set for the whole call — the synchronous `withBase` above would have restored them already.
 */
const RUNGS = {
    screen: { BOT_MINIAPP_BASE_URL: 'https://api.test', STOREFRONT_URL: 'https://shop.test' },
    link: { BOT_MINIAPP_BASE_URL: undefined, STOREFRONT_URL: 'https://shop.test' },
    none: { BOT_MINIAPP_BASE_URL: undefined, STOREFRONT_URL: undefined },
} as const;
type Rung = keyof typeof RUNGS;

const RUNG_VARIABLES = ['BOT_MINIAPP_BASE_URL', 'STOREFRONT_URL'] as const;

/** Apply one rung to the environment, and hand back the function that puts it back. */
function applyRung(rung: Rung): () => void {
    const before = RUNG_VARIABLES.map((name) => process.env[name]);
    RUNG_VARIABLES.forEach((name) => {
        const value = RUNGS[rung][name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    });
    return () => RUNG_VARIABLES.forEach((name, i) => {
        if (before[i] === undefined) delete process.env[name];
        else process.env[name] = before[i];
    });
}

async function withRung<T>(rung: Rung, fn: () => Promise<T>): Promise<T> {
    const restore = applyRung(rung);
    try {
        return await fn();
    } finally {
        restore();
    }
}

function inRung<T>(rung: Rung, fn: () => T): T {
    const restore = applyRung(rung);
    try {
        return fn();
    } finally {
        restore();
    }
}

/** What one door call produced: the reply it set, the body it sent, the sessions it minted. */
interface DoorRun {
    intent: BotReplyIntent | null | undefined;
    body: Record<string, unknown> | null;
    minted: Record<string, unknown>[];
    error: unknown;
}

/**
 * Drive a REAL door handler with a fake request, exactly as the router would after the identity
 * guard ran — and with the session store's `mint` replaced, so no Redis is needed.
 *
 * ⚠ The caller is a made-up customer on a made-up WhatsApp number; nothing here is anybody's.
 */
async function runDoor(
    call: (req: Request, res: Response, next: (error?: unknown) => void) => unknown,
    language: string,
): Promise<DoorRun> {
    const minted: Record<string, unknown>[] = [];
    const realMint = inAppSurfaceStore.mint;
    inAppSurfaceStore.mint = async (input) => {
        minted.push(input as unknown as Record<string, unknown>);
        return 'ia_test_handle';
    };
    const req = {
        body: {},
        params: {},
        bot: {
            caller: { userId: 'u-test', customerId: 'c-test', channel: 'whatsapp', externalIdentity: '237600000001' },
            envelope: { channel: 'whatsapp', externalId: '237600000001' },
            tool: 'test',
            anonymous: false,
            language,
        },
    } as unknown as Request;
    try {
        return await new Promise<DoorRun>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('the door neither answered nor failed')), 5000);
            const res = {
                status: () => res,
                json: (body: Record<string, unknown>) => {
                    clearTimeout(timer);
                    resolve({ intent: req.bot?.replyIntent, body, minted, error: null });
                    return res;
                },
            } as unknown as Response;
            const next = (error?: unknown): void => {
                clearTimeout(timer);
                resolve({ intent: req.bot?.replyIntent, body: null, minted, error: error ?? null });
            };
            Promise.resolve(call(req, res, next)).catch(next);
        });
    } finally {
        inAppSurfaceStore.mint = realMint;
    }
}

/** The WhatsApp body a door's reply renders to — what the owner's handset actually received. */
function whatsappBodyOf(intent: BotReplyIntent | null | undefined): { text: string; button: string } | null {
    if (!intent) return null;
    const [reply] = renderBotReplies(intent, 'whatsapp', '237600000001');
    const interactive = (reply?.body as { interactive?: Record<string, unknown> }).interactive as
        | { body?: { text?: string }; action?: { parameters?: { display_text?: string } } }
        | undefined;
    if (!interactive) return null;
    return { text: interactive.body?.text ?? '', button: interactive.action?.parameters?.display_text ?? '' };
}

const toolOrdersDoor = (req: Request, res: Response, next: (error?: unknown) => void): unknown =>
    BotInAppController.orders(req, res, next);
const tapOrdersDoor = (req: Request, res: Response): unknown =>
    ORDER_ACTION_HANDLERS['open:ol']!(req, res, { verb: 'open', subKey: 'ol', argument: '' });

/**
 * § 2 is asynchronous (the doors mint before they answer), so it runs first and the assertions
 * read its results.
 */
async function runDoors(): Promise<Record<string, DoorRun>> {
    const runs: Record<string, DoorRun> = {};
    for (const lang of BOT_COPY_LANGUAGES) {
        for (const rung of Object.keys(RUNGS) as Rung[]) {
            runs[`tool:${rung}:${lang}`] = await withRung(rung, () => runDoor(toolOrdersDoor, lang));
            runs[`tap:${rung}:${lang}`] = await withRung(rung, () => runDoor(tapOrdersDoor, lang));
        }
    }
    return runs;
}

async function main(): Promise<void> {
    const doors = await runDoors();

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

    // ─────────────────────────────────────────────────────────────────────────
    //  Still worth covering, and NOT covered here yet:
    //    · store browse with no screen configured falls back to the STOREFRONT LINK,
    //      never to a dead button — `inAppStoreListing` is a later milestone;
    //    · a product door refuses a product the customer could not have been shown.
    // ─────────────────────────────────────────────────────────────────────────

    console.log('\n── The order-history door, as the owner met it (core exec 1942) ──');

    /**
     * ⛔ **The regression, stated in the customer's terms.** "Sho my orders" was answered with a
     * WhatsApp `cta_url` reading *"Here are a few more."* over **Load more** — a second-page line
     * and a list-row label, borrowed from two other turns — and the model typed the same
     * sentence again as its own answer. This drives the REAL `inapp_open_orders` handler and
     * renders what it set through the REAL WhatsApp renderer, in all five languages.
     */
    assert('⛔ inapp_open_orders reads "see all your orders" over "See all" on WhatsApp — never "Here are a few more."', () =>
        BOT_COPY_LANGUAGES.every((lang) => {
            const wa = whatsappBodyOf(doors[`tool:screen:${lang}`].intent);
            return wa !== null
                && wa.text === botChrome('ordersScreenPrompt', lang)
                && wa.button === botChrome('browseAllButton', lang)
                && wa.text !== botChrome('moreProductsPrompt', lang)
                && wa.button !== botChrome('loadMoreRow', lang);
        }));

    assert('with a screen, the door is an in-app button onto an `ol` session, and it mints exactly one', () =>
        BOT_COPY_LANGUAGES.every((lang) => {
            const run = doors[`tool:screen:${lang}`];
            return run.error === null
                && run.intent?.kind === 'inapp'
                && run.intent.url === inRung('screen', () => inAppScreenUrl('ol', 'ia_test_handle', lang))
                && run.minted.length === 1
                && run.minted[0].kind === 'ol'
                && (run.body?.data as { opened?: string } | undefined)?.opened === 'orders';
        }));

    /**
     * Without an in-app origin the same sentence and label land on the storefront's own orders
     * page, in the customer's language.
     */
    assert('without a screen, the door is the storefront orders page, same sentence, same label', () =>
        BOT_COPY_LANGUAGES.every((lang) => {
            const run = doors[`tool:link:${lang}`];
            const link = inRung('link', () => botStorefrontLink(surfacePath('orders'), lang));
            return link !== null
                && link.startsWith('https://shop.test')
                && run.error === null
                && run.intent?.kind === 'link'
                && run.intent.url === link
                && run.intent.text === botChrome('ordersScreenPrompt', lang)
                && run.intent.label === botChrome('browseAllButton', lang);
        }));

    /** ⛔ The third rung: a control with an empty target is worse than none, so there is none. */
    assert('⛔ with neither a screen nor a storefront, the door sets NO reply and the model speaks', () =>
        BOT_COPY_LANGUAGES.every((lang) => {
            const run = doors[`tool:none:${lang}`];
            return run.error === null && run.intent === null
                && (run.body?.data as { opened?: string } | undefined)?.opened === 'orders';
        }));

    /**
     * ⭐ **The tool and the Load more row open the SAME door**, proven by behaviour rather than
     * by reading the source: they used to say different things over different labels, and a
     * scan for a shared constant would pass the day somebody spread it and then overrode a key.
     */
    assert('⭐ the tool door and the `open:ol` tap set byte-identical replies on every rung of the ladder', () =>
        BOT_COPY_LANGUAGES.every((lang) =>
            (Object.keys(RUNGS) as Rung[]).every((rung) => {
                const tool = doors[`tool:${rung}:${lang}`];
                const tap = doors[`tap:${rung}:${lang}`];
                return tool.error === null && tap.error === null
                    && JSON.stringify(tool.intent) === JSON.stringify(tap.intent);
            })));

    assert('the shared descriptor reads its fallback from the list window\'s own table', () =>
        ORDERS_SCREEN_DOOR.fallbackPath === surfacePath('orders'));

    console.log('\n── The sentence over a screen is per KIND, not a product default ──');

    /**
     * ⚠ The single default used to be the product-grid line for every kind, which is how one
     * product came to be introduced as "them" (exec 1892, the owner's handset, 2026-09-22).
     */
    assert('each kind that has its own sentence gets it by default', () =>
        screenPromptOf('ol') === 'ordersScreenPrompt'
        && screenPromptOf('pl') === 'browseProductsPrompt'
        && screenPromptOf('pd') === 'productScreenPrompt'
        && screenPromptOf('sl') === 'storesScreenPrompt'
        && screenPromptOf('tf') === 'supportFormPrompt'
        && screenPromptOf('bl') === 'bookingsScreenPrompt');

    /**
     * ⛔ The exact defect, pinned in words: the sentence over ONE product must not be the plural
     * grid line, in any language. Read through the real copy table, not the key name.
     */
    assert('⛔ one product is never introduced as "them" — in all five languages', () =>
        (['en', 'fr', 'pt', 'es', 'ar'] as const).every((lang) =>
            botChrome(screenPromptOf('pd'), lang) !== botChrome('browseProductsPrompt', lang)));

    console.log(
        failed === 0
            ? `\n✅ ${passed} passed, 0 failed`
            : `\n❌ ${passed} passed, ${failed} failed`,
    );
    process.exit(failed === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
    console.error(`  ❌ THROW: the suite itself — ${(error as Error).message}`);
    process.exit(1);
});
