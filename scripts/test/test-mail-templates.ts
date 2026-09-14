/**
 * test:mail-templates — every email body, rendered. **No DB, no network.**
 *
 * ── The assertion this suite exists for ──────────────────────────────────────
 *
 * ⛔ `customer-notification.hbs` **did not exist**. `customer-notification-event-handler`
 * has asked for it by name since the customer stack shipped, so every customer email
 * notification threw `MAIL_TEMPLATE_NOT_FOUND` — a 500 on a best-effort path, which means it
 * was logged and dropped and the customer was simply never emailed. Nothing could see it:
 * the template name is a STRING, so no compiler, linter or type-checker relates it to a file,
 * and the four notification stacks are near-identical so a reviewer's eye slides over the one
 * that is missing.
 *
 * § 1 is therefore the point of the whole file: every `template: '<name>'` literal in `src/`
 * must have a matching `.hbs`, and every `.hbs` must be reachable from some call site. It
 * fails in BOTH directions, like `test:env` — an orphan template is dead weight nobody will
 * dare delete, and a missing one is a channel that silently does not work.
 *
 * § 2 renders each template with realistic variables and asserts the OUTPUT, because a
 * Handlebars template cannot fail: an unknown variable renders as the empty string, so a
 * misspelt `{{brandName}}` produces "Welcome to ." and looks like copy.
 *
 * Run: npm run test:mail-templates
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import handlebars from 'handlebars';
import { mailBrand } from '../../src/modules/mail/domain/mail-brand';

const originalConsole = { log: console.log.bind(console), error: console.error.bind(console) };

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
    originalConsole.log(`\n── ${title} ${'─'.repeat(Math.max(0, 70 - title.length))}`);
}

const SRC = join(__dirname, '..', '..', 'src');
const TEMPLATES = join(SRC, 'modules', 'mail', 'templates');

function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            if (entry === 'node_modules') continue;
            walk(full, out);
        } else if (entry.endsWith('.ts')) {
            out.push(full);
        }
    }
    return out;
}

// ─────────────────────────────────────────────────────────────────────────────
section('1. Every template the code asks for EXISTS — and vice versa');
// ─────────────────────────────────────────────────────────────────────────────

/** variable name → the files that request it, so a failure says where to look. */
const requested = new Map<string, string[]>();
for (const file of walk(SRC)) {
    // `src/scripts/**` is one-off tooling, ESLint-ignored and not part of the deployed
    // service — the same exclusion `test:env` makes for the same reason.
    if (relative(SRC, file).replace(/\\/g, '/').startsWith('scripts/')) continue;
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/template:\s*'([a-z0-9-]+)'/g)) {
        const list = requested.get(match[1]) ?? [];
        list.push(relative(SRC, file).replace(/\\/g, '/'));
        requested.set(match[1], list);
    }
}

const onDisk = new Set(
    readdirSync(TEMPLATES).filter(f => f.endsWith('.hbs')).map(f => f.replace(/\.hbs$/, '')),
);

assert('the scan found template requests (a silent zero would be a false green)', requested.size >= 7);

for (const [name, callers] of [...requested].sort()) {
    assert(`'${name}.hbs' exists — requested by ${callers.length} site(s)`, onDisk.has(name),
        `asked for in: ${callers.join(', ')}`);
}

/**
 * Templates that exist on purpose with no call site, each with the reason.
 *
 * ⚠ **The list is meant to stay empty or near it.** An entry is a claim that a template is
 * worth keeping unsent, and the default answer to an orphan is to delete it — a template
 * nobody sends is a template nobody has looked at, and it will be wrong by the time somebody
 * wires it up.
 */
const KNOWN_UNWIRED: Readonly<Record<string, string>> = Object.freeze({
    /**
     * Written, styled and rendered by this suite, but sent by nothing: registration already
     * sends the verification email, and a welcome landing beside it is a second message in the
     * same minute saying less. It is also not free — both providers here are on free tiers
     * measured in hundreds a day, so doubling the mail per signup is a real cost.
     *
     * Kept rather than deleted because "welcome the user once they have VERIFIED" is a real
     * product decision somebody may take, and that is the moment it becomes the right message.
     * Wire it in `AuthService.verifyEmail`, not in `register`.
     */
    welcome: 'deliberately unsent — see AuthService.verifyEmail if you want a post-verification welcome',
});

for (const name of [...onDisk].sort()) {
    if (KNOWN_UNWIRED[name]) {
        assert(`'${name}.hbs' is a DOCUMENTED orphan (${KNOWN_UNWIRED[name]})`, !requested.has(name),
            'it is wired up now — remove it from KNOWN_UNWIRED');
        continue;
    }
    assert(`'${name}.hbs' is reachable from a call site`, requested.has(name),
        'orphan template — delete it, or document it in KNOWN_UNWIRED with a reason');
}

// ─────────────────────────────────────────────────────────────────────────────
section('2. Every template renders, with its real variables');
// ─────────────────────────────────────────────────────────────────────────────

for (const entry of readdirSync(join(TEMPLATES, 'partials'))) {
    if (!entry.endsWith('.hbs')) continue;
    handlebars.registerPartial(
        entry.replace(/\.hbs$/, ''),
        readFileSync(join(TEMPLATES, 'partials', entry), 'utf8'),
    );
}

const LINK = 'https://wi-mall.com/verify-email?token=abc123&app=vendor';

/** What each template is actually sent, mirroring its call site. */
const FIXTURES: Record<string, Record<string, unknown>> = {
    'verify-email': { link: LINK },
    'welcome': { name: 'Ada Nkemdirim', role: 'vendor' },
    'reset-password': { link: LINK, minutes: 30 },
    'verify-email-change': { link: LINK, newEmail: 'new.address@example.com', hours: 24 },
    'customer-notification': { customerName: 'Ada', title: 'Your order is on its way', message: 'Order WM-2026-000123 left the depot.\nYour agent is Paul.', actionLabel: 'Track it', actionUrl: LINK },
    'vendor-notification': { vendorName: 'Chez Ada', title: 'New order', message: 'You have a new order.', actionLabel: 'View', actionUrl: LINK },
    'agency-notification': { agencyName: 'Douala Express', title: 'Shipment assigned', message: 'A shipment needs an agent.', actionLabel: 'Assign', actionUrl: LINK },
    'agent-notification': { agentName: 'Paul', title: 'New delivery offer', message: 'A delivery is waiting for you.', actionLabel: 'Accept', actionUrl: LINK },
};

const brand = mailBrand();

for (const name of [...onDisk].sort()) {
    const source = readFileSync(join(TEMPLATES, `${name}.hbs`), 'utf8');
    const variables = FIXTURES[name];

    if (!variables) {
        assert(`'${name}' has a fixture in this suite`, false,
            'a new template must be added to FIXTURES, or it is rendered by nothing here');
        continue;
    }

    let html: string;
    try {
        html = handlebars.compile(source)({ ...brand, ...variables });
    } catch (error) {
        assert(`'${name}' compiles and renders`, false, String(error));
        continue;
    }

    assert(`'${name}' renders`, html.length > 500, `only ${html.length} chars`);

    /**
     * ⚠ **The empty-variable check, and the reason this suite is not just a smoke test.**
     * Handlebars swallows an unknown variable, so the failure mode is not an exception —
     * it is `style="background:;"` on a button, or a sentence with a hole in it. Neither is
     * visible to anything except a human reading a rendered email.
     */
    assert(`'${name}' leaves no unrendered {{handlebars}} behind`, !/\{\{/.test(html),
        html.match(/\{\{[^}]*\}\}/g)?.join(', '));
    assert(`'${name}' has no empty style value (a dropped variable)`, !/:\s*;/.test(html),
        (html.match(/[a-z-]+:\s*;/g) ?? []).join(', '));

    assert(`'${name}' carries the brand name`, html.includes(brand.brandName));
    assert(`'${name}' says Wi-Mall, never the old brand`, !/jovi ?mall/i.test(html));

    // Table-based, inline-styled, with a preheader — the three things that decide whether
    // this renders in Outlook and previews correctly in a list view.
    assert(`'${name}' is table-based (Outlook uses Word's engine)`, html.includes('role="presentation"'));
    assert(`'${name}' sets a preheader`, html.includes('mso-hide:all'));
    assert(`'${name}' declares a dark-mode-aware colour scheme`, html.includes('color-scheme'));

    /**
     * A button must be a TABLE CELL with a background, not a styled <a>: Outlook ignores
     * padding and border-radius on an inline element, so the common form renders as bare
     * coloured text with no shape.
     */
    if (String(variables.actionUrl ?? '') || name === 'verify-email' || name === 'reset-password' || name === 'verify-email-change' || name === 'welcome') {
        assert(`'${name}' uses the bulletproof (table) button`, html.includes(`bgcolor="${brand.brandColor}"`));
    }
}

// ─────────────────────────────────────────────────────────────────────────────
section('3. The brand context');
// ─────────────────────────────────────────────────────────────────────────────

assert('the default brand name is Wi-Mall', mailBrand().brandName === 'Wi-Mall');
assert('BRAND_NAME overrides it', (() => {
    process.env.BRAND_NAME = 'Test Brand';
    const ok = mailBrand().brandName === 'Test Brand';
    delete process.env.BRAND_NAME;
    return ok;
})());
assert('the logo is absent by default, so the wordmark is used', mailBrand().logoUrl === '');
assert('year is computed per call, never cached', mailBrand().year === new Date().getFullYear());

originalConsole.log(`\n${'═'.repeat(74)}`);
originalConsole.log(`  ${passed} passed, ${failed} failed`);
originalConsole.log('═'.repeat(74));
if (failed > 0) process.exit(1);
