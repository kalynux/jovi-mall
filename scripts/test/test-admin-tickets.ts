/**
 * Test: the administrator half of the ticket domain (Phase 17).
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no framework).
 * DB-free — but it loads the real route table and the real Mongoose schema, because the
 * three things most worth pinning here are structural rather than computational:
 *
 *   1. the LEGACY `/api/admin/tickets` mount is gone, and the internal one replaced it
 *   2. `publicAdminSnapshot` really drops `tier`
 *   3. the whole exclusivity mechanism is gone, not merely unused
 *
 * ── Why (2) carries the most weight ───────────────────────────────────────────
 * The snapshot block is rendered to ticket followers — a customer, a vendor, an agency, an
 * agent. `tier` is in it because wi-admin's read scope filters on it, and it is the one
 * field that must never travel: it publishes the platform's internal hierarchy, and it is
 * the input to who may see the ticket. A regression there is silent — the endpoint keeps
 * working and simply says more than it should — which is exactly the shape of leak the
 * public-catalog DTO assertions exist to catch.
 *
 * ── Why (3) is a SOURCE SCAN ─────────────────────────────────────────────────
 * `assigned_admin_id` was an auto-set exclusivity lock: touching a ticket claimed it, and
 * every other administrator then got a 403 — a Developer included. Deleting the column is
 * not enough to prove the behaviour is gone, and a leftover helper would be re-wired by
 * somebody reasonably assuming it still meant something. The scan asserts the names are
 * absent from the module entirely.
 *
 * Run: npm run test:admin-tickets
 */
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-secret-value-32-characters-long';
process.env.INTERNAL_ADMIN_SERVICE_TOKEN = process.env.INTERNAL_ADMIN_SERVICE_TOKEN ?? 'test-token-value-32-characters-long';

import fs from 'fs';
import path from 'path';
import { apiRouter } from '../../src/api/index';
import {
    AssignToAdministratorSchema,
    CreateTicketSchema,
} from '../../src/modules/tickets/validators/ticket.validator';
import { isAdminSnapshot, publicAdminSnapshot } from '../../src/core/types/admin-snapshot.types';
import { TicketModel } from '../../src/modules/tickets/models/ticket.model';

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

const SRC = path.resolve(__dirname, '../../src');
const read = (relative: string): string => fs.readFileSync(path.join(SRC, relative), 'utf8');

/** Every route Express actually registered, as `METHOD /full/path`. */
function registeredRoutes(): string[] {
    const found: string[] = [];
    const MOUNT = /^\^\\\/(.*?)\\\/\?\(\?=\\\/\|\$\)$/;

    const walk = (layers: any[], prefix: string): void => {
        for (const layer of layers || []) {
            if (layer.route) {
                for (const method of Object.keys(layer.route.methods || {})) {
                    found.push(`${method.toUpperCase()} ${prefix}${layer.route.path}`);
                }
            } else if (layer.name === 'router' && layer.handle?.stack) {
                const source: string = layer.regexp?.source ?? '';
                const matched = MOUNT.exec(source);
                const segment = matched?.[1] ? `/${matched[1].replace(/\\(.)/g, '$1')}` : '';
                walk(layer.handle.stack, prefix + segment);
            }
        }
    };

    walk((apiRouter as any).stack, '');
    return found;
}

const ADMIN: Parameters<typeof publicAdminSnapshot>[0] = {
    id: '68c0f1a2b3c4d5e6f7a8b9c0',
    source: 'admin',
    name: 'Jane Doe',
    tier: 1,
    job_title: 'Lead Support Engineer',
    department: 'Escalations',
    avatar_url: 'https://cdn.example.test/a.png',
};

function main(): void {
    const routes = registeredRoutes();
    const internal = routes.filter((r) => r.includes('/internal/admin/tickets'));

    console.log('\n▶ The mounts — the legacy admin ticket surface is gone');

    /**
     * The one ported domain that kept no public twin. Its only admin access control was the
     * exclusivity lock, which is deleted; and it could not have been given the tier rules
     * that replaced it, because a legacy `admin` is a platform `users` row with no tier.
     */
    assert('no /api/admin/tickets mount exists', () =>
        !routes.some((r) => /\s\/admin\/tickets/.test(r)));
    /**
     * 18 ported routes, plus `PATCH /:id/admin-snapshot`.
     *
     * That nineteenth is not a ported endpoint — it exists because the assignee's profile is
     * a COPY that goes stale, and wi-admin re-stamps it on every write (D-10). It is
     * deliberately NOT a shape of `/assign`: sending a bare `admin` there means "this
     * administrator now holds it, claimed", so routing a refresh through it would reassign the
     * ticket on every edit and clear `assigned_by` — the field the tier rules read.
     */
    assert('the internal mount serves 18 ported routes plus the snapshot refresh', () =>
        internal.length === 19
        && internal.includes('PATCH /internal/admin/tickets/:id/admin-snapshot'));

    assert('the refresh route is distinct from /assign', () =>
        internal.includes('PATCH /internal/admin/tickets/:id/assign'));
    assert('the other four role mounts are untouched', () =>
        ['vendor', 'customer', 'agency', 'agent']
            .every((role) => routes.some((r) => r.includes(`/${role}/tickets`))));

    /**
     * `/reference/*` and `/attachments/:id` are literal siblings of `/:id` and `/:ticketId`.
     * Express matches in registration order, so declared after them they are read as ids —
     * silently, and only for those two paths.
     */
    assert('literal routes are declared before the parameterised ones', () =>
        internal.indexOf('GET /internal/admin/tickets/reference/orders') < internal.indexOf('GET /internal/admin/tickets/:id')
        && internal.indexOf('DELETE /internal/admin/tickets/attachments/:id') < internal.indexOf('POST /internal/admin/tickets/:ticketId/attachments'));

    console.log('\n▶ The disclosure boundary — what a ticket follower may see');

    // Through `unknown`: the point of the assertions below is that the emitted object has
    // FEWER keys than the internal one, so it deliberately does not overlap a bag of strings.
    const shown = publicAdminSnapshot(ADMIN) as unknown as Record<string, unknown>;

    assert('the four visible fields survive', () =>
        shown.name === 'Jane Doe'
        && shown.job_title === 'Lead Support Engineer'
        && shown.department === 'Escalations'
        && shown.avatar_url === 'https://cdn.example.test/a.png');

    // The load-bearing one. `tier` decides who may see the ticket; a customer must not learn it.
    assert('tier NEVER travels to a ticket follower', () => !('tier' in shown));
    assert('the administrator id does not travel', () => !('id' in shown));
    assert('the identity source does not travel', () => !('source' in shown));
    assert('exactly four fields are emitted', () => Object.keys(shown).length === 4);
    assert('an unassigned ticket yields null, not an empty block', () =>
        publicAdminSnapshot(null) === null && publicAdminSnapshot(undefined) === null);

    console.log('\n▶ The wire contract wi-admin writes through');

    assert('a claim needs no assigner', () =>
        AssignToAdministratorSchema.safeParse({ admin: ADMIN }).success);
    assert('a handover carries both administrators', () =>
        AssignToAdministratorSchema.safeParse({ admin: ADMIN, assignedBy: { ...ADMIN, id: 'b', tier: 2 } }).success);
    assert('an unknown key is refused rather than stripped', () =>
        !AssignToAdministratorSchema.safeParse({ admin: { ...ADMIN, jobTitle: 'x' } }).success);
    assert('a tier outside 1..3 is refused', () =>
        !AssignToAdministratorSchema.safeParse({ admin: { ...ADMIN, tier: 0 } }).success
        && !AssignToAdministratorSchema.safeParse({ admin: { ...ADMIN, tier: 4 } }).success);
    assert('an assignment with no administrator is refused', () =>
        !AssignToAdministratorSchema.safeParse({}).success);

    const base = { subject: 's', description: 'd', type: 'ORDER_ISSUE', importance: 'high', entityType: 'OTHER' };
    assert('ticket creation accepts the creating administrator', () =>
        CreateTicketSchema.safeParse({ ...base, admin: ADMIN }).success);
    assert('ticket creation still works with no administrator (every role route)', () =>
        CreateTicketSchema.safeParse(base).success);
    assert('a half-filled snapshot is refused', () =>
        !CreateTicketSchema.safeParse({ ...base, admin: { id: 'a' } }).success);

    assert('isAdminSnapshot rejects an out-of-range tier', () =>
        !isAdminSnapshot({ ...ADMIN, tier: 4 }) && isAdminSnapshot(ADMIN));

    console.log('\n▶ The stored shape');

    const paths = Object.keys((TicketModel.schema as any).paths);
    const indexes = JSON.stringify((TicketModel.schema as any).indexes());

    assert('admin_assignment is on the schema', () =>
        paths.some((p) => p.startsWith('admin_assignment')));
    assert('created_by_admin is on the schema', () =>
        paths.some((p) => p.startsWith('created_by_admin')));

    /**
     * Both scope queries must be servable from an index: Support asks for "mine or
     * unassigned", an Admin for "mine, a Tier 3's, or unassigned", and both sort newest-first
     * like every other ticket list.
     */
    assert('the two read-scope indexes exist', () =>
        indexes.includes('admin_assignment.admin.id') && indexes.includes('admin_assignment.admin.tier'));

    console.log('\n▶ The exclusivity lock is gone, not merely unused');

    const ticketModule = [
        'modules/tickets/models/ticket.model.ts',
        'modules/tickets/services/ticket.service.ts',
        'modules/tickets/repositories/ticket.repository.ts',
        'modules/tickets/controllers/ticket.controller.ts',
        'modules/tickets/services/ticket-enrichment.service.ts',
    ].map(read);

    // Comments are stripped first: the tombstones explaining what was deleted are the most
    // useful thing in that diff, and a scan that forced their removal would make the codebase
    // worse. Same reasoning as `test:connections`.
    const code = ticketModule
        .map((s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''))
        .join('\n');

    assert('assigned_admin_id appears nowhere in the module', () => !code.includes('assigned_admin_id'));
    assert('validateActiveAdminPermission is gone', () => !code.includes('validateActiveAdminPermission'));
    assert('setActiveAdminIfNotSet is gone', () => !code.includes('setActiveAdminIfNotSet'));
    assert('setActiveAdmin / clearActiveAdmin are gone from the repository', () =>
        !code.includes('setActiveAdmin(') && !code.includes('clearActiveAdmin('));

    /**
     * The lookup that could not work. `resolveAdmins` queried THIS database's `admins`
     * collection for an id belonging to wi-admin's, so it matched nothing and every reader
     * saw `null` — which is the defect the snapshot exists to fix. If it comes back, the
     * snapshot has a competitor.
     */
    assert('resolveAdmins is gone from the enrichment service', () => !code.includes('resolveAdmins'));

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`  ${passed} passed, ${failed} failed`);
    console.log(`${'─'.repeat(60)}\n`);

    process.exit(failed > 0 ? 1 : 0);
}

main();
