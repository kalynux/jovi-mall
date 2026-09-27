/**
 * test:statement-mail — the account-statement mail relay and the attachment path under it.
 * **No DB, no network.**
 *
 * wi-admin computes and renders the statement (owner decision O-8, 2026-09-27); this service
 * only mails it. So there are two things to pin, and both fail SILENTLY if they regress:
 *
 *  1. **Every real provider forwards the attachment.** A provider that drops `attachments`
 *     still answers 2xx — the account holder receives a polite email about a file that is not
 *     there, and every log says "sent".
 *  2. **The caller cannot choose the recipient.** The schema is `.strict()`, so a `to`/`email`
 *     field is REFUSED rather than ignored, and the route resolves the address from the owner
 *     profile. A leaked service token can therefore mail a statement only to the person it
 *     describes.
 *
 * Run: npm run test:statement-mail
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { BrevoMailProvider } from '../../src/modules/mail/providers/brevo.provider';
import { ResendMailProvider } from '../../src/modules/mail/providers/resend.provider';
import {
    StatementMailSchema,
    STATEMENT_ATTACHMENT_MAX_BYTES,
    decodeStatementAttachment,
    maskEmail,
} from '../../src/modules/mail/admin-statement-mail.routes';

let passed = 0;
let failed = 0;

function assert(name: string, ok: boolean, detail?: string): void {
    if (ok) {
        console.log(`  ✅ ${name}`);
        passed++;
    } else {
        console.error(`  ❌ FAIL: ${name}${detail ? `\n       ${detail}` : ''}`);
        failed++;
    }
}

function section(title: string): void {
    console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 72 - title.length))}`);
}

/** Capture the JSON body an HTTP adapter posts, answering 200. */
async function captureBody(run: () => Promise<void>): Promise<any> {
    const original = globalThis.fetch;
    let captured: any = null;
    globalThis.fetch = (async (_url: string, init: { body?: string }) => {
        captured = init?.body ? JSON.parse(init.body) : null;
        return { ok: true, status: 200, json: async () => ({}) };
    }) as unknown as typeof fetch;
    try {
        await run();
    } finally {
        globalThis.fetch = original;
    }
    return captured;
}

async function codeOf(run: () => unknown): Promise<string | null> {
    try {
        await run();
        return null;
    } catch (e: any) {
        return e?.code ?? e?.name ?? 'THREW';
    }
}

const PDF = 'application/pdf';
const valid = {
    ownerType: 'vendor',
    ownerId: '64b7f0c2a1b2c3d4e5f60718',
    from: '2026-09-01',
    to: '2026-09-30',
    fileName: 'statement-2026-09.pdf',
    contentType: PDF,
    contentBase64: Buffer.from('%PDF-1.7 hello').toString('base64'),
};

async function main(): Promise<void> {
    section('1. Providers forward attachments');
    {
        const attachment = { filename: 's.pdf', contentType: PDF, content: Buffer.from('abc') };
        const base = { to: 'a@b.co', from: 'x@y.co', subject: 's', html: '<p/>' };

        const brevo = await captureBody(() =>
            new BrevoMailProvider({ apiKey: 'k' }, 1000).sendEmail({ ...base, attachments: [attachment] }),
        );
        assert(
            'Brevo sends `attachment[{name, content(base64)}]`',
            brevo?.attachment?.[0]?.name === 's.pdf' && brevo.attachment[0].content === 'YWJj',
            JSON.stringify(brevo?.attachment),
        );
        const brevoNone = await captureBody(() => new BrevoMailProvider({ apiKey: 'k' }, 1000).sendEmail(base));
        assert('Brevo omits the key when there is no attachment', !('attachment' in (brevoNone ?? {})));

        const resend = await captureBody(() =>
            new ResendMailProvider({ apiKey: 'k' }, 1000).sendEmail({ ...base, attachments: [attachment] }),
        );
        assert(
            'Resend sends `attachments[{filename, content(base64), content_type}]`',
            resend?.attachments?.[0]?.filename === 's.pdf' &&
                resend.attachments[0].content === 'YWJj' &&
                resend.attachments[0].content_type === PDF,
            JSON.stringify(resend?.attachments),
        );

        const smtpSource = readFileSync(join(__dirname, '../../src/modules/mail/providers/smtp.provider.ts'), 'utf8');
        assert('SMTP passes `attachments` to nodemailer', /attachments:\s*options\.attachments/.test(smtpSource));

        const serviceSource = readFileSync(join(__dirname, '../../src/modules/mail/mail.service.ts'), 'utf8');
        assert('MailService forwards `options.attachments` to the provider', /options\.attachments/.test(serviceSource));

        const consoleSource = readFileSync(
            join(__dirname, '../../src/modules/mail/providers/console.provider.ts'),
            'utf8',
        );
        assert(
            'the console provider never logs attachment bytes',
            !/a\.content\.toString|content\.toString\(/.test(consoleSource),
        );
    }

    section('2. The caller cannot choose the recipient');
    {
        assert('a well-formed request parses', StatementMailSchema.safeParse(valid).success);
        for (const field of ['to_email', 'email', 'recipient', 'cc', 'bcc']) {
            assert(
                `an extra \`${field}\` field is REFUSED, not ignored`,
                !StatementMailSchema.safeParse({ ...valid, [field]: 'attacker@evil.test' }).success,
            );
        }
        assert(
            '`to` is a DATE, not an address — an email there is refused',
            !StatementMailSchema.safeParse({ ...valid, to: 'attacker@evil.test' }).success,
        );
        const routeSource = readFileSync(
            join(__dirname, '../../src/modules/mail/admin-statement-mail.routes.ts'),
            'utf8',
        );
        assert(
            'the send uses the RESOLVED recipient',
            /to:\s*recipient\.email/.test(routeSource) && /\.strict\(\)/.test(routeSource),
        );
        assert(
            'an unverified address is refused (the notification-email rule)',
            /email_verified/.test(routeSource) && /STATEMENT_RECIPIENT_UNVERIFIED/.test(routeSource),
        );
        const mountSource = readFileSync(join(__dirname, '../../src/api/routes/internal-admin.routes.ts'), 'utf8');
        assert(
            'mounted behind requireAdminCaller',
            /router\.use\('\/mail',\s*buildAdminStatementMailRouter\(\[requireAdminCaller\]\)\)/.test(mountSource),
        );
    }

    section('3. Payload shape');
    {
        assert(
            'only pdf and xlsx content types',
            !StatementMailSchema.safeParse({ ...valid, contentType: 'text/html' }).success,
        );
        assert(
            'a file name with a path separator is refused',
            !StatementMailSchema.safeParse({ ...valid, fileName: '../etc/statement.pdf' }).success,
        );
        assert(
            'a file name with a CR/LF is refused',
            !StatementMailSchema.safeParse({ ...valid, fileName: 'a\r\nb.pdf' }).success,
        );
        assert('an unknown owner type is refused', !StatementMailSchema.safeParse({ ...valid, ownerType: 'customer' }).success);

        assert(
            'an oversize attachment is STATEMENT_ATTACHMENT_TOO_LARGE',
            (await codeOf(() =>
                decodeStatementAttachment(Buffer.alloc(STATEMENT_ATTACHMENT_MAX_BYTES + 1).toString('base64')),
            )) === 'STATEMENT_ATTACHMENT_TOO_LARGE',
        );
        assert(
            'exactly the cap is accepted',
            (await codeOf(() =>
                decodeStatementAttachment(Buffer.alloc(STATEMENT_ATTACHMENT_MAX_BYTES).toString('base64')),
            )) === null,
        );
        assert(
            'the parser backstop is above the decoded cap (base64 inflates by 4/3)',
            12 * 1024 * 1024 > Math.ceil((STATEMENT_ATTACHMENT_MAX_BYTES * 4) / 3),
        );
        const appSource = readFileSync(join(__dirname, '../../src/app.ts'), 'utf8');
        const scoped = appSource.indexOf("'/api/internal/admin/mail/statement'");
        const global = appSource.indexOf('app.use(express.json({ limit: JSON_BODY_LIMIT }))');
        assert(
            'the wide parser is mounted BEFORE the global 1 MB one',
            scoped > 0 && global > 0 && scoped < global,
        );
    }

    section('4. Masking and template');
    {
        assert('jane.doe@example.com → j***@example.com', maskEmail('jane.doe@example.com') === 'j***@example.com');
        assert('a malformed address masks to ***', maskEmail('nobody') === '***');
        assert(
            'the template exists (copied recursively by copy-build-assets)',
            existsSync(join(__dirname, '../../src/modules/mail/templates/account-statement.hbs')),
        );
    }

    console.log(`\n${'═'.repeat(76)}`);
    console.log(`  ${passed} passed, ${failed} failed`);
    console.log('═'.repeat(76));
    if (failed > 0) process.exit(1);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
