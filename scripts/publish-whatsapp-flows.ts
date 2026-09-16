/**
 * Publish the WhatsApp Flows — the step that is gated on a working number.
 *
 * ── WHY THIS IS A SCRIPT AND EXISTS BEFORE IT CAN BE RUN ────────────────────
 * Publishing a Flow is a sequence of four Graph calls that must happen in order, and it
 * cannot be rehearsed on this platform today: the sending number's display name has never
 * been approved, so nothing about the WhatsApp account is usable yet. The temptation is to
 * leave publishing as "a thing somebody does in the Flow Builder when the number clears" —
 * and that is how a gated final step becomes an afternoon of discovering that the public key
 * upload is a *separate* call from the Flow creation, that a Flow cannot be published until
 * its endpoint answers a health check, and that the endpoint cannot answer one until the key
 * is uploaded.
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

    if (!flowsConfigured()) problems.push('WHATSAPP_FLOW_PRIVATE_KEY is unset or will not parse');
    if (!ACCESS_TOKEN) problems.push('WHATSAPP_ACCESS_TOKEN is unset');
    if (!PHONE_NUMBER_ID) problems.push('WHATSAPP_PHONE_NUMBER_ID is unset — needed for the key upload');
    if (!WABA_ID) problems.push('WHATSAPP_BUSINESS_ACCOUNT_ID is unset — needed to create a Flow');

    for (const p of problems) console.log(`  ⚠ ${p}`);
    return problems.length === 0;
}

/**
 * Validate every definition offline.
 *
 * ⚠ **The same rules `test:whatsapp-flows` § 8 asserts**, repeated here on purpose rather
 * than imported: this script is what somebody runs at the moment of publishing, possibly
 * months later and under pressure, and it should refuse a broken definition itself rather
 * than assume a suite was run. Both catch an unrouted screen, which Meta accepts and then
 * renders as nothing.
 */
function validate(): boolean {
    console.log('\n▶ Definitions');
    let ok = true;

    for (const [kind, name, definition] of FLOWS) {
        const unrouted = definition.screens
            .filter((s) => !Object.prototype.hasOwnProperty.call(definition.routing_model, s.id))
            .map((s) => s.id);
        const terminals = definition.screens.filter((s) => s.terminal).length;
        const missingExample = definition.screens.flatMap((s) =>
            Object.entries(s.data ?? {})
                .filter(([, f]) => f.__example__ === undefined)
                .map(([field]) => `${s.id}.${field}`));

        const faults = [
            ...unrouted.map((s) => `screen '${s}' is not in the routing model (it would render as nothing)`),
            ...(terminals === 1 ? [] : [`${terminals} terminal screens, expected exactly 1`]),
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
        console.log('  When the number is working:');
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
            body: JSON.stringify({ name, categories: ['OTHER'] }),
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
         * `{version, data:{status:"active"}}` — in that order of likelihood.
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
