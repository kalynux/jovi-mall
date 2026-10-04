/**
 * test:role-closure — administrator-requested, user-confirmed closure of ONE role (ADR-A10).
 *
 * DB-free. Most of it is SOURCE SCANS, because the properties that matter are structural and
 * a regression in any of them is invisible to every behavioural test that runs green:
 *
 *   - a closed role must be REFUSED on all three credential paths (requireAuth, the refresh
 *     rotation, addRole) — miss one and a 30-day refresh cookie outlives the closure;
 *   - no reinstate verb may switch a closed role back on (vendor restore, agency reactivate,
 *     agent setStatus) — a closed role is `inactive`, which is exactly what they reinstate;
 *   - the confirm's compare-and-set runs FIRST inside the transaction, so two confirms
 *     racing run the cascade once;
 *   - the manifest touches no money collection, and deletes user-scoped rows only on the
 *     last-role branch (the person's other roles still use them);
 *   - nothing on the admin surface can confirm — only the user can.
 *
 * Run: npm run test:role-closure
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
    CLOSABLE_ROLES,
    ROLE_CLOSURE_BLOCKER_CODES,
    ROLE_CLOSURE_REQUEST_TTL_DAYS,
    isClosableRole,
} from '../../src/modules/role-closure/role-closure.types';
import {
    ConfirmRoleClosureSchema,
    RequestRoleClosureSchema,
    ROLE_CLOSURE_CONFIRMATION_PHRASE,
} from '../../src/modules/role-closure/role-closure.validators';
import { effectiveStatus } from '../../src/modules/role-closure/role-closure.dto';

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

const SRC = join(__dirname, '..', '..', 'src');
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');
const stripComments = (s: string): string =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const code = (rel: string): string => stripComments(read(rel));

/** The source between `start` and the next occurrence of `end` after it. */
function span(source: string, start: string, end: string): string {
    const from = source.indexOf(start);
    if (from < 0) throw new Error(`span start not found: ${start}`);
    const to = source.indexOf(end, from + start.length);
    return source.slice(from, to < 0 ? undefined : to);
}

function main(): void {
    console.log('\n1. Vocabulary');

    assert('the closable roles are the four platform roles — never `admin`', () =>
        CLOSABLE_ROLES.length === 4 && !(CLOSABLE_ROLES as readonly string[]).includes('admin')
        && !isClosableRole('admin') && isClosableRole('vendor'));

    assert('blocker codes are unique', () =>
        new Set(ROLE_CLOSURE_BLOCKER_CODES).size === ROLE_CLOSURE_BLOCKER_CODES.length);

    assert('the request lives seven days (owner decision O-3)', () => ROLE_CLOSURE_REQUEST_TTL_DAYS === 7);

    console.log('\n2. Request shapes');

    assert('a request needs a reason — the user is shown it', () =>
        !RequestRoleClosureSchema.safeParse({}).success
        && !RequestRoleClosureSchema.safeParse({ reason: 'x' }).success
        && RequestRoleClosureSchema.safeParse({ reason: 'Owner asked by email' }).success);

    assert('the request body is strict — no user id, no role, no subject can be smuggled in', () =>
        !RequestRoleClosureSchema.safeParse({ reason: 'Owner asked', userId: 'x' }).success);

    assert('a confirm needs the exact phrase, the same one ADR-A02 self-closure uses', () =>
        ROLE_CLOSURE_CONFIRMATION_PHRASE === 'CLOSE MY ACCOUNT'
        && ConfirmRoleClosureSchema.safeParse({ confirm: 'CLOSE MY ACCOUNT' }).success
        && !ConfirmRoleClosureSchema.safeParse({ confirm: 'close my account' }).success
        && !ConfirmRoleClosureSchema.safeParse({}).success);

    console.log('\n3. Lazy expiry');

    const now = new Date('2026-10-04T12:00:00Z');
    const row = (status: string, expiresAt: string) =>
        ({ status, expires_at: new Date(expiresAt) }) as never;

    assert('a pending request past its expiry reads as expired', () =>
        effectiveStatus(row('pending', '2026-10-04T11:59:59Z'), now) === 'expired');
    assert('...and at exactly its expiry, too (the confirm CAS is `expires_at > now`)', () =>
        effectiveStatus(row('pending', '2026-10-04T12:00:00Z'), now) === 'expired');
    assert('a pending request before its expiry stays pending', () =>
        effectiveStatus(row('pending', '2026-10-05T00:00:00Z'), now) === 'pending');
    assert('an answered request keeps its answer whatever the clock says', () =>
        effectiveStatus(row('confirmed', '2026-10-01T00:00:00Z'), now) === 'confirmed');

    console.log('\n4. A closed role is refused on every credential path');

    const middleware = code('api/middlewares/auth.middleware.ts');
    assert('requireAuth refuses a role entity carrying `closed_at`', () =>
        /closed_at[\s\S]{0,80}AUTH_ROLE_CLOSED/.test(middleware));
    assert('...BEFORE the vendor-suspension check (a closed vendor is also `inactive`)', () =>
        middleware.indexOf('AUTH_ROLE_CLOSED') < middleware.indexOf('AUTH_VENDOR_SUSPENDED'));

    const authService = code('modules/auth/auth.service.ts');
    const rotation = span(authService, 'async rotateRefreshToken', 'async register(');
    assert('the refresh rotation refuses a role no longer in `users.roles`', () =>
        /user\.roles\.includes\(payload\.role/.test(rotation) && rotation.includes('AUTH_ROLE_CLOSED'));
    assert('...BEFORE it mints the pair', () =>
        rotation.indexOf('AUTH_ROLE_CLOSED') < rotation.indexOf('issueTokenPair('));

    const addRole = span(authService, 'async addRole(', 'async sendEmailVerification');
    assert('addRole refuses re-adding a closed role, BEFORE creating an entity', () =>
        addRole.includes('ROLE_CLOSED') && addRole.indexOf('ROLE_CLOSED') < addRole.indexOf('Repo.create('));

    const botRegistration = code('modules/bot-surface/services/bot-registration.service.ts');
    assert('the bot never re-provisions a closed customer role', () =>
        /closed_at[\s\S]{0,120}AUTH_ROLE_CLOSED/.test(botRegistration));

    console.log('\n5. No reinstate verb can reopen a closed role');

    assert('vendor restore refuses `closed_at`', () =>
        /closed_at[\s\S]{0,120}ROLE_CLOSED/.test(span(code('modules/vendors/admin-vendor.service.ts'), 'async restore(', 'async restoreProduct(')));
    assert('agency reactivate refuses `closed_at`', () =>
        /closed_at[\s\S]{0,120}ROLE_CLOSED/.test(span(code('modules/delivery/services/admin-agency.service.ts'), 'async reactivate(', 'private async')));
    assert('agent setStatus refuses `closed_at`', () =>
        /closed_at[\s\S]{0,120}ROLE_CLOSED/.test(span(code('modules/agents/domain/services/agent-profile.service.ts'), 'async setStatus(', 'private async')));

    console.log('\n6. The four role models carry the stamp');

    for (const model of [
        'modules/customers/customer.model.ts',
        'modules/vendors/vendor.model.ts',
        'modules/delivery/delivery-agency.model.ts',
        'modules/agents/models/agent.model.ts',
    ]) {
        assert(`${model.split('/').pop()} declares \`closed_at\` in the interface and the schema`, () => {
            const src = code(model);
            return /closed_at: Date \| null;/.test(src) && /closed_at: \{ type: Date, default: null \}/.test(src);
        });
    }

    console.log('\n7. The manifest');

    const manifest = code('modules/role-closure/role-closure.manifest.ts');
    for (const method of ['closeVendor', 'closeAgency', 'closeAgent']) {
        assert(`${method} writes \`closed_at\` in the same $set as \`status: 'inactive'\``, () =>
            /status: 'inactive',\s*(status_reason: CLOSURE_REASON,\s*)?closed_at: closedAt/.test(
                span(manifest, `async ${method}(`, '\n  }\n')));
    }
    assert('the customer anonymisation stamps `closed_at` beside its status', () =>
        /status: 'inactive',\s*closed_at: closedAt/.test(code('modules/users/account-closure.repository.ts')));

    assert('the manifest imports NO money collection (ADR-A02 D-1: money is untouched)', () =>
        !/earnings|payout|cod\/|payments\/|refund/i.test(
            manifest.split('\n').filter((l) => l.startsWith('import')).join('\n')));

    const lastRole = span(manifest, 'async closeAccountIfLastRole(', '\n  }\n');
    assert('user-scoped rows (messaging connections, device tokens) are deleted ONLY on the last-role branch', () => {
        const outside = manifest.replace(lastRole, '');
        return lastRole.includes('deleteChannelConnections') && lastRole.includes('deleteDeviceTokens')
            && !outside.includes('deleteChannelConnections') && !outside.includes('deleteDeviceTokens');
    });
    assert('the last-role branch closes the account through the ADR-A02 compare-and-set', () =>
        lastRole.includes('anonymiseUser(') && lastRole.includes("$pull: { roles: role }"));

    assert('an agent closure turns Tracking Allow off AND emits the outbox row in the transaction', () => {
        const agent = span(manifest, 'async closeAgent(', '\n  }\n');
        return /setTrackingAllowed\([\s\S]*?false[\s\S]*?session/.test(agent)
            && /emitTrackingAllowChanged\([\s\S]*?session/.test(agent);
    });

    assert('a depot address is never emptied (its subdocument ids are durable references)', () =>
        !/headquarters_addresses: \[\]/.test(manifest));

    console.log('\n8. The lifecycle');

    const service = code('modules/role-closure/services/role-closure.service.ts');
    const confirm = span(service, 'async confirm(', '\n  private async requirePendingForCaller');
    assert('confirm re-checks the blockers before it writes anything', () =>
        confirm.indexOf('this.blockers.evaluate(') < confirm.indexOf('runInTransaction('));
    assert('the request compare-and-set runs FIRST inside the transaction', () => {
        const tx = span(confirm, 'runInTransaction(', 'const outcome');
        return tx.indexOf('this.requests.confirm(') >= 0
            && tx.indexOf('this.requests.confirm(') < tx.indexOf('this.manifest.close');
    });
    assert('events are published AFTER the commit, never inside it', () => {
        const tx = span(confirm, 'runInTransaction(', 'const outcome');
        return !tx.includes('eventBus.publish') && confirm.includes("'role_closure.confirmed'");
    });
    assert('the closing party\'s name is read BEFORE the anonymisation', () =>
        confirm.indexOf('displayNameOf(') < confirm.indexOf('runInTransaction('));

    const request = span(service, 'async request(', 'async cancel(');
    assert('a request refuses up front on the blockers the confirm would', () =>
        request.includes('this.blockers.evaluate(') && request.includes('ROLE_CLOSURE_BLOCKED'));
    assert('a stale pending row is expired before the create, so the unique index admits a new one', () =>
        request.indexOf('expireStale(') < request.indexOf('this.requests.create('));

    console.log('\n9. Who may answer');

    const controller = code('modules/role-closure/role-closure.controller.ts');
    const self = span(controller, 'export class RoleClosureSelfController', '\n}\n');
    assert('the user\'s role and entity come from the SESSION, never the body or the path', () =>
        /req\.auth!\.role\b/.test(controller) && /req\.auth!\.role_entity\._id/.test(controller)
        && !/req\.params/.test(self) && !/req\.body\.(role|userId)/.test(self));

    const adminRoutes = code('modules/users/admin-user.routes.ts');
    assert('the admin surface has request, cancel and list — and NO confirm', () =>
        adminRoutes.includes("'/:userId/roles/:role/closure', RoleClosureAdminController.request")
        && adminRoutes.includes("'/:userId/roles/:role/closure', RoleClosureAdminController.cancel")
        && adminRoutes.includes("'/:userId/closure-requests', RoleClosureAdminController.list")
        && !/RoleClosureAdminController\.confirm|RoleClosureSelfController/.test(adminRoutes));

    const meRoutes = code('modules/users/user.routes.ts');
    assert('/api/me serves the user\'s three verbs', () =>
        ["'/closure-request', RoleClosureSelfController.get",
            "'/closure-request/confirm', RoleClosureSelfController.confirm",
            "'/closure-request/decline', RoleClosureSelfController.decline"].every((s) => meRoutes.includes(s)));

    assert('the user\'s view names no administrator', () =>
        !/requestedBy|requested_by/.test(span(code('modules/role-closure/role-closure.dto.ts'), 'export function toSelfRoleClosureDto', '\n}\n')));

    console.log('\n10. The index');

    const model = code('modules/role-closure/models/role-closure-request.model.ts');
    const migration = read('../scripts/migrate-role-closure-indexes.ts');
    assert('one PENDING request per (user, role) — a partial unique index', () =>
        /\{ user_id: 1, role: 1 \}[\s\S]{0,200}unique: true[\s\S]{0,120}partialFilterExpression: \{ status: 'pending' \}/.test(model));
    assert('the migration builds it under the same name the model declares', () =>
        model.includes("name: 'role_closure_one_pending_per_role'")
        && migration.includes("name: 'role_closure_one_pending_per_role'"));
    assert('the migration is in the ledger registry', () =>
        read('../scripts/migrate.ts').includes("name: 'migrate:role-closure-indexes'"));

    console.log('\n' + '─'.repeat(72));
    console.log(`  ${passed} passed, ${failed} failed`);
    console.log('─'.repeat(72) + '\n');
    if (failed > 0) process.exit(1);
}

main();
