/**
 * Publish the WhatsApp Flows — an owner decision, taken at the end of the plan.
 *
 * ── THE NUMBER IS NOT THE BLOCKER ANY MORE ──────────────────────────────────
 * ⚠ **This header used to say the sending number's display name "has never been approved",
 * which stopped being true on 2026-09-16.** The platform moved to +237 652 705 926, and a
 * read-only Graph lookup that day returned `name_status: APPROVED`, `status: CONNECTED`,
 * `code_verification_status: VERIFIED`, quality `GREEN`. Anyone reading the old sentence would
 * have taken a solved problem for the blocker. Check it yourself with
 * `GET /{phone_number_id}?fields=verified_name,name_status,status` before trusting this one
 * either.
 *
 * What actually stands between this script and a live Flow:
 *   1. **The owner's go-ahead.** The plan is finished locally first, and publishing is theirs.
 *   2. **`WHATSAPP_FLOW_PRIVATE_KEY` and `WHATSAPP_APP_SECRET`**, set together (see
 *      `.env.example`: the key without the secret leaves an unrate-limited CPU cost open).
 *   3. **The endpoint reachable from the internet**, because publishing runs Meta's health
 *      check against it — **and Meta told where it is**, which this script derives from
 *      `API_PUBLIC_URL` (see `ENDPOINT_URI` below; it used to tell Meta nothing).
 *   4. **The automation layer routing `interactive.nfm_reply`**, or a finished form reports
 *      into silence.
 *
 * ── WHY THIS IS A SCRIPT AND EXISTS BEFORE IT CAN BE RUN ────────────────────
 * Publishing a Flow is a sequence of Graph calls that must happen in order. Left as "a thing
 * somebody does in the Flow Builder", it becomes an afternoon of discovering that the public key
 * upload is a *separate* call from the Flow creation, that a Flow can't be published until its
 * endpoint answers a health check, and that the endpoint can't answer one until the key is
 * uploaded.
 *
 * So the order is written down here, executable, with a dry run that proves everything it can
 * prove offline.
 *
 * ── ⚠ IT DOES NOT PUBLISH BY DEFAULT ───────────────────────────────────────
 * `--dry-run` is the default and it makes **no outward call at all**: it validates the
 * definitions, derives the public key, and prints exactly what would be sent where. Publishing
 * is an outward, hard-to-reverse act against a live Business Account — a published Flow is
 * visible to customers and a bad one has to be superseded rather than deleted — so it needs
 * `--publish` typed deliberately.
 *
 *   npm run flows:publish                    # rehearse everything, send nothing
 *   npm run flows:publish -- --upload-key    # upload the public key only
 *   npm run flows:publish -- --publish pl    # create, upload and publish one Flow
 *
 * ── ⚠ THE PUBLIC KEY IS DERIVED, NEVER CONFIGURED ──────────────────────────
 * It comes from `WHATSAPP_FLOW_PRIVATE_KEY`, so what Meta holds is provably the counterpart of
 * what the endpoint decrypts with. A separately-configured pair that does not match decrypts
 * nothing while both halves look perfectly well-formed — and the symptom (every request
 * failing the key unwrap) is identical to having no key at all.
 */
import 'dotenv/config';
import { flowPublicKeyPem, flowsConfigured, flowIdFor } from '../src/modules/whatsapp/flows/flows.config';
import { flowAppSecret } from '../src/modules/whatsapp/flows/domain/flow-signature';
import { PRODUCT_LISTING_FLOW } from '../src/modules/whatsapp/flows/definitions/product-listing.flow';
import { PRODUCT_DETAIL_FLOW } from '../src/modules/whatsapp/flows/definitions/product-detail.flow';
import { CHECKOUT_FLOW } from '../src/modules/whatsapp/flows/definitions/checkout.flow';
import type { FlowDefinition } from '../src/modules/whatsapp/flows/definitions/flow-definition.types';
import type { InAppSurfaceKind } from '../src/modules/bot-surface/services/inapp-surface.store';

const FLOWS: ReadonlyArray<readonly [InAppSurfaceKind, string, FlowDefinition]> = [
    ['pl', 'wi-mall product listing', PRODUCT_LISTING_FLOW],
    ['pd', 'wi-mall product detail', PRODUCT_DETAIL_FLOW],
    ['co', 'wi-mall checkout', CHECKOUT_FLOW],
];

const args = process.argv.slice(2);
const has = (flag: string): boolean => args.includes(flag);
const only = args.find((a) => !a.startsWith('--')) ?? null;

const GRAPH = process.env.WHATSAPP_API_URL || 'https://graph.facebook.com/v26.0';
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN || '';
const WABA_ID = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || '';

/**
 * ⛔ **Where Meta sends every screen request — and this script used to never say.** Meta's Flows
 * API reference: from Flow JSON 3.0 the endpoint "should be specified only via API", as
 * `endpoint_uri`, and every definition here declares a `data_api_version`. The create call sent a
 * name and a category and nothing else, so each Flow would have been created, given its asset,
 * and refused at the publish step — leaving a draft behind for every attempt. Found on deploy day
 * (2026-09-21), before the first run, by reading Meta's reference rather than this file.
 *
 * Derived from `API_PUBLIC_URL` plus the path `app.ts` mounts, so there is no second setting to
 * drift; `test:whatsapp-flows` pins this path against the mount.
 */
const FLOW_ENDPOINT_PATH = '/api/webhooks/whatsapp/flows';
const API_PUBLIC_URL = (process.env.API_PUBLIC_URL || '').replace(/\/+$/, '');
const ENDPOINT_URI = API_PUBLIC_URL ? `${API_PUBLIC_URL}${FLOW_ENDPOINT_PATH}` : '';

function line(label: string, value: string): void {
    console.log(`  ${label.padEnd(28)} ${value}`);
}

/**
 * ⚠ **Checked before anything is sent, and reported as a group.** Each of these produces a
 * different Graph error, and two of them produce errors that sound like a different problem —
 * a missing WABA id reads as "Flow not found", a missing token as a permissions failure on an
 * object that is fine.
 */
function reportReadiness(): boolean {
    console.log('\n▶ Readiness');
    const problems: string[] = [];

    line('Graph endpoint', GRAPH);
    line('Phone number id', PHONE_NUMBER_ID || '(unset)');
    line('Business account id', WABA_ID || '(unset)');
    line('Access token', ACCESS_TOKEN ? `set, ${ACCESS_TOKEN.length} chars` : '(unset)');
    line('Flow private key', flowsConfigured() ? 'set and parseable' : '(unset or unparseable)');
    line('App secret', flowAppSecret() ? `set, ${flowAppSecret().length} chars` : '(unset)');
    line('Flow endpoint', ENDPOINT_URI || '(unset — from API_PUBLIC_URL)');

    if (!flowsConfigured()) problems.push('WHATSAPP_FLOW_PRIVATE_KEY is unset or will not parse');

    /**
     * ⛔ **The app secret is checked HERE even though the endpoint treats it as optional**, and
     * the difference between those two positions is the whole point.
     *
     * The endpoint must tolerate an unset secret: a deployment with no Flows is a valid
     * deployment, and a development box has no business holding one. But **publishing is the
     * moment that stops being true.** With no secret the endpoint verifies no signature at all —
     * it decrypts whatever arrives and answers it — and Meta's health check passes either way, so
     * the Flow goes live, works perfectly, and nothing ever says that the one thing proving a
     * request came from Meta is switched off.
     *
     * ⚠ **This block used to say nothing about it while the file's own header told you to set it**
     * — a readiness report that is silent about a control it names elsewhere is worse than one
     * that omits it entirely, because it reads as "checked and fine". Raised by the deploy-day
     * runbook review, which asked exactly the right question: what does this print when the key is
     * there and the secret is not?
     */
    if (!flowAppSecret()) {
        problems.push(
            'WHATSAPP_APP_SECRET is unset — the endpoint would accept ANY request it can decrypt, '
            + 'unsigned, and Meta\'s health check would still pass. Set it before publishing.',
        );
    }
    if (!ACCESS_TOKEN) problems.push('WHATSAPP_ACCESS_TOKEN is unset');
    if (!PHONE_NUMBER_ID) problems.push('WHATSAPP_PHONE_NUMBER_ID is unset — needed for the key upload');
    if (!WABA_ID) problems.push('WHATSAPP_BUSINESS_ACCOUNT_ID is unset — needed to create a Flow');
    if (!ENDPOINT_URI.startsWith('https://')) {
        problems.push(
            'API_PUBLIC_URL is unset or not https — it is how Meta is told where the endpoint is, '
            + 'and Meta calls only an https address',
        );
    }

    for (const p of problems) console.log(`  ⚠ ${p}`);
    return problems.length === 0;
}

/**
 * Validate every definition offline.
 *
 * ⚠ **The structural rules `test:whatsapp-flows` § 8 asserts**, repeated here on purpose
 * rather than imported: this script is what somebody runs at the moment of publishing, possibly
 * months later and under pressure, and it should refuse a broken definition itself rather than
 * assume a suite was run.
 *
 * ⚠ **It used to demand exactly one terminal screen, and Meta has no such rule.** Meta's Flow
 * JSON reference: "Multiple screens can be marked as terminal". Every form here now has at least
 * two, so the old check would have refused all three.
 */
function validate(): boolean {
    console.log('\n▶ Definitions');
    let ok = true;

    for (const [kind, name, definition] of FLOWS) {
        const ids = new Set(definition.screens.map((s) => s.id));
        const unrouted = definition.screens
            .filter((s) => !Object.prototype.hasOwnProperty.call(definition.routing_model, s.id))
            .map((s) => s.id);
        const badRoutes = Object.entries(definition.routing_model).flatMap(([from, tos]) =>
            tos.filter((to) => !ids.has(to) || to === from).map((to) => `${from}→${to}`));
        const terminals = definition.screens.filter((s) => s.terminal).length;
        const missingExample = definition.screens.flatMap((s) =>
            Object.entries(s.data ?? {})
                .filter(([, f]) => f.__example__ === undefined)
                .map(([field]) => `${s.id}.${field}`));

        const faults = [
            ...unrouted.map((s) => `screen '${s}' is not declared in the routing model`),
            ...badRoutes.map((r) => `route ${r} targets a missing screen or itself`),
            ...(terminals >= 1 ? [] : ['no terminal screen: at least one is required']),
            ...missingExample.map((f) => `${f} has no __example__`),
        ];

        const published = flowIdFor(kind);
        line(
            `${kind} · ${name}`,
            faults.length === 0
                ? `ok · ${published ? `published as ${published}` : 'not yet published'}`
                : 'FAULTS',
        );
        for (const f of faults) console.log(`      ⚠ ${f}`);
        if (faults.length > 0) ok = false;
    }

    return ok;
}

async function graph(path: string, init: RequestInit): Promise<unknown> {
    const response = await fetch(`${GRAPH}/${path}`, {
        ...init,
        headers: {
            Authorization: `Bearer ${ACCESS_TOKEN}`,
            ...(init.headers ?? {}),
        },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
        // Printed rather than thrown: the caller decides whether one failure stops the run,
        // and a Graph error body is the most useful thing on the screen at that moment.
        console.error(`  ❌ ${response.status} ${JSON.stringify(body)}`);
        throw new Error(`Graph call failed: ${path}`);
    }
    return body;
}

/**
 * Step 1 — upload the public key.
 *
 * ⚠ **This is a call on the PHONE NUMBER, not on the Business Account or the Flow**, and it
 * is the step most often missed because nothing about creating a Flow mentions it. Without
 * it Meta has no key to encrypt with, every request fails the unwrap, and the endpoint
 * correctly answers 421 — forever, because there is no key to re-fetch.
 */
async function uploadPublicKey(): Promise<void> {
    const pem = flowPublicKeyPem();
    if (!pem) {
        console.log('\n⚠ No private key configured, so no public key to derive. Nothing uploaded.');
        return;
    }

    console.log('\n▶ Uploading the public key');
    console.log(`  derived from the private key, ${pem.split('\n').length} PEM lines`);

    if (!has('--upload-key') && !has('--publish')) {
        console.log('  (dry run — pass --upload-key to send this)');
        return;
    }

    await graph(`${PHONE_NUMBER_ID}/whatsapp_business_encryption`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ business_public_key: pem }).toString(),
    });
    console.log('  ✅ uploaded');
}

async function main(): Promise<void> {
    console.log('\n═══ WhatsApp Flows — publish ═══');

    const ready = reportReadiness();
    const valid = validate();

    if (!valid) {
        console.error('\n❌ A definition is not publishable. Nothing was sent.\n');
        process.exit(1);
    }

    await uploadPublicKey();

    if (!has('--publish')) {
        console.log('\n▶ Next');
        console.log('  This was a rehearsal. Nothing was published.');
        console.log('  When the owner approves publishing, with the key, app secret and a');
        console.log('  public endpoint in place:');
        console.log('    1. npm run flows:publish -- --upload-key');
        console.log('    2. npm run flows:publish -- --publish pl');
        console.log('    3. put the returned id in WHATSAPP_FLOW_ID_PRODUCT_LISTING and redeploy');
        console.log('    4. repeat for pd and co\n');
        console.log('  ⚠ Publish `pl` first and prove it end to end. It is the screen with no');
        console.log('    money and no address on it, so it is the cheapest place to find a');
        console.log('    signature or handshake fault. Finding one on checkout is a worse day.\n');
        process.exit(0);
    }

    if (!ready) {
        console.error('\n❌ --publish was passed but the readiness checks above did not pass.\n');
        process.exit(1);
    }

    const selected = FLOWS.filter(([kind]) => only === null || kind === only);
    if (selected.length === 0) {
        console.error(`\n❌ '${only}' is not one of: ${FLOWS.map(([k]) => k).join(', ')}\n`);
        process.exit(1);
    }

    for (const [kind, name, definition] of selected) {
        console.log(`\n▶ Publishing ${kind} · ${name}`);

        const created = (await graph(`${WABA_ID}/flows`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, categories: ['OTHER'], endpoint_uri: ENDPOINT_URI }),
        })) as { id?: string };

        const flowId = created.id;
        if (!flowId) {
            console.error('  ❌ Meta returned no Flow id');
            continue;
        }
        console.log(`  created ${flowId}`);

        /**
         * ⚠ **The definition is uploaded as a FILE, not as a JSON body**, and the field name
         * is `file` with an `asset_type` beside it. Posting the definition as the request body
         * is the obvious wrong version and Meta rejects it with a message about assets.
         */
        const form = new FormData();
        form.append('asset_type', 'FLOW_JSON');
        form.append('name', 'flow.json');
        form.append(
            'file',
            new Blob([JSON.stringify(definition)], { type: 'application/json' }),
            'flow.json',
        );

        const uploaded = (await graph(`${flowId}/assets`, { method: 'POST', body: form })) as {
            validation_errors?: unknown[];
        };

        if (uploaded.validation_errors?.length) {
            console.error(`  ❌ validation errors: ${JSON.stringify(uploaded.validation_errors)}`);
            console.error('  Not published. Fix the definition and re-run.');
            continue;
        }
        console.log('  asset uploaded, no validation errors');

        /**
         * ⚠ **Publishing runs Meta's health check against the live endpoint.** If it fails,
         * the endpoint is unreachable, the key is wrong, or the ping answer is not exactly
         * `{ data: { status: 'active' } }` — in that order of likelihood.
         *
         * ⛔ **This comment used to show that shape WITH a `version` field, and that was wrong in
         * the one way that costs a deploy day.** Meta's guide calls it the "Required response body
         * (exact)": `data.status` and not one field more, and `domain/flow-protocol.ts` records
         * adding a `version` as a mistake this endpoint already made and removed. A reader
         * debugging a failed publish against this comment would have "fixed" the correct answer
         * into the broken one — the code was always right, only the comment lied. The protocol
         * module is the source; this line is a pointer to it. (Found by the deploy-day spec.)
         */
        await graph(`${flowId}/publish`, { method: 'POST' });
        console.log(`  ✅ published`);
        console.log(`  → set ${envNameFor(kind)}=${flowId} and redeploy`);
    }

    console.log('');
}

function envNameFor(kind: InAppSurfaceKind): string {
    if (kind === 'pl') return 'WHATSAPP_FLOW_ID_PRODUCT_LISTING';
    if (kind === 'pd') return 'WHATSAPP_FLOW_ID_PRODUCT_DETAIL';
    if (kind === 'co') return 'WHATSAPP_FLOW_ID_CHECKOUT';
    return '(no variable — this screen has no Flow)';
}

if (require.main === module) {
    /**
     * ⚠ **Guarded, like `scripts/migrate.ts` and `ensure-indexes.ts`.** Without it, a suite
     * that imports this file for its constants would publish Flows to a live Business Account
     * as a side effect of being type-checked.
     */
    main().catch((error) => {
        console.error('\n💥', error instanceof Error ? error.message : error);
        process.exit(1);
    });
}
