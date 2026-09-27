/**
 * Test: the website's Bargain button opens a haggle in the chat — `/bargain <p> <v>` on WhatsApp,
 * `/start bargain_<p>_<v>` on Telegram.
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no framework).
 * DB-free: the grammar is pure, the store runs against a fake Redis, and the controllers and the
 * service are read as TEXT — importing them reaches `catalog/` and `orders/`, which hang bare
 * `ts-node` at import with no output at all (the reason `test:screen-bargain` reads them as text).
 *
 * ── WHAT IS BEING PROMISED TO THE STOREFRONT ────────────────────────────────
 *   1. Both spellings parse to the same ids, through the parser the router already uses.
 *   2. The Telegram payload fits Telegram's 64-character, no-colon rule.
 *   3. A customer mid-setup keeps the product; the price question follows setup.
 *   4. A Telegram chat with no account keeps it through the identity refusal.
 *   5. A product that became fixed-price is OFFERED, never added to the basket.
 *
 * Run: npm run test:bargain-entry
 */
import fs from 'fs';
import path from 'path';

import * as redisFactory from '../../src/infra/redis/redis.factory';
import {
    BARGAIN_START_PREFIX,
    TELEGRAM_START_PAYLOAD_MAX,
    bargainEntryFromText,
    bargainEntryIdsAreValid,
    bargainStartPayload,
    parseBargainStartPayload,
} from '../../src/modules/bot-commands/domain/bargain-entry';
import { COMMANDS, LIVE_COMMANDS } from '../../src/modules/bot-commands/domain/command-registry';
import { PendingBargainStore, readPendingBargain } from '../../src/modules/bot-surface/services/pending-bargain.store';
import { onboardingReplyIntent } from '../../src/modules/bot-surface/domain/onboarding-reply';
import { botChrome } from '../../src/modules/bot-surface/domain/bot-chrome-copy';

interface FakeEntry { value: string; expiresAtMs: number | null }

/** Real expiry, a real GET, a real GET-then-DEL for the consume script, and DEL. */
class FakeRedis {
    readonly store = new Map<string, FakeEntry>();

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
        return 'OK';
    }

    async get(key: string): Promise<string | null> {
        return this.live(key)?.value ?? null;
    }

    async del(key: string): Promise<number> {
        return this.store.delete(key) ? 1 : 0;
    }

    async eval(_script: string, options: { keys: string[] }): Promise<string | null> {
        const entry = this.live(options.keys[0]);
        if (!entry) return null;
        this.store.delete(options.keys[0]);
        return entry.value;
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

/** A source-scan guard seen to BITE: the real source passes and the named mutant fails. */
async function guardBites(name: string, check: (src: string) => boolean, src: string, mutant: string): Promise<void> {
    await assert(name, () => {
        const real = check(src);
        const bitten = !check(mutant);
        if (!real) console.error('      the real source fails the check');
        if (!bitten) console.error('      the mutant passes — the guard does not bite');
        return real && bitten;
    });
}

function section(title: string): void {
    console.log(`\n▶ ${title}`);
}

const ROOT = path.resolve(__dirname, '..', '..');

/** Comments stripped and line endings normalised, so prose cannot satisfy a code check. */
const code = (rel: string): string =>
    fs.readFileSync(path.join(ROOT, rel), 'utf8')
        .replace(/\r\n/g, '\n')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');

const P = '64f1a2b3c4d5e6f7a8b9c0d1';
const V = '65a1b2c3d4e5f6a7b8c9d0e1';

async function main(): Promise<void> {
    // ═════════════════════════════════════════════════════════════════════════
    section('1 · The two spellings, through the router\'s own parser');

    await assert('WhatsApp: `/bargain <p> <v>` → both ids', () => {
        const ids = bargainEntryFromText(`/bargain ${P} ${V}`);
        return ids?.productId === P && ids.variantId === V;
    });

    await assert('WhatsApp: a localised sentence after the ids is ignored — on the same line and on the next', () => {
        const a = bargainEntryFromText(`/bargain ${P} ${V} Je voudrais négocier le prix`);
        const b = bargainEntryFromText(`/bargain ${P} ${V}\nأود التفاوض على السعر`);
        return a?.productId === P && a.variantId === V && b?.productId === P && b.variantId === V;
    });

    await assert('WhatsApp: the product alone → variant null (the default variant)', () => {
        const ids = bargainEntryFromText(`/bargain ${P}`);
        return ids?.productId === P && ids.variantId === null;
    });

    await assert('Telegram: `/start bargain_<p>_<v>` → the same ids', () => {
        const ids = bargainEntryFromText(`/start ${BARGAIN_START_PREFIX}${P}_${V}`);
        return ids?.productId === P && ids.variantId === V;
    });

    await assert('Telegram: `/start@WiMallBot bargain_…` (group-chat suffix) still parses', () =>
        bargainEntryFromText(`/start@WiMallBot bargain_${P}_${V}`)?.variantId === V);

    await assert('plain `/start` and `/start other` are NOT a bargain — the welcome stays the welcome', () =>
        bargainEntryFromText('/start') === null && bargainEntryFromText('/start ref_abc') === null);

    await assert('ordinary text and other commands are NOT a bargain', () =>
        bargainEntryFromText('I want to bargain') === null
        && bargainEntryFromText('/help') === null
        && bargainEntryFromText(`/add ${P}`) === null);

    await assert('⚠ an EDITED id still reaches the handler as a bargain request (refused in words, not ignored)', () => {
        const ids = bargainEntryFromText('/bargain 64f1a2b3 nope');
        return ids !== null && !bargainEntryIdsAreValid(ids);
    });

    await assert('⚠ a `bargain_` payload with a third segment is carried as an UNREADABLE variant', () => {
        const ids = parseBargainStartPayload(`bargain_${P}_${V}_extra`);
        return ids !== null && !bargainEntryIdsAreValid(ids);
    });

    await assert('valid ids pass the one validity test; uppercase hex is an id too', () =>
        bargainEntryIdsAreValid({ productId: P, variantId: V })
        && bargainEntryIdsAreValid({ productId: P.toUpperCase(), variantId: null })
        && !bargainEntryIdsAreValid({ productId: '', variantId: null }));

    // ═════════════════════════════════════════════════════════════════════════
    section('2 · Telegram\'s payload rule — at most 64 characters of [A-Za-z0-9_-], no colon');

    await assert(`the full payload is 57 characters, under the cap of ${TELEGRAM_START_PAYLOAD_MAX}`, () =>
        bargainStartPayload(P, V).length === 57);

    await assert('it uses only Telegram\'s alphabet — no colon, no space', () =>
        /^[A-Za-z0-9_-]+$/.test(bargainStartPayload(P, V)) && /^[A-Za-z0-9_-]+$/.test(bargainStartPayload(P)));

    await assert('the builder and the parser round-trip', () => {
        const ids = parseBargainStartPayload(bargainStartPayload(P, V));
        const bare = parseBargainStartPayload(bargainStartPayload(P));
        return ids?.productId === P && ids.variantId === V && bare?.productId === P && bare.variantId === null;
    });

    await assert('the builder refuses an id that is not one', () => {
        try {
            bargainStartPayload('nope', V);
            return false;
        } catch {
            return true;
        }
    });

    // ═════════════════════════════════════════════════════════════════════════
    section('3 · The registry — live, unlisted, and one word');

    await assert('/bargain has a handler, no aliases, and is not advertised', () => {
        const spec = COMMANDS.find((c) => c.name === 'bargain');
        return spec?.handler === 'bargain' && spec.aliases.length === 0 && spec.advertised === false;
    });

    await assert('/bargain is absent from the list /help and the Telegram menu are built from', () =>
        !LIVE_COMMANDS.some((c) => c.name === 'bargain') && LIVE_COMMANDS.some((c) => c.name === 'start'));

    await assert('/start declares an optional `payload` and nothing else', () => {
        const start = COMMANDS.find((c) => c.name === 'start');
        return start?.args.length === 1 && start.args[0].name === 'payload' && !start.args[0].required;
    });

    await assert('commands.json mirrors both rows', () => {
        const doc = JSON.parse(fs.readFileSync(path.join(ROOT, 'api-doc/n8n/tools/commands.json'), 'utf8'));
        const bargain = doc.commands.find((c: { name: string }) => c.name === 'bargain');
        const start = doc.commands.find((c: { name: string }) => c.name === 'start');
        return bargain?.advertised === false && start?.args?.[0]?.name === 'payload';
    });

    // ═════════════════════════════════════════════════════════════════════════
    section('4 · The hand-off store — a held link with no owner yet, peek, discard');

    const store = new PendingBargainStore();

    await assert('a link held with NO owner is taken by whichever account the chat resolves to', async () => {
        await store.record({ owner: null, channel: 'telegram', externalId: 'chat-1' }, { productId: P, variantId: V });
        const got = await store.consume('telegram', 'chat-1', 'user-A');
        return got?.productId === P && got.variantId === V;
    });

    await assert('an OWNED link is still refused to another account', async () => {
        await store.record({ owner: 'user-A', channel: 'whatsapp', externalId: '2376' }, { productId: P, variantId: V });
        return (await store.consume('whatsapp', '2376', 'user-B')) === null;
    });

    await assert('peek does NOT spend — the next sync still receives it, once', async () => {
        await store.record({ owner: 'user-A', channel: 'whatsapp', externalId: '2377' }, { productId: P, variantId: V });
        const a = await store.peek('whatsapp', '2377', 'user-A');
        const b = await store.consume('whatsapp', '2377', 'user-A');
        const c = await store.consume('whatsapp', '2377', 'user-A');
        return a?.variantId === V && b?.variantId === V && c === null;
    });

    await assert('discard drops it', async () => {
        await store.record({ owner: 'user-A', channel: 'whatsapp', externalId: '2378' }, { productId: P, variantId: V });
        await store.discard('whatsapp', '2378');
        return (await store.peek('whatsapp', '2378', 'user-A')) === null;
    });

    await assert('peek and consume share ONE reading: lapsed and incomplete entries are absent to both', () => {
        const future = new Date(Date.now() + 60_000).toISOString();
        const past = new Date(Date.now() - 1).toISOString();
        const lapsed = JSON.stringify({ owner: null, productId: P, variantId: V, quantity: 1, expiresAt: past });
        const noVariant = JSON.stringify({ owner: null, productId: P, variantId: '', quantity: 1, expiresAt: future });
        return readPendingBargain(lapsed, 'u', Date.now()) === null && readPendingBargain(noVariant, 'u', Date.now()) === null;
    });

    // ═════════════════════════════════════════════════════════════════════════
    section('5 · Mid-setup — the setup question keeps its own control');

    await assert('the extracted renderer draws the same Skip button the sync always drew', () => {
        const intent = onboardingReplyIntent(
            { step: 'email', required: false, skippable: true, prompt: 'Your email?' } as never,
            'fr',
        );
        if (intent?.kind !== 'text') return false;
        const actions = intent.actions ?? [];
        return actions.length === 1 && actions[0].label === botChrome('skipButton', 'fr') && actions[0].id === 'skip:email';
    });

    await assert('a finished checklist renders NOTHING', () => onboardingReplyIntent(null, 'en') === null);

    await assert('the three new sentences exist in all five languages and differ from English', () =>
        (['bargainAfterSetupPrompt', 'bargainFixedPricePrompt', 'bargainBookInsteadPrompt'] as const).every((key) =>
            ['en', 'fr', 'pt', 'es', 'ar'].every((lang) => botChrome(key, lang).length > 0)
            && botChrome(key, 'fr') !== botChrome(key, 'en')));

    // ═════════════════════════════════════════════════════════════════════════
    section('6 · Source scans — the wiring nothing behavioural here can reach');

    const SERVICE = code('src/modules/bot-surface/services/bargain-entry.service.ts');
    const COMMAND = code('src/modules/bot-surface/controllers/bot-command.controller.ts');
    const IDENTITY = code('src/modules/bot-surface/controllers/bot-identity.controller.ts');
    const ROUTES = code('src/modules/bot-surface/bot.routes.ts');
    const HOLD = code('src/modules/bot-surface/middlewares/bargain-entry-hold.middleware.ts');
    const ROUTER = code('src/modules/bot-commands/services/command-router.service.ts');

    await guardBites(
        '⛔ a fixed-price product is OFFERED: the service never writes a cart',
        (src) => !/executePurchase|addToCart\(|cartService/.test(src),
        SERVICE,
        `${SERVICE}\nawait cartService.addToCart(customerId, productId, variantId, 1);`,
    );

    await guardBites(
        'the press is recorded BEFORE the price question is returned',
        (src) => {
            const begin = src.slice(src.indexOf('export async function beginBargainFromLink'));
            const record = begin.indexOf('pendingBargainStore.record(');
            const invite = begin.indexOf('bargainInviteIntent(verdict.productTitle');
            return record !== -1 && invite !== -1 && record < invite;
        },
        SERVICE,
        SERVICE.replace('pendingBargainStore.record(', 'void (').concat('\npendingBargainStore.record('),
    );

    await guardBites(
        'the command controller hands a `bargain` outcome to the service',
        (src) => /outcome\.kind === 'bargain'[\s\S]{0,200}beginBargainFromLink\(/.test(src),
        COMMAND,
        COMMAND.replace(/outcome\.kind === 'bargain'/, "outcome.kind === 'bargin'"),
    );

    await guardBites(
        'the router turns a `bargain_` start payload into a bargain, before the welcome',
        (src) => /parseBargainStartPayload\(args\.payload\)[\s\S]{0,160}kind: 'bargain'/.test(src),
        ROUTER,
        ROUTER.replace('parseBargainStartPayload(args.payload)', 'null'),
    );

    await guardBites(
        'BOTH setup-completing turns go through setCompletionReply — never the bare welcome',
        (src) => (src.match(/await setCompletionReply\(/g) ?? []).length === 2
            // CALLS only (`req,`) — the definition reads `setWelcomeReply(req: Request`.
            && (src.match(/setWelcomeReply\(req,/g) ?? []).length === 1,
        IDENTITY,
        IDENTITY.replace(/await setCompletionReply\(/, 'setWelcomeReply(req, null); void (async () => {})(); (('),
    );

    await guardBites(
        'the setup-completing reply only PEEKS — the next sync spends the hand-off',
        (src) => {
            const held = src.slice(src.indexOf('export async function replyForHeldBargain'), src.indexOf('export async function holdForUnregisteredSender'));
            return held.includes('pendingBargainStore.peek(') && !held.includes('pendingBargainStore.consume(');
        },
        SERVICE,
        SERVICE.replace('pendingBargainStore.peek(conversation.channel', 'pendingBargainStore.consume(conversation.channel'),
    );

    await guardBites(
        'the no-account hold is an ERROR handler mounted AFTER the routes',
        (src) => {
            const loop = src.indexOf('for (const route of BOT_ROUTES)');
            const hold = src.indexOf('router.use(holdBargainEntryForUnregisteredSender)');
            return loop !== -1 && hold > loop;
        },
        ROUTES,
        ROUTES.replace('router.use(holdBargainEntryForUnregisteredSender);', '').replace(
            'router.use(requireBotIdentity);',
            'router.use(holdBargainEntryForUnregisteredSender);\nrouter.use(requireBotIdentity);',
        ),
    );

    await guardBites(
        '⛔ the hold passes the SAME error on — the customer\'s refusal is unchanged',
        (src) => (src.match(/next\(error\)/g) ?? []).length === 3 && !/res\.(json|status|send)/.test(src),
        HOLD,
        HOLD.replace('.finally(() => next(error))', '.finally(() => _res.status(200).json({}))'),
    );

    await guardBites(
        'the hold records only for the two "no account yet" refusals on /command',
        (src) => src.includes('BOT_IDENTITY_NEEDS_CONTACT') && src.includes("req.path === '/command'"),
        HOLD,
        HOLD.replace("req.path === '/command'", 'true'),
    );

    console.log(`\n${'─'.repeat(72)}\n  ${passed} passed, ${failed} failed\n${'─'.repeat(72)}`);
    process.exit(failed === 0 ? 0 : 1);
}

void main();
