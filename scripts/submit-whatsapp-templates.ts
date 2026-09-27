/**
 * Submit the generated Meta `message_templates` payloads to the WhatsApp Business Account.
 *
 * ── Why this is a SEPARATE script from the generator ─────────────────────────
 *
 * `generate-whatsapp-templates.ts` deliberately submits nothing: creating a template is an
 * outward-facing act on a real business account that then goes to Meta for human review, and
 * an approved template's *name*, *language*, *placeholder order* and *button host* are
 * effectively permanent — the only way out of a wrong one is to delete it and wait out another
 * review. So generation is cheap and repeatable; submission is deliberate, and needs its own
 * `--submit` flag on top of its own command.
 *
 * ── Idempotent by construction ───────────────────────────────────────────────
 *
 * It reads what the WABA already holds before doing anything and submits only the difference,
 * keyed on `name|language`. A re-run after a partial failure therefore resumes rather than
 * duplicating, and a re-run after a full success is a no-op. That matters more than it looks:
 * Meta counts a rejected-and-resubmitted template against the WABA's quality rating, and
 * duplicate submissions of a name that already exists come back as errors that read like
 * permission problems.
 *
 * ⚠ **`--submit` is required, and nothing is sent without it.** Bare, this prints the plan.
 *
 * ⚠ **The token is read from the environment and never logged, and it must carry
 * `whatsapp_business_management`** — the messaging scope alone authenticates fine and then
 * fails every create with an error about the *WABA* rather than about the scope.
 *
 * Run:
 *   WHATSAPP_WABA_ID=… WHATSAPP_ACCESS_TOKEN=… npx ts-node scripts/submit-whatsapp-templates.ts
 *   …                                                                              --submit
 *
 * Flags: --submit · --edit · --only=<name> · --limit=<n> · --delay=<ms> · --in=<path> · --report=<path>
 *
 * ── EDITS: opt-in with `--edit`, because they spend a finite allowance ─────────
 *
 * A template already on the WABA whose buttons or body differ from the payload here is an
 * EDIT, not a creation — `POST /{template_id}` with the full component list. Until
 * 2026-09-27 this script only created, so a changed template was reported "already present"
 * and silently skipped: stage 2's buttons could never have been sent with it.
 *
 * ⚠ Meta allows an APPROVED template roughly one edit a day and ten a month, and every edit
 * goes back to review. So edits are listed in the dry run, and sent only with BOTH `--submit`
 * and `--edit`. A PENDING template cannot be edited at all; it is listed, never sent.
 *
 * Compared on what a person sees — body text and the buttons' type, text and URL — never on
 * the `example` blocks, which Meta stores in its own shape and would read as a change on
 * every run.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';

const argOf = (name: string): string | null => {
    const hit = process.argv.find(a => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
};
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const WABA_ID = process.env.WHATSAPP_WABA_ID ?? '';
const TOKEN = process.env.WHATSAPP_ACCESS_TOKEN ?? '';
const API = (process.env.WHATSAPP_API_URL ?? 'https://graph.facebook.com/v26.0').replace(/\/+$/, '');

const IN = argOf('in') ?? join(__dirname, '..', 'api-doc', 'notifications', 'whatsapp-template-payloads.json');
const REPORT = argOf('report');
const ONLY = argOf('only');
const LIMIT = Number(argOf('limit') ?? '0');

/**
 * ⚠ **Meta rate-limits template WRITES per WABA, and the limit is not published per-account.**
 * One-at-a-time with a pause is not politeness, it is the difference between 190 creates and a
 * throttle that returns errors indistinguishable from permission failures. Backoff below
 * handles the throttle when it comes anyway.
 */
const DELAY_MS = Number(argOf('delay') ?? '1200');

interface Payload { name: string; language: string; category: string; components: unknown[] }
interface Result { name: string; language: string; status: 'created' | 'edited' | 'exists' | 'failed'; id?: string; error?: string }
interface LiveTemplate { id: string; status: string; components: any[] }

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Meta error codes that mean "slow down" rather than "this payload is wrong". */
const THROTTLE_CODES = new Set([4, 17, 32, 613, 80007]);
/** Meta error codes that mean the credential is wrong — retrying 190 times helps nobody. */
const FATAL_CODES = new Set([190, 102]);

async function graph(path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: any }> {
    const response = await fetch(`${API}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
    const body: any = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, body };
}

/** Everything the WABA already holds, as `name|language`, following Meta's cursor pagination. */
async function existingTemplates(): Promise<Map<string, LiveTemplate>> {
    const keys = new Map<string, LiveTemplate>();
    let path: string | null = `/${WABA_ID}/message_templates?limit=200&fields=name,language,status,id,components`;

    while (path) {
        const { ok, body } = await graph(path);
        if (!ok) throw new Error(`could not list existing templates: ${JSON.stringify(body?.error ?? body)}`);
        for (const template of body?.data ?? []) {
            keys.set(`${template.name}|${template.language}`, {
                id: String(template.id), status: String(template.status), components: template.components ?? [],
            });
        }

        /**
         * ⚠ **`API` ALREADY CARRIES THE VERSION, and Meta's `paging.next` carries it again.**
         * This line used to cut the cursor URL at the first `/` after `https://`, which keeps
         * `/v26.0/…`; `graph()` then prepends `https://graph.facebook.com/v26.0` and asks for
         * `/v26.0/v26.0/{waba}/message_templates`. Graph answers `OAuthException` code 2500,
         * *"Unknown path components: /{waba}/message_templates"* — a message that reads like a
         * permission or WABA problem and is neither.
         *
         * ⛔ It could not fire until the WABA held more than one page. Measured 2026-09-27: the
         * account crossed 200 templates mid-batch (196 → 202 while submitting the payout six),
         * the second page appeared, and every subsequent run aborted before submitting anything.
         * The first page had always been enough before, so this line shipped unexercised.
         *
         * Strip the version explicitly rather than guessing at slashes, and keep the query.
         */
        const next: string | undefined = body?.paging?.next;
        if (!next) {
            path = null;
        } else {
            const cursor = new URL(next);
            path = `${cursor.pathname.replace(/^\/v\d+(\.\d+)?/, '')}${cursor.search}`;
        }
    }
    return keys;
}

/** What a person sees: body text, and each button's type · text · URL. */
function visibleShape(components: any[]): string {
    const body = components.find(c => String(c.type).toUpperCase() === 'BODY')?.text ?? '';
    const buttons = (components.find(c => String(c.type).toUpperCase() === 'BUTTONS')?.buttons ?? [])
        .map((b: any) => [String(b.type).toUpperCase(), b.text ?? '', b.url ?? ''].join('·'));
    return JSON.stringify({ body, buttons });
}

function buttonSummary(components: any[]): string {
    const buttons = components.find(c => String(c.type).toUpperCase() === 'BUTTONS')?.buttons ?? [];
    return buttons.map((b: any) => `${String(b.type).toUpperCase()}:${b.text}`).join(' | ') || '(none)';
}

/** Create (`templateId` absent) or edit (present). Same retry and fatal rules for both. */
async function createTemplate(payload: Payload, templateId?: string): Promise<Result> {
    const base: Omit<Result, 'status'> = { name: payload.name, language: payload.language };

    for (let attempt = 0; attempt < 5; attempt++) {
        const { ok, body } = templateId
            // An edit carries the components only: name, language and category are fixed.
            ? await graph(`/${templateId}`, { method: 'POST', body: JSON.stringify({ components: payload.components }) })
            : await graph(`/${WABA_ID}/message_templates`, { method: 'POST', body: JSON.stringify(payload) });

        if (ok && templateId && body?.success) return { ...base, status: 'edited', id: templateId };
        if (ok && !templateId && body?.id) return { ...base, status: 'created', id: body.id };

        const error = body?.error ?? {};
        const code = Number(error.code);

        if (FATAL_CODES.has(code)) {
            throw new Error(`credential rejected (code ${code}): ${error.message}. Nothing further was submitted.`);
        }

        if (THROTTLE_CODES.has(code)) {
            const wait = 30_000 * Math.pow(2, attempt);
            console.log(`   ⏳ throttled (code ${code}) — waiting ${Math.round(wait / 1000)}s`);
            await sleep(wait);
            continue;
        }

        // Anything else is a bad payload: the same bytes will fail the same way forever.
        const detail = [error.error_user_msg, error.error_user_title, error.message]
            .filter(Boolean)
            .join(' — ') || JSON.stringify(body);
        return { ...base, status: 'failed', error: `${code || '?'}: ${detail}` };
    }

    return { ...base, status: 'failed', error: 'still throttled after 5 attempts' };
}

async function main(): Promise<void> {
    if (!WABA_ID || !TOKEN) {
        console.error('\n❌ WHATSAPP_WABA_ID and WHATSAPP_ACCESS_TOKEN must both be set.');
        console.error('   The token needs the `whatsapp_business_management` scope, not just messaging.\n');
        process.exit(1);
    }

    const file = JSON.parse(readFileSync(IN, 'utf8'));
    let payloads: Payload[] = file.payloads ?? [];
    // A comma list scopes a run to exactly the names meant — e.g. the stage-2 edits without the
    // UTILITY OTP fallback, which Meta rejected on content and must not be re-sent by habit.
    if (ONLY) {
        const names = new Set(ONLY.split(',').map(n => n.trim()).filter(Boolean));
        payloads = payloads.filter(p => names.has(p.name));
    }
    if (!payloads.length) {
        console.error(`\n❌ no payloads to submit${ONLY ? ` matching --only=${ONLY}` : ''} in ${IN}\n`);
        process.exit(1);
    }

    console.log(`\nWABA ${WABA_ID} · ${API}`);
    console.log(`Source: ${IN}  (generated ${file.generatedAt})`);

    const live = await existingTemplates();
    const already = new Set(live.keys());
    console.log(`Already on the WABA: ${already.size} template(s)`);

    const pending = payloads.filter(p => !already.has(`${p.name}|${p.language}`));

    const differing = payloads
        .map(p => ({ payload: p, current: live.get(`${p.name}|${p.language}`) }))
        .filter((x): x is { payload: Payload; current: LiveTemplate } =>
            x.current !== undefined && visibleShape(x.current.components) !== visibleShape(x.payload.components));
    /**
     * ⛔ **An AUTHENTICATION template is NEVER edited.** Meta compiles it: the body becomes its
     * fixed OTP sentence and the OTP button becomes a URL button (see the generator's OTP
     * note). So the live copy ALWAYS differs from our payload, and "fixing" that difference
     * would re-submit the phone-verification template on every run and could break the one
     * path that lets a person verify a number.
     */
    const editable = differing.filter(x => x.current.status !== 'PENDING' && x.current.status !== 'IN_APPEAL'
        && x.payload.category !== 'AUTHENTICATION');
    const locked = differing.filter(x => !editable.includes(x));

    if (differing.length > 0) {
        console.log(`\nDiffer from the WABA: ${differing.length}  (${editable.length} editable, ${locked.length} still in review)`);
        for (const { payload, current } of differing) {
            const bodyChanged = JSON.parse(visibleShape(current.components)).body !== JSON.parse(visibleShape(payload.components)).body;
            console.log(`   ${editable.some(e => e.payload === payload) ? 'EDIT ' : 'LOCK '}${`${payload.name} [${payload.language}]`.padEnd(48)} ${current.status.padEnd(9)} `
                + `${buttonSummary(current.components)}  →  ${buttonSummary(payload.components)}${bodyChanged ? '  ⚠ BODY CHANGES' : ''}`);
        }
    }
    const skipped = payloads.length - pending.length;
    const todo = LIMIT > 0 ? pending.slice(0, LIMIT) : pending;

    console.log(`To submit: ${todo.length}${skipped ? `  (${skipped} already present, skipped)` : ''}`);

    if (!flag('submit')) {
        const byBase = new Map<string, number>();
        for (const p of todo) {
            const buttons: any = p.components.find((c: any) => c.type === 'BUTTONS');
            const url = buttons?.buttons?.[0]?.url ?? '(no url button)';
            byBase.set(url, (byBase.get(url) ?? 0) + 1);
        }
        console.log('\nButton hosts these would bake in PERMANENTLY:');
        for (const [url, count] of byBase) console.log(`   ${String(count).padStart(4)}  ${url}`);
        console.log('\nNOTHING WAS SUBMITTED. Re-run with --submit to create, and --submit --edit to also send the edits.\n');
        return;
    }

    const results: Result[] = payloads
        .filter(p => already.has(`${p.name}|${p.language}`))
        .map(p => ({ name: p.name, language: p.language, status: 'exists' as const }));

    console.log(`\nSubmitting ${todo.length} at ~${DELAY_MS}ms apart…\n`);

    for (const [index, payload] of todo.entries()) {
        const result = await createTemplate(payload);
        results.push(result);

        const label = `${payload.name} [${payload.language}]`.padEnd(52);
        const position = `${String(index + 1).padStart(3)}/${todo.length}`;
        if (result.status === 'created') console.log(`${position} ✅ ${label} ${result.id}`);
        else console.log(`${position} ❌ ${label} ${result.error}`);

        if (index < todo.length - 1) await sleep(DELAY_MS);
    }

    if (flag('edit')) {
        const edits = LIMIT > 0 ? editable.slice(0, LIMIT) : editable;
        console.log(`\nEditing ${edits.length}…\n`);
        for (const [index, { payload, current }] of edits.entries()) {
            await sleep(DELAY_MS);
            const result = await createTemplate(payload, current.id);
            // An edited template was recorded as "exists" above; replace that row.
            const at = results.findIndex(r => r.name === payload.name && r.language === payload.language);
            if (at >= 0) results.splice(at, 1);
            results.push(result);
            const label = `${payload.name} [${payload.language}]`.padEnd(52);
            const position = `${String(index + 1).padStart(3)}/${edits.length}`;
            if (result.status === 'edited') console.log(`${position} ✏️  ${label} ${result.id}`);
            else console.log(`${position} ❌ ${label} ${result.error}`);
        }
    } else if (editable.length > 0) {
        console.log(`\n${editable.length} edit(s) NOT sent — add --edit to send them.`);
    }

    const created = results.filter(r => r.status === 'created');
    const edited = results.filter(r => r.status === 'edited');
    const failed = results.filter(r => r.status === 'failed');

    console.log(`\n── Summary ───────────────────────────────────────────────`);
    console.log(`   created  ${created.length}`);
    console.log(`   edited   ${edited.length}`);
    console.log(`   existed  ${results.length - created.length - edited.length - failed.length}`);
    console.log(`   failed   ${failed.length}`);

    if (failed.length) {
        console.log('\nFailures:');
        for (const f of failed) console.log(`   ${f.name} [${f.language}] — ${f.error}`);
    }

    console.log('\n⚠ Created ≠ approved. Every one of these is now PENDING Meta review;');
    console.log('  poll status with --report or GET /{waba}/message_templates?fields=name,language,status\n');

    if (REPORT) {
        mkdirSync(dirname(REPORT), { recursive: true });
        writeFileSync(REPORT, JSON.stringify({ submittedAt: new Date().toISOString(), results }, null, 2));
        console.log(`Report written to ${REPORT}\n`);
    }

    if (failed.length) process.exit(1);
}

main().catch(error => {
    console.error(`\n❌ ${error.message}\n`);
    process.exit(1);
});
