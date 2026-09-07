/**
 * Verify: plan-quota enforcement against REAL Mongo.
 *
 * NEEDS Mongo. Writes then deletes its own `verify-quota-*` fixtures, pass or fail, and
 * touches no real vendor: everything it creates is under freshly-minted ObjectIds and two
 * throwaway pricing plans whose codes are namespaced.
 *
 * ── What this covers that `test:plan-quota` structurally cannot ──────────────
 * The DB-free suite pins the JUDGEMENT — which items fit, in what order — against plain
 * arrays. It cannot see any of the following, and each has already been a real defect class
 * in this codebase:
 *
 *   - that `countActiveByVendor` actually CONVERGES. That guard is a query filter, not an
 *     `if`, and a DB-free stub cannot fail a filter. If quota-suspended products kept
 *     counting, the sweep would suspend the whole catalog and still report the vendor over
 *     cap — and every unit test would still pass.
 *   - that `suspendProductsForQuota` moves a DRAFT. Every other suspend primitive here
 *     compare-and-sets on `status: 'active'`, so a copy-paste of one of them would silently
 *     no-op on exactly the products this feature has to be able to suspend.
 *   - that the aggregation-pipeline `$set` really captures `previousStatus: '$status'`
 *     rather than the literal string.
 *   - that an upgrade releases the SAME files, unchanged — that blocking is reversible in
 *     practice and not just in intent.
 *
 * Run: npm run verify:plan-quota
 */
import dotenv from 'dotenv';
dotenv.config();
import mongoose, { Types } from 'mongoose';
import { ProductModel } from '../../src/modules/catalog/models/product.model';
import { FileModel } from '../../src/modules/catalog/models/file.model';
import { PricingPlanModel } from '../../src/modules/billing/models/pricing-plan.model';
import { SubscriberPlanModel } from '../../src/modules/billing/models/subscriber-plan.model';
import { PlanQuotaStateModel } from '../../src/modules/plan-quota/models/plan-quota-state.model';
import { planQuotaEnforcementService } from '../../src/modules/plan-quota/domain/services/plan-quota-enforcement.service';
import { registerPlanQuotaConsumer } from '../../src/modules/plan-quota/events/plan-quota.consumer';
import { subscriberPlanService } from '../../src/modules/billing/services/subscriber-plan.service';
import { ProductRepositoryMongo } from '../../src/modules/catalog/repositories/mongo/product.repository.mongo';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi-mall';
const TAG = 'verify-quota';

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

const vendorId = new Types.ObjectId();
const productIds: Types.ObjectId[] = [];
const fileIds: Types.ObjectId[] = [];
let smallPlanId: Types.ObjectId;
let largePlanId: Types.ObjectId;

/** Spaced a minute apart so the oldest-first ordering is unambiguous. */
const at = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes, 0));

async function seed(): Promise<void> {
    const [small, large] = await PricingPlanModel.create([
        {
            role: 'vendor', code: `${TAG}-small`, name: 'Verify Small', price: 0, currency: 'XAF',
            term_days: null, credit_allowance: 0,
            max_active_products: 2, max_storage_bytes: 40, commission_percent: 7,
            max_unterminated_shipments: null, live_tracking_enabled: true, is_active: true,
        },
        {
            role: 'vendor', code: `${TAG}-large`, name: 'Verify Large', price: 0, currency: 'XAF',
            term_days: null, credit_allowance: 0,
            max_active_products: null, max_storage_bytes: 1_000_000, commission_percent: 5,
            max_unterminated_shipments: null, live_tracking_enabled: true, is_active: true,
        },
    ]);
    smallPlanId = small._id as Types.ObjectId;
    largePlanId = large._id as Types.ObjectId;

    // Products A, B, C — created in that order, all `draft` so the restore path is exercised
    // without the activation gate (which a fixture with no variants would always fail).
    for (const [i, title] of ['A', 'B', 'C'].entries()) {
        const doc = await ProductModel.create({
            vendorId,
            type: 'physical',
            status: 'draft',
            title: `${TAG}-${title}`,
            slug: `${TAG}-${title.toLowerCase()}`,
            category: 'test',
            createdAt: at(i),
        });
        productIds.push(doc._id as Types.ObjectId);
    }

    // Eight 10-byte files. The small plan's 40 bytes fits exactly the first four.
    for (let i = 1; i <= 8; i++) {
        const doc = await FileModel.create({
            key: `images/2026/01/${TAG}-${i}.png`,
            provider: 'local',
            mimeType: 'image/png',
            size: 10,
            ownerType: 'vendor',
            ownerId: vendorId,
            createdAt: at(i),
        });
        fileIds.push(doc._id as Types.ObjectId);
    }
}

async function assignPlan(planId: Types.ObjectId): Promise<void> {
    await SubscriberPlanModel.deleteMany({ owner_id: vendorId });
    const plan = await PricingPlanModel.findById(planId).lean();
    await SubscriberPlanModel.create({
        owner_type: 'vendor',
        owner_id: vendorId,
        plan_id: planId,
        plan_code: plan!.code,
        status: 'active',
        started_at: new Date(),
        expires_at: null,
        allowance_granted: true,
    });
}

/**
 * Wait for the fire-and-forget `plan.activated` handler to land.
 *
 * `SubscriberPlanService` publishes post-commit with `void this.emitActivated(...)`, so
 * `assignPlan` returns BEFORE the consumer has run. Polling is the honest way to observe
 * that — a fixed sleep would either be flaky or slow, and awaiting the publish is not
 * possible from outside.
 */
async function waitFor(predicate: () => Promise<boolean>, ms = 5000): Promise<boolean> {
    const deadline = Date.now() + ms;
    for (;;) {
        if (await predicate()) return true;
        if (Date.now() > deadline) return false;
        await new Promise((r) => setTimeout(r, 100));
    }
}

const statusOf = async (id: Types.ObjectId) =>
    (await ProductModel.findById(id).lean()) as unknown as { status: string; suspension?: { reason?: string; previousStatus?: string } };
const blockedIds = async () => {
    const rows = await FileModel.find({ ownerId: vendorId, quotaBlockedAt: { $ne: null } }, { _id: 1 }).lean();
    return new Set((rows as any[]).map((r) => r._id.toString()));
};

async function cleanup(): Promise<void> {
    await Promise.all([
        ProductModel.deleteMany({ vendorId }),
        FileModel.deleteMany({ ownerId: vendorId }),
        SubscriberPlanModel.deleteMany({ owner_id: vendorId }),
        PlanQuotaStateModel.deleteMany({ owner_id: vendorId }),
        PricingPlanModel.deleteMany({ code: { $in: [`${TAG}-small`, `${TAG}-large`] } }),
    ]);
}

async function main(): Promise<void> {
    await mongoose.connect(MONGO_URI);
    console.log(`Connected to ${MONGO_URI}`);
    const products = new ProductRepositoryMongo();

    try {
        await seed();

        // ── The downgrade ────────────────────────────────────────────────────
        console.log('\n▶ 1. Downgrade to a 2-product / 40-byte plan');
        await assignPlan(smallPlanId);
        const down = await planQuotaEnforcementService.reconcileOwner('vendor', vendorId.toString());

        assert('the pass reports it enforced something', () => down.enforced);
        assert('exactly one product was suspended — the newest', () => down.productsSuspended === 1);

        const [a, b, c] = await Promise.all(productIds.map(statusOf));
        assert('A and B stay draft, untouched', () =>
            a.status === 'draft' && b.status === 'draft' && !a.suspension && !b.suspension);
        assert('C is suspended for plan_quota_exceeded', () =>
            c.status === 'suspended' && c.suspension?.reason === 'plan_quota_exceeded');
        assert('…and previousStatus captured the REAL status, not the literal "$status"', () =>
            c.suspension?.previousStatus === 'draft');

        assert('a DRAFT was suspendable — the shared primitive would have no-opped on it', () =>
            c.status === 'suspended');

        const afterDown = await products.countActiveByVendor(vendorId.toString());
        assert('countActiveByVendor now reports 2 — the count CONVERGED to the cap', () =>
            afterDown === 2);

        const blocked1 = await blockedIds();
        assert('files 1-4 are still served', () =>
            fileIds.slice(0, 4).every((id) => !blocked1.has(id.toString())));
        assert('files 5-8 are blocked, including file 5 which belongs to a LIVE product', () =>
            fileIds.slice(4).every((id) => blocked1.has(id.toString())));

        const [fileCount, productCount] = await Promise.all([
            FileModel.countDocuments({ ownerId: vendorId, deletedAt: null }),
            ProductModel.countDocuments({ vendorId, deletedAt: null }),
        ]);
        assert('…confirmed: 8 files and 3 products survive the downgrade', () =>
            fileCount === 8 && productCount === 3);

        const state = await PlanQuotaStateModel.findOne({ owner_id: vendorId }).lean();
        assert('the enforcement stamp records the plan AND its limit values', () =>
            !!state
            && state.enforced_plan_id?.toString() === smallPlanId.toString()
            && state.enforced_max_products === 2
            && state.enforced_max_storage_bytes === 40);

        // ── Idempotence ──────────────────────────────────────────────────────
        console.log('\n▶ 2. Running it again changes nothing');
        const again = await planQuotaEnforcementService.reconcileOwner('vendor', vendorId.toString());
        assert('a second pass suspends and restores nothing', () =>
            again.productsSuspended === 0 && again.productsRestored === 0);
        assert('…and blocks nothing new', () => again.filesBlocked === 0);

        // ── The upgrade ──────────────────────────────────────────────────────
        console.log('\n▶ 3. Upgrade to unlimited products / 1 MB');
        await assignPlan(largePlanId);
        const up = await planQuotaEnforcementService.reconcileOwner('vendor', vendorId.toString());

        assert('the suspended product is restored', () => up.productsRestored === 1);
        const cAfter = await statusOf(productIds[2]);
        assert('…to its EXACT previous status, with the snapshot cleared', () =>
            cAfter.status === 'draft' && !cAfter.suspension);

        const blocked2 = await blockedIds();
        assert('every file is served again — blocking was reversible', () => blocked2.size === 0);

        const afterUp = await products.countActiveByVendor(vendorId.toString());
        assert('all three products count again', () => afterUp === 3);

        // ── Partial upgrade ──────────────────────────────────────────────────
        console.log('\n▶ 4. A partial upgrade releases oldest-first and stops at the cap');
        await PricingPlanModel.updateOne({ _id: smallPlanId }, { $set: { max_storage_bytes: 60 } });
        await assignPlan(smallPlanId);
        await planQuotaEnforcementService.reconcileOwner('vendor', vendorId.toString());

        const blocked3 = await blockedIds();
        assert('60 bytes serves files 1-6 and blocks 7-8', () =>
            fileIds.slice(0, 6).every((id) => !blocked3.has(id.toString()))
            && fileIds.slice(6).every((id) => blocked3.has(id.toString())));

        // ── The real upgrade path, end to end ────────────────────────────────
        //
        // Everything above drives `reconcileOwner` DIRECTLY, which proves the rule but
        // proves nothing about whether anything ever CALLS it. This section is the one that
        // answers "does paying for a bigger plan reactivate my catalogue on its own" — it
        // goes through `SubscriberPlanService.assignPlan`, exactly as
        // `PlanPurchaseService.completePurchase` does when a payment gateway confirms, and
        // waits for the `plan.activated` consumer to land.
        console.log('\n▶ 5. Paying for a bigger plan reactivates automatically');
        registerPlanQuotaConsumer();

        // Back to the tight plan first, so there is something to reactivate.
        await PricingPlanModel.updateOne({ _id: smallPlanId }, { $set: { max_storage_bytes: 40 } });
        await assignPlan(smallPlanId);
        await planQuotaEnforcementService.reconcileOwner('vendor', vendorId.toString());
        const beforeUpgrade = await statusOf(productIds[2]);
        const blockedBefore = await blockedIds();
        assert('precondition: C is suspended and four files are blocked', () =>
            beforeUpgrade.status === 'suspended' && blockedBefore.size === 4);

        // THE PAYMENT PATH. No direct call to the enforcement service anywhere below.
        await subscriberPlanService.assignPlan('vendor', vendorId.toString(), largePlanId.toString(), {
            paymentRef: 'verify-quota-gateway-ref',
            assignedBy: null,
        });

        const reactivated = await waitFor(async () => {
            const c = await statusOf(productIds[2]);
            return c.status !== 'suspended';
        });
        assert('the plan.activated consumer fired and un-suspended the product — NO manual step', () =>
            reactivated);

        const releasedFiles = await waitFor(async () => (await blockedIds()).size === 0);
        assert('…and released every blocked file in the same pass', () => releasedFiles);

        // ── The one case where it does NOT take effect immediately ───────────
        //
        // `assignPlan` has two branches: a free or lapsed active plan is REPLACED at once,
        // but a PAID plan with time still on it queues the purchase as
        // `pending_activation` — so the entitlements, and therefore the release, wait for
        // the current term to end. That is pre-existing billing behaviour, not something
        // plan-quota introduced, and it is asserted here so nobody reports it as a
        // reactivation bug.
        console.log('\n▶ 6. A plan bought while a PAID term is still running is QUEUED, not applied');
        await SubscriberPlanModel.deleteMany({ owner_id: vendorId });
        await SubscriberPlanModel.create({
            owner_type: 'vendor',
            owner_id: vendorId,
            plan_id: smallPlanId,
            plan_code: `${TAG}-small`,
            status: 'active',
            started_at: new Date(),
            // A real future expiry — this is what makes the branch queue rather than apply.
            expires_at: new Date(Date.now() + 30 * 86_400_000),
            allowance_granted: true,
        });
        await planQuotaEnforcementService.reconcileOwner('vendor', vendorId.toString());
        const beforeQueued = await statusOf(productIds[2]);
        assert('precondition: back on the tight plan, C suspended again', () =>
            beforeQueued.status === 'suspended');

        const queued = await subscriberPlanService.assignPlan(
            'vendor', vendorId.toString(), largePlanId.toString(), { paymentRef: null, assignedBy: null },
        );
        assert('the purchase is queued as pending_activation, not activated', () =>
            queued.status === 'pending_activation');

        const stillSuspended = await statusOf(productIds[2]);
        assert('…so the product stays suspended until the paid term ends (NOT a quota bug)', () =>
            stillSuspended.status === 'suspended');
    } finally {
        await cleanup();
        console.log('\nFixtures deleted.');
        await mongoose.disconnect();
    }

    console.log(`\n${passed} passed, ${failed} failed\n`);
    if (failed > 0) process.exit(1);
}

main().catch(async (err) => {
    console.error('verify:plan-quota failed:', err);
    try {
        await cleanup();
        await mongoose.disconnect();
    } catch {
        // Already disconnected, or the failure was the connection itself.
    }
    process.exit(1);
});
