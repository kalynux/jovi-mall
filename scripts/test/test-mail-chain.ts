/**
 * test:mail-chain — the multi-provider mail failover chain. **No DB, no network.**
 *
 * Every provider is a fake implementing `IMailProvider`, and the two HTTP adapters are driven
 * against a fake `fetch`. That is not a convenience: the whole subject of this suite is what
 * happens when a provider says *"your allowance is spent"*, and nobody can produce that on
 * demand against a live account without deliberately burning a day's quota — which, on a free
 * tier of 300, means burning the platform's ability to send mail for a day to test that it can.
 *
 * ── What the chain exists for ────────────────────────────────────────────────
 *
 * Brevo's free tier is 300 emails/day; Resend's is 100/day and 3 000/month. This platform's four
 * notification stacks send on every order, shipment transition, booking and password reset.
 * Picking one provider just moves the ceiling; the chain adds the allowances together, latches a
 * provider out when it reports exhaustion, and returns to it when its window rolls over.
 *
 * ── The rules under test, and why each is a rule ─────────────────────────────
 *
 *  1. **Quota latches; a rate limit does not.** Both arrive as a 429 at Resend and they mean
 *     completely different things. Latching a per-second limit until midnight throws away the
 *     primary's whole remaining allowance.
 *  2. **An auth failure fails over and is NEVER latched.** The message still goes out (a
 *     password reset is worth more than a clean signal) and the misconfiguration stays loud,
 *     because every subsequent send re-tries the broken provider and logs.
 *  3. ⭐ **A latch may never be the reason a message is not sent.** When every provider is
 *     latched the chain tries them anyway. A latch is a guess about a counter on somebody
 *     else's server.
 *  4. **`console` can never be a chain member.** It cannot fail, so it would absorb every
 *     message the real providers refused and report success — the exact silent non-delivery
 *     this module was built to end.
 *  5. **The reset boundary is a calendar boundary, not `now + 24h`.** An allowance exhausted at
 *     23:50 must come back ten minutes later, not the following evening.
 *
 * Run: npm run test:mail-chain
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { createAppError } from '../../src/core/errors';
import { ERROR_CODES } from '../../src/core/error-codes';
import { ChainedMailProvider } from '../../src/modules/mail/mail.chain';
import { createMailProvider } from '../../src/modules/mail/mail.factory';
import {
    MailConfig,
    MailLatchConfig,
    MailProviderName,
    MAIL_PROVIDERS,
} from '../../src/modules/mail/mail.config';
import { IMailProvider, ProviderSendOptions } from '../../src/modules/mail/mail.interface';
import {
    classifyMailFailure,
    latchKindFor,
    outcomeLabel,
    shouldLatch,
} from '../../src/modules/mail/domain/mail-failure';
import {
    clearLatch,
    isLatched,
    latch,
    latchSnapshot,
} from '../../src/modules/mail/domain/mail-latch';
import { nextQuotaResetAt } from '../../src/modules/mail/domain/quota-window';
import { formatMailAddress, parseMailAddress } from '../../src/modules/mail/domain/mail-address';
import { BrevoMailProvider } from '../../src/modules/mail/providers/brevo.provider';
import { ResendMailProvider } from '../../src/modules/mail/providers/resend.provider';

const originalConsole = {
    log: console.log.bind(console),
    error: console.error.bind(console),
    warn: console.warn.bind(console),
};

let passed = 0;
let failed = 0;

function assert(name: string, ok: boolean, detail?: string): void {
    if (ok) {
        originalConsole.log(`  ✅ ${name}`);
        passed++;
    } else {
        originalConsole.error(`  ❌ FAIL: ${name}${detail ? `\n       ${detail}` : ''}`);
        failed++;
    }
}

function section(title: string): void {
    originalConsole.log(`\n── ${title} ${'─'.repeat(Math.max(0, 72 - title.length))}`);
}

/** Silence the chain's own warn/error lines while a case runs; they are expected output. */
async function quietly<T>(body: () => Promise<T>): Promise<T> {
    const { warn, error, log } = console;
    console.warn = () => {};
    console.error = () => {};
    console.log = () => {};
    try {
        return await body();
    } finally {
        console.warn = warn;
        console.error = error;
        console.log = log;
    }
}

const MESSAGE: ProviderSendOptions = {
    to: 'customer@example.com',
    from: 'Jovi Mall <noreply@jovimall.com>',
    subject: 'Your order',
    html: '<p>Hello</p>',
};

const LATCH_CONFIG: MailLatchConfig = {
    quotaResetPeriod: 'daily',
    quotaResetTimezone: 'UTC',
    cooldownMs: 300_000,
};

type Behaviour = 'ok' | 'quota' | 'quota_monthly' | 'rate_limit' | 'unavailable' | 'auth' | 'rejected' | 'raw';

class FakeProvider implements IMailProvider {
    sent = 0;
    attempts = 0;

    constructor(
        readonly name: MailProviderName,
        private behaviour: Behaviour,
        private readonly verifyBehaviour: 'ok' | 'fail' = 'ok',
    ) {}

    setBehaviour(behaviour: Behaviour): void {
        this.behaviour = behaviour;
    }

    async sendEmail(_options: ProviderSendOptions): Promise<void> {
        this.attempts++;
        switch (this.behaviour) {
            case 'ok':
                this.sent++;
                return;
            case 'quota':
                throw createAppError(ERROR_CODES.MAIL_PROVIDER_QUOTA_EXCEEDED, 429, 'out of allowance');
            case 'quota_monthly':
                throw createAppError(
                    ERROR_CODES.MAIL_PROVIDER_QUOTA_EXCEEDED, 429, 'out of allowance',
                    { quotaPeriod: 'monthly' },
                );
            case 'rate_limit':
                throw createAppError(ERROR_CODES.MAIL_PROVIDER_RATE_LIMITED, 429, 'slow down');
            case 'unavailable':
                throw createAppError(ERROR_CODES.MAIL_PROVIDER_UNAVAILABLE, 503, 'unreachable');
            case 'auth':
                throw createAppError(ERROR_CODES.MAIL_PROVIDER_AUTH_FAILED, 502, 'bad key');
            case 'rejected':
                throw createAppError(ERROR_CODES.MAIL_SEND_REJECTED, 502, 'unverified domain');
            case 'raw':
                // Deliberately NOT an AppError — the "an adapter threw something nobody
                // classified" case, which must still fail over.
                throw new TypeError('cannot read property of undefined');
        }
    }

    async verify(): Promise<void> {
        if (this.verifyBehaviour === 'fail') throw new Error(`${this.name} unreachable`);
    }
}

/** Swap `globalThis.fetch` for one canned response, and put it back afterwards. */
async function withFetch(
    response: { status: number; body?: unknown },
    body: () => Promise<void>,
): Promise<void> {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => ({
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        json: async () => response.body ?? {},
    })) as unknown as typeof fetch;
    try {
        await body();
    } finally {
        globalThis.fetch = original;
    }
}

/** Run `send` and return the thrown error's code, or null on success. */
async function codeOf(run: () => Promise<void>): Promise<string | null> {
    try {
        await run();
        return null;
    } catch (error) {
        return (error as { code?: string }).code ?? 'UNCLASSIFIED';
    }
}

function baseConfig(overrides: Partial<MailConfig> = {}): MailConfig {
    return {
        provider: 'chain',
        requestTimeoutMs: 1000,
        latch: LATCH_CONFIG,
        ...overrides,
    };
}

async function main(): Promise<void> {
    // ─────────────────────────────────────────────────────────────────────────
    section('1. The reset boundary — calendar, not a rolling window');
    // ─────────────────────────────────────────────────────────────────────────
    {
        const lateEvening = new Date('2026-09-14T23:50:00.000Z');
        const nextDay = nextQuotaResetAt(lateEvening, 'daily', 'UTC');
        assert(
            'an allowance spent at 23:50 returns at midnight, ten minutes later',
            nextDay.toISOString() === '2026-09-15T00:00:00.000Z',
            nextDay.toISOString(),
        );
        assert(
            '…which is the whole reason it is not `now + 24h` — that would cost a full extra day',
            nextDay.getTime() - lateEvening.getTime() < 60 * 60 * 1000,
        );

        assert(
            'a daily boundary rolls the MONTH on the 30th',
            nextQuotaResetAt(new Date('2026-09-30T12:00:00.000Z'), 'daily', 'UTC').toISOString()
                === '2026-10-01T00:00:00.000Z',
        );
        assert(
            'a daily boundary rolls the YEAR on 31 December',
            nextQuotaResetAt(new Date('2026-12-31T12:00:00.000Z'), 'daily', 'UTC').toISOString()
                === '2027-01-01T00:00:00.000Z',
        );
        assert(
            'a monthly boundary lands on the 1st, not 30 days out',
            nextQuotaResetAt(new Date('2026-09-02T12:00:00.000Z'), 'monthly', 'UTC').toISOString()
                === '2026-10-01T00:00:00.000Z',
        );
        assert(
            'a monthly boundary rolls the year in December',
            nextQuotaResetAt(new Date('2026-12-15T12:00:00.000Z'), 'monthly', 'UTC').toISOString()
                === '2027-01-01T00:00:00.000Z',
        );

        /**
         * The timezone is the PROVIDER's accounting day. Asserting a non-UTC zone here is what
         * proves the parameter is actually used — a `nextQuotaResetAt` that ignored it would
         * pass every case above.
         */
        const middayUtc = new Date('2026-09-14T10:00:00.000Z');
        const douala = nextQuotaResetAt(middayUtc, 'daily', 'Africa/Douala');
        assert(
            'the zone is honoured — Africa/Douala is UTC+1, so its midnight lands at 23:00 UTC',
            douala.toISOString() === '2026-09-14T23:00:00.000Z',
            douala.toISOString(),
        );
        assert(
            '…and it differs from the UTC answer, which is what proves the parameter is read',
            douala.getTime() !== nextQuotaResetAt(middayUtc, 'daily', 'UTC').getTime(),
        );
        /**
         * The zone shifts which local day `now` falls on, so an instant late in the UTC day is
         * already tomorrow in Douala and its next boundary is a day further out. Asserted
         * because it is the case that looks like an off-by-one and is not.
         */
        assert(
            '23:50 UTC is already the NEXT day in Douala, so its boundary is a day later',
            nextQuotaResetAt(new Date('2026-09-14T23:50:00.000Z'), 'daily', 'Africa/Douala').toISOString()
                === '2026-09-15T23:00:00.000Z',
        );
        assert(
            'every boundary is strictly in the future',
            [middayUtc, lateEvening].every(instant =>
                nextQuotaResetAt(instant, 'daily', 'Africa/Douala').getTime() > instant.getTime()
                && nextQuotaResetAt(instant, 'monthly', 'UTC').getTime() > instant.getTime()),
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    section('2. Classification — the verdict table');
    // ─────────────────────────────────────────────────────────────────────────
    {
        const table: Array<[string, string, string]> = [
            [ERROR_CODES.MAIL_PROVIDER_QUOTA_EXCEEDED, 'quota', 'quota_exceeded'],
            [ERROR_CODES.MAIL_PROVIDER_RATE_LIMITED, 'rate_limit', 'rate_limited'],
            [ERROR_CODES.MAIL_PROVIDER_UNAVAILABLE, 'unavailable', 'unavailable'],
            [ERROR_CODES.MAIL_PROVIDER_AUTH_FAILED, 'auth', 'auth_failed'],
            [ERROR_CODES.MAIL_SEND_REJECTED, 'rejected', 'rejected'],
        ];
        for (const [code, kind, label] of table) {
            const verdict = classifyMailFailure(createAppError(code as never, 500, 'x'));
            assert(`${code} → ${kind}`, verdict.kind === kind, verdict.kind);
            assert(`${code} → metric outcome "${label}"`, outcomeLabel(verdict.kind) === label);
        }

        assert(
            'an unrecognised throw is "unknown", NOT "rejected" — the chain must still move on',
            classifyMailFailure(new TypeError('boom')).kind === 'unknown',
        );
        assert('a non-Error throw does not crash the classifier', classifyMailFailure('nope').kind === 'unknown');

        assert(
            "Resend's quotaPeriod survives onto the verdict",
            classifyMailFailure(createAppError(
                ERROR_CODES.MAIL_PROVIDER_QUOTA_EXCEEDED, 429, 'x', { quotaPeriod: 'monthly' },
            )).quotaPeriod === 'monthly',
        );
        assert(
            "Brevo's quota refusal carries no period — the chain falls back to configuration",
            classifyMailFailure(createAppError(ERROR_CODES.MAIL_PROVIDER_QUOTA_EXCEEDED, 429, 'x')).quotaPeriod === null,
        );
        assert(
            'a bogus quotaPeriod is ignored rather than trusted',
            classifyMailFailure(createAppError(
                ERROR_CODES.MAIL_PROVIDER_QUOTA_EXCEEDED, 429, 'x', { quotaPeriod: 'weekly' },
            )).quotaPeriod === null,
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    section('3. Which verdicts latch — and the three that must not');
    // ─────────────────────────────────────────────────────────────────────────
    {
        assert('quota latches', shouldLatch('quota'));
        assert('a rate limit latches', shouldLatch('rate_limit'));
        assert('an outage latches', shouldLatch('unavailable'));

        assert(
            '⭐ auth NEVER latches — a wrong key must stay loud on every single send',
            !shouldLatch('auth'),
        );
        assert(
            'a rejected MESSAGE never latches — the provider is fine, the recipient is not',
            !shouldLatch('rejected'),
        );
        assert('an unclassified failure never latches', !shouldLatch('unknown'));

        assert('only quota earns the calendar-boundary latch', latchKindFor('quota') === 'quota');
        assert('a rate limit earns the short cooldown', latchKindFor('rate_limit') === 'cooldown');
        assert('an outage earns the short cooldown', latchKindFor('unavailable') === 'cooldown');
    }

    // ─────────────────────────────────────────────────────────────────────────
    section('4. The latch store');
    // ─────────────────────────────────────────────────────────────────────────
    {
        clearLatch();
        const now = new Date('2026-09-14T10:00:00.000Z');

        assert('nothing is latched to begin with', !isLatched('brevo', now));

        latch({
            provider: 'brevo', kind: 'quota', latchedAt: now,
            until: new Date('2026-09-15T00:00:00.000Z'), reason: 'MAIL_PROVIDER_QUOTA_EXCEEDED',
        });
        assert('a quota latch holds', isLatched('brevo', now));

        /**
         * ⚠ The longer latch wins. A rate limit arriving after an exhausted allowance must not
         * shorten it to five minutes — the allowance is still gone, and re-asking then burns
         * exactly the call the latch existed to save.
         */
        latch({
            provider: 'brevo', kind: 'cooldown', latchedAt: now,
            until: new Date('2026-09-14T10:05:00.000Z'), reason: 'MAIL_PROVIDER_RATE_LIMITED',
        });
        assert(
            '⭐ a shorter latch does NOT shorten a longer one',
            isLatched('brevo', new Date('2026-09-14T10:06:00.000Z')),
        );
        assert(
            '…and the surviving latch is still the quota one',
            latchSnapshot(now).find(l => l.provider === 'brevo')?.kind === 'quota',
        );

        assert('a latch expires on its own boundary', !isLatched('brevo', new Date('2026-09-15T00:00:01.000Z')));

        clearLatch();
        latch({
            provider: 'resend', kind: 'cooldown', latchedAt: now,
            until: new Date('2026-09-14T10:05:00.000Z'), reason: 'MAIL_PROVIDER_UNAVAILABLE',
        });
        assert('the snapshot reports a live latch for the ops surface', latchSnapshot(now).length === 1);
        assert('…and drops expired ones', latchSnapshot(new Date('2026-09-14T11:00:00.000Z')).length === 0);
        clearLatch();
    }

    // ─────────────────────────────────────────────────────────────────────────
    section('5. Failover — the behaviour, against fakes');
    // ─────────────────────────────────────────────────────────────────────────
    {
        clearLatch();
        const brevo = new FakeProvider('brevo', 'quota');
        const resend = new FakeProvider('resend', 'ok');
        const chain = new ChainedMailProvider([brevo, resend], LATCH_CONFIG);

        await quietly(() => chain.sendEmail(MESSAGE));
        assert('an exhausted primary hands the message to the reserve', resend.sent === 1);
        assert('…and the message was NOT dropped', brevo.sent === 0 && resend.sent === 1);
        assert('…and the primary is now latched', isLatched('brevo'));

        const before = brevo.attempts;
        await quietly(() => chain.sendEmail(MESSAGE));
        assert(
            '⭐ the next send SKIPS the latched provider — this is the whole saving',
            brevo.attempts === before,
        );
        assert('…and the reserve carries it', resend.sent === 2);
        clearLatch();
    }

    {
        clearLatch();
        const brevo = new FakeProvider('brevo', 'auth');
        const resend = new FakeProvider('resend', 'ok');
        const chain = new ChainedMailProvider([brevo, resend], LATCH_CONFIG);

        await quietly(() => chain.sendEmail(MESSAGE));
        assert('a refused CREDENTIAL still gets the message delivered', resend.sent === 1);
        assert(
            '⭐ …and does NOT latch, so the misconfiguration cannot go quiet',
            !isLatched('brevo'),
        );

        await quietly(() => chain.sendEmail(MESSAGE));
        assert('…the broken provider is re-tried on every send', brevo.attempts === 2);
        clearLatch();
    }

    {
        clearLatch();
        const brevo = new FakeProvider('brevo', 'quota');
        const resend = new FakeProvider('resend', 'quota');
        const chain = new ChainedMailProvider([brevo, resend], LATCH_CONFIG);

        await quietly(() => codeOf(() => chain.sendEmail(MESSAGE)));
        assert('both providers latch once both report exhaustion', isLatched('brevo') && isLatched('resend'));

        // The load-bearing rule. Everything is latched; the allowance may have come back, our
        // clock may be wrong, the plan may have been upgraded. Try anyway.
        brevo.setBehaviour('ok');
        const attemptsBefore = brevo.attempts;
        await quietly(() => chain.sendEmail(MESSAGE));
        assert(
            '⭐ with EVERY provider latched the chain still tries them — a latch may never drop a message',
            brevo.attempts > attemptsBefore && brevo.sent === 1,
        );
        assert(
            '…and a success while latched releases the latch early',
            !isLatched('brevo'),
        );
        clearLatch();
    }

    {
        clearLatch();
        const brevo = new FakeProvider('brevo', 'raw');
        const resend = new FakeProvider('resend', 'ok');
        const chain = new ChainedMailProvider([brevo, resend], LATCH_CONFIG);

        await quietly(() => chain.sendEmail(MESSAGE));
        assert(
            'an UNCLASSIFIED throw still fails over — one buggy adapter must not stop all mail',
            resend.sent === 1,
        );
        assert('…and never latches, because the verdict could not be read', !isLatched('brevo'));
        clearLatch();
    }

    {
        clearLatch();
        const brevo = new FakeProvider('brevo', 'quota');
        const resend = new FakeProvider('resend', 'auth');
        const smtp = new FakeProvider('smtp', 'rejected');
        const chain = new ChainedMailProvider([brevo, resend, smtp], LATCH_CONFIG);

        let thrown: unknown;
        await quietly(async () => {
            try { await chain.sendEmail(MESSAGE); } catch (e) { thrown = e; }
        });

        assert(
            'every provider failing raises MAIL_ALL_PROVIDERS_FAILED',
            (thrown as { code?: string })?.code === ERROR_CODES.MAIL_ALL_PROVIDERS_FAILED,
        );
        const attempts = (thrown as { details?: { attempts?: unknown[] } })?.details?.attempts ?? [];
        assert(
            '⭐ …carrying EVERY provider\'s own verdict, not just the last one',
            attempts.length === 3,
            `got ${attempts.length}`,
        );
        assert('…all three were actually tried', brevo.attempts === 1 && resend.attempts === 1 && smtp.attempts === 1);
        clearLatch();
    }

    {
        clearLatch();
        const brevo = new FakeProvider('brevo', 'rate_limit');
        const resend = new FakeProvider('resend', 'ok');
        const chain = new ChainedMailProvider([brevo, resend], { ...LATCH_CONFIG, cooldownMs: 300_000 });

        await quietly(() => chain.sendEmail(MESSAGE));
        const state = latchSnapshot().find(l => l.provider === 'brevo');
        assert('a rate limit latches for the COOLDOWN, not to midnight', state?.kind === 'cooldown');
        assert(
            '…and the cooldown is minutes, not hours',
            !!state && state.until.getTime() - state.latchedAt.getTime() === 300_000,
        );
        clearLatch();
    }

    // ─────────────────────────────────────────────────────────────────────────
    section('6. verify() — a chain is not down because one member is');
    // ─────────────────────────────────────────────────────────────────────────
    {
        const okChain = new ChainedMailProvider(
            [new FakeProvider('brevo', 'ok', 'fail'), new FakeProvider('resend', 'ok', 'ok')],
            LATCH_CONFIG,
        );
        assert('one member failing does not fail the probe', await codeOf(() => okChain.verify()) === null);

        const deadChain = new ChainedMailProvider(
            [new FakeProvider('brevo', 'ok', 'fail'), new FakeProvider('resend', 'ok', 'fail')],
            LATCH_CONFIG,
        );
        assert(
            'no member reachable DOES fail the probe',
            await codeOf(() => deadChain.verify()) === ERROR_CODES.MAIL_ALL_PROVIDERS_FAILED,
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    section('7. The factory');
    // ─────────────────────────────────────────────────────────────────────────
    {
        const full = createMailProvider(baseConfig({
            chain: ['brevo', 'resend', 'smtp'],
            brevo: { apiKey: 'k' },
            resend: { apiKey: 'k' },
            smtp: { host: 'localhost', port: 587 },
        })) as ChainedMailProvider;
        assert('a fully configured chain builds in order', full.chain.join(',') === 'brevo,resend,smtp');

        const partial = createMailProvider(baseConfig({
            chain: ['brevo', 'resend', 'smtp'],
            resend: { apiKey: 'k' },
        })) as ChainedMailProvider;
        assert(
            'a member with no credentials is SKIPPED, not fatal',
            partial.chain.join(',') === 'resend',
        );

        const withConsole = createMailProvider(baseConfig({
            chain: ['brevo', 'console', 'resend'],
            brevo: { apiKey: 'k' },
            resend: { apiKey: 'k' },
        })) as ChainedMailProvider;
        assert(
            '⭐ `console` is DROPPED from a chain — it cannot fail, so it would swallow everything after it',
            withConsole.chain.join(',') === 'brevo,resend',
        );

        const empty = createMailProvider(baseConfig({ chain: ['brevo', 'resend'] }));
        assert(
            'a chain with no usable member degrades to console rather than crashing the boot',
            empty.name === 'console',
        );

        assert(
            'a MISSPELT provider is fatal, even inside a chain',
            await codeOf(async () => {
                createMailProvider(baseConfig({ chain: ['brevo', 'brevoo'] as MailProviderName[], brevo: { apiKey: 'k' } }));
            }) === ERROR_CODES.CONFIG_INVALID_MAIL_PROVIDER,
        );

        assert(
            'a SINGLE provider with no credential is fatal — nothing is skipped when nothing follows',
            await codeOf(async () => { createMailProvider(baseConfig({ provider: 'brevo' })); })
                === ERROR_CODES.MAIL_PROVIDER_NOT_CONFIGURED,
        );

        assert(
            'an empty chain is refused at construction',
            await codeOf(async () => { new ChainedMailProvider([], LATCH_CONFIG); })
                === ERROR_CODES.MAIL_PROVIDER_NOT_CONFIGURED,
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    section('8. Brevo adapter — its refusals mapped');
    // ─────────────────────────────────────────────────────────────────────────
    {
        const brevo = new BrevoMailProvider({ apiKey: 'k' }, 1000);
        const send = () => brevo.sendEmail(MESSAGE);

        await withFetch({ status: 201 }, async () => {
            assert('a 201 is a success', await codeOf(send) === null);
        });

        await withFetch({ status: 402, body: { code: 'not_enough_credits' } }, async () => {
            assert('402 → quota exceeded', await codeOf(send) === ERROR_CODES.MAIL_PROVIDER_QUOTA_EXCEEDED);
        });

        /**
         * ⭐ The case a status-only rule would miss. Brevo documents `not_enough_credits` at 400
         * as well as 402, and a 400 read as "malformed request" would be classified `rejected` —
         * which does not latch, so the chain would re-ask an exhausted provider on every send
         * for the rest of the day.
         */
        await withFetch({ status: 400, body: { code: 'not_enough_credits' } }, async () => {
            assert(
                '⭐ 400 + not_enough_credits is ALSO quota — the code is evidence, not just the status',
                await codeOf(send) === ERROR_CODES.MAIL_PROVIDER_QUOTA_EXCEEDED,
            );
        });

        await withFetch({ status: 429, body: {} }, async () => {
            assert(
                '429 is a RATE LIMIT here, not exhaustion — Brevo allows 1 000 rps on this endpoint',
                await codeOf(send) === ERROR_CODES.MAIL_PROVIDER_RATE_LIMITED,
            );
        });

        await withFetch({ status: 401, body: { code: 'unauthorized' } }, async () => {
            assert('401 → auth failed', await codeOf(send) === ERROR_CODES.MAIL_PROVIDER_AUTH_FAILED);
        });

        await withFetch({ status: 400, body: { code: 'account_under_validation' } }, async () => {
            assert(
                'an account under validation is auth, not quota — it does not come back at midnight',
                await codeOf(send) === ERROR_CODES.MAIL_PROVIDER_AUTH_FAILED,
            );
        });

        await withFetch({ status: 503, body: {} }, async () => {
            assert('5xx → unavailable', await codeOf(send) === ERROR_CODES.MAIL_PROVIDER_UNAVAILABLE);
        });

        await withFetch({ status: 400, body: { code: 'invalid_parameter' } }, async () => {
            assert('a malformed request → rejected', await codeOf(send) === ERROR_CODES.MAIL_SEND_REJECTED);
        });

        await withFetch({ status: 400, body: 'not json at all' }, async () => {
            assert('an unparseable error body still classifies', await codeOf(send) === ERROR_CODES.MAIL_SEND_REJECTED);
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    section('9. Resend adapter — three conditions share one status');
    // ─────────────────────────────────────────────────────────────────────────
    {
        const resend = new ResendMailProvider({ apiKey: 'k' }, 1000);
        const send = () => resend.sendEmail(MESSAGE);

        await withFetch({ status: 200, body: { id: 'x' } }, async () => {
            assert('a 200 is a success', await codeOf(send) === null);
        });

        /**
         * ⭐ The three-way 429. A chain switching on status alone would latch Resend out until
         * midnight every time it sent two messages in the same second.
         */
        await withFetch({ status: 429, body: { name: 'daily_quota_exceeded' } }, async () => {
            assert('429 daily_quota_exceeded → quota', await codeOf(send) === ERROR_CODES.MAIL_PROVIDER_QUOTA_EXCEEDED);
        });
        await withFetch({ status: 429, body: { name: 'monthly_quota_exceeded' } }, async () => {
            assert('429 monthly_quota_exceeded → quota', await codeOf(send) === ERROR_CODES.MAIL_PROVIDER_QUOTA_EXCEEDED);
        });
        await withFetch({ status: 429, body: { name: 'rate_limit_exceeded' } }, async () => {
            assert(
                '⭐ 429 rate_limit_exceeded → rate limit, on the SAME status as the two above',
                await codeOf(send) === ERROR_CODES.MAIL_PROVIDER_RATE_LIMITED,
            );
        });

        // And the period travels, so the latch releases at the right boundary without config.
        await withFetch({ status: 429, body: { name: 'monthly_quota_exceeded' } }, async () => {
            let thrown: unknown;
            try { await send(); } catch (e) { thrown = e; }
            assert(
                '⭐ a monthly exhaustion carries quotaPeriod:"monthly" — it must not retry at midnight',
                classifyMailFailure(thrown).quotaPeriod === 'monthly',
            );
        });
        await withFetch({ status: 429, body: { name: 'daily_quota_exceeded' } }, async () => {
            let thrown: unknown;
            try { await send(); } catch (e) { thrown = e; }
            assert('a daily exhaustion carries quotaPeriod:"daily"', classifyMailFailure(thrown).quotaPeriod === 'daily');
        });

        await withFetch({ status: 403, body: { name: 'email_above_quota' } }, async () => {
            assert('403 email_above_quota → quota', await codeOf(send) === ERROR_CODES.MAIL_PROVIDER_QUOTA_EXCEEDED);
        });

        /**
         * ⭐ The commonest first-run failure on Resend, and the one a naive mapping gets exactly
         * backwards: an unverified sending domain is a 403, and reporting it as a credential
         * problem sends an operator to rotate a key that was never wrong.
         */
        await withFetch({ status: 403, body: { name: 'validation_error', message: 'The jovimall.com domain is not verified' } }, async () => {
            assert(
                '⭐ 403 validation_error (unverified domain) → REJECTED, not auth',
                await codeOf(send) === ERROR_CODES.MAIL_SEND_REJECTED,
            );
        });

        await withFetch({ status: 401, body: { name: 'missing_api_key' } }, async () => {
            assert('401 missing_api_key → auth failed', await codeOf(send) === ERROR_CODES.MAIL_PROVIDER_AUTH_FAILED);
        });
        await withFetch({ status: 403, body: { name: 'suspended_api_key' } }, async () => {
            assert('403 suspended_api_key → auth failed', await codeOf(send) === ERROR_CODES.MAIL_PROVIDER_AUTH_FAILED);
        });
        await withFetch({ status: 503, body: { name: 'service_unavailable' } }, async () => {
            assert('503 → unavailable', await codeOf(send) === ERROR_CODES.MAIL_PROVIDER_UNAVAILABLE);
        });
        await withFetch({ status: 422, body: { name: 'missing_required_field' } }, async () => {
            assert('422 → rejected', await codeOf(send) === ERROR_CODES.MAIL_SEND_REJECTED);
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    section('10. Sender parsing — Brevo needs the split, Resend does not');
    // ─────────────────────────────────────────────────────────────────────────
    {
        const display = parseMailAddress('Jovi Mall <noreply@jovimall.com>');
        assert('a display-name form splits', display.email === 'noreply@jovimall.com' && display.name === 'Jovi Mall');

        const bare = parseMailAddress('noreply@jovimall.com');
        assert('a bare address has no name', bare.email === 'noreply@jovimall.com' && bare.name === undefined);

        assert(
            'quotes are stripped — Brevo renders them literally otherwise',
            parseMailAddress('"Jovi Mall" <a@b.c>').name === 'Jovi Mall',
        );
        assert('whitespace is trimmed', parseMailAddress('  a@b.c  ').email === 'a@b.c');
        assert(
            'an empty display name yields no name rather than an empty one',
            parseMailAddress('<a@b.c>').name === undefined,
        );
        assert(
            'an unparseable value passes THROUGH — the provider names the real problem',
            parseMailAddress('not an address').email === 'not an address',
        );
        assert('the round trip is stable', formatMailAddress(display) === 'Jovi Mall <noreply@jovimall.com>');
        assert('…and a bare address round-trips bare', formatMailAddress(bare) === 'noreply@jovimall.com');
    }

    // ─────────────────────────────────────────────────────────────────────────
    section('11. Source scans — the invariants no behaviour can reach');
    // ─────────────────────────────────────────────────────────────────────────
    {
        /**
         * ⚠ **Comments are stripped before every scan below**, following `test:connections`.
         * The headers in this module are mostly tombstones — they name the very constructs the
         * scans forbid, in order to explain why they were removed — and a scan that forced
         * their deletion would have made the codebase worse to protect a regex.
         */
        const stripComments = (source: string): string =>
            source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

        const read = (rel: string) =>
            stripComments(readFileSync(join(__dirname, '..', '..', 'src', rel), 'utf8'));

        /**
         * ⚠ The latch is per-PROCESS in-memory state, so it is only shared if the chain holding
         * it is shared. `MailService` is constructed with `new MailService()` at eight call
         * sites; if it built its own provider, Brevo running out would be re-discovered eight
         * times over, once per subsystem, on every send. No behavioural test can see that —
         * every one of them would pass.
         */
        const service = read('modules/mail/mail.service.ts');
        assert(
            '⭐ MailService reaches the provider through the SINGLETON',
            service.includes('getMailProvider()'),
        );
        assert(
            '⭐ …and constructs no provider of its own',
            !/new\s+(Smtp|Console|Brevo|Resend|Chained)MailProvider/.test(service),
        );

        /**
         * The provider vocabulary must live in one place. A second `MAIL_PROVIDER ===` branch is
         * how `smtp` and `console` came to be decided in the service constructor in the first
         * place, which is what made adding a third provider a change to eight call sites.
         */
        assert(
            'provider selection happens only in the factory',
            !service.includes('MAIL_PROVIDER'),
        );

        /**
         * Every adapter must CLASSIFY. An adapter that lets a raw error escape is not merely
         * less informative — the chain reads `error.code` to decide whether to latch, so an
         * unclassified throw makes an exhausted provider indistinguishable from a broken one.
         */
        for (const file of ['brevo.provider.ts', 'resend.provider.ts', 'smtp.provider.ts']) {
            const source = read(`modules/mail/providers/${file}`);
            assert(
                `${file} classifies its failures onto the shared codes`,
                source.includes('MAIL_PROVIDER_QUOTA_EXCEEDED') || source.includes('MAIL_PROVIDER_RATE_LIMITED'),
            );
            assert(
                `${file} never throws a bare Error`,
                !/throw\s+new\s+Error\(/.test(source),
            );
        }

        /**
         * The chain must contain no provider names. The moment it does, the classification layer
         * has stopped being the seam and a fourth provider means editing the chain.
         */
        const chainSource = read('modules/mail/mail.chain.ts');
        assert(
            'the chain names no provider at all — classification is the seam, not a branch',
            MAIL_PROVIDERS.filter(n => n !== 'console').every(n => !chainSource.includes(n)),
            MAIL_PROVIDERS.filter(n => n !== 'console' && chainSource.includes(n)).join(', '),
        );

        assert(
            'the chain tries latched providers last rather than excluding them',
            chainSource.includes('latchedNames.has') && chainSource.includes('...this.providers.filter'),
        );

        /** `console` must stay out of any chain — asserted where the decision lives. */
        const factorySource = read('modules/mail/mail.factory.ts');
        assert(
            "the factory refuses 'console' as a chain member",
            /name\s*!==\s*'console'/.test(factorySource),
        );

        assert(
            'MAIL_PROVIDERS covers every adapter the factory can build',
            MAIL_PROVIDERS.length === 4 && MAIL_PROVIDERS.every(n => factorySource.includes(`case '${n}'`)),
        );
    }

    originalConsole.log(`\n${'═'.repeat(76)}`);
    originalConsole.log(`  ${passed} passed, ${failed} failed`);
    originalConsole.log('═'.repeat(76));
    if (failed > 0) process.exit(1);
}

main().catch((error) => {
    originalConsole.error(error);
    process.exit(1);
});
