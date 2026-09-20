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
    type BotConfirmationPurpose,
} from '../../src/modules/bot-surface/domain/bot-confirmation-ref';
import {
    applyOnboardingStep,
    BOT_ONBOARDING_STEP_VALUES,
    isOnboardingComplete,
    nextOnboardingStep,
    onboardingChanged,
    seedOnboarding,
    type BotOnboardingRecord,
} from '../../src/modules/bot-surface/domain/bot-onboarding';
import {
    CONTACT_RESEND_COOLDOWN_SECONDS,
    resendWaitSeconds,
} from '../../src/modules/bot-surface/domain/bot-resend-cooldown';
import {
    composeSignInMessage,
    SignInMessageError,
} from '../../src/modules/bot-surface/domain/bot-signin-message';

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

    console.log('\n── A Skip button stays tappable forever, and must not rewrite an answer ──');

    /**
     * ⚠ **THE SITUATION, BECAUSE IT READS LIKE AN EDGE CASE AND IS NOT ONE.** The bot asks
     * for an email and draws [Skip]. The customer ignores the button and types their address
     * instead; the step is recorded `provided`. The Skip is still sitting in the thread —
     * a chat keeps its whole history, and nothing expires a button — and days later they
     * scroll up and tap it.
     *
     * Before the fix the write was unconditional, so that tap re-recorded an ANSWERED step as
     * declined. `skipped` means "never ask again", so the address stayed on the profile while
     * the checklist stopped accounting for it — and on a REQUIRED step the same overwrite
     * un-completes a finished account, because `isOnboardingComplete` demands `provided`
     * there, not merely "not pending".
     */
    const JAN = new Date('2026-01-05T09:00:00Z');
    const MAR = new Date('2026-03-02T14:30:00Z');
    const LATER = new Date('2026-03-02T14:35:00Z');

    /** A WhatsApp account: the sender id IS the number, so `phone` is satisfied at creation. */
    const seeded = seedOnboarding(['phone'], JAN);
    const stateOf = (rows: readonly BotOnboardingRecord[], step: string) =>
        rows.find((r) => r.step === step)!;

    const answeredEmail = applyOnboardingStep(seeded, 'email', 'provided', MAR);
    const staleSkip = applyOnboardingStep(answeredEmail, 'email', 'skipped', LATER);

    assert('⛔ a Skip tapped after the answer leaves the email PROVIDED, at its original time', () =>
        stateOf(staleSkip, 'email').state === 'provided'
        && stateOf(staleSkip, 'email').at!.getTime() === MAR.getTime());

    assert('⛔ a stale Skip cannot un-complete a finished account (the REQUIRED-step case)', () => {
        const done = ['name', 'email', 'address'].reduce(
            (rows, step) => applyOnboardingStep(rows, step as typeof BOT_ONBOARDING_STEP_VALUES[number], 'provided', JAN),
            seeded,
        );
        if (!isOnboardingComplete(done)) return false;
        return isOnboardingComplete(applyOnboardingStep(done, 'name', 'skipped', LATER));
    });

    assert('⛔ a second Skip keeps the date of the FIRST refusal, so "when did they decline" survives', () => {
        const declined = applyOnboardingStep(seeded, 'email', 'skipped', JAN);
        const again = applyOnboardingStep(declined, 'email', 'skipped', LATER);
        return stateOf(again, 'email').state === 'skipped'
            && stateOf(again, 'email').at!.getTime() === JAN.getTime();
    });

    /** The guard must not cost the ordinary path: a genuine first Skip still records. */
    assert('a Skip on a step that IS pending still records, and the ask moves on', () => {
        const skipped = applyOnboardingStep(
            applyOnboardingStep(seeded, 'name', 'provided', MAR), 'email', 'skipped', MAR,
        );
        return stateOf(skipped, 'email').state === 'skipped'
            && stateOf(skipped, 'email').at!.getTime() === MAR.getTime()
            && nextOnboardingStep(skipped)?.step === 'address';
    });

    /**
     * The asymmetry is the rule, not an oversight: a LATER answer may always replace an
     * earlier refusal (a person who declined an email in January owns that field in March),
     * while a stale refusal may never replace an answer.
     */
    assert('providing after a skip is still allowed — only the reverse is refused', () => {
        const declined = applyOnboardingStep(seeded, 'email', 'skipped', JAN);
        const answered = applyOnboardingStep(declined, 'email', 'provided', MAR);
        return stateOf(answered, 'email').state === 'provided'
            && stateOf(answered, 'email').at!.getTime() === MAR.getTime();
    });

    assert('onboardingChanged tells a real skip from a stale one, so a no-op need not be written', () =>
        onboardingChanged(seeded, applyOnboardingStep(seeded, 'email', 'skipped', MAR))
        && !onboardingChanged(answeredEmail, staleSkip));

    /**
     * ⚠ **Span, stated because a scan that cannot say what it read is the recurring defect
     * here**: the text between `async applyStep(` and this method's `switch (step) {` — i.e.
     * the skip branch alone, never the whole file, which mentions `persistOnboarding` in four
     * other places. Both boundary markers are asserted present first, so a rename cannot
     * leave this vacuously green.
     */
    const registration = read('modules/bot-surface/services/bot-registration.service.ts');
    const from = registration.indexOf('async applyStep(');
    const to = registration.indexOf('switch (step) {', from);
    const skipBranch = from >= 0 && to > from ? registration.slice(from, to) : '';

    assert('the scan found applyStep\'s skip branch (markers present, region non-empty)', () =>
        skipBranch.length > 0 && skipBranch.includes("action === 'skip'"));

    assert('⛔ the service returns the customer UNWRITTEN when the skip changes nothing', () =>
        /if\s*\(!onboardingChanged\([^)]*\)\)\s*return customer;/.test(stripComments(skipBranch))
        && stripComments(skipBranch).indexOf('onboardingChanged')
            < stripComments(skipBranch).indexOf('persistOnboarding'));

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

    /**
     * Known answers, one per purpose, taken from the construction as committed in `6b2a47d`.
     * ⚠ **These are the property that a button already sitting in a customer's chat still works
     * after a deploy.** A change to the salt, the field order, the separator or the encoding
     * changes every MAC, and every Confirm button in flight answers "expired or invalid" for ten
     * minutes. If that is ever intended, it is a new construction: bump `v1` and replace these.
     */
    assert('⛔ each purpose mints exactly the committed known answer (the construction has not drifted)', () => {
        const KNOWN: [BotConfirmationPurpose, string, string][] = [
            ['close', '', 'tlghso.XX2IAmoVBrtteslEJULGkg'],
            ['unlink', 'whatsapp', 'tlghso.HAPBhITMVGDRwUS7mx4FDg'],
            ['cancel', '66f0a1b2c3d4e5f60123abcd', 'tlghso.KXKH8As18gmxouYWJ_2cug'],
            ['ticket-close', '66f0a1b2c3d4e5f60123dcba', 'tlghso.6sp3l90ONQEJr0HLTrDzbg'],
        ];
        return KNOWN.every(([purpose, scope, want]) => mintConfirmationRef(purpose, ME, scope, T0, SECRET) === want);
    });

    console.log('\n── The two confirms the ORDERS stream draws: cancel an order, close a ticket ──');

    /**
     * `cancel` and `ticket-close` are scoped to ONE order / ONE ticket. Without the scope, the
     * reference from "cancel order A?" would confirm cancelling order B for the same customer —
     * the button would be bound to the person and not to the thing.
     */
    const ORDER_A = '66f0a1b2c3d4e5f60123abcd';
    const ORDER_B = '66f0a1b2c3d4e5f60123abce';
    for (const [purpose, verb] of [['cancel', 'yes:cnc'], ['ticket-close', 'yes:tcl']] as const) {
        const minted = mintConfirmationRef(purpose, ME, ORDER_A, T0, SECRET);
        const judge = (p: BotConfirmationPurpose, scope: string, subject = ME) =>
            verifyConfirmationRef(minted, p, subject, scope, T0 + 1000, SECRET);

        assert(`${purpose}: valid for the one ${purpose === 'cancel' ? 'order' : 'ticket'} it was minted for`, () =>
            judge(purpose, ORDER_A) === 'valid');

        assert(`⛔ ${purpose}: another ${purpose === 'cancel' ? 'order' : 'ticket'} of the SAME customer → invalid`, () =>
            judge(purpose, ORDER_B) === 'invalid');

        assert(`⛔ ${purpose}: an EMPTY scope → invalid (an unscoped verify cannot accept a scoped ref)`, () =>
            judge(purpose, '') === 'invalid');

        assert(`⛔ ${purpose}: another customer, or the other app → invalid`, () =>
            judge(purpose, ORDER_A, { ...ME, userId: '66f0a1b2c3d4e5f601234568' }) === 'invalid'
            && judge(purpose, ORDER_A, { ...ME, channel: 'whatsapp' }) === 'invalid');

        assert(`⛔ ${purpose}: presented on any OTHER purpose, same scope → invalid`, () =>
            (['close', 'unlink', 'cancel', 'ticket-close'] as const)
                .filter((other) => other !== purpose)
                .every((other) => judge(other, ORDER_A) === 'invalid'));

        /**
         * The orders stream pins 62 bytes for its token; this pins the other half — that the
         * reference itself is the length that arithmetic assumes. A 24-hex Mongo id is the
         * longest scope either verb carries.
         */
        assert(`${verb}:<24-hex id>:<ref> is 62 bytes — inside Telegram's 64, with the ref's 29`, () => {
            const token = `${verb}:${ORDER_A}:${minted}`;
            return minted.length === 29 && Buffer.byteLength(token, 'utf8') === 62;
        });
    }

    console.log('\n── Disconnecting an app: the scope is the CHANNEL, and the budget is not tight ──');

    /**
     * ⚠ **The scope here is the channel being disconnected, which is not the channel in the
     * subject.** `bot-confirmation-ref.ts` documents that distinction at `ConfirmationSubject`:
     * the subject's channel is the conversation's. Both matter and they differ — a customer
     * talking to us on WhatsApp gets a button that disconnects Telegram, so a reference bound
     * only to the account would let the two swap places in a scrolled-back thread.
     *
     * ⚠ **`unlink` is also the purpose whose scope is NOT a 24-hex id**, which is the reason
     * these assertions exist beside the orders stream's: the byte arithmetic that says 62 does
     * not describe this verb at all, and a budget assertion copied from there would pin a
     * number this token can never reach.
     */
    const WA = 'whatsapp';
    const TG = 'telegram';
    const unlinkRef = mintConfirmationRef('unlink', ME, TG, T0, SECRET);
    const judgeUnlink = (scope: string, subject = ME, purpose: BotConfirmationPurpose = 'unlink') =>
        verifyConfirmationRef(unlinkRef, purpose, subject, scope, T0 + 1000, SECRET);

    assert('unlink: valid for the one app it was minted for', () =>
        judgeUnlink(TG) === 'valid');

    assert('⛔ unlink: the OTHER app → invalid (a scrolled-back button cannot swap which app it cuts)', () =>
        judgeUnlink(WA) === 'invalid');

    assert('⛔ unlink: an EMPTY scope → invalid', () =>
        judgeUnlink('') === 'invalid');

    assert('⛔ unlink: another customer, or the same question asked in the other app → invalid', () =>
        judgeUnlink(TG, { ...ME, userId: '66f0a1b2c3d4e5f601234568' }) === 'invalid'
        && judgeUnlink(TG, { ...ME, channel: 'whatsapp' }) === 'invalid');

    assert('⛔ unlink: presented on any OTHER purpose, same scope → invalid', () =>
        (['close', 'cancel', 'ticket-close'] as const)
            .every((other) => judgeUnlink(TG, ME, other) === 'invalid'));

    assert('yes:unl:<channel>:<ref> is 46 bytes, and no:unl:<channel> is 15', () =>
        Buffer.byteLength(`yes:unl:${WA}:${unlinkRef}`, 'utf8') === 46
        && Buffer.byteLength(`no:unl:${WA}`, 'utf8') === 15);

    /**
     * ⛔ **The measurement that changed the design.** The plan called this context `unlink`, and
     * with the scope it was first specified with — a 24-hex id — `yes:unlink:<id>:<ref>` is 65
     * bytes, one over Telegram's cap, which silently drops the keyboard. Both halves moved: the
     * context to three letters, and the scope to what the platform actually identifies a
     * connection by. This pins the arithmetic so neither can drift back.
     */
    assert('⛔ the rejected shapes are the ones that do NOT fit: `unlink` + a 24-hex id is 65 bytes', () =>
        Buffer.byteLength(`yes:unlink:${ORDER_A}:${unlinkRef}`, 'utf8') === 65
        && Buffer.byteLength(`yes:unl:${ORDER_A}:${unlinkRef}`, 'utf8') === 62);

    console.log('\n── Asking for the confirmation link again: the wait, and the button that is absent ──');

    const SENT = new Date('2026-09-20T10:00:00Z');
    const after = (seconds: number) => new Date(SENT.getTime() + seconds * 1000);

    assert('the moment it was sent, the whole cooldown is still to run', () =>
        resendWaitSeconds(SENT, SENT) === CONTACT_RESEND_COOLDOWN_SECONDS);

    assert('⛔ one millisecond short of the cooldown still refuses, and never says "retry in 0"', () => {
        const wait = resendWaitSeconds(SENT, new Date(SENT.getTime() + CONTACT_RESEND_COOLDOWN_SECONDS * 1000 - 1));
        return wait === 1;
    });

    assert('exactly on time may send — the request a well-behaved client makes after being told to wait', () =>
        resendWaitSeconds(SENT, after(CONTACT_RESEND_COOLDOWN_SECONDS)) === 0
        && resendWaitSeconds(SENT, after(CONTACT_RESEND_COOLDOWN_SECONDS + 1)) === 0);

    assert('a wait is always a whole number of seconds, for every point inside the window', () =>
        [0.5, 1, 17.25, 60, 119.9].every((elapsed) => {
            const wait = resendWaitSeconds(SENT, after(elapsed));
            return Number.isInteger(wait) && wait >= 1 && wait <= CONTACT_RESEND_COOLDOWN_SECONDS;
        }));

    assert('⛔ a requestedAt in the FUTURE waits the full cooldown, never a negative wait', () =>
        resendWaitSeconds(SENT, after(-90)) === CONTACT_RESEND_COOLDOWN_SECONDS
        && resendWaitSeconds(new Date(NaN), SENT) === CONTACT_RESEND_COOLDOWN_SECONDS);

    /**
     * ⚠ **Span**: the body of `pendingChangeActions` and of `contactSection` in
     * `bot-contact.controller.ts`, sliced between named markers and asserted non-empty first.
     * What it pins is a DELIBERATE ASYMMETRY that reads like an omission — a phone change sends
     * nothing (it is proved by connecting the number on WhatsApp), so there is no link to send
     * again and no `ph:resend` anywhere. The next person to "finish the pair" needs to meet
     * this rather than a silent no-op.
     */
    const contactSource = read('modules/bot-surface/controllers/bot-contact.controller.ts');
    const actionsFrom = contactSource.indexOf('function pendingChangeActions(');
    const actionsTo = contactSource.indexOf('export class BotContactController', actionsFrom);
    const actionsRegion = actionsFrom >= 0 && actionsTo > actionsFrom
        ? stripComments(contactSource.slice(actionsFrom, actionsTo)) : '';

    const routeFrom = contactSource.indexOf('export async function contactSection(');
    const routeRegion = routeFrom >= 0 ? stripComments(contactSource.slice(routeFrom)) : '';

    assert('the scan found both spans it reasons about', () =>
        actionsRegion.includes('cancelChangeButton') && routeRegion.includes('switch (rest)'));

    assert('⛔ a phone change offers Cancel and NOTHING to re-send (nothing was ever sent)', () =>
        actionsRegion.includes("if (field === 'phone') return [cancel];")
        && !actionsRegion.includes("'ph', 'resend'"));

    assert('⛔ `ph:resend` routes nowhere — three cases, and the fourth is refused, not ignored', () =>
        ["'em:resend'", "'em:cancel'", "'ph:cancel'"].every((c) => routeRegion.includes(c))
        && !routeRegion.includes("'ph:resend'")
        && routeRegion.includes('throw unknownBotAction()'));

    console.log('\n── The sign-in message: five languages, one code, no grammar around a value ──');

    /** Stand-ins for the five-language phrases, which land with backend-dc's batch 2. */
    const PHRASES = {
        en: { tapToOpen: 'Tap to sign in on this device:', codeIntro: 'Or sign in with your phone number and this code:', codeOnly: 'Sign in with your phone number and this code:', website: 'Website:', validFor: 'Valid for:', ignore: 'If you did not ask to sign in, ignore this message.' },
        fr: { tapToOpen: 'Touchez pour vous connecter sur cet appareil :', codeIntro: 'Ou connectez-vous avec votre numéro de téléphone et ce code :', codeOnly: 'Connectez-vous avec votre numéro de téléphone et ce code :', website: 'Site web :', validFor: 'Valable :', ignore: "Si vous n'avez pas demandé à vous connecter, ignorez ce message." },
        pt: { tapToOpen: 'Toque para entrar neste dispositivo:', codeIntro: 'Ou entre com o seu número de telefone e este código:', codeOnly: 'Entre com o seu número de telefone e este código:', website: 'Site:', validFor: 'Válido:', ignore: 'Se não pediu para entrar, ignore esta mensagem.' },
        es: { tapToOpen: 'Toca para iniciar sesión en este dispositivo:', codeIntro: 'O inicia sesión con tu número de teléfono y este código:', codeOnly: 'Inicia sesión con tu número de teléfono y este código:', website: 'Sitio web:', validFor: 'Válido:', ignore: 'Si no pediste iniciar sesión, ignora este mensaje.' },
        ar: { tapToOpen: 'اضغط لتسجيل الدخول على هذا الجهاز:', codeIntro: 'أو سجّل الدخول برقم هاتفك وهذا الرمز:', codeOnly: 'سجّل الدخول برقم هاتفك وهذا الرمز:', website: 'الموقع:', validFor: 'صالح لمدة:', ignore: 'إن لم تطلب تسجيل الدخول، تجاهل هذه الرسالة.' },
    };
    const VALUES = { magicLink: 'https://wi-mall.com/s/abc123', site: 'wi-mall.com', code: '482913', ttlSeconds: 900 };
    const LANGS = ['en', 'fr', 'pt', 'es', 'ar'] as const;

    assert('every language assembles, and none of them drops a phrase or a value', () =>
        LANGS.every((lang) => {
            const message = composeSignInMessage(PHRASES[lang], VALUES);
            return Object.values(PHRASES[lang]).filter((p) => p !== PHRASES[lang].codeOnly).every((p) => message.includes(p))
                && message.includes(VALUES.magicLink) && message.includes(VALUES.site);
        }));

    assert('⛔ the code appears EXACTLY once, in every language', () =>
        LANGS.every((lang) =>
            composeSignInMessage(PHRASES[lang], VALUES).split(VALUES.code).length - 1 === 1));

    assert('⛔ the code is alone on its line — nothing to select around, nothing to reorder it', () =>
        LANGS.every((lang) =>
            composeSignInMessage(PHRASES[lang], VALUES).split('\n').includes(VALUES.code)));

    /**
     * ⚠ **The Arabic assertion is about the ASSEMBLED string, not the phrases** — which is
     * the check the coordinator asked for, and the one that would have caught a concatenated
     * sentence. Every left-to-right run (the link, the code, `15 min`, the host) must occupy
     * a whole line, so the bidirectional algorithm has no right-to-left text on that line to
     * reorder it against.
     */
    assert('⛔ Arabic: every left-to-right value stands alone on its own line', () => {
        const lines = composeSignInMessage(PHRASES.ar, VALUES).split('\n');
        return [VALUES.magicLink, VALUES.code, VALUES.site, '15 min'].every((ltr) => lines.includes(ltr));
    });

    assert('the duration never inflects a word: a number and the symbol "min"', () =>
        LANGS.every((lang) => {
            const message = composeSignInMessage(PHRASES[lang], VALUES);
            return message.includes('15 min')
                && !/minute|minuto|دقيقة|دقائق|دقيقتان/.test(message);
        }));

    assert('⛔ a lifetime rounds UP, and never to "0 min" or below one minute', () =>
        [[30, '1 min'], [60, '1 min'], [61, '2 min'], [90, '2 min'], [900, '15 min']]
            .every(([ttl, expected]) =>
                composeSignInMessage(PHRASES.en, { ...VALUES, ttlSeconds: ttl as number })
                    .includes(expected as string)));

    assert('without a magic link the code intro stands alone — no dangling "Or"', () => {
        const message = composeSignInMessage(PHRASES.en, { ...VALUES, magicLink: null });
        return message.includes(PHRASES.en.codeOnly)
            && !message.includes(PHRASES.en.codeIntro)
            && !message.includes(PHRASES.en.tapToOpen);
    });

    assert('without a site the website label disappears with it', () => {
        const message = composeSignInMessage(PHRASES.en, { ...VALUES, site: null });
        return !message.includes(PHRASES.en.website);
    });

    /**
     * ⛔ The refusals. Each of these reaches a customer as a blank line or `NaN min` on the
     * one message they need to get into their account, where it reads as the platform having
     * lost their code rather than as a caller that forgot an argument.
     */
    assert('⛔ a missing code, phrase or lifetime THROWS rather than printing a gap', () => {
        const cases: (() => string)[] = [
            () => composeSignInMessage(PHRASES.en, { ...VALUES, code: '   ' }),
            () => composeSignInMessage(PHRASES.en, { ...VALUES, ttlSeconds: 0 }),
            () => composeSignInMessage(PHRASES.en, { ...VALUES, ttlSeconds: NaN }),
            () => composeSignInMessage({ ...PHRASES.en, validFor: '' }, VALUES),
        ];
        return cases.every((run) => {
            try {
                run();
                return false;
            } catch (err) {
                return err instanceof SignInMessageError;
            }
        });
    });

    console.log('\n── The welcome: once, on the turn that finishes the setup ──');

    /**
     * ⚠ **Span**: `setWelcomeReply`'s own body, sliced to where the next function begins, plus
     * the two call sites found over the whole file. Both markers asserted present first. The
     * controller cannot be imported — it reaches `orders/`, which does work at import under
     * bare `ts-node` and never returns — so this is a scan by necessity, and it is written to
     * name what it read.
     */
    const identity = read('modules/bot-surface/controllers/bot-identity.controller.ts');
    const welcomeFrom = identity.indexOf('function setWelcomeReply(');
    const welcomeTo = identity.indexOf('function setOnboardingReply(', welcomeFrom);
    const welcome = welcomeFrom >= 0 && welcomeTo > welcomeFrom
        ? stripComments(identity.slice(welcomeFrom, welcomeTo)) : '';

    /**
     * ⚠ **Everything OUTSIDE the definition**, because `function setWelcomeReply(req…` matches
     * a naive search for a call and would make "two call sites" read as three. Caught by this
     * assertion failing on correct code — the span and the claim have to be the same text.
     */
    const callSites = identity.slice(0, welcomeFrom) + identity.slice(welcomeTo);

    assert('the scan found setWelcomeReply, and the file still has both call sites', () =>
        welcome.length > 0
        && (callSites.match(/setWelcomeReply\(req/g) ?? []).length === 2);

    assert('the welcome offers exactly THREE buttons — WhatsApp silently drops a fourth', () =>
        (welcome.match(/\{ id: /g) ?? []).length === 3);

    assert('they are Browse · My orders · Help, by the agreed tokens', () =>
        welcome.includes("openSurfaceActionId('pl')")
        && welcome.includes("orderActionId('list')")
        && welcome.includes('supportFormActionId()'));

    /**
     * ⛔ The property the whole feature turns on. "The checklist is complete" stays true for
     * ever, so a welcome sent on the STATE greets the customer again every time they later add
     * an email or re-share their contact. Only the TRANSITION is the event — and both call
     * sites must test it, including the rare one where sharing a contact completes a
     * backfilled account.
     */
    assert('⛔ both call sites fire on the TRANSITION (!wasComplete && …), never on the state', () =>
        (identity.match(/if\s*\(!wasComplete\s*&&\s*isOnboardingComplete\([\s\S]{0,60}?setWelcomeReply\(req/g) ?? []).length === 2);

    assert('⛔ each `wasComplete` is read BEFORE its write, not after', () => {
        const stripped = stripComments(identity);
        return ['applyStep(', 'registerFromContact('].every((write) => {
            const at = stripped.indexOf(write);
            const readAt = stripped.lastIndexOf('wasComplete =', at);
            return readAt > 0 && readAt < at;
        });
    });

    console.log('\n── Every source file stays TEXT to git ──');

    /**
     * ⚠ **A raw control byte in a source file can make git store it as BINARY**, and a binary
     * file shows no diff — a reviewer reading the commit sees "Binary files differ" and nothing
     * else. `bot-confirmation-ref.ts` shipped that way in `6b2a47d`: a literal NUL typed as the
     * MAC's field separator, 5741 bytes in, inside the first 8000 bytes git inspects. A second
     * one sat in `core/geocoding/geocoding.cache.ts` as the search key's separator; it was past
     * byte 8000, so git still diffed it — until any edit above it shortened the file enough.
     * The escape `'\u0000'` is the same character at runtime and plain text on disk; both fixes
     * were proved byte-identical in what they produce (refs above, cache keys by comparison).
     *
     * **The span is every `.ts` file under `src/` and `scripts/`**, not one stream's files — the
     * second instance was in a file no stream owns, which a per-stream scan would never have
     * reached. Forbidden: 0x00–0x08, 0x0B, 0x0C, 0x0E–0x1F. Allowed: tab, line feed, carriage
     * return (`core.autocrlf=true` puts CRs in every file here).
     *
     * Non-vacuity comes first: the walk must have read hundreds of files, including both files
     * the defect was found in.
     */
    const ROOT = path.resolve(__dirname, '../..');
    const walk = (dir: string): string[] =>
        fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) =>
            e.isDirectory()
                ? (e.name === 'node_modules' ? [] : walk(`${dir}/${e.name}`))
                : e.name.endsWith('.ts') ? [`${dir}/${e.name}`] : []);
    const scanned = ['src', 'scripts'].flatMap(walk);
    const FOUND_IN = ['src/modules/bot-surface/domain/bot-confirmation-ref.ts', 'src/core/geocoding/geocoding.cache.ts'];
    const controlBytes = (relative: string): number[] =>
        [...fs.readFileSync(path.join(ROOT, relative))]
            .map((byte, at) => (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d ? at : -1))
            .filter((at) => at >= 0);

    assert('the scan read ≥ 800 .ts files under src/ + scripts/, both files the defect was found in among them', () =>
        scanned.length >= 800 && FOUND_IN.every((f) => scanned.includes(f)));

    assert('⛔ no .ts file under src/ or scripts/ holds a raw control byte (a NUL can hide a whole file\'s diff)', () => {
        const dirty = scanned.filter((f) => controlBytes(f).length > 0);
        if (dirty.length) console.error(`     ${dirty.map((f) => `${f} @ byte ${controlBytes(f).slice(0, 3).join(',')}`).join('\n     ')}`);
        return dirty.length === 0;
    });

    console.log(
        failed === 0
            ? `\n✅ ${passed} passed, 0 failed`
            : `\n❌ ${passed} passed, ${failed} failed`,
    );
    process.exit(failed === 0 ? 0 : 1);
}

main();
