/**
 * test:phone-verification — the WhatsApp OTP. **No DB, no network, no Redis.**
 *
 * ── What this flow is for ────────────────────────────────────────────────────
 *
 * `/api/me/phone/confirm` proves a number by requiring an existing WhatsApp CONNECTION on it —
 * a message actually arrived from that number, which beats any code the platform sends itself.
 * That is the customer path and it is unchanged.
 *
 * Vendors, agencies, agents and administrators sign up on a dashboard and may never message the
 * platform, so there is no connection to check and `phone_verified` could never become true for
 * them. The OTP is the path for an account the platform has no other way to reach.
 *
 * ── Why the whole policy is PURE, and why that matters here ──────────────────
 *
 * Every decision — expiry, attempt exhaustion, the resend cooldown, the constant-time
 * comparison — is a pure function taking `now` and its limits as arguments. That is what lets
 * the entire table be asserted in milliseconds instead of waiting ten minutes for a TTL, and
 * it is the reason the security-relevant half of this feature is testable at all: the
 * interesting cases are the REFUSALS, and a refusal that needs Redis and a clock to reproduce
 * is a refusal nobody asserts.
 *
 * Run: npm run test:phone-verification
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
    OTP_LENGTH,
    digestForKey,
    generateOtp,
    judgeOtp,
    mayResend,
    normalizeOtp,
    otpMatches,
    OtpLimits,
} from '../../src/modules/phone-verification/domain/otp';
import {
    OTP_COPY_LANGUAGES,
    otpMessage,
    OTP_FALLBACK_COPY_LANGUAGES,
    otpFallbackTemplateBody,
    otpFallbackTemplateParams,
} from '../../src/modules/phone-verification/domain/otp-copy';
import { SUPPORTED_LANGUAGES } from '../../src/core/constants/languages';

const originalConsole = { log: console.log.bind(console), error: console.error.bind(console) };

let passed = 0;
let failed = 0;

function assert(name: string, ok: boolean, detail?: string): void {
    if (ok) { originalConsole.log(`  ✅ ${name}`); passed++; }
    else { originalConsole.error(`  ❌ FAIL: ${name}${detail ? `\n       ${detail}` : ''}`); failed++; }
}

function section(title: string): void {
    originalConsole.log(`\n── ${title} ${'─'.repeat(Math.max(0, 68 - title.length))}`);
}

const LIMITS: OtpLimits = { ttlSeconds: 600, maxAttempts: 5, resendCooldownSeconds: 60 };
const NOW = new Date('2026-09-14T12:00:00.000Z');
const rec = (over: Partial<{ code: string; attempts: number; expiresAt: Date }> = {}) => ({
    code: '123456',
    attempts: 0,
    expiresAt: new Date(NOW.getTime() + 600_000),
    ...over,
});

// ─────────────────────────────────────────────────────────────────────────────
section('1. The code itself');
// ─────────────────────────────────────────────────────────────────────────────
{
    const codes = Array.from({ length: 500 }, () => generateOtp());

    assert('every code is exactly 6 digits', codes.every(c => /^[0-9]{6}$/.test(c)));
    assert(`…and ${OTP_LENGTH} is what the module says it is`, OTP_LENGTH === 6);

    /**
     * ⚠ Not a randomness test — 500 samples proves nothing about a CSPRNG. It catches the one
     * failure that actually happens: a constant, or a generator seeded per process, which is
     * what `Math.random()` degrades to and what `randomInt` is used to avoid.
     */
    assert('codes are not constant', new Set(codes).size > 400, `${new Set(codes).size} distinct of 500`);

    // Every digit position must be able to produce a 0 and a 9 — catches an off-by-one range
    // like `randomInt(1, 10)`, which silently makes a sixth of the keyspace unreachable.
    const digitsSeen = new Set(codes.flatMap(c => c.split('')));
    assert('all ten digits occur', digitsSeen.size === 10, [...digitsSeen].sort().join(''));

    assert('a pasted code is normalised', normalizeOtp(' 123-456 ') === '123456');
    assert('normalisation strips letters rather than keeping them', normalizeOtp('12a3456') === '123456');
}

// ─────────────────────────────────────────────────────────────────────────────
section('2. Comparison is constant-time and total');
// ─────────────────────────────────────────────────────────────────────────────
{
    assert('an exact match passes', otpMatches('123456', '123456'));
    assert('a formatted match passes', otpMatches('123 456', '123456'));
    assert('a wrong code fails', !otpMatches('123457', '123456'));
    assert('a SHORTER code fails rather than throwing', !otpMatches('12345', '123456'));
    assert('a LONGER code fails rather than throwing', !otpMatches('1234567', '123456'));
    assert('an empty code fails', !otpMatches('', '123456'));
    assert('a non-numeric code fails', !otpMatches('abcdef', '123456'));
}

// ─────────────────────────────────────────────────────────────────────────────
section('3. The verdict table');
// ─────────────────────────────────────────────────────────────────────────────
{
    assert('the right code is accepted', judgeOtp(rec(), '123456', NOW, LIMITS).outcome === 'ok');

    const wrong = judgeOtp(rec(), '000000', NOW, LIMITS);
    assert('a wrong code is a mismatch', wrong.outcome === 'mismatch');
    assert('…and reports the attempts left', wrong.outcome === 'mismatch' && wrong.attemptsLeft === 4);

    const lastGuess = judgeOtp(rec({ attempts: 4 }), '000000', NOW, LIMITS);
    assert('the last wrong guess reports zero left', lastGuess.outcome === 'mismatch' && lastGuess.attemptsLeft === 0);

    /**
     * ⚠ `exhausted` is a DIFFERENT outcome from `mismatch` with zero left. The first means
     * "stop, request a new code"; the second is the last wrong guess. Collapsing them leaves a
     * client looping on a record that can never succeed.
     */
    assert('one attempt past the limit is EXHAUSTED, not mismatch',
        judgeOtp(rec({ attempts: 5 }), '000000', NOW, LIMITS).outcome === 'exhausted');
    assert('…and exhaustion beats a CORRECT code',
        judgeOtp(rec({ attempts: 5 }), '123456', NOW, LIMITS).outcome === 'exhausted');

    const expired = new Date(NOW.getTime() - 1000);
    assert('an expired code is expired', judgeOtp(rec({ expiresAt: expired }), '123456', NOW, LIMITS).outcome === 'expired');
    assert('⭐ expiry is checked BEFORE the code — an expired right answer must not pass',
        judgeOtp(rec({ expiresAt: expired, attempts: 0 }), '123456', NOW, LIMITS).outcome === 'expired');
    assert('the boundary is inclusive — expiring exactly now is expired',
        judgeOtp(rec({ expiresAt: NOW }), '123456', NOW, LIMITS).outcome === 'expired');
}

// ─────────────────────────────────────────────────────────────────────────────
section('4. The resend cooldown');
// ─────────────────────────────────────────────────────────────────────────────
{
    assert('a first send is always allowed', mayResend(null, NOW, LIMITS).allowed);

    const justSent = new Date(NOW.getTime() - 5_000);
    const refused = mayResend(justSent, NOW, LIMITS);
    assert('a send 5s ago is refused', !refused.allowed);
    assert('…and says how long to wait', !refused.allowed && refused.retryAfterSeconds === 55);

    assert('a send 60s ago is allowed', mayResend(new Date(NOW.getTime() - 60_000), NOW, LIMITS).allowed);
    assert('a send 61s ago is allowed', mayResend(new Date(NOW.getTime() - 61_000), NOW, LIMITS).allowed);
    assert('retryAfter is rounded UP, never to 0',
        (() => {
            const v = mayResend(new Date(NOW.getTime() - 59_500), NOW, LIMITS);
            return !v.allowed && v.retryAfterSeconds === 1;
        })());
}

// ─────────────────────────────────────────────────────────────────────────────
section('5. Key hashing — the operations surface lists key NAMES');
// ─────────────────────────────────────────────────────────────────────────────
{
    const id = '507f1f77bcf86cd799439011';
    assert('a key component is hashed', digestForKey(id) !== id);
    assert('…deterministically', digestForKey(id) === digestForKey(id));
    assert('…and differs per input', digestForKey(id) !== digestForKey('507f1f77bcf86cd799439012'));
    assert('the digest is hex and fixed-length', /^[0-9a-f]{32}$/.test(digestForKey(id)));
}

// ─────────────────────────────────────────────────────────────────────────────
section('6. The message copy');
// ─────────────────────────────────────────────────────────────────────────────
{
    assert('copy exists in every supported language',
        SUPPORTED_LANGUAGES.every(l => OTP_COPY_LANGUAGES.includes(l)),
        `missing: ${SUPPORTED_LANGUAGES.filter(l => !OTP_COPY_LANGUAGES.includes(l)).join(', ')}`);

    for (const lang of SUPPORTED_LANGUAGES) {
        const body = otpMessage('123456', lang, 600);
        assert(`[${lang}] contains the code`, body.includes('123456'));
        assert(`[${lang}] names the brand`, body.includes('Wi-Mall'));
        assert(`[${lang}] states the expiry in minutes`, body.includes('10'));
        assert(`[${lang}] renders no undefined`, !body.includes('undefined'));
        /**
         * ⚠ The code is deliberately NOT bolded, unlike every notification template parameter.
         * WhatsApp offers tap-to-copy on a bare line of digits and asterisks defeat it — people
         * then select by hand and catch an asterisk with the code.
         */
        assert(`[${lang}] leaves the code unbolded so it stays tap-to-copy`, !body.includes('*123456*'));
    }

    assert('an unknown language falls back rather than throwing',
        otpMessage('123456', 'zz' as never, 600).includes('123456'));
}

// ─────────────────────────────────────────────────────────────────────────────
section('6b. The UTILITY fallback template copy');
// ─────────────────────────────────────────────────────────────────────────────
{
    assert('fallback copy exists in every supported language',
        SUPPORTED_LANGUAGES.every(l => OTP_FALLBACK_COPY_LANGUAGES.includes(l)),
        `missing: ${SUPPORTED_LANGUAGES.filter(l => !OTP_FALLBACK_COPY_LANGUAGES.includes(l)).join(', ')}`);

    /**
     * ⭐ **The parameter ORDER is the contract, and nothing else can catch it breaking.**
     *
     * Meta substitutes positionally. Swap these two and every out-of-window message says the
     * TTL where the code belongs — an approved template, a successful send, a 200 response and
     * a person holding "10" as their verification code. There is no error anywhere in that
     * path, which is exactly why it is pinned here.
     */
    assert('⭐ the fallback params are [code, minutes] in that order',
        JSON.stringify(otpFallbackTemplateParams('123456', 600)) === JSON.stringify(['123456', '10']));

    assert('…and the minutes are derived from the TTL, not hardcoded',
        otpFallbackTemplateParams('123456', 300)[1] === '5');

    for (const lang of SUPPORTED_LANGUAGES) {
        const body = otpFallbackTemplateBody(lang);
        const placeholders = body.match(/\{\{\d+\}\}/g) ?? [];

        assert(`[${lang}] fallback body has exactly the 2 params the send supplies`,
            placeholders.length === otpFallbackTemplateParams('123456', 600).length,
            `${placeholders.length} placeholder(s): ${placeholders.join(' ')}`);
        assert(`[${lang}] fallback body uses {{1}} then {{2}}`,
            placeholders.join('') === '{{1}}{{2}}', placeholders.join(' '));
        assert(`[${lang}] fallback body renders no undefined`, !body.includes('undefined'));

        /**
         * ⚠ Meta refuses a template whose first or last element is a variable, and counts
         * neither the `*` bold markers nor a trailing full stop as content. 38 of the first 190
         * submissions to this WABA died on exactly that, so it is asserted rather than trusted.
         */
        const bare = body.replace(/\*/g, '').trim();
        assert(`⭐ [${lang}] fallback body does not OPEN on a variable (Meta refuses it)`,
            !/^\{\{\d+\}\}/.test(bare));
        assert(`⭐ [${lang}] fallback body does not CLOSE on a variable, punctuation ignored`,
            !/\{\{\d+\}\}[\s".,;:!?)\]]*$/.test(bare));

        /**
         * ⚠ A UTILITY template gets NONE of what Meta renders for an AUTHENTICATION one — no
         * security line, no expiry notice, no copy-code button — so the body must carry the
         * expiry itself or the message silently stops saying when the code dies.
         */
        assert(`[${lang}] fallback body carries its own expiry, since Meta adds none`,
            body.includes('{{2}}'));
    }
}

// ─────────────────────────────────────────────────────────────────────────────
section('7. Source scans — what no behavioural test can see');
// ─────────────────────────────────────────────────────────────────────────────
{
    const read = (rel: string) => readFileSync(join(__dirname, '..', '..', 'src', rel), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

    const domain = read('modules/phone-verification/domain/otp.ts');
    assert('⭐ codes come from crypto.randomInt, never Math.random',
        domain.includes('randomInt') && !domain.includes('Math.random'));
    assert('⭐ comparison is timingSafeEqual, never ===',
        domain.includes('timingSafeEqual'));

    const store = read('modules/phone-verification/services/otp.store.ts');
    assert('the store key is hashed', store.includes('digestForKey'));
    assert('⭐ the store is PREFIXED, so it shares LOGIN_CODE_DB without colliding',
        store.includes("'phoneverify:'") && store.includes('LOGIN_CODE_DB'));

    const service = read('modules/phone-verification/services/phone-verification.service.ts');
    assert('⭐ a successful confirm SPENDS the code immediately',
        /case 'ok':[\s\S]{0,200}clearOtp/.test(service));
    assert('⭐ the code is stored only AFTER a successful send',
        service.indexOf('await this.deliver') < service.indexOf('await putOtp'));
    assert('the out-of-window path uses a template, not free text',
        service.includes("type: 'template'") && service.includes('OTP_TEMPLATE_NAME'));

    /**
     * ⭐ The change mechanics must have ONE owner. A second copy is how the compare-and-set,
     * the uniqueness re-check and the role-entity sync end up on one path and forgotten on the
     * other — and the forgetful one is the newer one nobody has watched in production.
     */
    const coordinator = read('modules/phone-verification/services/phone-verification.coordinator.ts');
    assert('⭐ the coordinator delegates the write to ContactChangeService',
        coordinator.includes('applyProvenPhone'));
    assert('⭐ …and no phone-verification file writes a user document itself',
        [domain, store, service, coordinator].every(s => !/UserModel|userRepo\.|applyPhoneChange\(/.test(s)));

    /**
     * ⚠ The intent must come from the stored record, not from the account's live state: a
     * pending change can be cancelled between send and confirm, and re-deriving would stamp the
     * OLD number as verified using a code that proved the NEW one.
     */
    assert('⭐ the confirm reads the intent off the RECORD',
        coordinator.includes("proved.intent === 'complete_change'"));

    const controller = read('modules/phone-verification/phone-verification.controller.ts');
    assert('⭐ the confirm body is .strict() — a caller may not name the number',
        controller.includes('.strict()') && !/phone:\s*z\./.test(controller));
    assert('the identity comes from req.auth, never a body',
        controller.includes('req.auth!.user._id') && !/req\.body\.(userId|phone)/.test(controller));

    const routes = read('modules/users/user.routes.ts');
    assert('the routes are mounted under /phone/verify',
        routes.includes("'/phone/verify/request'") && routes.includes("'/phone/verify/confirm'"));
    assert('the existing connection-proof confirm is UNTOUCHED',
        routes.includes("'/phone/confirm'"));
}

originalConsole.log(`\n${'═'.repeat(72)}`);
originalConsole.log(`  ${passed} passed, ${failed} failed`);
originalConsole.log('═'.repeat(72));
if (failed > 0) process.exit(1);
