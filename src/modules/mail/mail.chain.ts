import { createAppError } from '../../core/errors';
import { ERROR_CODES } from '../../core/error-codes';
import { recordMailSend } from '../system/metrics/metrics';
import { MailLatchConfig, MailProviderName } from './mail.config';
import { IMailProvider, ProviderSendOptions } from './mail.interface';
import {
    classifyMailFailure,
    latchKindFor,
    outcomeLabel,
    shouldLatch,
} from './domain/mail-failure';
import { clearLatch, isLatched, latch, latchSnapshot } from './domain/mail-latch';
import { nextQuotaResetAt } from './domain/quota-window';

/**
 * ChainedMailProvider — several providers, tried in order, first success wins.
 *
 * ── What it is for ───────────────────────────────────────────────────────────
 *
 * Both candidate providers have a free tier measured in **hundreds of messages a day** — Brevo
 * 300/day, Resend 100/day and 3 000/month — and this platform's notification stacks send on
 * every order, shipment transition, booking and password reset. Picking one just moves the
 * ceiling. The chain **adds the allowances together**: Brevo's larger daily bucket in front,
 * Resend behind it, and SMTP last as the member with no API quota at all.
 *
 * ── The two things it does that a geocoding chain does not ───────────────────
 *
 * This is deliberately NOT a copy of {@link ChainedGeocodingProvider}, and the differences are
 * decisions rather than drift:
 *
 * 1. **It LATCHES.** Geocoding fails over per request and forgets. Here, a provider that says
 *    "your allowance is spent" is telling us something that stays true until its window rolls
 *    over — so asking it again on the next send is a guaranteed-wasted round trip, and with a
 *    300/day cap against a few thousand sends that is thousands of them. `domain/mail-latch.ts`
 *    remembers; `domain/quota-window.ts` decides until when.
 *
 * 2. **It fails over on an AUTH failure, which geocoding refuses to do.** That refusal is
 *    well-argued there — quietly serving from the reserve is how a deployment runs for months on
 *    half its capacity with nobody aware — and the argument does not survive the change of
 *    subject. A geocoding request that fails costs an address lookup; a mail send that fails
 *    costs somebody their password reset, and they have no way to tell that the platform is
 *    broken rather than ignoring them. So the chain moves on, **and refuses to go quiet about
 *    it**: an `auth` verdict is never latched, so every subsequent send re-tries the misconfigured
 *    provider, logs at `error`, and increments `jovimall_mail_sends_total{outcome="auth_failed"}`.
 *    The cost is one wasted round trip per send while a key is wrong; the property bought is that
 *    a wrong key can never be silent.
 *
 * ── The rule that outranks the latch ─────────────────────────────────────────
 *
 * ⚠ **A latch may never be the reason a message is not sent.** Once the unlatched providers are
 * exhausted the chain tries the latched ones too, in chain order. A latch is a *guess* about a
 * counter on somebody else's server, derived from one earlier refusal; the provider may have been
 * upgraded, the window may have rolled over early, our clock may be wrong. Dropping a message on
 * the strength of that guess is not a trade worth making to save one API call — see
 * `domain/mail-latch.ts`.
 *
 * ── What it reports when everything fails ────────────────────────────────────
 *
 * `MAIL_ALL_PROVIDERS_FAILED`, carrying each provider's own verdict in `details.attempts`. Not
 * the last error alone: with a chain, "Resend rejected the message" is a misleading summary of a
 * run where Brevo was out of quota and SMTP's password had expired, and the operator needs all
 * three lines to act.
 */
export class ChainedMailProvider implements IMailProvider {
    constructor(
        private readonly providers: IMailProvider[],
        private readonly latchConfig: MailLatchConfig,
    ) {
        if (providers.length === 0) {
            // A construction-time programming error rather than a runtime fault, but it still
            // goes through createAppError: the ESLint ban on `throw new Error()` is absolute
            // here precisely so no path can produce an error the global handler cannot normalise.
            throw createAppError(
                ERROR_CODES.MAIL_PROVIDER_NOT_CONFIGURED,
                500,
                'ChainedMailProvider requires at least one provider',
            );
        }
    }

    /**
     * The FIRST provider's name — for logging and `getMailProviderType()` only.
     *
     * Never taken as "the provider that sent this message": with a latch in play, most sends
     * during an exhausted day go out through the second member. Nothing persists this value.
     */
    get name(): MailProviderName {
        return this.providers[0].name;
    }

    /** The chain, in order — for the operations surface and for the tests. */
    get chain(): MailProviderName[] {
        return this.providers.map(p => p.name);
    }

    async sendEmail(options: ProviderSendOptions): Promise<void> {
        const now = new Date();

        /**
         * Unlatched first, then the latched ones as a last resort — one ordered list rather than
         * two passes, so there is exactly one loop and the "try them anyway" rule cannot be
         * deleted by someone tidying a nested retry away.
         */
        const latchedNames = new Set(
            this.providers.filter(p => isLatched(p.name, now)).map(p => p.name),
        );
        const order = [
            ...this.providers.filter(p => !latchedNames.has(p.name)),
            ...this.providers.filter(p => latchedNames.has(p.name)),
        ];

        const attempts: Array<{ provider: string; code: string | null; message: string }> = [];

        for (const provider of order) {
            const wasLatched = latchedNames.has(provider.name);
            try {
                await provider.sendEmail(options);
                recordMailSend(provider.name, 'sent');
                if (wasLatched) {
                    // The guess was wrong and is now proven wrong — the allowance came back
                    // early, or the plan changed. Nothing clears it explicitly: the next
                    // `isLatched` read is what matters, and leaving a stale latch in place would
                    // keep pushing this provider to the back of the order for no reason.
                    console.warn(
                        `[Mail] '${provider.name}' succeeded while latched — releasing the latch early`,
                    );
                    clearLatch(provider.name);
                }
                return;
            } catch (error) {
                const failure = classifyMailFailure(error);
                attempts.push({
                    provider: provider.name,
                    code: failure.code,
                    message: failure.message,
                });

                recordMailSend(provider.name, outcomeLabel(failure.kind));
                this.applyLatch(provider.name, failure.kind, failure.quotaPeriod, failure.code, now);

                /**
                 * An auth failure is logged at `error` rather than `warn`, and that asymmetry is
                 * the entire visibility half of "we fail over on auth". Everything else the chain
                 * absorbs is expected operation — running out of a free tier is what a free tier
                 * is for — but a refused credential is a fault somebody has to fix, and it is
                 * about to be invisible because the message goes out anyway.
                 */
                const log = failure.kind === 'auth' ? console.error : console.warn;
                log(
                    `[Mail] '${provider.name}' failed over (${failure.kind}): ${failure.code ?? 'unclassified'}`,
                    failure.message,
                );
            }
        }

        throw createAppError(
            ERROR_CODES.MAIL_ALL_PROVIDERS_FAILED,
            502,
            `Every mail provider failed: ${attempts.map(a => `${a.provider}=${a.code ?? 'unclassified'}`).join(', ')}`,
            { attempts },
        );
    }

    /**
     * Ask every member to prove it can reach its backend; resolve if ANY can.
     *
     * ⚠ Throwing when a *single* member fails would be the obvious implementation and is wrong:
     * the whole premise of a chain is that one member being unusable is survivable, so a probe
     * that goes red on it reports an outage the platform does not have. It throws only when no
     * member can deliver — which is the condition an operator actually needs woken for — and
     * names every failure, because "which one is broken" is the next question either way.
     */
    async verify(): Promise<void> {
        const failures: string[] = [];

        for (const provider of this.providers) {
            try {
                await provider.verify();
                return;
            } catch (error) {
                failures.push(`${provider.name}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }

        throw createAppError(
            ERROR_CODES.MAIL_ALL_PROVIDERS_FAILED,
            502,
            `No mail provider could be verified — ${failures.join(' | ')}`,
            { failures },
        );
    }

    /** Live latch state, for `/system/integrations`. */
    describeLatches(): ReturnType<typeof latchSnapshot> {
        return latchSnapshot();
    }

    // ── internals ──────────────────────────────────────────────────────────────

    private applyLatch(
        provider: MailProviderName,
        kind: ReturnType<typeof classifyMailFailure>['kind'],
        quotaPeriod: ReturnType<typeof classifyMailFailure>['quotaPeriod'],
        code: string | null,
        now: Date,
    ): void {
        if (!shouldLatch(kind)) return;

        const latchKind = latchKindFor(kind);
        const until = latchKind === 'quota'
            // The provider's own word on which window it exhausted beats our configured guess —
            // Resend says, Brevo does not. See `RESEND_QUOTA_PERIOD`.
            ? nextQuotaResetAt(now, quotaPeriod ?? this.latchConfig.quotaResetPeriod, this.latchConfig.quotaResetTimezone)
            : new Date(now.getTime() + this.latchConfig.cooldownMs);

        latch({
            provider,
            kind: latchKind,
            until,
            latchedAt: now,
            reason: code ?? 'unclassified',
        });

        console.warn(
            `[Mail] '${provider}' latched (${latchKind}) until ${until.toISOString()} — ${code ?? 'unclassified'}`,
        );
    }
}
