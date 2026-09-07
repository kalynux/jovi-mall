/**
 * Test: the notification deep-link VOCABULARY for the vendor, agency and agent apps.
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no framework).
 * DB-free.
 *
 * ── WHY THIS SUITE EXISTS ────────────────────────────────────────────────────
 *
 * On 2026-09-07 the owner chose how notification buttons reach these three apps, out of
 * three options: the backend owning each app's real routes, each app translating a short
 * label into its own route, or dropping the button on external channels. **Each app
 * translates** was chosen, and this suite is the half of that decision that lives here.
 *
 * The choice only works if `action.path` is a CLOSED, STABLE set. Three apps now hold a
 * translation table keyed on these strings — `resolveDeepLink` in the Flutter agent app,
 * `dashboardRoute` in agency-dash, and vendor-dash's own resolver — and none of them is in
 * this repository. A path added, renamed or removed here without telling them is a button
 * that silently goes nowhere, in an app nobody rebuilt.
 *
 * That is not hypothetical, and it is the reason the vocabulary is pinned against a
 * HARDCODED LITERAL rather than derived twice. The customer stack had exactly this shape of
 * bug: all 22 of its buttons pointed at pages that had never existed, in every language on
 * every channel, and four assertions written against the broken values passed for months.
 * A test that re-derives the list from the catalogue would agree with any change ever made.
 *
 * ⚠ **If this suite fails, the fix is usually NOT to edit the literal.** It is to ask
 * whether the three apps can translate the new value, and to update
 * `api-doc/notifications/deep-links.md` in the same change. Editing the literal alone
 * makes the test green and the buttons dead.
 *
 * Run: npm run test:notification-deeplinks
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { NOTIFICATION_CATALOG } from '../../src/modules/notifications/catalog/notification-catalog';
import { AGENCY_NOTIFICATION_CATALOG } from '../../src/modules/notifications/catalog/agency-notification-catalog';
import { AGENT_NOTIFICATION_CATALOG } from '../../src/modules/notifications/catalog/agent-notification-catalog';

let passed = 0;
let failed = 0;

function assert(name: string, fn: () => boolean): void {
    let ok: boolean;
    try {
        ok = fn();
    } catch (err) {
        console.error(`  ❌ THROW: ${name} — ${(err as Error).message}`);
        failed++;
        return;
    }
    if (ok) {
        console.log(`  ✅ ${name}`);
        passed++;
    } else {
        console.error(`  ❌ FAIL: ${name}`);
        failed++;
    }
}

type CatalogEntry = { button?: { urlSuffix: string } };
type Catalog = Record<string, CatalogEntry>;

/** Every distinct `action.path` a catalogue can produce, sorted. */
function vocabularyOf(catalog: Catalog): string[] {
    return [...new Set(
        Object.values(catalog)
            .map((entry) => entry.button?.urlSuffix)
            .filter((s): s is string => typeof s === 'string'),
    )].sort();
}

/**
 * ⚠ **THE CONTRACT. Three apps in three repositories translate these strings.**
 *
 * Copied into `api-doc/notifications/deep-links.md`, which is what the app authors were
 * handed. Changing one is a four-repository change: here, that document, and whichever
 * apps hold a case for it.
 */
const VENDOR_VOCABULARY = [
    'agency-connections/{{connectionId}}',
    'bookings/{{bookingId}}',
    'orders/{{orderId}}',
    'plans',
    'products/{{productId}}',
    'settings/storage',
    'stock-requests/{{requestId}}',
    'tickets/{{ticketId}}',
];

const AGENCY_VOCABULARY = [
    'agents/{{contractId}}',
    'cod/deposits/{{depositId}}',
    'plans',
    'settings/storage',
    'shipments/{{shipmentId}}',
    'stock-requests/{{requestId}}',
    'tickets/{{ticketId}}',
    'vendor-connections/{{connectionId}}',
];

const AGENT_VOCABULARY = [
    'cod/deposits/{{depositId}}',
    'memberships/{{contractId}}',
    'offers/{{offerId}}',
    'plans',
    'settings/storage',
];

function main(): void {
    console.log('\n── The vocabulary each app translates (the contract) ──');

    assert('the VENDOR app is offered exactly the 8 documented paths', () =>
        JSON.stringify(vocabularyOf(NOTIFICATION_CATALOG as unknown as Catalog))
        === JSON.stringify(VENDOR_VOCABULARY));

    assert('the AGENCY app is offered exactly the 8 documented paths', () =>
        JSON.stringify(vocabularyOf(AGENCY_NOTIFICATION_CATALOG as unknown as Catalog))
        === JSON.stringify(AGENCY_VOCABULARY));

    assert('the AGENT app is offered exactly the 5 documented paths', () =>
        JSON.stringify(vocabularyOf(AGENT_NOTIFICATION_CATALOG as unknown as Catalog))
        === JSON.stringify(AGENT_VOCABULARY));

    console.log('\n── The shape rules a translator depends on ──');

    const allPaths = [...VENDOR_VOCABULARY, ...AGENCY_VOCABULARY, ...AGENT_VOCABULARY];

    /**
     * ⚠ A leading slash is not cosmetic here. Every consumer joins this onto a base —
     * `${APP_URL}/${path}` on the wire, `/dashboard/${path}` in agency-dash — so one
     * produces `//shop` or `/dashboard//orders`, both of which resolve to something else.
     */
    assert('no path carries a leading slash', () =>
        allPaths.every((p) => !p.startsWith('/')));

    assert('no path carries a trailing slash', () =>
        allPaths.every((p) => !p.endsWith('/')));

    /**
     * The customer stack's paths gained a `shop/account/` prefix and a locale, because the
     * storefront's routes really are addressed that way. These three are the opposite case:
     * they are LABELS, translated on arrival, so a route prefix here would be a fact about
     * one app baked into a string the other two also read.
     */
    assert('no path carries an app route prefix — these are labels, not routes', () =>
        allPaths.every((p) => !p.startsWith('dashboard/') && !p.startsWith('shop/')));

    assert('no path carries a locale segment', () =>
        allPaths.every((p) => !/^(en|fr|pt|es|ar)\//.test(p)));

    /**
     * A translator switches on the literal segments and reads the id out of the placeholder
     * slot. A path mixing two placeholders, or placing one anywhere but last, would need a
     * parser rather than a table.
     */
    assert('every path has at most one placeholder, and it is always LAST', () =>
        allPaths.every((p) => {
            const matches = p.match(/\{\{[a-zA-Z]+\}\}/g) ?? [];
            if (matches.length !== 1) return matches.length === 0;
            const [only] = matches;
            return only !== undefined && p.endsWith(only);
        }));

    assert('every placeholder names an id the notification actually carries', () => {
        const known = new Set([
            'connectionId', 'bookingId', 'orderId', 'productId', 'requestId', 'ticketId',
            'contractId', 'depositId', 'shipmentId', 'offerId',
        ]);
        return allPaths.every((p) => {
            const m = p.match(/\{\{([a-zA-Z]+)\}\}/);
            return !m || known.has(m[1]);
        });
    });

    console.log('\n── Deliberate absences, so nobody "fixes" them ──');

    /**
     * The Flutter app's `resolveDeepLink` returns null for an absent path and falls back to
     * the inbox, and its comment names this situation. Giving it a button would send an
     * agent to a shipment that is no longer theirs — every scoped read 404s once `agent_id`
     * is cleared.
     */
    assert('⚠ shipment.reassigned_away deliberately has NO button', () =>
        (AGENT_NOTIFICATION_CATALOG as unknown as Catalog)['shipment.reassigned_away']?.button === undefined);

    /**
     * The agency calls it a contract everywhere else — `AgentAgencyContract`, `contractId`,
     * `agent_contract.*`. The agent app's path says `memberships`, the pre-refactor word.
     * It is kept BECAUSE the app already translates it: renaming would break a shipped
     * client to tidy a string nobody sees. The Flutter resolver's own comment says as much.
     */
    assert('⚠ the agent path keeps the legacy word `memberships` for a `contractId`', () =>
        AGENT_VOCABULARY.includes('memberships/{{contractId}}'));

    /**
     * The same situation family reaches the agency as `agents/{id}` and the agent as
     * `memberships/{id}`, carrying the same contract id. Two audiences, two apps, two
     * screens — the path is per-audience and must not be unified.
     */
    assert('the same contract event uses a DIFFERENT path per audience', () =>
        AGENCY_VOCABULARY.includes('agents/{{contractId}}')
        && AGENT_VOCABULARY.includes('memberships/{{contractId}}'));

    console.log('\n── The document that was handed to the app authors ──');

    /**
     * ⚠ A vocabulary nobody was told about is not a contract. The three apps translate from
     * that file, so it is as load-bearing as the literal above — and a path added here with
     * no row there is a button its author believes works.
     */
    assert('every path appears in api-doc/notifications/deep-links.md', () => {
        const doc = readFileSync(join(__dirname, '../../api-doc/notifications/deep-links.md'), 'utf8');
        return [...new Set(allPaths)].every((p) => doc.includes(p));
    });

    console.log(
        failed === 0
            ? `\n✅ ${passed} passed, 0 failed`
            : `\n❌ ${passed} passed, ${failed} failed`,
    );
    process.exit(failed === 0 ? 0 : 1);
}

main();
