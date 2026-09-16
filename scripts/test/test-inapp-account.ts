/**
 * Test: STREAM H — first contact, the account surface, and the private-chat guard.
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no framework).
 * DB-free, network-free.
 *
 * ── ⚠ WHY THIS IS ITS OWN FILE ──────────────────────────────────────────────
 * Several sessions build the bot surface in one working tree with no branching, so two of them
 * appending to one suite is a lost write rather than a merge conflict. `test-bot-surface.ts`
 * and the other `test-inapp-*.ts` suites belong to other streams. **This file is Stream H's
 * alone.**
 *
 * ── SECTIONS ────────────────────────────────────────────────────────────────
 *   § 1  The private-chat guard (`channel-reply.ts`, which Stream H owns this round)
 *   § 2  Atlas phase 1 — first contact
 *   § 3  Atlas phase 9 — the account
 *
 * Run: npm run test:inapp-account
 *      (until that binding lands: npx ts-node scripts/test/test-inapp-account.ts)
 */
import fs from 'fs';
import path from 'path';
import { renderBotReplies, type BotReplyIntent } from '../../src/modules/bot-surface/domain/channel-reply';
import {
    CONFIRMATION_REF_TTL_SECONDS,
    mintConfirmationRef,
    verifyConfirmationRef,
} from '../../src/modules/bot-surface/domain/bot-confirmation-ref';

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

const SRC = path.resolve(__dirname, '../../src');
const read = (relative: string): string => fs.readFileSync(path.join(SRC, relative), 'utf8');
const stripComments = (s: string): string =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

type Markup = { inline_keyboard?: Record<string, unknown>[][]; keyboard?: unknown };

/** The first inline button of a rendered Telegram body. */
function firstInlineButton(body: Record<string, unknown>): Record<string, unknown> {
    return (body.reply_markup as Markup).inline_keyboard![0][0];
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

/** A real-shaped private chat: a user id, which is also that chat's id. */
const PRIVATE = '1804835114';

/**
 * One of each non-private dialog-id range from core.telegram.org/api/bots/ids:
 * a basic group, a supergroup/channel, and a monoforum.
 */
const NOT_PRIVATE = ['-4012345678', '-1001234567890', '-2147483649000'];

const SCREEN = 'https://api.wi-mall.com/api/bot/miniapp/s/pl/ia_x?lang=fr';

const LABELS = { browse: 'Browse', buyNow: 'Buy now', addToCart: 'Add to cart', seeMore: 'See more', details: 'Details' };

const productList = (miniAppUrl: string | null, text = ''): BotReplyIntent => ({
    kind: 'product_list',
    text,
    browsePrompt: 'Here is what I found.',
    cards: [],
    miniAppUrl,
    hasMore: false,
    labels: LABELS,
});

/** Every intent kind, including both halves of each degradation. Extend when an intent is added. */
const EVERY_INTENT: readonly BotReplyIntent[] = [
    { kind: 'text', text: 'hello' },
    { kind: 'text', text: 'Your email?', actions: [{ id: 'skip:email', label: 'Skip' }] },
    { kind: 'contact_request', text: 'Share your number', buttonLabel: 'Share my number' },
    { kind: 'location_request', text: 'Send a pin', buttonLabel: 'Send location', skipLabel: 'Skip' },
    { kind: 'location_request', text: 'Send a pin', buttonLabel: 'Send location' },
    {
        kind: 'choice',
        text: 'Which one?',
        options: [{ id: 'gc_a', label: 'Akwa' }, { id: 'gc_b', label: 'Bonapriso' }],
        listButton: 'Choose',
        sectionTitle: 'Addresses',
    },
    { kind: 'link', text: 'Pay here', label: 'Pay', url: 'https://pay.test/x' },
    { kind: 'inapp', text: 'Here they are', label: 'See all', url: SCREEN },
    { kind: 'inapp', text: 'Here they are', label: 'See all', url: 'http://localhost:8022/s/pl/x' },
    productList(SCREEN),
    productList(SCREEN, 'Five of them.'),
    productList(null),
];

/** The three controls the Bot API documents as "available in private chats only". */
const PRIVATE_ONLY_CONTROLS = ['"web_app"', '"request_contact"', '"request_location"'];

function main(): void {
    console.log('\n══ § 1 · The private-chat guard ══');

    console.log('\n── Outside a private chat, no private-only control is ever drawn ──');

    /**
     * ⭐ **The whole guard in one assertion.** Telegram refuses a message carrying any of these
     * controls outside a one-to-one chat, and refuses it WHOLE — the sentence goes with the
     * button. So this sweeps every intent, on every non-private id range, and inspects the
     * serialised bodies rather than one field, which is what catches a control added later in
     * some other corner of the markup.
     */
    assert('⛔ no web_app / request_contact / request_location reaches a group, supergroup, channel or monoforum', () =>
        NOT_PRIVATE.every((chat) =>
            EVERY_INTENT.every((intent) =>
                renderBotReplies(intent, 'telegram', chat).every((reply) => {
                    const json = JSON.stringify(reply.body);
                    return PRIVATE_ONLY_CONTROLS.every((control) => !json.includes(control));
                }),
            ),
        ));

    assert('⚠ the degraded turn still ARRIVES — every body keeps its sentence', () =>
        NOT_PRIVATE.every((chat) =>
            EVERY_INTENT.every((intent) =>
                renderBotReplies(intent, 'telegram', chat).every((reply) => {
                    const body = reply.body as { text?: string; caption?: string };
                    return (body.text ?? body.caption ?? '').length > 0 && (reply.body as { chat_id: string }).chat_id === chat;
                }),
            ),
        ));

    assert('⚠ a chat type never changes HOW MANY messages a turn is', () =>
        NOT_PRIVATE.every((chat) =>
            EVERY_INTENT.every((intent) =>
                renderBotReplies(intent, 'telegram', chat).length === renderBotReplies(intent, 'telegram', PRIVATE).length,
            ),
        ));

    console.log('\n── The screen door degrades to a plain link, to the SAME address ──');

    assert('inapp in a group → a url button to the same screen, not web_app', () => {
        const [reply] = renderBotReplies({ kind: 'inapp', text: 'Here they are', label: 'See all', url: SCREEN }, 'telegram', NOT_PRIVATE[0]);
        const button = firstInlineButton(reply.body);
        return button.url === SCREEN && button.web_app === undefined && button.text === 'See all';
    });

    /**
     * The screens are built to run with no Telegram runtime, so the link is a working door and
     * not a dead end. Pinned here because the whole degradation rests on it: a page that threw
     * without `Telegram.WebApp` would make this fallback a blank screen.
     */
    assert('⚠ …and that link is a real door: every screen page guards its Telegram runtime', () => {
        const dir = path.join(SRC, 'modules/bot-surface/miniapp/public');
        const pages = fs.readdirSync(dir).filter((f) => f.endsWith('.html'));
        return pages.length > 0
            && pages.every((page) => {
                const html = fs.readFileSync(path.join(dir, page), 'utf8');
                return !html.includes('Telegram.WebApp') || html.includes('(window.Telegram && window.Telegram.WebApp) || null');
            });
    });

    assert('product list with a screen, in a supergroup → ONE message, Browse as a url button', () => {
        const replies = renderBotReplies(productList(SCREEN), 'telegram', NOT_PRIVATE[1]);
        const button = firstInlineButton(replies[0].body);
        return replies.length === 1
            && replies[0].method === 'sendMessage'
            && (replies[0].body as { text: string }).text === 'Here is what I found.'
            && button.url === SCREEN
            && button.web_app === undefined;
    });

    assert('⚠ the product-list door now re-checks HTTPS too (it used to trust the caller)', () => {
        const [reply] = renderBotReplies(productList('http://localhost:8022/s/pl/x'), 'telegram', PRIVATE);
        return firstInlineButton(reply.body).web_app === undefined;
    });

    console.log('\n── The phone and location keyboards drop to the sentence ──');

    assert('contact_request in a group → the sentence, no keyboard button', () => {
        const [reply] = renderBotReplies(
            { kind: 'contact_request', text: 'Share your number', buttonLabel: 'Share my number' },
            'telegram',
            NOT_PRIVATE[0],
        );
        const body = reply.body as { text: string; reply_markup: Record<string, unknown> };
        return body.text === 'Share your number' && body.reply_markup.keyboard === undefined;
    });

    assert('location_request with Skip in a channel-range chat → the sentence, no keyboard', () => {
        const [reply] = renderBotReplies(
            { kind: 'location_request', text: 'Send a pin', buttonLabel: 'Send location', skipLabel: 'Skip' },
            'telegram',
            NOT_PRIVATE[1],
        );
        const body = reply.body as { text: string; reply_markup: Record<string, unknown> };
        return body.text === 'Send a pin' && body.reply_markup.keyboard === undefined;
    });

    console.log('\n── A private chat is untouched ──');

    assert('private chat: inapp is still web_app', () => {
        const [reply] = renderBotReplies({ kind: 'inapp', text: 't', label: 'Open', url: SCREEN }, 'telegram', PRIVATE);
        const button = firstInlineButton(reply.body);
        return (button.web_app as { url: string } | undefined)?.url === SCREEN && button.url === undefined;
    });

    assert('private chat: the product-list door is still web_app', () => {
        const [reply] = renderBotReplies(productList(SCREEN), 'telegram', PRIVATE);
        return firstInlineButton(reply.body).web_app !== undefined;
    });

    assert('private chat: the phone and location keyboards are still drawn', () => {
        const contact = JSON.stringify(
            renderBotReplies({ kind: 'contact_request', text: 's', buttonLabel: 'Share' }, 'telegram', PRIVATE)[0].body,
        );
        const location = JSON.stringify(
            renderBotReplies({ kind: 'location_request', text: 's', buttonLabel: 'Send', skipLabel: 'Skip' }, 'telegram', PRIVATE)[0].body,
        );
        return contact.includes('"request_contact":true') && location.includes('"request_location":true') && location.includes('"Skip"');
    });

    assert('WhatsApp is unaffected by any of it (it has no chat type to guard)', () => {
        const intent: BotReplyIntent = { kind: 'inapp', text: 'Here they are', label: 'See all', url: SCREEN };
        const [reply] = renderBotReplies(intent, 'whatsapp', '237699000771');
        return (reply.body.interactive as { type: string }).type === 'cta_url';
    });

    console.log('\n── Anything that is not a plain positive integer counts as NOT private ──');

    assert('0, a @username, a padded or a malformed id → no web_app', () =>
        ['0', '@wimall_channel', ' 1804835114', '1804835114a', '+1804835114', ''].every((chat) => {
            const [reply] = renderBotReplies({ kind: 'inapp', text: 't', label: 'Open', url: SCREEN }, 'telegram', chat);
            return firstInlineButton(reply.body).web_app === undefined;
        }));

    console.log('\n── Structure: one door, and no Business-account sends ──');

    const renderer = stripComments(read('modules/bot-surface/domain/channel-reply.ts'));

    /**
     * ⚠ **One `web_app` site, and it is the guarded helper.** The sweep above covers every
     * intent that exists; this covers the one somebody adds next, by refusing a second place
     * that writes the key without going through `telegramScreenButton`.
     */
    assert('⛔ channel-reply.ts writes `web_app:` in exactly ONE place (telegramScreenButton)', () => {
        const sites = renderer.match(/\bweb_app\s*:/g) ?? [];
        const helper = renderer.slice(renderer.indexOf('function telegramScreenButton('));
        return sites.length === 1 && /\bweb_app\s*:/.test(helper.slice(0, helper.indexOf('\n}')));
    });

    /**
     * ⚠ **The Business-account half of the restriction is unreachable by construction, and this
     * is the construction.** `web_app` is unsupported on a message sent *on behalf of* a Telegram
     * Business account, which on the wire means a `business_connection_id` in the body. The
     * renderer has no chat-type signal for that case — a business chat is private — so the guard
     * rests on never writing the field.
     */
    assert('⛔ the renderer never sends on behalf of a Telegram Business account', () =>
        !renderer.includes('business_connection_id'));

    console.log('\n══ § 2 · Atlas phase 1 — first contact ══');
    console.log('  (not built yet)\n');

    console.log('\n══ § 3 · Atlas phase 9 — the account ══');

    console.log('\n── The confirmation reference: what makes an old Confirm button harmless ──');

    const SECRET = 'test-secret-that-is-long-enough-0123456789';
    const OTHER_SECRET = 'a-different-secret-entirely-9876543210';
    const T0 = Date.UTC(2026, 8, 16, 12, 0, 0);
    const ME = { userId: '66f0a1b2c3d4e5f601234567', channel: 'telegram' };
    const ref = mintConfirmationRef('close', ME, '', T0, SECRET);
    const verify = (r: string, over: Partial<{ purpose: 'close' | 'unlink'; subject: typeof ME; scope: string; now: number; secret: string }> = {}) =>
        verifyConfirmationRef(r, over.purpose ?? 'close', over.subject ?? ME, over.scope ?? '', over.now ?? T0 + 1000, over.secret ?? SECRET);

    assert('a fresh reference, for the same account, channel and purpose → valid', () => verify(ref) === 'valid');

    assert('⛔ another account → invalid', () =>
        verify(ref, { subject: { ...ME, userId: '66f0a1b2c3d4e5f601234568' } }) === 'invalid');

    assert('⛔ the same account from the OTHER app → invalid', () =>
        verify(ref, { subject: { ...ME, channel: 'whatsapp' } }) === 'invalid');

    assert('⛔ a close reference presented on an unlink confirm → invalid (one key per purpose)', () =>
        verify(ref, { purpose: 'unlink' }) === 'invalid');

    assert('⛔ an unlink reference for Telegram presented for WhatsApp → invalid (the scope is bound)', () => {
        const unlinkTelegram = mintConfirmationRef('unlink', ME, 'telegram', T0, SECRET);
        return verifyConfirmationRef(unlinkTelegram, 'unlink', ME, 'telegram', T0 + 1000, SECRET) === 'valid'
            && verifyConfirmationRef(unlinkTelegram, 'unlink', ME, 'whatsapp', T0 + 1000, SECRET) === 'invalid';
    });

    assert('⛔ minted under a different secret → invalid', () => verify(ref, { secret: OTHER_SECRET }) === 'invalid');

    assert('⛔ expired → "expired", checked BEFORE the MAC (a tampered expired ref still reads expired)', () => {
        const later = T0 + (CONFIRMATION_REF_TTL_SECONDS + 1) * 1000;
        const tampered = `${ref.slice(0, -1)}${ref.endsWith('A') ? 'B' : 'A'}`;
        return verify(ref, { now: later }) === 'expired' && verify(tampered, { now: later }) === 'expired';
    });

    assert('still valid one second before expiry, expired at it', () =>
        verify(ref, { now: T0 + (CONFIRMATION_REF_TTL_SECONDS - 1) * 1000 }) === 'valid'
        && verify(ref, { now: T0 + CONFIRMATION_REF_TTL_SECONDS * 1000 }) === 'expired');

    /**
     * Every single-character change to the MAC must be refused — not one sample position. A
     * comparison that only looked at a prefix, or a decoder that tolerated a stray character,
     * passes a one-position test and fails this one.
     */
    assert('⛔ flipping ANY one character of the MAC → invalid', () => {
        const [exp, mac] = ref.split('.');
        return [...mac].every((ch, i) => {
            const swapped = ch === 'A' ? 'B' : 'A';
            return verify(`${exp}.${mac.slice(0, i)}${swapped}${mac.slice(i + 1)}`) === 'invalid';
        });
    });

    /**
     * The last of 22 base64url characters carries four bits nobody reads, so the same MAC has
     * sixteen spellings. Deterministic, unlike the flip above: it builds the other spellings
     * from whatever the last character is, so it bites on every run and not one run in four.
     */
    assert('⛔ a NON-CANONICAL spelling of the correct MAC → invalid', () => {
        const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
        const [exp, mac] = ref.split('.');
        const last = ALPHABET.indexOf(mac[mac.length - 1]);
        const spellings = Array.from({ length: 15 }, (_, i) => ALPHABET[(last & 0b110000) | (i + 1)]);
        return spellings.every((ch) => verify(`${exp}.${mac.slice(0, -1)}${ch}`) === 'invalid');
    });

    assert('⛔ a forged expiry with the original MAC → invalid', () => {
        const [exp, mac] = ref.split('.');
        const oneMore = (parseInt(exp, 36) - 60).toString(36);
        return verify(`${oneMore}.${mac}`) === 'invalid';
    });

    assert('⛔ an expiry further ahead than this service ever mints → invalid', () => {
        const [, mac] = ref.split('.');
        const farFuture = (Math.floor(T0 / 1000) + 365 * 24 * 3600).toString(36);
        return verify(`${farFuture}.${mac}`) === 'invalid';
    });

    assert('malformed references → invalid, never a throw', () =>
        ['', '.', 'abc', `${ref}x`, ref.replace('.', ':'), `${ref.split('.')[0]}.`, 'zzzzzzzzzzz.AAAAAAAAAAAAAAAAAAAAAA', `${ref.split('.')[0]}.${'A'.repeat(21)}=`]
            .every((bad) => verify(bad) === 'invalid'));

    assert('the reference carries no ":" and both confirm tokens fit Telegram\'s 64 bytes', () => {
        const unlink = mintConfirmationRef('unlink', ME, 'whatsapp', T0, SECRET);
        return !ref.includes(':')
            && Buffer.byteLength(`yes:close:${ref}`, 'utf8') <= 64
            && Buffer.byteLength(`yes:unlink:whatsapp:${unlink}`, 'utf8') <= 64;
    });

    const confirmRef = stripComments(read('modules/bot-surface/domain/bot-confirmation-ref.ts'));

    assert('⛔ the MAC is compared with timingSafeEqual, and the raw secret is never the HMAC key', () =>
        confirmRef.includes('timingSafeEqual(presented, expected)')
        && /hkdfSync\([^)]*\$\{purpose\}/.test(confirmRef)
        && !/createHmac\(\s*'sha256'\s*,\s*secret\b/.test(confirmRef));

    console.log(
        failed === 0
            ? `\n✅ ${passed} passed, 0 failed`
            : `\n❌ ${passed} passed, ${failed} failed`,
    );
    process.exit(failed === 0 ? 0 : 1);
}

main();
