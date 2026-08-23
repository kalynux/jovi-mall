/**
 * Test: account closure — anonymise-and-retain (ADR-A02 D-1, Phase 6 step 12).
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no framework).
 * DB-free. The confirmation schema is exercised for real; everything else is a SOURCE SCAN,
 * because what has to be guaranteed here is not a return value — it is that a particular set
 * of writes happens and another particular set does NOT.
 *
 * ── What this guards ─────────────────────────────────────────────────────────
 * Closure has three failure modes and only one of them is loud:
 *
 *   1. It anonymises too little — a collection holding the person's name or phone number is
 *      missed. **Silent.** The account looks closed and the identifier is still there.
 *   2. It anonymises too much — a money record is emptied, and somebody else's balance is now
 *      wrong. Loud, eventually, and unrecoverable.
 *   3. The account can still be signed into. Loud, and the whole promise is void.
 *
 * The manifest scans below are aimed at (1), the untouched-collections scan at (2), and the
 * three auth-path scans at (3). None of them can be replaced by a behavioural test without a
 * database, and (1) cannot be replaced by one even with a database — a test can only assert
 * over the collections somebody thought to seed.
 *
 * Run: npm run test:account-closure
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
    CloseAccountSchema,
    ACCOUNT_CLOSURE_CONFIRMATION,
} from '../../src/modules/users/user.validator';

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

const ROOT = join(__dirname, '..', '..');
const SRC = join(ROOT, 'src');
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');
const readRoot = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');
const stripComments = (s: string): string =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const model = read('modules/users/user.model.ts');
const repoRaw = read('modules/users/account-closure.repository.ts');
const repo = stripComments(repoRaw);
const serviceRaw = read('modules/users/account-closure.service.ts');
const service = stripComments(serviceRaw);
const controller = stripComments(read('modules/users/user.controller.ts'));
const routes = stripComments(read('modules/users/user.routes.ts'));
const middleware = stripComments(read('api/middlewares/auth.middleware.ts'));
const authService = stripComments(read('modules/auth/auth.service.ts'));
const resetService = stripComments(read('modules/auth/services/password-reset.service.ts'));
const adminUserService = stripComments(read('modules/users/admin-user.service.ts'));
/**
 * The closure handler alone. Scoped so a password scan cannot see `updatePassword` next door,
 * which legitimately handles one — `handlerBody` is a hoisted declaration, so calling it here
 * is fine.
 */
const closeHandler = handlerBody(controller, 'closeAccount');
const doc = readRoot(join('api-doc', 'me', 'account-closure.md'));
/**
 * Prose wraps; a phrase split across two lines is still the phrase. Blockquote markers go
 * first — otherwise a wrapped line inside a `>` block joins as `reasonable > expectation`.
 */
const docFlat = doc.replace(/^>\s?/gm, '').replace(/\s+/g, ' ');

/** One handler body, for scans that must not see `updatePassword` next door. */
function handlerBody(source: string, name: string): string {
    const start = source.indexOf(`static ${name} = asyncHandler(`);
    if (start === -1) return '';
    const after = source.slice(start + 1);
    const next = after.search(/\n {2,4}static \w+ = /);
    return next === -1 ? after : after.slice(0, next);
}

/** The body of one method, for scans that must not see its neighbours. */
function methodBody(source: string, name: string): string {
    const start = source.indexOf(`async ${name}(`);
    if (start === -1) return '';
    const after = source.slice(start + 1);
    // The indent width is not fixed across this codebase — match two OR four.
    const next = after.search(/\n {2,4}(?:async \w+\(|\/\*\*)/);
    return next === -1 ? after : after.slice(0, next);
}

function main(): void {
    console.log('\n── `closed` is a THIRD status, not a reuse of `suspended` ──────────────\n');

    assert('the status union carries all three values', () =>
        model.includes("export type UserStatus = 'active' | 'suspended' | 'closed';"));

    assert('the schema enum carries all three', () =>
        /enum:\s*\['active',\s*'suspended',\s*'closed'\]/.test(model));

    assert('the closure stamp exists and defaults to null', () =>
        /closed_at:\s*\{\s*type:\s*Date,\s*default:\s*null\s*\}/.test(model));

    // The reason `closed` is not `suspended`. Both admin verbs compare-and-set from a status a
    // closed account is not in, so neither can touch one — and that is what makes closure
    // irreversible by construction rather than by everybody remembering.
    assert('admin suspend still compare-and-sets FROM active', () =>
        methodBody(stripComments(adminUserService), 'suspend')
            .includes("applyStatusChangeIfCurrent(userId, 'active', 'suspended'"));

    assert('admin restore still compare-and-sets FROM suspended — so it cannot un-close', () =>
        methodBody(stripComments(adminUserService), 'restore')
            .includes("applyStatusChangeIfCurrent(userId, 'suspended', 'active'"));

    assert('nothing anywhere transitions OUT of closed', () => {
        const src = repo + service + stripComments(adminUserService);
        // Any write moving a row off `closed` would have to name it as the `from`.
        return !/'closed',\s*'(active|suspended)'/.test(src)
            && !/status:\s*'closed'[^}]*\}\s*,\s*\{\s*\$set:\s*\{\s*status:\s*'(active|suspended)'/.test(src);
    });

    console.log('\n── The `_id` is KEPT and the identifiers are GONE ──────────────────────\n');

    const anonymiseUser = methodBody(repo, 'anonymiseUser');

    assert('the user write is a compare-and-set on active, keyed by _id', () =>
        anonymiseUser.includes("{ _id: userId, status: 'active' }"));

    assert('it never deletes the row', () =>
        !repo.includes('UserModel.deleteOne') && !repo.includes('UserModel.deleteMany')
        && !repo.includes('findByIdAndDelete'));

    assert('both login identifiers are $unset, not set to null', () =>
        /\$unset:\s*\{\s*login_email:\s*'',\s*login_phone:\s*''\s*\}/.test(anonymiseUser));

    // `$set: null` would collide on the SPARSE unique indexes the moment a second account
    // closed — the same rule `UserRepository.updateContact` follows.
    assert('neither identifier is set to null anywhere in the closure', () =>
        !/login_(email|phone):\s*null/.test(repo));

    assert('status, the stamp, the hash and the epoch are ONE $set', () => {
        const set = anonymiseUser.slice(anonymiseUser.indexOf('$set'), anonymiseUser.indexOf('$unset'));
        return set.includes("status: 'closed'")
            && set.includes('closed_at: closedAt')
            && set.includes('password_hash: replacementPasswordHash')
            && set.includes('password_changed_at: closedAt');
    });

    const anonymiseCustomer = methodBody(repo, 'anonymiseCustomer');

    assert('the profile loses its name', () =>
        anonymiseCustomer.includes('name: ANONYMISED_CUSTOMER_NAME'));

    assert('the profile loses its contact fields', () =>
        /\$unset:\s*\{\s*email:\s*'',\s*phone:\s*''\s*\}/.test(anonymiseCustomer));

    assert('the profile loses avatar, bio, addresses and date of birth', () =>
        anonymiseCustomer.includes('avatar_file_id: null')
        && anonymiseCustomer.includes('avatar_url: null')
        && anonymiseCustomer.includes('bio: null')
        && anonymiseCustomer.includes('saved_addresses: []')
        && anonymiseCustomer.includes('date_of_birth: null'));

    assert('marketing consent does not survive the account it was given on', () =>
        anonymiseCustomer.includes("'preferences.marketing_opt_in': false"));

    assert('the customer row is updated, never deleted', () =>
        !repo.includes('CustomerModel.deleteOne') && !repo.includes('CustomerModel.deleteMany'));

    console.log('\n── The rows that ARE an identifier are deleted ─────────────────────────\n');

    // Each of these is either an address the person can be reached on or a name. Anonymising
    // one would keep exactly the part that identifies them.
    const deletes: [string, string][] = [
        ['messaging connections', 'ChannelConnectionModel.deleteMany({ user_id: userId }'],
        ['push device tokens', 'DeviceTokenModel.deleteMany({ userId }'],
        ['saved payment instruments', 'UserPaymentMethodModel.deleteMany('],
        ['in-app notifications', 'CustomerNotificationModel.deleteMany('],
    ];
    for (const [label, needle] of deletes) {
        assert(`${label} are deleted`, () => repo.includes(needle));
    }

    assert("the vendor's private NAME for the customer is cleared, and only that", () => {
        const body = methodBody(repo, 'clearVendorAnnotations');
        return body.includes('$set: { display_name_override: null }')
            && !body.includes('order_count')
            && !body.includes('total_spent')
            && !body.includes('deleteMany');
    });

    console.log('\n── Money and transactions are UNTOUCHED ────────────────────────────────\n');

    /**
     * The (2) failure mode. ADR-A02 D-1: money records "are not the customer's personal data to
     * remove, and removing them would corrupt somebody else's balance".
     *
     * Asserted as an absence, which is the only way to assert it: any of these appearing in the
     * closure manifest is the defect, whatever the surrounding code intends.
     */
    const forbidden = [
        'CashCollectionModel', 'AgentDepositModel', 'AgencyRemittanceModel',
        'EarningsModel', 'PayoutRequestModel', 'PaymentTransactionModel',
        'RefundTransactionModel', 'CodDiscrepancyModel', 'TransactionModel',
    ];
    for (const model_ of forbidden) {
        assert(`${model_} is not reachable from the closure`, () => !repoRaw.includes(`import { ${model_}`));
    }

    assert('orders are only COUNTED, never written', () => {
        const orderUses = repo.match(/OrderModel\.\w+/g) ?? [];
        return orderUses.length > 0 && orderUses.every((u) => u === 'OrderModel.countDocuments');
    });

    assert('tickets and bookings are not touched at all', () =>
        !repoRaw.includes('TicketModel') && !repoRaw.includes('BookingModel'));

    console.log('\n── A dual-role account is REFUSED, not partially closed ────────────────\n');

    assert('the refusal has its own code', () =>
        service.includes('ERROR_CODES.ACCOUNT_CLOSURE_ROLE_NOT_ELIGIBLE'));

    // "anything that is not customer", not "vendor" — an agent carries a COD liability balance
    // and an agency contract, and neither has a self-service close either.
    assert('it refuses every role beyond customer, not just vendor', () =>
        service.includes("filter((role) => role !== 'customer')"));

    assert('the refusal names which roles blocked it', () =>
        service.includes('blockingRoles'));

    assert('the role guard runs BEFORE anything is written', () => {
        const guard = service.indexOf('ACCOUNT_CLOSURE_ROLE_NOT_ELIGIBLE');
        const write = service.indexOf('runInTransaction');
        return guard > -1 && write > -1 && guard < write;
    });

    console.log('\n── Orders in flight are refused ────────────────────────────────────────\n');

    assert('the refusal has its own code and carries a count', () =>
        service.includes('ERROR_CODES.ACCOUNT_CLOSURE_ORDERS_IN_FLIGHT')
        && service.includes('activeOrderCount'));

    // Derived by exclusion, so a fulfilment status added later is "in flight" until somebody
    // deliberately says otherwise. The cost of the wrong answer is an undeliverable parcel.
    assert('"settled" is a closed list and everything else counts as in flight', () =>
        repo.includes("SETTLED_FULFILMENT: readonly FulfillmentStatus[] = ['fulfilled', 'cancelled', 'returned']")
        && repo.includes('$nin: SETTLED_FULFILMENT'));

    assert('an order under a dispute hold blocks closure too', () =>
        repo.includes("'dispute_hold.active': true"));

    console.log('\n── One transaction, and the ordering that survives a failure ───────────\n');

    assert('the whole cascade runs in a transaction', () =>
        service.includes('transactionManager.runInTransaction'));

    assert('the compare-and-set is the FIRST write in it', () => {
        const tx = service.slice(service.indexOf('runInTransaction'));
        return tx.indexOf('anonymiseUser') < tx.indexOf('anonymiseCustomer');
    });

    assert('a lost compare-and-set raises USER_STATUS_CONFLICT, not a silent success', () =>
        service.includes('ERROR_CODES.USER_STATUS_CONFLICT'));

    /**
     * `FileReferenceService.reconcile` takes no session, so it cannot join the transaction.
     * Detaching FIRST is the survivable order: a failure aborts before anything is anonymised.
     * Detaching after a committed closure would leave a reference to an avatar the profile no
     * longer names — protecting a file from cleanup forever, silently.
     */
    assert('the avatar reference is detached BEFORE the transaction opens', () => {
        const detach = service.indexOf('fileReferenceService.reconcile');
        const tx = service.indexOf('runInTransaction');
        return detach > -1 && tx > -1 && detach < tx;
    });

    assert('the replacement hash is computed outside the transaction', () => {
        const hash = service.indexOf('bcrypt.hash');
        return hash > -1 && hash < service.indexOf('runInTransaction');
    });

    assert('the event and the audit row are published AFTER the commit', () => {
        const tx = service.indexOf('runInTransaction');
        return service.indexOf('eventBus.publish') > tx && service.indexOf('auditLogger.log') > tx;
    });

    // Writing the removed identifiers into an audit row re-creates the record the closure just
    // removed, in a place with no retention owner.
    assert('the audit row carries no `before` state', () =>
        !/auditLogger\.log\([\s\S]{0,600}?changes:/.test(service));

    console.log('\n── Authentication is refused on every path afterwards ──────────────────\n');

    /**
     * Three paths, plus the reset redemption. The ORDER is the assertion that matters at each:
     * `closed` is not `active`, so the suspension guard would match it and tell somebody who
     * anonymised their own account that it is "suspended" — which reads as appealable.
     */
    /**
     * ⚠ Scoped to the REDEMPTION method for the reset service, not the whole file.
     *
     * `requestReset` carries its own `status !== 'active'` guard higher up — a deliberately
     * SILENT one, because naming an account's state to an unauthenticated caller is an
     * enumeration leak — and a whole-file ordering scan reads that guard instead and reports a
     * failure that does not exist.
     */
    const paths: [string, string][] = [
        ['every authenticated request (requireAuth)', middleware],
        ['login and refresh rotation (AuthService)', authService],
        ['password-reset redemption', methodBody(resetService, 'resetPassword')],
    ];
    for (const [label, source] of paths) {
        assert(`${label} refuses a closed account`, () =>
            source.includes("status === 'closed'") && source.includes('AUTH_ACCOUNT_CLOSED'));

        assert(`${label} checks closed BEFORE suspended`, () => {
            const closed = source.indexOf("status === 'closed'");
            const suspended = source.indexOf("status !== 'active'");
            return closed > -1 && suspended > -1 && closed < suspended;
        });
    }

    assert('login carries BOTH closed checks — rotation and the credential path', () => {
        const hits = authService.match(/status === 'closed'/g) ?? [];
        return hits.length === 2;
    });

    // The credential comparison still comes first on the login path: naming an account's state
    // to a caller who has not proved they hold it is an enumeration oracle.
    assert('the login refusal still sits after bcrypt.compare', () =>
        authService.indexOf('bcrypt.compare(input.password')
            < authService.lastIndexOf("status === 'closed'"));

    assert('the closed code is distinct from the suspended one', () => {
        const codes = read('core/error-codes.ts');
        return codes.includes("AUTH_ACCOUNT_CLOSED: 'AUTH_ACCOUNT_CLOSED'")
            && codes.includes("AUTH_ACCOUNT_SUSPENDED: 'AUTH_ACCOUNT_SUSPENDED'");
    });

    // A 403 derives to `authorization` from the status rule, and that is wrong here for the
    // same reason it is wrong for a suspension: the session is over, not this one resource.
    assert('it is categorised as authentication, with a stated reason', () => {
        const cat = read('core/error-category.ts');
        const idx = cat.indexOf('AUTH_ACCOUNT_CLOSED');
        if (idx === -1) return false;
        const block = cat.slice(idx, idx + 400);
        return block.includes('AUTHENTICATION') && /reason:\s*\n?\s*'/.test(block);
    });

    console.log('\n── The endpoint: the caller\'s own account, and nobody else\'s ──────────\n');

    assert('it is POST /close — not DELETE, because nothing is deleted', () =>
        routes.includes("router.post('/close', UserController.closeAccount)")
        && !routes.includes("router.delete('/'"));

    assert('the account id comes from the token, never the body', () =>
        controller.includes("req.auth!.user._id.toString()")
        && !controller.includes('req.body.userId')
        && !controller.includes('req.params.userId'));

    assert('the schema is strict, so a userId in the body is refused rather than ignored', () => {
        const validator = read('modules/users/user.validator.ts');
        const idx = validator.indexOf('CloseAccountSchema');
        return validator.slice(idx, idx + 400).includes('.strict()');
    });

    assert('the auth cookies are cleared on the way out', () =>
        controller.includes('clearAuthCookies(res)'));

    console.log('\n── The confirmation phrase (parsed for real) ───────────────────────────\n');

    assert('the exact phrase is accepted', () =>
        CloseAccountSchema.safeParse({ confirm: ACCOUNT_CLOSURE_CONFIRMATION }).success);

    assert('an empty body is refused', () =>
        !CloseAccountSchema.safeParse({}).success);

    assert('a near miss is refused', () =>
        !CloseAccountSchema.safeParse({ confirm: 'close my account' }).success
        && !CloseAccountSchema.safeParse({ confirm: 'CLOSE MY ACCOUNT ' }).success);

    assert('an unexpected key is refused rather than ignored', () =>
        !CloseAccountSchema.safeParse({
            confirm: ACCOUNT_CLOSURE_CONFIRMATION,
            userId: '665f1c2a9b3e4a91c7d2e5f0',
        }).success);

    /**
     * Customers are passwordless by default — `RegisterSchema` strips a supplied password for
     * `role: 'customer'` — so a password prompt would make closure impossible for most of the
     * people entitled to it. This asserts the decision has not quietly been reversed.
     */
    assert('closure does not require a password', () =>
        !service.includes('verifyPassword') && !closeHandler.includes('oldPassword')
        && !closeHandler.includes('password'));

    console.log('\n── It is called ANONYMISE, never DELETE (ADR-A02 D-2) ──────────────────\n');

    /**
     * D-2 is explicit: this is a product promise, not a compliance position, and describing it
     * to a customer as a deletion — or as satisfying a legal right — is the thing that must not
     * happen. The customer-facing strings are where that goes wrong first.
     */
    assert('the success message says closed and anonymised', () => {
        const idx = controller.indexOf('has been closed');
        return idx > -1 && controller.slice(idx, idx + 200).includes('anonymised');
    });

    assert('no customer-facing string in the endpoint promises deletion', () => {
        const strings = (controller.match(/'[^']{20,}'|`[^`]{20,}`/g) ?? []).join(' ').toLowerCase();
        return !strings.includes('delete') && !strings.includes('erase') && !strings.includes('permanently removed');
    });

    assert('the api-doc leads with what this is NOT', () =>
        doc.includes('It is not a deletion') && doc.includes('ADR-A02'));

    assert('the api-doc states the D-2 position on the legal question', () =>
        /legal right/i.test(docFlat) && /reasonable expectation/i.test(docFlat));

    assert('the api-doc says what survives, not just what goes', () =>
        /Untouched/i.test(doc) && /Orders, shipments/i.test(doc));

    console.log('\n── geo-tracker\'s position is written down (step 12.5) ──────────────────\n');

    const adr = readFileSync(
        join(ROOT, '..', 'geo-tracker', 'docs', 'ADR-B02-CLOSED-ACCOUNT-TRAIL.md'),
        'utf8',
    );

    assert('the ADR exists and answers ADR-A02', () => adr.includes('ADR-A02'));

    assert('it states the decision: no cross-service call', () =>
        /no code change/i.test(adr) && /triggers nothing in geo-tracker/i.test(adr));

    // The trigger clause is the half that keeps the ADR true later.
    assert('it names `tracking_audit` as the trigger to reopen it', () =>
        adr.includes('tracking_audit') && /trigger to reopen/i.test(adr));

    assert('jovi-mall links to it, so a client is not left guessing', () =>
        doc.includes('ADR-B02-CLOSED-ACCOUNT-TRAIL.md'));

    console.log('\n' + '─'.repeat(72));
    console.log(`  ${passed} passed, ${failed} failed`);
    console.log('─'.repeat(72) + '\n');
    if (failed > 0) process.exit(1);
}

main();
