/**
 * Generate the Meta `message_templates` payloads this service actually sends.
 *
 * ── Why it GENERATES rather than transcribes ─────────────────────────────────
 *
 * The catalogs declare **94** template names and the WABA has **ZERO** — measured against the
 * Graph API on 2026-09-14 — so every out-of-window notification fails on send today.
 *
 * `api-doc/notifications/whatsapp-templates.md` already says as much (it counts the same 94 and
 * notes 30 are never registered), and it carries hand-written approval copy for a subset. The
 * obvious fix is to transcribe that page into Business Manager, and it is the wrong one: a
 * hand-typed body is a SECOND source of truth for something that must agree with
 * `render*WhatsAppTemplateParams` exactly. Meta substitutes POSITIONALLY, so a body whose
 * `{{2}}` sits where the code puts `{{1}}` does not fail — it sends the customer's name where
 * the order number should be, on every message, forever.
 *
 * ── How the body is derived, and what that catches ───────────────────────────
 *
 * Each catalog value is rendered twice with a SENTINEL context (`«orderNumber»` in place of
 * every value): once through `render*ChannelText(…, 'whatsapp', …)` to get the real localised
 * copy, and once through `render*WhatsAppTemplateParams` to get the ordered parameter list.
 * Every sentinel in the copy is then replaced by its 1-based index in that list.
 *
 * That makes three defects impossible to ship and one visible:
 *
 *   - placeholder COUNT cannot disagree with the code — both come from the same call;
 *   - placeholder ORDER cannot disagree — the index is read from the params array;
 *   - the copy is the REAL approved-language copy, not a paraphrase;
 *   - ⚠ and a sentinel left over in the copy means the template quotes a value the send does
 *     NOT pass. That is the open defect `jovi-mall/CLAUDE.md` records ("five situations'
 *     bodyParams do not cover their own copy"), and it is reported per row rather than
 *     silently emitted.
 *
 * ⚠ **It SUBMITS NOTHING.** Creating a template is an outward-facing act on a business account
 * that then goes to Meta for review. Submitting is a separate, deliberate decision.
 *
 * Run: npx ts-node scripts/generate-whatsapp-templates.ts [--langs=en,fr] [--out=<path>]
 */
import { writeFileSync, mkdirSync, readFileSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import {
    NOTIFICATION_CATALOG,
    whatsAppTemplateName,
    renderWhatsAppTemplateParams,
    renderButton,
    renderChannelText,
} from '../src/modules/notifications/catalog/notification-catalog';
import {
    CUSTOMER_NOTIFICATION_CATALOG,
    customerWhatsAppTemplateName,
    renderCustomerWhatsAppTemplateParams,
    renderCustomerButton,
    renderCustomerChannelText,
} from '../src/modules/notifications/catalog/customer-notification-catalog';
import {
    AGENCY_NOTIFICATION_CATALOG,
    agencyWhatsAppTemplateName,
    renderAgencyWhatsAppTemplateParams,
    renderAgencyButton,
    renderAgencyChannelText,
} from '../src/modules/notifications/catalog/agency-notification-catalog';
import {
    AGENT_NOTIFICATION_CATALOG,
    agentWhatsAppTemplateName,
    renderAgentWhatsAppTemplateParams,
    renderAgentButton,
    renderAgentChannelText,
} from '../src/modules/notifications/catalog/agent-notification-catalog';
import { META_LANGUAGE_CODE } from '../src/modules/notifications/catalog/notification-i18n';
import { otpFallbackTemplateBody } from '../src/modules/phone-verification/domain/otp-copy';
import { Language } from '../src/core/constants/languages';

type Lang = keyof typeof META_LANGUAGE_CODE;

const argOf = (name: string): string | null => {
    const hit = process.argv.find(a => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
};

/**
 * ⚠ **Default en,fr — NOT all five.** A template must be approved in every language a
 * recipient might hold, so five languages multiplies the review queue by five for a market
 * that is overwhelmingly bilingual. Add the rest when a user with that preference exists; an
 * unapproved language delivers nothing, which is exactly today's state.
 */
const LANGS = (argOf('langs') ?? 'en,fr').split(',').map(s => s.trim()) as Lang[];
const OUT = argOf('out') ?? join(__dirname, '..', 'api-doc', 'notifications', 'whatsapp-template-payloads.json');

/**
 * Every context key any catalog template interpolates, each mapped to a unique sentinel.
 *
 * ⚠ The sentinel must be a string no copy would contain and that survives
 * `renderTemplate`'s whitespace tidying — hence the guillemets. A sentinel containing a space
 * would be collapsed by `REPEATED_SPACES` and stop matching.
 */
/**
 * ⚠ **Derived from the catalog SOURCE, never hand-listed.**
 *
 * The first version of this script carried a hand-written key list and reported 3 defective
 * templates where `jovi-mall/CLAUDE.md` records 5. The list was the reason: a context key it
 * did not know about renders as the empty string, leaving no sentinel behind — so the detector
 * was blind to exactly the templates it was written to find, and reported a clean-looking
 * lower bound as if it were the answer. The catalogs use `amountFormatted`, `startAt`,
 * `expiresInMinutes`, `reopenLine` and others that no reasonable hand list would guess.
 *
 * Scanning the source for `{{key}}` cannot go stale, and a key added tomorrow is covered
 * without anybody remembering this file exists.
 */
const KEYS = (() => {
    const found = new Set<string>();
    const dir = join(__dirname, '..', 'src', 'modules', 'notifications', 'catalog');
    for (const file of readdirSync(dir)) {
        if (!file.endsWith('.ts')) continue;
        const source = readFileSync(join(dir, file), 'utf8');
        for (const match of source.matchAll(/\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g)) {
            found.add(match[1]);
        }
    }
    return [...found].sort();
})();
const SENTINEL: Record<string, string> = Object.fromEntries(KEYS.map(k => [k, `«${k}»`]));
const SENTINEL_PATTERN = /«[a-zA-Z]+»/g;

/**
 * Context values that are OPTIONAL CLAUSES, and are therefore expected to be absent from a
 * template body rather than parameterised.
 *
 * ⚠ **This is an allowlist, so anything not named here is a DEFECT and fails the run.** That
 * asymmetry is the point: an optional clause dropped from the out-of-window copy is a
 * deliberate, stated difference between the two forms of a message, while a real value dropped
 * mid-sentence is broken copy — `customer_order_created` rendered "— item(s), 45 000 FCFA"
 * until `itemCount` was added to its `bodyParams`.
 *
 * They cannot be parameters: each is frequently the empty string, and **Meta rejects a send
 * whose parameter value is empty**, so parameterising one turns "there is no COD line this
 * time" into a failed delivery.
 *
 * ⚠ A name ending in `Line`/`Suffix`/`Phrase` is NOT the test — `whenPhrase` is a real value
 * and is a parameter. Add a key here only after reading the copy and confirming the sentence
 * still reads without it.
 */
const OPTIONAL_CLAUSES = new Set([
    'confirmationLine', 'refundLine', 'balanceLine', 'paymentLine',
    'codLine', 'reasonLine', 'reasonSuffix',
]);

interface Row {
    audience: string;
    situation: string;
    name: string;
    bodies: Partial<Record<Lang, string>>;
    paramCount: number;
    hasUrlButton: boolean;
    /** Sentinels in the copy that the send does NOT pass — a real defect, reported per row. */
    unsuppliedValues: string[];
}

const rows: Row[] = [];

type TextFn = (s: string, channel: 'whatsapp', lang: Lang, ctx: Record<string, string>) => { subject: string; body: string };
type ParamFn = (s: string, lang: Lang, ctx: Record<string, string>) => string[];
type ButtonFn = (s: string, lang: Lang, ctx: Record<string, string>, base?: string) => unknown;

function collect(
    audience: string,
    catalog: Record<string, unknown>,
    nameOf: (s: string) => string,
    textOf: TextFn,
    paramsOf: ParamFn,
    buttonOf: ButtonFn,
): void {
    for (const situation of Object.keys(catalog)) {
        const params = safe(() => paramsOf(situation, 'en', SENTINEL), [] as string[]);
        const bodies: Partial<Record<Lang, string>> = {};
        const unsupplied = new Set<string>();

        for (const lang of LANGS) {
            const text = safe(() => textOf(situation, 'whatsapp', lang, SENTINEL), { subject: '', body: '' });

            /**
             * Every parameter is rendered BOLD, so the values a reader is actually looking for —
             * the order number, the amount, the name — stand out of the sentence.
             *
             * ⚠ **The heading is exempt, and that is not a style choice.** It is already wrapped
             * in `*…*`, and WhatsApp has no nesting: `*Out for delivery: *{{1}}**` does not
             * produce a doubly-bold run, it terminates the first run early and leaves stray
             * asterisks in the message. So the subject's parameters stay bare — they are
             * already inside a bold span — and only the body's are wrapped.
             *
             * ⚠ A parameter whose VALUE contains `*` will still break its own run. That is
             * unavoidable (Meta offers no escape) and is bounded: it affects one value's
             * emphasis, not the message.
             */
            const substitute = (source: string, bold: boolean): string =>
                source.replace(SENTINEL_PATTERN, (sentinel) => {
                    const index = params.indexOf(sentinel);
                    if (index === -1) {
                        unsupplied.add(sentinel.slice(1, -1));
                        return sentinel;
                    }
                    return bold ? `*{{${index + 1}}}*` : `{{${index + 1}}}`;
                });

            const heading = text.subject ? `*${substitute(text.subject, false)}*` : '';
            const body = substitute(text.body, true);

            bodies[lang] = tidy(heading ? `${heading}\n\n${body}` : body);
        }

        rows.push({
            audience,
            situation,
            name: nameOf(situation),
            bodies,
            paramCount: params.length,
            hasUrlButton: Boolean(safe(() => buttonOf(situation, 'en', SENTINEL, 'https://wi-mall.com'), null)),
            unsuppliedValues: [...unsupplied],
        });
    }
}

/**
 * Remove the leftover sentinels and tidy what they leave behind.
 *
 * ── Why they are STRIPPED rather than turned into parameters ─────────────────
 *
 * Almost every unsupplied value is an OPTIONAL trailing sentence — `codLine`, `refundLine`,
 * `reasonLine`, `paymentLine`, `balanceLine` — which the in-window renderer computes from
 * context and which is frequently the empty string. That is fine for a free-form message and
 * impossible for a template: a Meta template body is static, so an optional clause can only be
 * expressed as a parameter, and **Meta rejects a send whose parameter value is empty**. Making
 * them parameters would therefore turn "there is no COD line this time" into a failed delivery.
 *
 * So the out-of-window copy is the sentence WITHOUT its optional tail, which is exactly what a
 * static template can honestly promise. The in-window message still carries the full line.
 *
 * ⚠ That is a real difference in what the two forms say, so every stripped row is reported for
 * a human to read the result. `customer_order_created` is the one to check first: the strip
 * removes an `«itemCount» item(s)` fragment from mid-sentence rather than a trailing clause,
 * and mid-sentence removal is where this produces copy that scans badly.
 */
function tidy(text: string): string {
    return text
        .replace(SENTINEL_PATTERN, '')
        // A stripped tail leaves a double space, or a space before the full stop.
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/[ \t]+([.,;:!?])/g, '$1')
        .replace(/\n{3,}/g, '\n\n')
        .split('\n').map(line => line.trimEnd()).join('\n')
        .trim();
}

function safe<T>(fn: () => T, fallback: T): T {
    try {
        return fn() ?? fallback;
    } catch {
        return fallback;
    }
}

/**
 * Meta refuses a body whose FIRST or LAST element is a variable — and its rule is stricter than
 * its error message, which is why this pass exists rather than a note telling someone to check.
 *
 * ⚠ **Formatting and trailing punctuation do not count as content.** `… for {{2}} {{3}}.` reads
 * as ending on a variable: the `*…*` bold markers are stripped before the check and so is the
 * full stop. Measured on 2026-09-14 — 38 of 190 submissions were refused with "Les variables ne
 * peuvent pas se trouver au début ou à la fin du modèle", and 14 of those ended in `{{n}}.`,
 * which by a literal reading of the message should have been fine.
 *
 * The related refusal — "too many variables relative to its length" — has the same remedy: the
 * body needs more static prose, not fewer values.
 *
 * ── Why this PADS rather than rewrites ───────────────────────────────────────
 *
 * The copy is derived from the catalogs on purpose: it is the same text the in-window message
 * sends, so the two forms of a notification cannot drift. Reordering a sentence to move a
 * variable off the end would make this script a second author of the copy, which is the thing
 * the whole generator is built to prevent. Adding a static closing line leaves the derived
 * sentence exactly as the catalog wrote it.
 *
 * ⚠ **The tail is button-aware, because the version naming the button would otherwise be a lie
 * on the templates that have none.**
 */
const BODY_TAIL_WITH_BUTTON: Record<string, string> = {
    en: 'Tap Open below for the full details.',
    fr: 'Appuyez sur Ouvrir ci-dessous pour tous les détails.',
};

const BODY_TAIL_NO_BUTTON: Record<string, string> = {
    en: 'You can see the details in the Wi-Mall app.',
    fr: 'Vous pouvez voir les détails dans l\'application Wi-Mall.',
};

/** Prefixed to a HEADING that opens on a variable, inside its bold span. */
const HEADING_LEAD: Record<string, string> = {
    en: 'Update: ',
    fr: 'Mise \u00e0 jour : ',
};

/** Meta strips WhatsApp formatting before judging the first and last element. */
const unformatted = (body: string): string => body.replace(/\*/g, '');
const startsOnParam = (body: string): boolean => /^[\s"'\u00ab(\[]*\{\{\d+\}\}/.test(unformatted(body));
const endsOnParam = (body: string): boolean => /\{\{\d+\}\}[\s"'\u00bb.,;:!?)\]]*$/.test(unformatted(body));

interface Padding { name: string; start: boolean; end: boolean }
const padded: Padding[] = [];

function padEdges(): void {
    for (const row of rows) {
        let start = false;
        let end = false;

        for (const lang of LANGS) {
            let body = row.bodies[lang];
            if (!body) continue;

            if (startsOnParam(body)) {
                const lead = HEADING_LEAD[lang] ?? HEADING_LEAD.en;
                // The heading is `*…*`; the lead belongs INSIDE that bold span, not before it.
                body = body.startsWith('*') ? `*${lead}${body.slice(1)}` : `${lead}${body}`;
                start = true;
            }

            if (endsOnParam(body)) {
                const tail = row.hasUrlButton
                    ? (BODY_TAIL_WITH_BUTTON[lang] ?? BODY_TAIL_WITH_BUTTON.en)
                    : (BODY_TAIL_NO_BUTTON[lang] ?? BODY_TAIL_NO_BUTTON.en);
                body = `${body}\n\n${tail}`;
                end = true;
            }

            row.bodies[lang] = body;
        }

        if (start || end) padded.push({ name: row.name, start, end });
    }
}

collect('vendor', NOTIFICATION_CATALOG as Record<string, unknown>, whatsAppTemplateName as never, renderChannelText as never, renderWhatsAppTemplateParams as never, renderButton as never);
collect('customer', CUSTOMER_NOTIFICATION_CATALOG as Record<string, unknown>, customerWhatsAppTemplateName as never, renderCustomerChannelText as never, renderCustomerWhatsAppTemplateParams as never, renderCustomerButton as never);
collect('agency', AGENCY_NOTIFICATION_CATALOG as Record<string, unknown>, agencyWhatsAppTemplateName as never, renderAgencyChannelText as never, renderAgencyWhatsAppTemplateParams as never, renderAgencyButton as never);
collect('agent', AGENT_NOTIFICATION_CATALOG as Record<string, unknown>, agentWhatsAppTemplateName as never, renderAgentChannelText as never, renderAgentWhatsAppTemplateParams as never, renderAgentButton as never);

/**
 * The host baked into each audience's approved URL button.
 *
 * ⚠ **The base is PERMANENT once Meta approves the template, and the send path never supplies
 * it.** The handler passes `button.whatsappSuffix` — the locale-prefixed path and nothing else
 * (`customer-notification-event-handler.service.ts`) — so the host comes from the approved
 * template forever. ONE base for all four audiences was wrong and silently so: the four front
 * ends are on four hosts, so every vendor, agency and agent "Open" button would have opened the
 * CUSTOMER storefront, on a link Meta had already approved.
 *
 * ⚠ **This is a silent config pair that neither side can check.** The same four variables build
 * the runtime `button.url` for in-app, email, push and Telegram. Change `VENDOR_APP_URL` later
 * and those four channels follow it while every approved WhatsApp template still points at the
 * old host — nothing compares them and nothing errors. **A host change means RE-SUBMITTING
 * these templates**, not editing an env var.
 *
 * Read from the SAME variable names the send path reads, so the two cannot drift at generation
 * time. Missing, non-https or localhost is FATAL: an approved template pointing at
 * `http://localhost:5173` is unrecoverable except by deleting it and waiting out another review.
 */
const BUTTON_BASE_VAR: Record<string, string> = {
    vendor: 'VENDOR_APP_URL',
    agency: 'AGENCY_APP_URL',
    agent: 'AGENT_APP_URL',
    customer: 'STOREFRONT_URL',
};

/** Illustrative only — Meta’s reviewer checks the example resolves like a real link. */
const BUTTON_EXAMPLE_PATH: Record<string, string> = {
    vendor: 'orders/WM-2026-000123',
    customer: 'orders/WM-2026-000123',
    agency: 'shipments/SHP-2026-000123',
    agent: 'shipments/SHP-2026-000123',
};

function buttonBase(audience: string): string {
    const variable = BUTTON_BASE_VAR[audience];
    if (!variable) throw new Error(`no button base is configured for audience "${audience}"`);

    const raw = (argOf(`base-${audience}`) ?? process.env[variable] ?? '').trim().replace(/\/+$/, '');
    if (!raw) {
        throw new Error(
            `${variable} is unset, so the ${audience} templates have no button host.\n` +
            `  Set it to the PRODUCTION host — approval bakes it in permanently — or pass --base-${audience}=https://…`,
        );
    }
    if (!raw.startsWith('https://') || /localhost|127\.0\.0\.1|\.local\b/.test(raw)) {
        throw new Error(
            `${variable}="${raw}" is not a public https host.\n` +
            `  Meta bakes this into the approved template; an http or localhost base cannot be edited away.`,
        );
    }
    return raw;
}

function payloadFor(row: Row, lang: Lang) {
    const components: unknown[] = [{
        type: 'BODY',
        text: row.bodies[lang] ?? '',
        ...(row.paramCount > 0
            ? { example: { body_text: [Array.from({ length: row.paramCount }, (_, i) => `example ${i + 1}`)] } }
            : {}),
    }];

    if (row.hasUrlButton) {
        const base = buttonBase(row.audience);
        components.push({
            type: 'BUTTONS',
            buttons: [{
                type: 'URL',
                text: lang === 'fr' ? 'Ouvrir' : 'Open',
                // The approved URL is host + ONE placeholder; the service sends the whole path
                // after the host, locale prefix included (`whatsappSuffix`, not `urlSuffix`).
                url: `${base}/{{1}}`,
                example: [`${base}/${lang}/${BUTTON_EXAMPLE_PATH[row.audience] ?? BUTTON_EXAMPLE_PATH.customer}`],
            }],
        });
    }

    return {
        name: row.name,
        language: META_LANGUAGE_CODE[lang],
        // UTILITY, never MARKETING: every one of these is the consequence of something the
        // recipient or their counterparty did. Miscategorising as MARKETING costs more per
        // message and makes the send subject to marketing opt-out.
        category: 'UTILITY',
        components,
    };
}

/**
 * The phone-verification OTP template — the one entry NOT derived from a notification catalog.
 *
 * ── Why it is hand-built here ────────────────────────────────────────────────
 *
 * It is not a notification: no domain event raises it, it is never preference-gated, it writes
 * no inbox row, and it must never be retried (a retry re-sends a live credential). It lives in
 * `modules/phone-verification/` for those reasons, so there is no catalog entry to derive from.
 *
 * ⚠ **Category AUTHENTICATION, not UTILITY.** Meta treats these differently — they may carry a
 * copy-code button, they are exempt from some limits, and submitting an OTP body as UTILITY is
 * a documented rejection reason.
 *
 * ⚠ **The code appears TWICE** — once in the body and once as the button's parameter. Meta
 * requires both; sending only the body yields a copy button that copies nothing. The service
 * sends it twice for exactly this reason.
 *
 * ⚠ **THE BODY IS META'S, NOT OURS — this component carries no `text` and no `example`.**
 * An AUTHENTICATION template's copy is fixed: Meta writes and localises it ("<CODE> is your
 * verification code…"), appends its own "do not share this code" line from
 * `add_security_recommendation`, and appends the expiry notice from
 * `code_expiration_minutes`. Only the three flags below are ours.
 *
 * ⚠ This script DID send a hand-written body until 2026-09-14, and the comment sitting right
 * here already said Meta renders those two lines — the body was written anyway. A `text` on an
 * AUTHENTICATION body is rejected at create time, so the OTP template simply would not have been
 * created, and the phone-verification path would have stayed broken for the one reason nobody
 * would look for: the submission that was supposed to fix it never landed.
 *
 * The verification code still travels as `{{1}}` at SEND time — Meta's fixed body has exactly
 * one placeholder — and, separately, as the copy-code button's parameter. Both are required.
 */

const OTP_BUTTON_LABEL: Record<string, string> = {
    en: 'Copy code', fr: 'Copier le code', pt: 'Copiar código', es: 'Copiar código', ar: 'نسخ الرمز',
};

const authPayloads = LANGS.map(lang => ({
    name: process.env.PHONE_VERIFY_TEMPLATE_NAME || 'wi_mall_phone_verification',
    language: META_LANGUAGE_CODE[lang],
    category: 'AUTHENTICATION',
    components: [
        // No `text`: Meta owns and localises an authentication body. See above.
        { type: 'BODY', add_security_recommendation: true },
        { type: 'FOOTER', code_expiration_minutes: 10 },
        {
            type: 'BUTTONS',
            buttons: [{ type: 'OTP', otp_type: 'COPY_CODE', text: OTP_BUTTON_LABEL[lang] ?? OTP_BUTTON_LABEL.en }],
        },
    ],
}));

padEdges();

// Resolve every base first, so a missing host fails with one readable line rather than a
// stack trace from inside a flatMap — and fails BEFORE the output file is overwritten.
try {
    for (const audience of new Set(rows.filter(r => r.hasUrlButton).map(r => r.audience))) buttonBase(audience);
} catch (error) {
    console.error(`
❌ ${(error as Error).message}
`);
    process.exit(1);
}

/**
 * The UTILITY **fallback** for phone verification — the second entry not derived from a
 * notification catalog, and the only template here that exists because of an account problem
 * rather than a product one.
 *
 * ⚠ **It is NOT a replacement for the AUTHENTICATION template above, and both are emitted.**
 * `PhoneVerificationService.deliver()` tries AUTHENTICATION first every time and only reaches
 * this one when that send fails. On this WABA it always does: Meta gates the AUTHENTICATION
 * category behind business verification, the owning business is `rejected`, and so the
 * template cannot be created at all. Resolve the verification and this stops being reached
 * without anything being edited.
 *
 * ⚠ **Submitting OTP copy as UTILITY is a documented Meta rejection reason.** This template may
 * be refused at review, and that is a known cost of the trade rather than a bug to fix here.
 *
 * ⚠ **The body is imported, not written here.** `otp-copy.ts` owns it because the SEND site
 * reads its parameter order from the same file — Meta substitutes positionally, so a body
 * typed independently in this script is the exact defect the whole generator exists to
 * prevent. It takes two parameters (code, minutes) where the AUTHENTICATION one takes the code
 * twice, because a UTILITY template gets no Meta-rendered expiry line.
 */
const fallbackPayloads = LANGS.map(lang => ({
    name: process.env.PHONE_VERIFY_FALLBACK_TEMPLATE_NAME || 'wi_mall_phone_verification_utility',
    language: META_LANGUAGE_CODE[lang],
    category: 'UTILITY',
    components: [
        {
            type: 'BODY',
            text: otpFallbackTemplateBody(lang as Language),
            example: { body_text: [['123456', '10']] },
        },
    ],
}));

const payloads = [
    ...rows.flatMap(row => LANGS.map(lang => payloadFor(row, lang))),
    ...authPayloads,
    ...fallbackPayloads,
];
const defective = rows.filter(r => r.unsuppliedValues.length > 0);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({
    generatedAt: new Date().toISOString(),
    note: 'GENERATED from the notification catalogs by scripts/generate-whatsapp-templates.ts. Do not hand-edit: names, placeholder counts and placeholder ORDER are derived from the same functions the send path uses, and editing them here makes the approved template disagree with what is sent.',
    languages: LANGS.map(l => META_LANGUAGE_CODE[l]),
    templateCount: rows.length + 1,
    submissionCount: payloads.length,
    needsCopyReview: defective.map(r => ({ name: r.name, unsuppliedValues: r.unsuppliedValues })),
    payloads,
}, null, 2));

const byAudience = rows.reduce<Record<string, number>>((a, r) => { a[r.audience] = (a[r.audience] ?? 0) + 1; return a; }, {});

console.log(`\nTemplates derived from the catalogs: ${rows.length}`);
for (const [a, n] of Object.entries(byAudience)) console.log(`   ${a.padEnd(9)} ${n}`);
console.log(`\nLanguages: ${LANGS.join(', ')}  →  ${payloads.length} submissions`);
console.log(`With a URL button: ${rows.filter(r => r.hasUrlButton).length}`);

if (padded.length > 0) {
    console.log(`\nℹ ${padded.length} template(s) padded so Meta accepts the first/last element.`);
    console.log('  Meta refuses a body that opens or closes on a variable, counting neither the');
    console.log('  bold markers nor a trailing full stop as content. The derived sentence is');
    console.log('  unchanged; a static lead or closing line was added around it.');
    for (const entry of padded) {
        const where = [entry.start ? 'lead' : '', entry.end ? 'tail' : ''].filter(Boolean).join(' + ');
        console.log(`   ${entry.name.padEnd(46)} ${where}`);
    }
}

const stripped = defective.filter(r => r.unsuppliedValues.every(v => OPTIONAL_CLAUSES.has(v)));
const broken = defective.filter(r => r.unsuppliedValues.some(v => !OPTIONAL_CLAUSES.has(v)));

if (stripped.length > 0) {
    console.log(`\nℹ ${stripped.length} template(s) drop an OPTIONAL clause the in-window message keeps.`);
    console.log('  Expected: a static template cannot carry a sometimes-empty sentence, and Meta');
    console.log('  refuses an empty parameter. Read each once to confirm it still scans.');
    for (const r of stripped) console.log(`   ${r.name.padEnd(44)} without: ${r.unsuppliedValues.join(', ')}`);
}

if (broken.length > 0) {
    console.log(`\n❌ ${broken.length} template(s) quote a REAL value the send does not pass.`);
    console.log('  This is broken copy, not an omitted clause — add the value to that');
    console.log('  situation\'s bodyParams, or add it to OPTIONAL_CLAUSES if the sentence');
    console.log('  genuinely reads without it.');
    for (const r of broken) {
        const real = r.unsuppliedValues.filter(v => !OPTIONAL_CLAUSES.has(v));
        console.log(`   ${r.name.padEnd(44)} missing: ${real.join(', ')}`);
    }
} else {
    console.log('\n✅ no template quotes a real value the send does not pass');
}

console.log(`\nWritten to ${OUT}`);
console.log('NOTHING WAS SUBMITTED.');

// A broken body is not a reviewable artifact — fail, so this cannot be submitted by habit.
if (broken.length > 0) process.exit(1);
