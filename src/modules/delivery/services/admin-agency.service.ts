import { ClientSession } from 'mongoose';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { auditLogger } from '../../../core/audit/audit-logger';
import { TransactionManager, transactionManager } from '../../../core/database/transaction.manager';
import { DeliveryAgencyRepository } from '../delivery-agency.repository';
import { VendorRepository } from '../../vendors/vendor.repository';
import { ProductDeliveryAgencySuspensionService } from '../../catalog/domain/services/ProductDeliveryAgencySuspensionService';
import { IProductRepository } from '../../catalog/repositories/interfaces/product.repository.interface';
import { ProductRepositoryMongo } from '../../catalog/repositories/mongo/product.repository.mongo';
import { OrderRepository } from '../../orders/order.repository';
import { AdminAgencyListItemDto, AdminAgencyListMeta, AdminAgencyMapper } from '../dto/admin-agency.dto';
import { ProductStatus } from '../../catalog/models/product.model';
import { IDeliveryAgency } from '../delivery-agency.model';
import { FileRepositoryMongo } from '../../catalog/repositories/mongo/file.repository.mongo';
import { resolveFileDetail, resolveFileDetails } from '../../catalog/read-models/file-detail.resolver';
import { getStorageProvider, IStorageProvider } from '../../../core/storage';
import { MagazinRepository } from '../../magazin/repositories/magazin.repository';
import { ActorRef } from '../../../core/types/actor-source.types';

/**
 * AdminAgencyService: admin-facing delivery agency management.
 *
 * Deactivating an agency:
 *  1. Suspends every vendor's ACTIVE physical products where this agency is
 *     currently their DEFAULT — see ProductDeliveryAgencySuspensionService.
 *     (Drafts etc. are untouched: they can't activate without the gate anyway.)
 *  2. Suspends any physical product, across ANY vendor, whose OWN delivery-agency
 *     OVERRIDE points at this agency — independent of that vendor's default.
 *  3. Puts every still pending/assigned order item currently riding this agency on
 *     hold (any vendor, any provenance) — see OrderRepository.holdItemsByAgency.
 *
 * Reactivating reverses all three. All fanned out inside a single transaction.
 */
export class AdminAgencyService {
    constructor(
        private readonly agencyRepo: DeliveryAgencyRepository = new DeliveryAgencyRepository(),
        private readonly vendorRepo: VendorRepository = new VendorRepository(),
        private readonly suspensionService: ProductDeliveryAgencySuspensionService = new ProductDeliveryAgencySuspensionService(),
        private readonly txManager: TransactionManager = transactionManager,
        private readonly productRepo: IProductRepository = new ProductRepositoryMongo(),
        private readonly orderRepo: OrderRepository = new OrderRepository(),
        private readonly fileRepo: FileRepositoryMongo = new FileRepositoryMongo(),
        private readonly storage: IStorageProvider = getStorageProvider(),
        private readonly magazinRepo: MagazinRepository = new MagazinRepository(),
    ) { }

    /** Map one agency, resolving its business name + logo from the Magazin. */
    private async toDto(agency: IDeliveryAgency): Promise<AdminAgencyListItemDto> {
        const magazin = await this.magazinRepo.findByAgencyIdOrNull(agency._id.toString());
        const logo = await resolveFileDetail(magazin?.logo_file_id?.toString(), this.fileRepo, this.storage);
        return AdminAgencyMapper.toListItemDto(agency, magazin?.name ?? '', logo);
    }

    async list(params: {
        status?: 'active' | 'pending_verification' | 'inactive';
        page: number;
        limit: number;
    }): Promise<{ agencies: AdminAgencyListItemDto[]; meta: AdminAgencyListMeta }> {
        const { agencies, total } = await this.agencyRepo.findAllForAdmin(params);

        // Business name/logo come from the joined Magazin. Batch-resolve logos.
        const detailByFileId = await resolveFileDetails(
            agencies.map(a => a.magazin?.logo_file_id?.toString() ?? null),
            this.fileRepo,
            this.storage,
        );

        return {
            agencies: agencies.map(a => {
                const fileId = a.magazin?.logo_file_id?.toString();
                return AdminAgencyMapper.toListItemDto(
                    a,
                    a.magazin?.name ?? '',
                    fileId ? detailByFileId.get(fileId) ?? null : null,
                );
            }),
            meta: {
                total,
                page: params.page,
                limit: params.limit,
                totalPages: Math.ceil(total / params.limit),
            },
        };
    }

    async getById(agencyId: string): Promise<AdminAgencyListItemDto> {
        const agency = await this.agencyRepo.findById(agencyId);
        if (!agency) throw createAppError(ERROR_CODES.DELIVERY_AGENCY_NOT_FOUND, 404, 'Delivery agency not found');
        return this.toDto(agency);
    }

    /**
     * Approve an agency's business verification — the exit from `pending_verification`.
     *
     * ── Why this endpoint exists ─────────────────────────────────────────────────
     * Every agency is created at `pending_verification` and, until this, nothing moved it
     * off. `setLegitVerified` had no caller, `requireLegitBusiness` had no call sites, and
     * the only writers of `status` were deactivate/reactivate — so approval was being done
     * by calling `reactivate` on an agency that had never been active, which also runs the
     * whole product-restore cascade over products that were never suspended.
     *
     * ── Why it is not a transaction ──────────────────────────────────────────────
     * Unlike its two neighbours there is no cascade: approving an agency suspends nothing
     * and restores nothing. The whole write is one compare-and-set, which is atomic on its
     * own, so a transaction would buy a session and no additional guarantee.
     *
     * A miss is 409, never 404: the agency exists, it is simply **already approved** — by a
     * colleague, or by this administrator double-clicking. That is the only state the
     * predicate refuses (BR-026 § 2); a refused agency IS approvable, which is what makes
     * re-review work at all. 404 and 409 are different remedies and the caller must be able
     * to tell them apart.
     */
    async verify(agencyId: string, actor: ActorRef): Promise<AdminAgencyListItemDto> {
        const verified = await this.agencyRepo.markVerifiedIfNotVerified(agencyId, actor);
        if (verified) return this.toDto(verified);

        // The CAS returned nothing. Distinguish "no such agency" from "already approved" —
        // collapsing them would send an administrator looking for a typo in the id when
        // the real answer is that somebody else already approved it.
        const existing = await this.agencyRepo.findById(agencyId);
        if (!existing) {
            throw createAppError(ERROR_CODES.DELIVERY_AGENCY_NOT_FOUND, 404, 'Delivery agency not found');
        }
        throw createAppError(
            ERROR_CODES.DELIVERY_AGENCY_VERIFICATION_CONFLICT,
            409,
            /**
             * ⚠ Reports the VERIFICATION verdict, not the account status — those became two
             * different things on 2026-09-15, and the CODE was renamed to say so in the same
             * week (BR-026 § 3). `currentStatus` is kept beside it because it is still true
             * and clients already read it, but it is no longer what decided this refusal, and
             * an administrator told "this agency is active" when the real answer is "a
             * colleague already decided" goes looking in the wrong place.
             *
             * The message names the ONE verdict this endpoint refuses rather than reporting
             * whichever verdict is on the row: every other value is now accepted, so
             * "already ${verdict}, not pending" would have described a refusal that did not
             * happen for a reason that was not the reason.
             */
            'This agency is already verified — re-read it before deciding',
            {
                currentVerification: existing.kyc_details?.status ?? null,
                currentStatus: existing.status,
            },
        );
    }

    /**
     * Refuse an agency's business verification, with a reason.
     *
     * ── Why this had to exist beside `verify` ────────────────────────────────────
     * Until it did, `kyc_details.legit_verified: false` meant both "never reviewed" and
     * "reviewed and refused", so a review queue could not be built over it and an agency
     * was never told what to fix. The vendor lifecycle solved the same problem the same
     * way and its model docstring is the argument.
     *
     * ── Why it is not a transaction, and why it changes no status ────────────────
     * Same as `verify`: one compare-and-set, no cascade. Rejection does not touch the
     * agency's top-level `status`, so it records a *verdict* rather than adding enforcement.
     *
     * ⚠ **What that record COSTS changed on 2026-09-15, and it SHRANK.** This paragraph used
     * to say a refused agency "stays `pending_verification`, where every existing gate
     * already refuses them" — true while administrative approval was the only thing that
     * set an agency `active`. Agencies now activate themselves on a proved phone, so a
     * refused agency is routinely `active`, and product activation, pickup resolution and
     * vendor default-agency selection all accept it. What a refusal still costs is **cash**:
     * COD eligibility tests `kyc_details.legit_verified` explicitly and the payout allowance
     * reads the verdict. Anything else that ought to turn on a refusal must say so itself.
     *
     * Re-review still needs no "un-reject" verb — fixing the problem and calling `verify`
     * is the whole loop — and since 2026-09-15 the approval predicate actually admits a
     * refused agency, which between the activation split landing and BR-026 § 2 being
     * answered — the same day, undeployed — it did not.
     *
     * A miss is 409, never 404, for the reason `verify` gives: the caller needs to tell
     * "no such agency" from "already refused".
     */
    async reject(agencyId: string, actor: ActorRef, reason: string): Promise<AdminAgencyListItemDto> {
        const rejected = await this.agencyRepo.rejectIfNotRejected(agencyId, actor, reason);
        if (rejected) return this.toDto(rejected);

        const existing = await this.agencyRepo.findById(agencyId);
        if (!existing) {
            throw createAppError(ERROR_CODES.DELIVERY_AGENCY_NOT_FOUND, 404, 'Delivery agency not found');
        }
        throw createAppError(
            ERROR_CODES.DELIVERY_AGENCY_VERIFICATION_CONFLICT,
            409,
            /**
             * ⚠ Reports the VERIFICATION verdict, not the account status — those became two
             * different things on 2026-09-15, and the CODE was renamed to say so in the same
             * week (BR-026 § 3). `currentStatus` is kept beside it because it is still true
             * and clients already read it, but it is no longer what decided this refusal, and
             * an administrator told "this agency is active" when the real answer is "a
             * colleague already decided" goes looking in the wrong place.
             *
             * The message names the ONE verdict this endpoint refuses rather than reporting
             * whichever verdict is on the row: every other value is now accepted, so
             * "already ${verdict}, not pending" would have described a refusal that did not
             * happen for a reason that was not the reason.
             */
            'This agency’s verification has already been rejected — re-read it before deciding',
            {
                currentVerification: existing.kyc_details?.status ?? null,
                currentStatus: existing.status,
            },
        );
    }

    /**
     * Deactivate an agency. Idempotent — no-op if the agency is already inactive.
     */
    async deactivate(agencyId: string, actorUserId: string): Promise<{
        agency: AdminAgencyListItemDto;
        affectedProductIds: string[];
        heldOrderItemCount: number;
    }> {
        return this.txManager.runInTransaction(async (session) => {
            const agency = await this.agencyRepo.findById(agencyId, session);
            if (!agency) throw createAppError(ERROR_CODES.DELIVERY_AGENCY_NOT_FOUND, 404, 'Delivery agency not found');

            if (agency.status === 'inactive') {
                return { agency: await this.toDto(agency), affectedProductIds: [], heldOrderItemCount: 0 };
            }

            const updated = await this.agencyRepo.updateStatusById(agencyId, 'inactive', session);

            const defaultAgencyProductIds = await this.suspendVendorDefaultProducts(agencyId, session);
            const ownAgencyProductIds = await this.suspendProductOverrides(agencyId, session);
            const affectedProductIds = [...defaultAgencyProductIds, ...ownAgencyProductIds];

            const heldItems = await this.orderRepo.holdItemsByAgency(agencyId, session);

            await auditLogger.log({
                actor: { userId: actorUserId, role: 'admin' },
                action: 'DELIVERY_AGENCY_DEACTIVATED',
                resource: { type: 'DeliveryAgency', id: agencyId },
                changes: {
                    status: { from: agency.status, to: 'inactive' },
                    suspendedProductCount: affectedProductIds.length,
                    heldOrderItemCount: heldItems.length,
                },
                timestamp: new Date(),
            }, session);

            return { agency: await this.toDto(updated!), affectedProductIds, heldOrderItemCount: heldItems.length };
        });
    }

    /**
     * Reactivate an agency. Idempotent — no-op if already active.
     */
    async reactivate(agencyId: string, actorUserId: string): Promise<{
        agency: AdminAgencyListItemDto;
        restoredProducts: { productId: string; status: ProductStatus }[];
        unheldOrderItemCount: number;
    }> {
        return this.txManager.runInTransaction(async (session) => {
            const agency = await this.agencyRepo.findById(agencyId, session);
            if (!agency) throw createAppError(ERROR_CODES.DELIVERY_AGENCY_NOT_FOUND, 404, 'Delivery agency not found');

            if (agency.status === 'active') {
                return { agency: await this.toDto(agency), restoredProducts: [], unheldOrderItemCount: 0 };
            }

            const updated = await this.agencyRepo.updateStatusById(agencyId, 'active', session);

            const defaultAgencyRestored = await this.restoreVendorDefaultProducts(agencyId, session);
            const ownAgencyRestored = await this.restoreProductOverrides(agencyId, session);
            const restoredProducts = [...defaultAgencyRestored, ...ownAgencyRestored];

            const unheldItems = await this.orderRepo.unholdItemsForAgency(agencyId, session);

            await auditLogger.log({
                actor: { userId: actorUserId, role: 'admin' },
                action: 'DELIVERY_AGENCY_REACTIVATED',
                resource: { type: 'DeliveryAgency', id: agencyId },
                changes: {
                    status: { from: agency.status, to: 'active' },
                    restoredProductCount: restoredProducts.length,
                    unheldOrderItemCount: unheldItems.length,
                },
                timestamp: new Date(),
            }, session);

            return { agency: await this.toDto(updated!), restoredProducts, unheldOrderItemCount: unheldItems.length };
        });
    }

    private async suspendVendorDefaultProducts(agencyId: string, session: ClientSession): Promise<string[]> {
        const vendorIds = await this.vendorRepo.findVendorIdsByDefaultAgency(agencyId, session);
        const affectedProductIds: string[] = [];
        for (const vendorId of vendorIds) {
            const ids = await this.suspensionService.suspendForVendor(vendorId, { session });
            affectedProductIds.push(...ids);
        }
        return affectedProductIds;
    }

    private async restoreVendorDefaultProducts(agencyId: string, session: ClientSession): Promise<{ productId: string; status: ProductStatus }[]> {
        const vendorIds = await this.vendorRepo.findVendorIdsByDefaultAgency(agencyId, session);
        const restoredProducts: { productId: string; status: ProductStatus }[] = [];
        for (const vendorId of vendorIds) {
            const results = await this.suspensionService.restoreForVendor(vendorId, { session });
            restoredProducts.push(...results);
        }
        return restoredProducts;
    }

    /** Suspends every physical product (any vendor) whose OWN override points at this agency. */
    private async suspendProductOverrides(agencyId: string, session: ClientSession): Promise<string[]> {
        const products = await this.productRepo.findPhysicalByOwnDeliveryAgency(agencyId, { session });
        const affectedProductIds: string[] = [];
        for (const product of products) {
            const suspended = await this.suspensionService.suspendProductOwnAgency(product.id, product.vendorId, { session });
            if (suspended) affectedProductIds.push(product.id);
        }
        return affectedProductIds;
    }

    /** Restores every physical product (any vendor) suspended because its OWN override was this agency. */
    private async restoreProductOverrides(agencyId: string, session: ClientSession): Promise<{ productId: string; status: ProductStatus }[]> {
        const products = await this.productRepo.findPhysicalByOwnDeliveryAgency(agencyId, { session });
        const restored: { productId: string; status: ProductStatus }[] = [];
        for (const product of products) {
            const result = await this.suspensionService.restoreProductOwnAgency(product.id, product.vendorId, { session });
            if (result.restored && result.status) {
                restored.push({ productId: product.id, status: result.status });
            }
        }
        return restored;
    }
}
