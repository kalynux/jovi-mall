/**
 * verify:mail-providers — the mail chain against the REAL provider APIs.
 *
 * The counterpart to `verify:geocoding-providers`, and it exists for the same reason: an
 * adapter's field mapping is a claim about somebody else's API, and a fake `fetch` cannot
 * falsify it. `test:mail-chain` (110, offline) already pins every classification rule against
 * canned responses — what it structurally cannot see is whether Brevo actually accepts the
 * `sender: { email, name }` object this code builds, or whether Resend actually parses the
 * RFC 5322 string it is handed instead.
 *
 * ── The two modes, and why sending is OPT-IN ─────────────────────────────────
 *
 *   npm run verify:mail-providers                        credentials + config. Sends NOTHING.
 *   npm run verify:mail-providers -- --send=a@b.c        ALSO sends one real message per
 *                                                        provider, plus one through the chain.
 *
 * The default mode is read-only because ADR-014 D-2's rule applies here too: a diagnostic may
 * not consume a quota a real request needs. On a 300/day Brevo free tier, a verify suite that
 * sent on every run would be spending roughly one percent of the platform's daily sending
 * capacity to tell you it works. `--send` is a deliberate act with a named recipient; there is
 * no default address, so nobody can be mailed by running this carelessly.
 *
 * ── It SKIPS GREEN on a provider with no credentials ─────────────────────────
 * …and says so loudly. A developer machine with no keys must be able to run this, and a skip
 * that reads as a pass without an explanation is how a suite quietly stops covering anything.
 *
 * Run: npm run verify:mail-providers [-- --send=you@example.com]
 */
import 'dotenv/config';
import { mailConfig } from '../../src/modules/mail/mail.instance';
import { MailService } from '../../src/modules/mail/mail.service';
import { BrevoMailProvider } from '../../src/modules/mail/providers/brevo.provider';
import { ResendMailProvider } from '../../src/modules/mail/providers/resend.provider';
import { SmtpMailProvider } from '../../src/modules/mail/providers/smtp.provider';
import { IMailProvider } from '../../src/modules/mail/mail.interface';
import { MailProviderName } from '../../src/modules/mail/mail.config';
import { classifyMailFailure } from '../../src/modules/mail/domain/mail-failure';
import { metricsRegistry } from '../../src/modules/system/metrics/metrics';

const originalConsole = {
    log: console.log.bind(console),
    error: console.error.bind(console),
    warn: console.warn.bind(console),
};

let passed = 0;
let failed = 0;
let skipped = 0;

function assert(name: string, ok: boolean, detail?: string): void {
    if (ok) {
        originalConsole.log(`  ✅ ${name}`);
        passed++;
    } else {
        originalConsole.error(`  ❌ FAIL: ${name}${detail ? `\n       ${detail}` : ''}`);
        failed++;
    }
}

function skip(name: string, why: string): void {
    originalConsole.log(`  ⏭️  SKIP ${name} — ${why}`);
    skipped++;
}

function section(title: string): void {
    originalConsole.log(`\n── ${title} ${'─'.repeat(Math.max(0, 72 - title.length))}`);
}

const recipient = (() => {
    const arg = process.argv.find(a => a.startsWith('--send='));
    return arg ? arg.slice('--send='.length).trim() : null;
})();

const STAMP = new Date().toISOString();

/**
 * How many messages each provider reports having SENT, read off the Prometheus counter the
 * chain increments.
 *
 * This is the only way to answer "which member actually carried it" from outside — a delivered
 * message looks identical to the caller whichever provider took it, which is the whole reason
 * `jovimall_mail_sends_total` exists.
 */
async function sentCounts(): Promise<Record<string, number>> {
    const metrics = await metricsRegistry().getMetricsAsJSON();
    const counter = metrics.find(m => m.name === 'jovimall_mail_sends_total') as
        { values?: Array<{ labels?: Record<string, string>; value: number }> } | undefined;
    const out: Record<string, number> = {};
    for (const v of counter?.values ?? []) {
        if (v.labels?.outcome === 'sent' && v.labels.provider) {
            out[v.labels.provider] = (out[v.labels.provider] ?? 0) + v.value;
        }
    }
    return out;
}

/** Build one provider directly, bypassing the chain, so each can be exercised alone. */
function buildDirect(name: MailProviderName): IMailProvider | null {
    switch (name) {
        case 'brevo':
            return mailConfig.brevo ? new BrevoMailProvider(mailConfig.brevo, mailConfig.requestTimeoutMs) : null;
        case 'resend':
            return mailConfig.resend ? new ResendMailProvider(mailConfig.resend, mailConfig.requestTimeoutMs) : null;
        case 'smtp':
            return mailConfig.smtp ? new SmtpMailProvider(mailConfig.smtp) : null;
        default:
            return null;
    }
}

const SENDER_FOR: Record<string, string> = {
    // Deliberately exercises BOTH configured senders, because Brevo validates the sender
    // address and not merely the domain — so a suite that only ever sent from one of them
    // would pass while the other was unusable.
    brevo: process.env.MAIL_FROM_AUTH || 'support@wi-mall.com',
    resend: process.env.MAIL_FROM_SYSTEM || 'info@wi-mall.com',
    smtp: process.env.MAIL_FROM_SYSTEM || 'info@wi-mall.com',
};

function body(provider: string): string {
    return `<!doctype html><html><body style="font-family:system-ui,sans-serif">
<h2>wi-mall mail provider test</h2>
<p>This message was sent <strong>directly through the <code>${provider}</code> adapter</strong>,
bypassing the failover chain, by <code>npm run verify:mail-providers</code>.</p>
<table cellpadding="6" style="border-collapse:collapse">
  <tr><td><b>Provider</b></td><td><code>${provider}</code></td></tr>
  <tr><td><b>From</b></td><td><code>${SENDER_FOR[provider]}</code></td></tr>
  <tr><td><b>Sent at</b></td><td><code>${STAMP}</code></td></tr>
</table>
<p style="color:#666;font-size:13px">⚠ Check the <em>actual</em> From address your mail client
shows. If it does not match the one above, that provider rewrote it.</p>
</body></html>`;
}

async function main(): Promise<void> {
    originalConsole.log('\n════════════════════════════════════════════════════════════════════════════');
    originalConsole.log('  verify:mail-providers — against the REAL provider APIs');
    originalConsole.log(`  mode: ${recipient ? `SENDING to ${recipient}` : 'read-only (pass --send=you@example.com to send)'}`);
    originalConsole.log('════════════════════════════════════════════════════════════════════════════');

    // ─────────────────────────────────────────────────────────────────────────
    section('1. Configuration as loaded');
    // ─────────────────────────────────────────────────────────────────────────
    originalConsole.log(`  MAIL_PROVIDER       ${mailConfig.provider}`);
    originalConsole.log(`  chain               ${mailConfig.chain?.join(' → ') ?? '(factory default: brevo → resend → smtp)'}`);
    originalConsole.log(`  quota reset         ${mailConfig.latch.quotaResetPeriod} in ${mailConfig.latch.quotaResetTimezone}`);
    originalConsole.log(`  senders             AUTH=${SENDER_FOR.brevo}  SYSTEM=${SENDER_FOR.resend}`);

    /**
     * ⚠ **A run with NO credentials SKIPS rather than fails, and the distinction matters.**
     *
     * This is a diagnostic aimed at a real environment, not a unit test: it asks whether the
     * mail this deployment sends can actually leave the building. CI deliberately holds no
     * provider credentials — putting a live Brevo key in a workflow secret to satisfy a
     * read-only check would be a worse trade than not running the check — so an unconditional
     * assert here fails every CI run forever and teaches people to ignore a red live-suites
     * job. That is the failure mode this suite was written to prevent, arriving by the back
     * door.
     *
     * Same posture as `verify-geocoding-providers.ts`, which skips both adapters and says so
     * loudly. A skipped run announces that it proved nothing; it does not claim health.
     *
     * ⚠ It does NOT weaken the check where it counts. Run against an environment that HAS
     * credentials, the assert still fires — and `MAIL_PROVIDER=console` with real keys present
     * is still caught by section 1's printout, which is the configuration this exists to catch
     * silently swallowing mail.
     */
    const deliverable = Boolean(mailConfig.brevo || mailConfig.resend || mailConfig.smtp);
    if (deliverable) {
        assert('at least one deliverable provider is configured', true);
    } else {
        skip('deliverability', 'no provider credentials in this environment');
        originalConsole.log('\n⚠ NO provider is configured, so this run proved NOTHING about');
        originalConsole.log('  deliverability. Every send here would go to the console provider,');
        originalConsole.log('  which reports success and delivers nothing. Set BREVO_API_KEY,');
        originalConsole.log('  RESEND_API_KEY or SMTP_HOST and run this against a deployment');
        originalConsole.log('  before trusting `MAIL_PROVIDER=chain` there.\n');
    }

    // ─────────────────────────────────────────────────────────────────────────
    section('2. Credentials — each provider proves it can be reached, sending nothing');
    // ─────────────────────────────────────────────────────────────────────────
    for (const name of ['brevo', 'resend', 'smtp'] as const) {
        const provider = buildDirect(name);
        if (!provider) {
            skip(`${name} verify()`, `no credentials configured (${name === 'smtp' ? 'SMTP_HOST' : `${name.toUpperCase()}_API_KEY`} unset)`);
            continue;
        }
        try {
            await provider.verify();
            assert(`${name} authenticates`, true);
        } catch (error) {
            const verdict = classifyMailFailure(error);
            assert(`${name} authenticates`, false, `${verdict.kind}: ${verdict.message}`);
        }
    }

    // Brevo's remaining allowance is the single most useful operational number here, and it is
    // free to read. It is REPORTED rather than asserted: a suite that failed when the day's
    // allowance ran low would be red for a condition the chain is designed to absorb.
    if (mailConfig.brevo) {
        try {
            const r = await fetch('https://api.brevo.com/v3/account', {
                headers: { 'api-key': mailConfig.brevo.apiKey, accept: 'application/json' },
            });
            const account = await r.json() as { plan?: Array<{ type: string; credits: number; creditsType: string }> };
            for (const p of account.plan ?? []) {
                originalConsole.log(`  ℹ️  brevo allowance: ${p.credits} (${p.creditsType}, plan "${p.type}")`);
            }
        } catch { /* reported only; never fails the suite */ }
    }

    if (mailConfig.resend) {
        try {
            const r = await fetch('https://api.resend.com/domains', {
                headers: { authorization: `Bearer ${mailConfig.resend.apiKey}` },
            });
            const body = await r.json() as { data?: Array<{ name: string; status: string; region: string }> };
            for (const d of body.data ?? []) {
                originalConsole.log(`  ℹ️  resend domain: ${d.name} [${d.region}] ${d.status}`);
                assert(`resend domain ${d.name} is verified`, d.status === 'verified', `status=${d.status}`);
            }
        } catch { /* reported only */ }
    }

    // ─────────────────────────────────────────────────────────────────────────
    section('3. A real send through EACH provider, directly');
    // ─────────────────────────────────────────────────────────────────────────
    if (!recipient) {
        skip('per-provider sends', 'no --send=<address> given (deliberate: a diagnostic must not spend a real quota)');
    } else {
        for (const name of ['brevo', 'resend', 'smtp'] as const) {
            const provider = buildDirect(name);
            if (!provider) {
                skip(`${name} send`, 'no credentials configured');
                continue;
            }
            try {
                await provider.sendEmail({
                    to: recipient,
                    from: SENDER_FOR[name],
                    subject: `[wi-mall] provider test — ${name}`,
                    html: body(name),
                    text: `wi-mall mail provider test. Provider: ${name}. From: ${SENDER_FOR[name]}. Sent at ${STAMP}.`,
                });
                assert(`${name} accepted a real message from ${SENDER_FOR[name]}`, true);
            } catch (error) {
                const verdict = classifyMailFailure(error);
                assert(`${name} accepted a real message from ${SENDER_FOR[name]}`, false,
                    `${verdict.kind} (${verdict.code}): ${verdict.message}`);
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    section('4. The CHAIN, end to end, through a real Handlebars template');
    // ─────────────────────────────────────────────────────────────────────────
    if (!recipient) {
        skip('chain send', 'no --send=<address> given');
    } else {
        const before = await sentCounts();
        try {
            await new MailService().send({
                to: recipient,
                type: 'SYSTEM',
                subject: '[wi-mall] chain test — SYSTEM class',
                template: 'welcome',
                variables: { name: 'wi-mall operator', role: 'system test', year: new Date().getFullYear() },
            });
            assert('the chain delivered a templated message', true);

            const after = await sentCounts();
            const carrier = Object.keys(after).find(p => (after[p] ?? 0) > (before[p] ?? 0));
            assert('…and the metric names which member carried it', Boolean(carrier), JSON.stringify(after));
            if (carrier) {
                originalConsole.log(`  ℹ️  carried by: ${carrier}  (SYSTEM class ⇒ From ${SENDER_FOR.resend})`);
            }
        } catch (error) {
            const verdict = classifyMailFailure(error);
            assert('the chain delivered a templated message', false, `${verdict.code}: ${verdict.message}`);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    section('5. FAILOVER, proven against the live APIs');
    // ─────────────────────────────────────────────────────────────────────────
    /**
     * The one claim `test:mail-chain` cannot make. It proves the failover rules against fakes,
     * which is the only way to reproduce a quota refusal without burning a day's allowance —
     * but a fake cannot show that a REAL refusal from a REAL provider is classified correctly
     * and that the next member really picks the message up.
     *
     * A deliberately-invalid credential is the trigger, chosen over a forced quota refusal for
     * two reasons: it costs no allowance at the first provider, and an `auth` verdict is the
     * one that **must not latch** — so this leaves no state behind for the next run.
     */
    if (!recipient || !mailConfig.brevo || !mailConfig.resend) {
        skip('failover proof', !recipient ? 'no --send=<address> given' : 'needs BOTH brevo and resend configured');
    } else {
        const { ChainedMailProvider } = await import('../../src/modules/mail/mail.chain');
        const { isLatched } = await import('../../src/modules/mail/domain/mail-latch');

        const brokenBrevo = new BrevoMailProvider({ apiKey: 'xkeysib-deliberately-invalid' }, mailConfig.requestTimeoutMs);
        const realResend = new ResendMailProvider(mailConfig.resend, mailConfig.requestTimeoutMs);
        const chain = new ChainedMailProvider([brokenBrevo, realResend], mailConfig.latch);

        try {
            await chain.sendEmail({
                to: recipient,
                from: SENDER_FOR.resend,
                subject: '[wi-mall] failover test — brevo refused, resend carried it',
                html: body('resend (after a real brevo refusal)'),
                text: 'Failover test: brevo was given an invalid credential and refused; resend carried this message.',
            });
            assert('a REAL refusal from brevo is absorbed and resend delivers the message', true);
            assert('…and an auth refusal left NO latch behind, so brevo is tried again next send',
                !isLatched('brevo'));
        } catch (error) {
            const verdict = classifyMailFailure(error);
            assert('a REAL refusal from brevo is absorbed and resend delivers the message', false,
                `${verdict.code}: ${verdict.message}`);
        }
    }

    originalConsole.log(`\n${'═'.repeat(76)}`);
    originalConsole.log(`  ${passed} passed, ${failed} failed, ${skipped} skipped`);
    if (recipient) {
        originalConsole.log(`\n  📬 Check ${recipient}. You should have up to FOUR messages.`);
        originalConsole.log('     ⚠ Compare the From address each one SHOWS against the one it claims.');
        originalConsole.log('       A mismatch means that provider rewrote the sender.');
    }
    originalConsole.log('═'.repeat(76));
    if (failed > 0) process.exit(1);
}

main().catch((error) => {
    originalConsole.error(error);
    process.exit(1);
});
