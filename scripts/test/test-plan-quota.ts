/**
 * Test: plan-quota enforcement — what survives a downgrade, and what comes back on upgrade.
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no framework).
 * DB-free.
 *
 * ── What is worth pinning, and why it splits in two ─────────────────────────
 *
 * The JUDGEMENT is pure. `planCountCutoff` and `planSizeCutoff` decide which products and
 * which files fit inside a plan, and they take plain arrays — no Mongo, no clock. So the
 * whole decision table is exercised directly here, including the cases nobody would think
 * to create by hand in a database: a plan of exactly 0, an item bigger than the entire
 * allowance, and pinned items outnumbering the limit.
 *
 * The WIRING is structural, and several of its invariants are invisible to any behavioural
 * test, so they are SOURCE SCANS — the same tool `test:system` uses for the worker lock and
 * `test:storefront-checkout` uses for the stock lifecycle. Three of them matter most:
 *
 *   - `plan_quota_exceeded` must not appear in any of the four pre-existing reason sets.
 *     If it did, an unrelated restore sweep would republish products the vendor has not
 *     bought room for — and nothing would fail, because the product would simply be live.
 *   - The quota must NOT be an activation blocker. `collectActivationBlockers` is called by
 *     `revalidateActiveStatus`, which SILENTLY DEMOTES a live product to draft rather than
 *     refusing, so a quota blocker there would quietly unpublish a product every time an
 *     over-cap vendor edited anything. The symptom would be indistinguishable from a bug in
 *     the editor.
 *   - `countActiveByVendor` must exclude quota-suspended products. This is the one that
 *     makes the feature converge at all: a `suspended` product is otherwise counted, so if
 *     quota-suspended ones counted too the sweep would suspend the whole catalog and still
 *     report the vendor over cap.
 *
 * Run: npm run test:plan-quota
 */
import fs from 'fs';
import path from 'path';
import {
    QuotaCandidate,
    planCountCutoff,
    planSizeCutoff,
} from '../../src/modules/plan-quota/domain/quota-cutoff';
import { PRODUCT_SUSPENSION_REASONS, PLAN_QUOTA_REASONS } from '../../src/modules/catalog/models/product.model';

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

const SRC = path.join(__dirname, '..', '..', 'src');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');

/** The same file with comments removed — every scan below must read CODE, not prose. */
const stripComments = (s: string): string =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const readCode = (rel: string): string => stripComments(read(rel));

const item = (id: string, over: Partial<QuotaCandidate> = {}): QuotaCandidate =>
    ({ id, blocked: false, ...over });
const ids = (xs: string[]) => xs.join(',');

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n▶ 1. The owner's worked example, exactly as specified");

// Products A, B, C created in that order; a plan allowing 2.
const exampleProducts = planCountCutoff([item('A'), item('B'), item('C')], 2);

assert('a plan of 2 keeps the two OLDEST products and suspends the newest', () =>
    ids(exampleProducts.allowed) === 'A,B' && ids(exampleProducts.denied) === 'C');
assert('…and it is the newest that is asked to be suspended', () =>
    ids(exampleProducts.toBlock) === 'C' && exampleProducts.toRelease.length === 0);

// Images 1,2,3 on A; 4,5 on B; 6,7,8 on C. Sizes chosen so 1-4 exactly fill a 40-byte plan.
const images: QuotaCandidate[] = [
    item('1', { size: 10 }), item('2', { size: 10 }), item('3', { size: 10 }),
    item('4', { size: 10 }), item('5', { size: 10 }),
    item('6', { size: 10 }), item('7', { size: 10 }), item('8', { size: 10 }),
];
const exampleFiles = planSizeCutoff(images, 40);

assert('images 1-4 fill the allowance and stay', () =>
    ids(exampleFiles.allowed) === '1,2,3,4');
assert('images 5, 6, 7 and 8 are blocked — including 5, which belongs to a LIVE product', () =>
    ids(exampleFiles.denied) === '5,6,7,8');

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n▶ 2. The count rule');

assert('null means unlimited — nothing is denied', () => {
    const r = planCountCutoff([item('a'), item('b'), item('c')], null);
    return r.denied.length === 0 && r.allowed.length === 3;
});
assert('…and unlimited RELEASES everything currently held, which is the upgrade path', () => {
    const r = planCountCutoff([item('a', { blocked: true }), item('b', { blocked: true })], null);
    return ids(r.toRelease) === 'a,b' && r.toBlock.length === 0;
});
assert('a limit of 0 denies everything — 0 is a real limit, only null is unlimited', () => {
    const r = planCountCutoff([item('a'), item('b')], 0);
    return r.allowed.length === 0 && ids(r.denied) === 'a,b';
});
assert('an upgrade releases OLDEST-FIRST and stops at the new limit', () => {
    // Was on a plan of 1; upgrading to 3 must return b and c but not d.
    const r = planCountCutoff([
        item('a'),
        item('b', { blocked: true }),
        item('c', { blocked: true }),
        item('d', { blocked: true }),
    ], 3);
    return ids(r.toRelease) === 'b,c' && ids(r.denied) === 'd' && r.toBlock.length === 0;
});
assert('a plan that already fits asks for no change at all', () => {
    const r = planCountCutoff([item('a'), item('b')], 5);
    return r.toBlock.length === 0 && r.toRelease.length === 0;
});
assert('re-running against the resulting state is a no-op — the pass is idempotent', () => {
    const after: QuotaCandidate[] = [item('A'), item('B'), item('C', { blocked: true })];
    const r = planCountCutoff(after, 2);
    return r.toBlock.length === 0 && r.toRelease.length === 0 && ids(r.allowed) === 'A,B';
});

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n▶ 3. Pinned products — suspended for somebody else's reason");

assert('a pinned item keeps its slot and pushes a suspendable one out instead', () => {
    // B is suspended by an administrator. The plan allows 2. B keeps its slot, so the
    // NEWEST suspendable product (C) goes rather than B.
    const r = planCountCutoff([item('A'), item('B', { pinned: true }), item('C')], 2);
    return ids(r.allowed) === 'A,B' && ids(r.toBlock) === 'C';
});
assert('a pinned item is never asked to be blocked, even when it is the newest', () => {
    const r = planCountCutoff([item('A'), item('B'), item('C', { pinned: true })], 2);
    return !r.toBlock.includes('C') && r.allowed.includes('C');
});
assert('…and pinned budget is RESERVED, so the survivor count still equals the limit', () => {
    // Taking pinned slots in sequence would let A and B each claim one and C take a third.
    const r = planCountCutoff([item('A'), item('B'), item('C', { pinned: true })], 2);
    return r.allowed.length === 2;
});
assert('pinned items outnumbering the limit deny everything else, and stay idempotent', () => {
    const first = planCountCutoff([item('A', { pinned: true }), item('B', { pinned: true }), item('C')], 1);
    const after = [item('A', { pinned: true }), item('B', { pinned: true }), item('C', { blocked: true })];
    const second = planCountCutoff(after, 1);
    return ids(first.toBlock) === 'C' && second.toBlock.length === 0 && second.toRelease.length === 0;
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n▶ 4. The size rule — a PREFIX, not a knapsack');

assert('the first item that does not fit ends the run', () => {
    const r = planSizeCutoff([item('a', { size: 30 }), item('b', { size: 30 })], 50);
    return ids(r.allowed) === 'a' && ids(r.denied) === 'b';
});
assert('…and everything AFTER it is denied even when it would have fitted', () => {
    // The 1-byte 'c' fits in the 20 bytes left, and is denied anyway. Admitting it would
    // make the visible set depend on file SIZES rather than on age, and would let an
    // unrelated deletion silently reshuffle which images a customer sees.
    const r = planSizeCutoff([
        item('a', { size: 30 }),
        item('b', { size: 30 }),
        item('c', { size: 1 }),
    ], 50);
    return ids(r.allowed) === 'a' && ids(r.denied) === 'b,c';
});
assert('an item larger than the whole allowance denies itself and its successors', () => {
    const r = planSizeCutoff([item('a', { size: 999 }), item('b', { size: 1 })], 50);
    return r.allowed.length === 0 && ids(r.denied) === 'a,b';
});
assert('a limit of exactly the total keeps everything (the boundary is inclusive)', () => {
    const r = planSizeCutoff([item('a', { size: 25 }), item('b', { size: 25 })], 50);
    return r.denied.length === 0;
});
assert('freeing room releases oldest-first, up to the cap', () => {
    const r = planSizeCutoff([
        item('a', { size: 10 }),
        item('b', { size: 10, blocked: true }),
        item('c', { size: 10, blocked: true }),
    ], 20);
    return ids(r.toRelease) === 'b' && ids(r.denied) === 'c';
});
assert('a zero-byte file never ends the run on its own', () => {
    const r = planSizeCutoff([item('a', { size: 0 }), item('b', { size: 0 })], 0);
    return r.denied.length === 0;
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n▶ 5. Ordering is stable, because the CALLER supplies it');

assert('the cut-off follows input order, so a stable sort is what makes runs repeatable', () => {
    // Same items, reversed: the survivors change. That is the whole reason the repository
    // sorts by `createdAt` ASC with an `_id` tie-break — a bulk upload lands several rows in
    // one millisecond, and an unstable sort would flip which of them is blocked each night.
    const forward = planCountCutoff([item('x'), item('y')], 1);
    const reverse = planCountCutoff([item('y'), item('x')], 1);
    return ids(forward.allowed) === 'x' && ids(reverse.allowed) === 'y';
});

assert('the repository sorts by createdAt AND _id on both axes', () => {
    const products = readCode('modules/catalog/repositories/mongo/product.repository.mongo.ts');
    const files = readCode('modules/catalog/repositories/mongo/file.repository.mongo.ts');
    const tie = /sort\(\{\s*createdAt:\s*1,\s*_id:\s*1\s*\}\)/;
    return tie.test(products) && tie.test(files);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n▶ 6. The fifth reason set is DISJOINT from the other four');

assert('plan_quota_exceeded is a declared suspension reason', () =>
    (PRODUCT_SUSPENSION_REASONS as readonly string[]).includes('plan_quota_exceeded')
    && PLAN_QUOTA_REASONS.length === 1
    && PLAN_QUOTA_REASONS[0] === 'plan_quota_exceeded');

assert('it is NOT in DELIVERY_AGENCY_REASONS — an agency fix cannot buy plan room', () => {
    const src = readCode('modules/catalog/domain/services/ProductDeliveryAgencySuspensionService.ts');
    const at = src.indexOf('DELIVERY_AGENCY_REASONS');
    return at !== -1 && !src.slice(at, at + 400).includes('plan_quota_exceeded');
});

assert('no restore path outside plan-quota clears it', () => {
    // Each of these services restores products scoped to ITS OWN reason. If any of them
    // learned this one, an upgrade the vendor never bought would republish their catalog.
    const offenders = [
        'modules/catalog/domain/services/ProductDeliveryAgencySuspensionService.ts',
        'modules/catalog/domain/services/ProductPlatformSuspensionService.ts',
        'modules/inventory/domain/services/agency-storage-suspension.service.ts',
        'modules/vendors/admin-vendor.service.ts',
    ].filter((rel) => readCode(rel).includes('plan_quota_exceeded'));
    if (offenders.length) console.error(`     offenders: ${offenders.join(', ')}`);
    return offenders.length === 0;
});

assert('the quota restore pins suspension.reason on the way back out', () => {
    const repo = readCode('modules/catalog/repositories/mongo/product.repository.mongo.ts');
    const restore = repo.slice(repo.indexOf('async restoreProductFromQuota'));
    return restore.includes("'suspension.reason': 'plan_quota_exceeded'");
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n▶ 7. The invariants nothing behavioural can see');

assert('countActiveByVendor EXCLUDES quota-suspended products — this is what converges', () => {
    const repo = readCode('modules/catalog/repositories/mongo/product.repository.mongo.ts');
    const at = repo.indexOf('private quotaSlotFilter');
    const filter = repo.slice(at, at + 400);
    return at !== -1 && filter.includes("'suspension.reason'") && filter.includes('plan_quota_exceeded');
});

assert('the quota is NOT an activation blocker (revalidateActiveStatus would silently demote)', () => {
    const gate = readCode('modules/catalog/domain/services/ProductStatusValidationService.ts');
    return !gate.includes('plan_quota') && !gate.includes('assertCanAddProduct');
});

assert('the bulk path uses the BATCH assertion, not the per-item threshold test', () => {
    const bulk = readCode('modules/catalog/domain/services/ProductBulkOperationsService.ts');
    return bulk.includes('assertCanAddProducts(');
});

assert('duplicate and un-archive both ask the plan first', () => {
    const ctrl = readCode('modules/catalog/controllers/vendor-product.controller.ts');
    const dup = ctrl.slice(ctrl.indexOf('static duplicateProduct'), ctrl.indexOf('static archiveProduct'));
    const status = ctrl.slice(ctrl.indexOf('static changeStatus'), ctrl.indexOf('static setDefaultVariant'));
    return dup.includes('assertCanAddProduct(')
        && status.includes('assertCanAddProduct(')
        && status.includes("product.status === 'archived'");
});

assert('enforcement never lazily CREATES a plan — a sweep must not mint credit grants', () => {
    const svc = readCode('modules/plan-quota/domain/services/plan-quota-enforcement.service.ts');
    return svc.includes('findActivePlanWithoutCreating') && !svc.includes('.getActivePlan(');
});

assert('the worker sweeps drifted owners AND owners still holding something back', () => {
    const worker = readCode('modules/plan-quota/workers/plan-quota-reconcile.worker.ts');
    return worker.includes('ownersHoldingQuotaState') && worker.includes('hasDrifted');
});

assert('the state row stamps the LIMIT VALUES, not just the plan id', () => {
    // An administrator editing a live plan changes no plan_id anywhere and emits no event,
    // so comparing ids alone would miss the one case that re-tiers a whole cohort at once.
    const worker = readCode('modules/plan-quota/workers/plan-quota-reconcile.worker.ts');
    return worker.includes('enforced_max_products') && worker.includes('enforced_max_storage_bytes');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n▶ 8. Blocking is not deletion');

assert('setQuotaBlocked touches neither deletedAt nor orphanedAt', () => {
    const repo = readCode('modules/catalog/repositories/mongo/file.repository.mongo.ts');
    const fn = repo.slice(repo.indexOf('async setQuotaBlocked'), repo.indexOf('async update('));
    return !fn.includes('deletedAt: new Date()') && !fn.includes('orphanedAt');
});

assert('the metered list is every LIVE file — a blocked one still counts', () => {
    // Blocking changes no size and removes no row, which is what lets an upgrade restore
    // the identical set rather than an approximation of it.
    const repo = readCode('modules/catalog/repositories/mongo/file.repository.mongo.ts');
    const list = repo.slice(repo.indexOf('async listOwnedOldestFirst'), repo.indexOf('async setQuotaBlocked'));
    return list.includes('deletedAt: null') && !list.includes('quotaBlockedAt: null }');
});

assert('digital-product assets are excluded from blocking, as they are from metering', () => {
    const svc = readCode('modules/plan-quota/domain/services/plan-quota-enforcement.service.ts');
    return svc.includes('digitalAssetFileIds') && svc.includes("ownerType !== 'vendor'");
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
