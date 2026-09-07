import { Types } from 'mongoose';
import { BillingOwnerType } from '../../../billing/billing.types';
import { SubscriberPlanService, subscriberPlanService } from '../../../billing/services/subscriber-plan.service';
import { PricingPlanRepository } from '../../../billing/repositories/pricing-plan.repository';
import { ProductRepositoryMongo } from '../../../catalog/repositories/mongo/product.repository.mongo';
import { FileRepositoryMongo } from '../../../catalog/repositories/mongo/file.repository.mongo';
import { VariantRepositoryMongo } from '../../../catalog/repositories/mongo/variant.repository.mongo';
import { ProductStatusValidationService } from '../../../catalog/domain/services/ProductStatusValidationService';
import { DigitalAssetModel } from '../../../digital-delivery/models/digital-asset.model';
import { PlanQuotaStateModel } from '../../models/plan-quota-state.model';
import { PLAN_QUOTA_REASONS, ProductStatus } from '../../../catalog/models/product.model';
import { QuotaCandidate, planCountCutoff, planSizeCutoff } from '../quota-cutoff';

/** What one reconcile pass did. Reporting only — the truth is on the rows themselves. */
export interface PlanQuotaOutcome {
    ownerType: BillingOwnerType;
    ownerId: string;
    /** `false` when the owner has no active plan, so there was nothing to enforce against. */
    enforced: boolean;
    productsSuspended: number;
    productsRestored: number;
    filesBlocked: number;
    filesReleased: number;
    /** Total slots occupied after the pass. */
    productsAllowed: number;
    /** Total metered bytes still served after the pass. */
    bytesAllowed: number;
}

/**
 * PlanQuotaEnforcementService — brings an owner's catalog and media library back inside
 * whatever plan they are on now.
 *
 * ── What this is for ─────────────────────────────────────────────────────────────
 * Plan limits used to bind only at creation time, on two endpoints. A vendor who
 * downgraded from 100 GB and unlimited products to 1 GB and fifteen kept every product
 * live and every byte served, forever, because nothing ever recounted. This is the
 * recount, and it runs on every plan transition.
 *
 * ── The rule ─────────────────────────────────────────────────────────────────────
 * Oldest first. The allowance is filled from the oldest end; whatever no longer fits is
 * **suspended (products) or blocked (files), never deleted**, newest first. An upgrade
 * runs the identical computation against the larger number, so restoration is
 * oldest-first for free rather than by a second algorithm that could disagree.
 *
 * ── Properties that are load-bearing ─────────────────────────────────────────────
 *
 * **It is idempotent and it re-derives from the rows.** The state document records what
 * the last pass was computed for, never what it concluded; every pass reads
 * `Product.suspension.reason` and `File.quotaBlockedAt` afresh. So a half-finished pass,
 * a crash, or two passes racing all converge — the second one simply finds less to do.
 *
 * **It never creates a plan.** `findActivePlanWithoutCreating` rather than
 * `getActivePlan`, for the reason `EntitlementService.getAdminEntitlements` gives at
 * length: the lazy free-tier creation grants a credit allowance, and a background sweep
 * touching every owner must not mint plans and grants for owners who have never turned
 * up. An owner with no active plan is skipped, not defaulted.
 *
 * **It only ever writes its OWN suspension reason.** `plan_quota_exceeded` is the fifth
 * disjoint reason set. Products suspended by an administrator, by an agency, or by the
 * vendor cascade are *pinned* — they keep their slot and are never touched — because
 * room reappearing in a plan says nothing about why somebody else took a listing down.
 *
 * **It is not on any request path.** Suspending a hundred products is not work to hang
 * off a plan-purchase response, and a failure here must never fail the purchase that
 * triggered it — the owner has paid. Callers dispatch it post-commit and the reconcile
 * worker is the backstop.
 */
export class PlanQuotaEnforcementService {
    constructor(
        private readonly plans: SubscriberPlanService = subscriberPlanService,
        private readonly planRepo: PricingPlanRepository = new PricingPlanRepository(),
        private readonly productRepo: ProductRepositoryMongo = new ProductRepositoryMongo(),
        private readonly fileRepo: FileRepositoryMongo = new FileRepositoryMongo(),
        private readonly statusValidation: ProductStatusValidationService = new ProductStatusValidationService(
            new ProductRepositoryMongo(),
            new VariantRepositoryMongo(),
        ),
    ) { }

    /**
     * Recompute and apply the whole quota verdict for one owner.
     *
     * Safe to call at any time, from anywhere, as often as you like.
     */
    async reconcileOwner(ownerType: BillingOwnerType, ownerId: string): Promise<PlanQuotaOutcome> {
        const empty: PlanQuotaOutcome = {
            ownerType,
            ownerId,
            enforced: false,
            productsSuspended: 0,
            productsRestored: 0,
            filesBlocked: 0,
            filesReleased: 0,
            productsAllowed: 0,
            bytesAllowed: 0,
        };

        if (!Types.ObjectId.isValid(ownerId)) return empty;

        const active = await this.plans.findActivePlanWithoutCreating(ownerType, ownerId);
        if (!active) return empty;

        const plan = await this.planRepo.findById(active.plan_id.toString());
        if (!plan) return empty;

        // `max_active_products` is a vendor-only field; agency and agent plans carry none,
        // so their product axis is vacuously unlimited and only storage applies.
        const maxProducts = ownerType === 'vendor' ? plan.max_active_products : null;
        const maxStorageBytes = plan.max_storage_bytes;

        const products = ownerType === 'vendor'
            ? await this.applyProductQuota(ownerId, maxProducts)
            : { suspended: 0, restored: 0, allowed: 0 };

        const files = maxStorageBytes === null
            ? { blocked: 0, released: await this.releaseAllFiles(ownerType, ownerId), allowedBytes: 0 }
            : await this.applyStorageQuota(ownerType, ownerId, maxStorageBytes);

        await PlanQuotaStateModel.updateOne(
            { owner_type: ownerType, owner_id: new Types.ObjectId(ownerId) },
            {
                $set: {
                    enforced_plan_id: plan._id,
                    enforced_max_products: maxProducts,
                    enforced_max_storage_bytes: maxStorageBytes,
                    enforced_at: new Date(),
                    products_suspended: products.suspended,
                    files_blocked: files.blocked,
                    bytes_blocked: 0,
                },
            },
            { upsert: true },
        ).exec();

        return {
            ownerType,
            ownerId,
            enforced: true,
            productsSuspended: products.suspended,
            productsRestored: products.restored,
            filesBlocked: files.blocked,
            filesReleased: files.released,
            productsAllowed: products.allowed,
            bytesAllowed: files.allowedBytes,
        };
    }

    // ── Products ────────────────────────────────────────────────────────────────

    private async applyProductQuota(
        vendorId: string,
        limit: number | null,
    ): Promise<{ suspended: number; restored: number; allowed: number }> {
        const slots = await this.productRepo.listQuotaSlotsOldestFirst(vendorId);

        const candidates: QuotaCandidate[] = slots.map((s) => {
            const quotaSuspended = s.suspensionReason === PLAN_QUOTA_REASONS[0];
            return {
                id: s.id,
                blocked: quotaSuspended,
                // Suspended for someone else's reason: consumes a slot, untouchable.
                pinned: s.suspensionReason !== null && !quotaSuspended,
            };
        });

        const plan = planCountCutoff(candidates, limit);

        const suspendedIds = await this.productRepo.suspendProductsForQuota(vendorId, plan.toBlock);
        const restored = await this.restoreProducts(vendorId, plan.toRelease);

        return { suspended: suspendedIds.length, restored, allowed: plan.allowed.length };
    }

    /**
     * Lift the quota suspension on each id, re-running the activation gate for anything
     * that was live when it was suspended.
     *
     * ⚠ **A product that fails the gate is restored to `draft`, not left suspended.**
     * The precedent (`ProductPlatformSuspensionService.restoreEligible`) leaves it
     * suspended, and that is right there — the suspension and the blocker are the same
     * problem. Here they are unrelated: the vendor has bought the room, so continuing to
     * hold the product under a *quota* suspension would be a lie about why it is off
     * sale, and worse, it would keep consuming the slot that the next-oldest product is
     * waiting for. Demoting to `draft` is exactly what `revalidateActiveStatus` does to
     * a live product that stops qualifying, and it frees the slot honestly.
     *
     * Restores run one at a time rather than as one `updateMany` because each needs its
     * own gate evaluation, and a failure on one must not roll back the others.
     */
    private async restoreProducts(vendorId: string, ids: string[]): Promise<number> {
        let restored = 0;

        for (const id of ids) {
            const product = await this.productRepo.findById(id, vendorId);
            if (!product || product.suspension?.reason !== PLAN_QUOTA_REASONS[0]) continue;

            const previous = (product.suspension.previousStatus ?? 'draft') as Exclude<ProductStatus, 'suspended'>;
            let target: Exclude<ProductStatus, 'suspended'> = previous;

            if (previous === 'active') {
                try {
                    await this.statusValidation.validate(product, 'active');
                } catch {
                    // Still blocked for an unrelated reason — take the room back, but do
                    // not put it on sale. The vendor sees an ordinary draft with the usual
                    // activation checklist rather than an unexplained suspension.
                    target = 'draft';
                }
            }

            if (await this.productRepo.restoreProductFromQuota(id, vendorId, target)) restored += 1;
        }

        return restored;
    }

    // ── Storage ─────────────────────────────────────────────────────────────────

    private async applyStorageQuota(
        ownerType: BillingOwnerType,
        ownerId: string,
        limitBytes: number,
    ): Promise<{ blocked: number; released: number; allowedBytes: number }> {
        const files = await this.fileRepo.listOwnedOldestFirst(ownerType, ownerId);
        const excluded = await this.digitalAssetFileIds(ownerType, ownerId);

        const metered = excluded.size === 0 ? files : files.filter(f => !excluded.has(f.id));

        const candidates: QuotaCandidate[] = metered.map(f => ({
            id: f.id,
            size: f.size,
            blocked: f.quotaBlockedAt !== null,
        }));

        const plan = planSizeCutoff(candidates, limitBytes);

        const blocked = await this.fileRepo.setQuotaBlocked(plan.toBlock, true);
        // Unmetered files are released unconditionally: a digital asset must never be
        // blocked by a cap it does not count against, and one could carry a stale flag
        // from before it became an asset.
        const released = await this.fileRepo.setQuotaBlocked(
            [...plan.toRelease, ...files.filter(f => excluded.has(f.id) && f.quotaBlockedAt !== null).map(f => f.id)],
            false,
        );

        const allowedSet = new Set(plan.allowed);
        const allowedBytes = metered.reduce((sum, f) => (allowedSet.has(f.id) ? sum + f.size : sum), 0);

        return { blocked, released, allowedBytes };
    }

    /** Release every block this owner holds — the unlimited-storage path. */
    private async releaseAllFiles(ownerType: BillingOwnerType, ownerId: string): Promise<number> {
        const files = await this.fileRepo.listOwnedOldestFirst(ownerType, ownerId);
        const blockedIds = files.filter(f => f.quotaBlockedAt !== null).map(f => f.id);
        return this.fileRepo.setQuotaBlocked(blockedIds, false);
    }

    /**
     * The vendor's digital-product asset files, which are **outside** the media cap.
     *
     * ⚠ This mirrors `MediaStorageService.getUsageBreakdown`, which subtracts digital
     * asset bytes from a vendor's total (they are billed under their own per-asset cap)
     * and does not for agencies or agents. Blocking must apply to exactly the set that is
     * metered — blocking a file that does not count toward the cap punishes an owner for
     * bytes they are not being charged for, and, since these are goods a customer has
     * already paid for, it would break a download that was already sold.
     *
     * If that subtraction rule ever changes, it changes here in the same edit.
     */
    private async digitalAssetFileIds(ownerType: BillingOwnerType, ownerId: string): Promise<Set<string>> {
        if (ownerType !== 'vendor') return new Set();

        const rows = await DigitalAssetModel.find(
            { vendorId: new Types.ObjectId(ownerId), deletedAt: null },
            { fileId: 1 },
        ).lean();

        return new Set((rows as any[]).map(r => r.fileId?.toString()).filter(Boolean));
    }
}

export const planQuotaEnforcementService = new PlanQuotaEnforcementService();
