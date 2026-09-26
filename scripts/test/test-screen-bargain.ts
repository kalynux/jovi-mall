/**
 * Test: Bargain pressed on the in-app detail SCREEN — it reaches the chat on BOTH channels, and
 * the customer's answer can be routed to the bargainer.
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no framework).
 * DB-free: the store runs against a fake Redis with real GET-then-DEL semantics; the controllers
 * are read as TEXT, because importing them reaches `orders/` and `payments/`, which hang bare
 * `ts-node` at import with no output at all.
 *
 * ── THE DEFECT, FOUND ON A HANDSET 2026-09-22 ───────────────────────────────
 * On WhatsApp the listing screen's rows open the detail screen in WhatsApp's in-app browser.
 * Pressing Bargain there greyed the button, printed the question under it — and did nothing
 * else. `pushIntoConversation` returned early for every channel but Telegram, and the page's
 * only way back to the chat was `Telegram.WebApp.close()`. Even on Telegram, where the question
 * did arrive, the customer's typed offer went to the main assistant: n8n routes to the
 * bargainer from a flag it sets on a Bargain TAP, and a screen press never passes through n8n.
 *
 * Run: npm run test:screen-bargain
 */
import fs from 'fs';
import path from 'path';

import * as redisFactory from '../../src/infra/redis/redis.factory';
import { PENDING_BARGAIN_TTL_SECONDS, PendingBargainStore } from '../../src/modules/bot-surface/services/pending-bargain.store';
import { conversationUrl } from '../../src/modules/bot-surface/domain/conversation-url';

/**
 * The store reaches for `getRedisClient` at CALL time, so replacing the factory export below is
 * enough — the technique `test:bot-surface` uses.
 */

interface FakeEntry { value: string; expiresAtMs: number | null }

/** Real expiry and a real GET-then-DEL, so the store is exercised rather than restated. */
class FakeRedis {
    readonly store = new Map<string, FakeEntry>();
    readonly ttls = new Map<string, number>();

    private live(key: string): FakeEntry | null {
        const entry = this.store.get(key);
        if (!entry) return null;
        if (entry.expiresAtMs !== null && Date.now() > entry.expiresAtMs) {
            this.store.delete(key);
            return null;
        }
        return entry;
    }

    async set(key: string, value: string, options?: { EX?: number }): Promise<string> {
        this.store.set(key, { value, expiresAtMs: options?.EX ? Date.now() + options.EX * 1000 : null });
        if (options?.EX) this.ttls.set(key, options.EX);
        return 'OK';
    }

    async eval(_script: string, options: { keys: string[] }): Promise<string | null> {
        const entry = this.live(options.keys[0]);
        if (!entry) return null;
        this.store.delete(options.keys[0]);
        return entry.value;
    }

    keys(): string[] {
        return [...this.store.keys()];
    }
}

const fakeRedis = new FakeRedis();
(redisFactory as any).getRedisClient = async () => fakeRedis;

let passed = 0;
let failed = 0;

async function assert(name: string, fn: () => boolean | Promise<boolean>): Promise<void> {
    let ok: boolean;
    try {
        ok = await fn();
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

/**
 * A source-scan guard that must be seen to BITE: the real source passes, and the named mutant —
 * the defect this suite was written after — fails. A guard proven only on correct code cannot
 * tell whether it ran at all.
 */
async function guardBites(name: string, check: (src: string) => boolean, src: string, mutant: string): Promise<void> {
    await assert(name, () => {
        const real = check(src);
        const bitten = !check(mutant);
        if (!real) console.error('      the real source fails the check');
        if (!bitten) console.error('      the mutant passes — the guard does not bite');
        return real && bitten;
    });
}

/** Comments stripped and line endings normalised, so prose cannot satisfy a code check. */
const code = (file: string): string =>
    fs.readFileSync(file, 'utf8')
        .replace(/\r\n/g, '\n')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/[^\n]*$/gm, '');

const SRC = path.join(__dirname, '../../src/modules/bot-surface');
const PURCHASE = code(path.join(SRC, 'controllers/bot-purchase.controller.ts'));
const IDENTITY = code(path.join(SRC, 'controllers/bot-identity.controller.ts'));
const PROJECTIONS = code(path.join(SRC, 'dto/bot-projections.ts'));
const PAGE = fs.readFileSync(path.join(SRC, 'miniapp/public/pd.html'), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');

/** The body of one named function or static handler, up to the next top-level declaration. */
function bodyOf(src: string, opener: RegExp): string {
    const at = src.search(opener);
    if (at === -1) return '';
    const rest = src.slice(at);
    const next = rest.slice(1).search(/\n(?:async function|function|export|const|\/\*\*| {4}static)\b/);
    return next === -1 ? rest : rest.slice(0, next + 1);
}

async function main(): Promise<void> {
    console.log('\n── The hand-off store ──');

    const store = new PendingBargainStore();
    const P = 'a1b2c3d4e5f60718293a4b5c';
    const V = 'b1b2c3d4e5f60718293a4b5c';
    const V2 = 'c1b2c3d4e5f60718293a4b5c';
    const OWNER = 'd1b2c3d4e5f60718293a4b5c';

    await store.record({ owner: OWNER, channel: 'whatsapp', externalId: '237672745831' }, { productId: P, variantId: V });

    await assert('a press is kept for thirty minutes — the lifetime n8n gives a TAP\'s flag', () =>
        PENDING_BARGAIN_TTL_SECONDS === 30 * 60
        && [...fakeRedis.ttls.values()].every((ttl) => ttl === PENDING_BARGAIN_TTL_SECONDS));

    /**
     * ⚠ Key NAMES are listed to dev-tools callers. A raw WhatsApp number there is a list of
     * who has been haggling.
     */
    await assert('the key names no phone number', () =>
        fakeRedis.keys().length === 1
        && fakeRedis.keys().every((k) => k.startsWith('bot:bargain:pending:') && !k.includes('237672745831')));

    await assert('the next sync gets exactly what a Bargain TAP\'s response carries', async () => {
        const got = await store.consume('whatsapp', '237672745831', OWNER);
        return JSON.stringify(got) === JSON.stringify({ productId: P, variantId: V, quantity: 1 });
    });

    /**
     * ⭐ Handed over ONCE. After that n8n's own flag is the authority, and n8n clears it when the
     * haggle closes. A second hand-off would re-open a finished haggle on the next message.
     */
    await assert('⛔ and the sync after that gets nothing', async () =>
        (await store.consume('whatsapp', '237672745831', OWNER)) === null && fakeRedis.keys().length === 0);

    await assert('the latest press wins — the last question asked is the one being answered', async () => {
        await store.record({ owner: OWNER, channel: 'whatsapp', externalId: '237672745831' }, { productId: P, variantId: V });
        await store.record({ owner: OWNER, channel: 'whatsapp', externalId: '237672745831' }, { productId: P, variantId: V2 });
        return (await store.consume('whatsapp', '237672745831', OWNER))?.variantId === V2;
    });

    await assert('one conversation per channel — a Telegram chat id never reads a WhatsApp press', async () => {
        await store.record({ owner: OWNER, channel: 'whatsapp', externalId: '1804835114' }, { productId: P, variantId: V });
        const crossed = await store.consume('telegram', '1804835114', OWNER);
        const own = await store.consume('whatsapp', '1804835114', OWNER);
        return crossed === null && own?.variantId === V;
    });

    await assert('⛔ a sync that resolves to another account gets nothing', async () => {
        await store.record({ owner: OWNER, channel: 'telegram', externalId: '42' }, { productId: P, variantId: V });
        return (await store.consume('telegram', '42', 'e1b2c3d4e5f60718293a4b5c')) === null;
    });

    await assert('⛔ a lapsed record is refused even if Redis still holds it', async () => {
        await store.record({ owner: OWNER, channel: 'telegram', externalId: '43' }, { productId: P, variantId: V });
        const key = fakeRedis.keys()[0];
        const record = JSON.parse(fakeRedis.store.get(key)!.value);
        fakeRedis.store.set(key, {
            value: JSON.stringify({ ...record, expiresAt: new Date(Date.now() - 1000).toISOString() }),
            expiresAtMs: null,
        });
        return (await store.consume('telegram', '43', OWNER)) === null;
    });

    console.log('\n── The way back to the chat ──');

    const saved = { wa: process.env.WA_BOT_NUMBER, tg: process.env.TELEGRAM_BOT_NAME };

    await assert('WhatsApp goes back through wa.me, with no pre-filled text', () => {
        process.env.WA_BOT_NUMBER = '237652705926';
        return conversationUrl('whatsapp') === 'https://wa.me/237652705926';
    });

    await assert('a number written with + and spaces still makes a working link', () => {
        process.env.WA_BOT_NUMBER = '+237 652 705 926';
        return conversationUrl('whatsapp') === 'https://wa.me/237652705926';
    });

    await assert('Telegram goes back through t.me', () => {
        process.env.TELEGRAM_BOT_NAME = '@WiMallBot';
        return conversationUrl('telegram') === 'https://t.me/WiMallBot';
    });

    await assert('⛔ unset means NO link — never a dead button', () => {
        delete process.env.WA_BOT_NUMBER;
        delete process.env.TELEGRAM_BOT_NAME;
        return conversationUrl('whatsapp') === null && conversationUrl('telegram') === null;
    });

    if (saved.wa === undefined) delete process.env.WA_BOT_NUMBER; else process.env.WA_BOT_NUMBER = saved.wa;
    if (saved.tg === undefined) delete process.env.TELEGRAM_BOT_NAME; else process.env.TELEGRAM_BOT_NAME = saved.tg;

    console.log('\n── The screen door pushes to BOTH channels ──');

    const PUSH = bodyOf(PURCHASE, /async function pushIntoConversation\(/);
    const pushesToWhatsApp = (src: string): boolean =>
        src.includes('sendText(')
        && !/if\s*\(\s*channel\s*!==\s*'telegram'\s*\)\s*return\s*;/.test(src)
        && src.includes('telegramBotService.sendMessage(');

    /** ⭐ The defect itself, as the mutant: the early return that made the button do nothing. */
    await guardBites(
        '⛔ the push is not Telegram-only any more — and the guard bites on the old early return',
        pushesToWhatsApp,
        PUSH,
        PUSH.replace('if (channel === \'telegram\') {', 'if (channel !== \'telegram\') return;\n    if (channel === \'telegram\') {'),
    );

    /**
     * ⚠ Best-effort, and it must stay that way: turning a refused send into a 500 would tell a
     * customer their haggle failed when only the notification about it did.
     */
    await assert('the WhatsApp send is best-effort — caught, and never thrown at the page', () =>
        /try\s*\{[\s\S]*sendText\([\s\S]*\}\s*catch/.test(PUSH));

    await assert('the WhatsApp stack is loaded lazily, so an unconfigured provider cannot break the purchase path', () =>
        PUSH.includes("await import('../../whatsapp/services/whatsapp-service-messenger')")
        && !/^import[^\n]*whatsapp-service-messenger/m.test(PURCHASE));

    console.log('\n── The press is handed to the bargainer ──');

    const ACT = bodyOf(PURCHASE, /static screenAct = /);

    /**
     * ⚠ The record must land BEFORE the push. A customer who answers the pushed question fast
     * enough would otherwise reach `/identity/sync` ahead of it and be routed to the assistant.
     */
    await guardBites(
        '⛔ the press is recorded BEFORE the question is pushed — and the guard bites',
        (src) => {
            const recordAt = src.indexOf('pendingBargainStore.record(');
            const pushAt = src.indexOf('await pushIntoConversation(');
            return recordAt !== -1 && pushAt !== -1 && recordAt < pushAt;
        },
        ACT,
        ACT.replace('pendingBargainStore.record(', 'void (').concat('\npendingBargainStore.record('),
    );

    await assert('only a BARGAIN is recorded — a booking has no bargainer to route to', () =>
        /result\.verb === 'bargain'[\s\S]{0,80}pendingBargainStore\.record\(/.test(ACT));

    await assert('the page is told where "Back to chat" goes', () =>
        ACT.includes('chatUrl: conversationUrl(session.channel)'));

    console.log('\n── /identity/sync hands it over, once, and only there ──');

    const SYNC = bodyOf(IDENTITY, /static sync = /);
    const DESCRIBE = bodyOf(IDENTITY, /async function describe\(/);

    await assert('sync consumes the press and returns it as `pendingBargain`', () =>
        SYNC.includes('pendingBargainStore.consume(envelope.channel, envelope.externalId, outcome.account.userId)')
        && SYNC.includes('{ ...dto, pendingBargain }'));

    /**
     * ⛔ `describe` is shared with the onboarding route, which must never spend a hand-off.
     */
    await assert('⛔ never in `describe` — the onboarding route shares it', () =>
        DESCRIBE.length > 0 && !DESCRIBE.includes('pendingBargain'));

    /**
     * ⚠ A turn that goes to onboarding never reaches the bargaining route, so a press consumed
     * there would be lost. It waits for the next sync instead.
     */
    await assert('⛔ withheld while onboarding has a question outstanding', () =>
        /dto\.onboarding\.next\s*\?\s*null\s*:\s*await pendingBargainStore\.consume\(/.test(SYNC));

    await assert('every other projection of the sync answers `pendingBargain: null`', () =>
        /pendingBargain:\s*\{\s*productId: string; variantId: string; quantity: number \}\s*\|\s*null;/.test(PROJECTIONS)
        && /pendingBargain:\s*null,/.test(PROJECTIONS));

    console.log('\n── The page goes back to the chat when nothing can close it ──');

    await assert('with no Telegram runtime, the button becomes "Back to chat" onto `chatUrl`', () =>
        /if \(out\.chatUrl\) \{\s*backTo = out\.chatUrl;\s*el\.act\.textContent = copy\.flowBackToChat;\s*el\.act\.disabled = false;/.test(PAGE));

    await assert('a press after that goes to the chat and posts nothing', () =>
        /el\.act\.addEventListener\("click", function \(\) \{\s*if \(backTo\) \{ window\.location\.assign\(backTo\); return; \}/.test(PAGE));

    await assert('inside Telegram the page still closes, and returns before drawing a way back', () =>
        /if \(tg && tg\.close\) \{[\s\S]{0,120}tg\.close\(\);[\s\S]{0,60}return;\s*\}/.test(PAGE));

    await assert('the question keeps its line break under the button', () =>
        /#note \{ white-space: pre-line; \}/.test(PAGE));

    console.log(
        failed === 0
            ? `\n✅ ${passed} passed, 0 failed`
            : `\n❌ ${passed} passed, ${failed} failed`,
    );
    process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
