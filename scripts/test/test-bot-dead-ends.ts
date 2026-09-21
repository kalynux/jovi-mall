/**
 * Test: ATLAS PHASE 11 — the way out of a dead end.
 *
 * Plain ts-node, hand-rolled asserts, no framework, no database, no network — the convention
 * every other suite in this folder follows.
 *
 * ── WHAT THIS PINS, AND WHY NONE OF IT IS VISIBLE TO A HAPPY-PATH TEST ──────
 * Every refusal on this surface used to carry a correct, translated sentence and **no
 * control**, so a customer whose button had expired was told what had happened and left with
 * nothing to press. `recoveryFor` is the table that closes that, and everything worth
 * asserting about it is a property that no request-level test would notice:
 *
 *   § 1  the right way out per code and per category — including where there must be NONE
 *   § 2  ⛔ no button is ever offered behind the guard that just refused
 *   § 3  every token it emits is a key the dispatcher actually routes
 *   § 4  the maintenance window: mode-aware, and `details.mode` survives the boundary
 *   § 5  labels are translated and fit the channel that caps hardest
 *   § 6  ⛔ the maintenance gate is still mounted, once, in the right place in `app.ts`
 *
 * ── ⛔ TWO LESSONS THIS SUITE WAS BOUGHT WITH ───────────────────────────────
 *
 * **1 · A CATEGORY IS DERIVED FROM A STATUS, so reasoning about categories is reasoning
 * about a number somebody chose at a throw site you have not read.** § 2 exists because
 * `BOT_IDENTITY_UNRESOLVED` is raised at **404** and therefore derives `not_found` — the one
 * category that offers Browse — on the error raised for a customer the platform could not
 * identify. Every bot route is behind `requireBotIdentity`, so the table would have answered
 * a dead end with the same dead end, one tap later. No amount of thinking about what
 * `not_found` *means* would have found it; it took opening `bot-identity.service.ts:210`.
 *
 * **2 · A PROOF OF THE ORDER IS NOT A PROOF THE THING IS THERE.** §§ 1–5 and the mount-order
 * harness all passed against an `app.ts` from which the maintenance gate had been deleted
 * outright, because none of them read `app.ts`. § 6 is the cheap assertion that does.
 * ⚠ Generalise it before writing the next guard: **a test that builds its own subject cannot
 * see the real subject going missing.**
 *
 * § 2 and § 3 are the two that matter. Both answer the same question from opposite ends —
 * *can the customer actually use the thing we just offered them?* — and a table can be
 * perfectly sensible and fail either.
 *
 * ⚠ **§ 3 reads the dispatcher registry as TEXT rather than importing it.** Importing it
 * pulls in `orders/` and `payments/`, whose module-level work never returns under bare
 * ts-node — the run would produce zero output and read as a broken test rather than a failing
 * one. Every `test:inapp-*` suite scans for this reason; see the note in `bot-rich-ui-effort`.
 *
 * Credit where it is due: § 3's shape and its two non-vacuity guards are backend-df's, from a
 * parallel pass at this phase that was reverted in favour of this one.
 *
 * Run: npm run test:dead-ends
 */
import fs from 'fs';
import path from 'path';
import { recoveryFor } from '../../src/modules/bot-surface/domain/bot-recovery-actions';
import { maintenanceMessageFor, __BOT_ERROR_COPY } from '../../src/modules/bot-surface/domain/bot-error-copy';
import { ERROR_CODES } from '../../src/core/error-codes';
import { ERROR_CATEGORIES } from '../../src/core/error-category';
import { projectDetails } from '../../src/core/error-detail-policy';
import { parseBotActionId } from '../../src/modules/bot-surface/domain/bot-action-id';

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

const LANGUAGES = ['en', 'fr', 'pt', 'es', 'ar'] as const;
/** WhatsApp's reply-button title cap — the hardest limit either channel imposes. */
const WA_BUTTON_TITLE = 20;

/** The sentence stands in for `error.customerMessage`; only one situation replaces it. */
const SENTENCE = 'that did not work';

function recovery(code: string | null, category: string | null, language = 'en') {
    return recoveryFor({ code, category, details: undefined, text: SENTENCE, language });
}

function ids(code: string | null, category: string | null, language = 'en'): string[] {
    return recovery(code, category, language).actions.map((a) => a.id);
}

function main(): void {
    console.log('\n══ Atlas phase 11 — dead ends ══');

    console.log('\n── § 1 · The right way out, and where there is deliberately none ──');

    assert('a lapsed product set offers a fresh search', () =>
        ids(ERROR_CODES.BOT_PRODUCT_LIST_EXPIRED, ERROR_CATEGORIES.NOT_FOUND).join() === 'open:pl');

    /**
     * ⭐ The stale button after a deploy — the turn this whole table exists for. Telegram
     * reports nothing for an unhandled callback, so the customer's previous tap was silence;
     * answering that with a sentence and no control is a conversation with no way forward.
     * Both doors, because the token is unreadable by definition: a retired button is as often
     * an order button as a product one, and we cannot tell which.
     */
    assert('a button from a retired deploy offers a fresh start, both doors', () =>
        ids(ERROR_CODES.BOT_ACTION_TOKEN_UNKNOWN, ERROR_CATEGORIES.BUSINESS_RULE).join() === 'open:pl,ord:list');

    /**
     * ⚠ **The CODE beats the CATEGORY where they disagree, and this proves it.** A lapsed
     * product set and a genuinely missing order are both `not_found`, and "search again" is
     * the answer to one and not the other. A category-only table cannot tell them apart.
     * (backend-df's assertion, kept — it pins the table's most important structural property.)
     */
    assert('⛔ the code beats the category where the two disagree', () =>
        ids(ERROR_CODES.BOT_SCREEN_SESSION_EXPIRED, ERROR_CATEGORIES.NOT_FOUND).length === 0
        && ids('SOME_OTHER_NOT_FOUND', ERROR_CATEGORIES.NOT_FOUND).join() === 'open:pl');

    assert('a business rule, an outage and an internal fault all offer Get help', () =>
        [
            ERROR_CATEGORIES.BUSINESS_RULE,
            ERROR_CATEGORIES.EXTERNAL_SERVICE,
            ERROR_CATEGORIES.INTERNAL,
            ERROR_CATEGORIES.AUTHORIZATION,
        ].every((category) => ids('ANY_CODE', category).join() === 'tkt:new'));

    /**
     * ⛔ **The categories where a button would be worse than nothing**, each for its own
     * reason: a validation refusal is answered by the customer's next sentence; a rate limit
     * is answered by waiting, and a button there is the one control guaranteed to make it
     * worse; a conflict means the state moved, and this table cannot know whether the state
     * in question is a cart, an order or a booking.
     */
    assert('⛔ validation, rate_limit and conflict get NO button', () =>
        [
            ERROR_CATEGORIES.VALIDATION,
            ERROR_CATEGORIES.RATE_LIMIT,
            ERROR_CATEGORIES.CONFLICT,
        ].every((category) => ids('ANY_CODE', category).length === 0));

    assert('an unknown code with an unknown category gets NO button', () =>
        ids('WHAT_IS_THIS', 'not_a_category').length === 0 && ids(null, null).length === 0);

    /**
     * ⛔ **No generic "Try again", ever.** The dispatcher keeps no copy of the request that
     * failed, so such a button would re-issue nothing. `tryAgainButton` keeps its copy key for
     * the notification catalogue, which draws it on messages that DO carry their own token —
     * this asserts the table never reaches for it, which is the part that would rot.
     */
    assert('⛔ no category or code ever emits a bare retry', () => {
        const every = [
            ...Object.values(ERROR_CATEGORIES).map((c) => ids('ANY_CODE', c)),
            ids(ERROR_CODES.BOT_PRODUCT_LIST_EXPIRED, ERROR_CATEGORIES.NOT_FOUND),
            ids(ERROR_CODES.BOT_ACTION_TOKEN_UNKNOWN, ERROR_CATEGORIES.BUSINESS_RULE),
        ].flat();
        return every.length > 0 && !every.some((id) => id.startsWith('retry') || id.includes(':rt'));
    });

    console.log('\n── § 2 · ⛔ Never a door behind the guard that just refused ──');

    /**
     * ⛔ **THE ONE THAT WOULD HAVE SHIPPED.** `bot.routes.ts` puts `requireBotIdentity` in
     * front of every route on this surface, so when *that guard* is what refused, every door
     * this table can offer is shut too.
     *
     * The trap is that the categories do not group these and one actively misleads:
     * `BOT_IDENTITY_UNRESOLVED` is raised at **404**, so it derives `not_found` — whose entry
     * offers Browse. Without the code-level override, the customer the platform could not
     * identify would be invited to go shopping and the tap would fail identically.
     */
    assert('⛔ an identity-gate refusal offers nothing, whatever its category says', () =>
        ids(ERROR_CODES.BOT_IDENTITY_UNRESOLVED, ERROR_CATEGORIES.NOT_FOUND).length === 0
        && ids(ERROR_CODES.BOT_IDENTITY_NOT_CUSTOMER, ERROR_CATEGORIES.AUTHORIZATION).length === 0
        && ids(ERROR_CODES.BOT_IDENTITY_NEEDS_CONTACT, ERROR_CATEGORIES.AUTHENTICATION).length === 0);

    /** The category as a whole, for the codes not named individually. */
    assert('⛔ the authentication category offers nothing', () =>
        ids('ANY_AUTH_CODE', ERROR_CATEGORIES.AUTHENTICATION).length === 0);

    /**
     * ⚠ **Non-vacuity for the two assertions above.** Both are satisfied by a table that has
     * stopped emitting anything at all, so this proves the table is still alive.
     */
    assert('the table still emits buttons elsewhere (non-vacuity)', () =>
        ids('ANY_CODE', ERROR_CATEGORIES.BUSINESS_RULE).length > 0
        && ids(ERROR_CODES.BOT_PRODUCT_LIST_EXPIRED, ERROR_CATEGORIES.NOT_FOUND).length > 0);

    console.log('\n── § 3 · Every token it emits is a key somebody actually routes ──');

    /**
     * ⛔ **A recovery button that reached the unknown-token refusal would answer a dead end
     * with the dead end it had just described.** Scanned as text, never imported — see the
     * header.
     */
    const controllers = path.join(__dirname, '../../src/modules/bot-surface/controllers');
    const dispatcherSrc = fs
        .readFileSync(path.join(controllers, 'bot-action.controller.ts'), 'utf8')
        .replace(/\r\n/g, '\n');

    const mapNames = [
        ...dispatcherSrc.matchAll(/import\s*\{[^}]*\b([A-Z][A-Z_]*_ACTION_HANDLERS)\b[^}]*\}\s*from\s*'\.\/([^']+)'/g),
    ].map((m) => ({ name: m[1], file: m[2] }));

    assert('the dispatcher registry is found (non-vacuity)', () => mapNames.length >= 4);

    const routedKeys = new Set<string>();
    for (const { name, file } of mapNames) {
        const full = path.join(controllers, `${file}.ts`);
        if (!fs.existsSync(full)) continue;
        const src = fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n');
        const at = src.indexOf(`export const ${name}`);
        if (at < 0) continue;
        /**
         * ⚠ **Sliced to the map's own closing `});`, not to end of file.** A region sliced
         * past its end swallows whatever follows and makes the claim true of text the guard
         * was never about — the single commonest guard defect in this repository.
         */
        const body = src.slice(at, src.indexOf('});', at));
        for (const m of body.matchAll(/^\s*'?([a-z]+(?::[a-z]+)?)'?\s*:/gm)) routedKeys.add(m[1]);
    }

    assert('the merged registry parsed (non-vacuity)', () => routedKeys.size > 20);

    assert('⛔ every token this table can emit routes to a handler', () => {
        const emitted = [
            ...ids(ERROR_CODES.BOT_PRODUCT_LIST_EXPIRED, ERROR_CATEGORIES.NOT_FOUND),
            ...ids(ERROR_CODES.BOT_ACTION_TOKEN_UNKNOWN, ERROR_CATEGORIES.BUSINESS_RULE),
            ...ids('ANY_CODE', ERROR_CATEGORIES.BUSINESS_RULE),
            ...maintenanceIds('readonly'),
        ];
        if (emitted.length === 0) return false;
        return emitted.every((id) => {
            const parsed = parseBotActionId(id);
            if (!parsed) return false;
            /**
             * The dispatcher routes a sub-dispatched verb by `verb:sub` and a plain one by the
             * verb alone; a key is reachable if either form is registered.
             */
            return routedKeys.has(`${parsed.verb}:${parsed.argument.split(':')[0]}`)
                || routedKeys.has(parsed.verb);
        });
    });

    console.log('\n── § 4 · The maintenance window says what is actually true of it ──');

    assert('a read-only window says reads still work, and offers the two that do', () =>
        maintenanceIds('readonly').join() === 'open:pl,ord:list');

    /** ⛔ In a full stop every door 503s, so there is none. */
    assert('⛔ a full stop offers NO button', () => maintenanceIds('down').length === 0);

    assert('the two windows say different things', () =>
        maintenanceMessageFor('readonly', 'en') !== maintenanceMessageFor('down', 'en'));

    /**
     * ⚠ **An unreadable mode is treated as a full stop** — the conservative direction. Being
     * told the shop is closed when it is merely read-only costs a customer a little; being
     * offered a door that answers 503 costs them a tap and their trust.
     */
    assert('an absent or unknown mode degrades to the full stop', () => {
        const absent = recoveryFor({ code: ERROR_CODES.SYSTEM_MAINTENANCE_ACTIVE, category: ERROR_CATEGORIES.BUSINESS_RULE, details: undefined, text: SENTENCE, language: 'en' });
        const junk = recoveryFor({ code: ERROR_CODES.SYSTEM_MAINTENANCE_ACTIVE, category: ERROR_CATEGORIES.BUSINESS_RULE, details: { mode: 'sideways' }, text: SENTENCE, language: 'en' });
        return absent.actions.length === 0
            && junk.actions.length === 0
            && absent.text === maintenanceMessageFor('down', 'en');
    });

    /**
     * ⛔ **THE LOAD-BEARING DEPENDENCY ON ANOTHER MODULE, ASSERTED RATHER THAN COMMENTED.**
     *
     * The mode reaches this surface on `error.details`, and `error-detail-policy.ts` strips
     * `details` wholesale for `internal` and `external_service` and allowlists keys for
     * `authorization` and `rate_limit`. `SYSTEM_MAINTENANCE_ACTIVE` is categorised
     * `business_rule` — which takes the `scrubValue` branch and keeps the key — and that is
     * the *only* reason any of § 4 works.
     *
     * If the policy ever scrubs it, the buttons become **wrong rather than absent**: every
     * window would read as a full stop and a read-only window would stop telling customers
     * that browsing still works. That is a silent regression, so it is pinned here.
     */
    assert('⛔ details.mode survives the boundary for this code\'s category', () => {
        const projected = projectDetails(ERROR_CATEGORIES.BUSINESS_RULE, {
            mode: 'readonly',
            reason: 'migration',
            startedAt: null,
            expiresAt: null,
        });
        return projected?.mode === 'readonly';
    });

    /** ⚠ And that the sentence is not merely present but different per language. */
    assert('the maintenance copy is complete and distinct in all five languages', () => {
        const seen = new Set<string>();
        for (const mode of ['readonly', 'down'] as const) {
            for (const language of LANGUAGES) {
                const text = maintenanceMessageFor(mode, language);
                if (typeof text !== 'string' || text.trim().length === 0) return false;
                seen.add(`${mode}:${text}`);
            }
        }
        return seen.size === 10;
    });

    /**
     * ⚠ **The maintenance copy is inside the boot assert's reach.** It is resolved through a
     * function rather than through either copy table, so the assert's two existing loops walk
     * straight past it — and a missing translation there would be discovered *during an
     * outage*, which is the worst moment available.
     */
    assert('the maintenance copy is exposed to the boot assert', () =>
        Object.keys(__BOT_ERROR_COPY.MAINTENANCE_COPY ?? {}).sort().join() === 'down,readonly');

    console.log('\n── § 5 · Labels are translated and fit the channel that caps hardest ──');

    assert('every language gets a real label, never a key and never empty', () =>
        LANGUAGES.every((language) =>
            [
                recovery(ERROR_CODES.BOT_ACTION_TOKEN_UNKNOWN, ERROR_CATEGORIES.BUSINESS_RULE, language),
                recovery('ANY_CODE', ERROR_CATEGORIES.BUSINESS_RULE, language),
            ].every((r) =>
                r.actions.every(
                    (a) => a.label.trim().length > 0 && !a.label.includes('Button') && a.label !== a.id,
                ))));

    assert(`every label fits WhatsApp's ${WA_BUTTON_TITLE}-character button title`, () =>
        LANGUAGES.every((language) =>
            [
                recovery(ERROR_CODES.BOT_ACTION_TOKEN_UNKNOWN, ERROR_CATEGORIES.BUSINESS_RULE, language),
                recovery('ANY_CODE', ERROR_CATEGORIES.BUSINESS_RULE, language),
                recoveryFor({ code: ERROR_CODES.SYSTEM_MAINTENANCE_ACTIVE, category: ERROR_CATEGORIES.BUSINESS_RULE, details: { mode: 'readonly' }, text: SENTENCE, language }),
            ].every((r) => r.actions.every((a) => (a.shortLabel ?? a.label).length <= WA_BUTTON_TITLE))));

    /**
     * ⚠ **Never more than WhatsApp can draw.** Three reply buttons is its cap and a fourth is
     * dropped in silence — the failure that looks like working code.
     */
    assert('never more than three buttons on one refusal', () =>
        [
            ...Object.values(ERROR_CATEGORIES).map((c) => ids('ANY_CODE', c)),
            ids(ERROR_CODES.BOT_ACTION_TOKEN_UNKNOWN, ERROR_CATEGORIES.BUSINESS_RULE),
            maintenanceIds('readonly'),
        ].every((list) => list.length <= 3));

    /** ⚠ The sentence is the error's own for everything but the maintenance window. */
    assert('the table rewords nothing except the maintenance window', () =>
        recovery(ERROR_CODES.BOT_PRODUCT_LIST_EXPIRED, ERROR_CATEGORIES.NOT_FOUND).text === SENTENCE
        && recovery('ANY_CODE', ERROR_CATEGORIES.INTERNAL).text === SENTENCE
        && recovery(null, null).text === SENTENCE);

    console.log('\n── § 6 · The gate is still mounted, once, in the right place ──');

    /**
     * ⛔ **THE ASSERTION THAT EXISTS BECAUSE THE FIX NEARLY BROKE THE THING IT FIXED.**
     *
     * Applying the mount-order change, the first attempt replaced the block around
     * `app.use(maintenanceModeMiddleware)` and did not put the gate back — which would have
     * disabled maintenance mode platform-wide. **Every proof still passed**, because the
     * harness wires the middleware itself and never reads `app.ts`. It was caught by hand.
     *
     * So this reads the real file. The property is not "the order is right" — that was always
     * provable elsewhere — it is **"the gate is still there at all"**.
     *
     * ⚠ **Comments are stripped first — as a BELT, and the honest measurement is this.**
     * `app.ts` names `maintenanceModeMiddleware` four times: the import, two comments
     * explaining what sits either side of it, and the mount. So **a guard that counted the
     * SYMBOL would find four and fail on correct code.** The `app.use(…)` form below finds
     * exactly one **with or without** the stripping, measured — so today the stripping changes
     * nothing, and it is kept for the case this codebase makes likely rather than
     * hypothetical: a comment that quotes the mount it is describing. There is no such
     * comment in `app.ts` right now; there are several elsewhere in this repository.
     *
     * ⚠ That distinction is written out because the first version of this comment claimed the
     * stripping was load-bearing and that a naive count "finds three mounts". Both were false
     * — wrong number, wrong regex — in a guard that was itself correct. **A wrong example
     * inside a right guard is how the guard gets weakened later**, by somebody who tests the
     * comment, finds it does not hold, and concludes the check is junk.
     */
    const appSrc = fs
        .readFileSync(path.join(__dirname, '../../src/app.ts'), 'utf8')
        .replace(/\r\n/g, '\n');
    const appCode = appSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    assert('app.ts was read and has mounts (non-vacuity)', () =>
        appCode.length > 500 && appCode.includes('app.use('));

    /**
     * ⚠ **Matched as a PROPERTY, not an idiom.** Whitespace, a trailing semicolon and an
     * `app.use(x, maintenanceModeMiddleware)` form are all the same fact; pinning the exact
     * spelling would accuse a correct rewrite of being a breach.
     */
    const mountsOf = (needle: string): number[] => {
        const out: number[] = [];
        const re = new RegExp(`app\\s*\\.\\s*use\\s*\\([^)]*\\b${needle}\\b`, 'g');
        for (const m of appCode.matchAll(re)) out.push(m.index ?? -1);
        return out;
    };

    const gate = mountsOf('maintenanceModeMiddleware');
    const reply = mountsOf('attachBotReply');
    const envelope = mountsOf('attachBotEnvelope');
    const api = appCode.search(/app\s*\.\s*use\s*\(\s*['"]\/api['"]/);

    assert('⛔ the maintenance gate is mounted EXACTLY once', () => gate.length === 1);

    assert('the two bot mounts are present, once each', () =>
        reply.length === 1 && envelope.length === 1);

    /**
     * The order the whole fix depends on: the bot surface must be able to answer a refusal the
     * gate is about to make, and the gate must still run before any business route.
     */
    assert('⛔ bot mounts → maintenance gate → /api, in that order', () =>
        reply[0] > 0
        && reply[0] < gate[0]
        && envelope[0] < gate[0]
        && gate[0] < api
        && api > 0);

    /** ⚠ Bot-prefixed, never app-wide — what makes every other route byte-identical. */
    assert('the two bot mounts are scoped to the bot prefix, not app-wide', () =>
        [reply[0], envelope[0]].every((at) =>
            appCode.slice(at, at + 120).includes('BOT_SURFACE_PREFIX')));

    console.log(
        failed === 0
            ? `\n✅ ${passed} passed, 0 failed`
            : `\n❌ ${passed} passed, ${failed} failed`,
    );
    process.exit(failed === 0 ? 0 : 1);
}

function maintenanceIds(mode: string): string[] {
    return recoveryFor({
        code: ERROR_CODES.SYSTEM_MAINTENANCE_ACTIVE,
        category: ERROR_CATEGORIES.BUSINESS_RULE,
        details: { mode },
        text: SENTENCE,
        language: 'en',
    }).actions.map((a) => a.id);
}

main();
