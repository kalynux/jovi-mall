import { createAppError } from '../../../../../core/errors';
import { ERROR_CODES } from '../../../../../core/error-codes';
import { TransactionManager } from '../../../../../core/database/transaction.manager';
import { IProductRepository } from '../../../repositories/interfaces/product.repository.interface';
import { IVariantRepository } from '../../../repositories/interfaces/variant.repository.interface';
import { Product } from '../../../repositories/mappers/product.mapper';
import { Variant } from '../../../repositories/mappers/variant.mapper';
import { SlugService } from '../SlugService';
import { FileReferenceService } from '../media/FileReferenceService';
import { assertProductImageLimit } from '../media/image-limits';
import { PickupLocationResolver, PickupResolutionReason } from '../PickupLocationResolver';
import { mergeDeliveryConfig } from '../delivery-config.merge';
import { generateSimpleSku } from './sku-generator';
import { PickupLocationSource } from '../../../models/product.model';

export interface CreateSimpleProductInput {
    vendorId: string;
    title: string;
    description: string;
    category: string;
    tags?: string[];
    fileIds?: string[];
    seoTitle?: string;
    seoDescription?: string;

    price: number;
    compareAtPrice?: number;
    stock: number;
    isInfiniteStock: boolean;
    sku?: string;
    weight?: number;
    length?: number;
    width?: number;
    height?: number;

    freeDelivery: boolean;
    pickupLocation?: { source: PickupLocationSource; vendorAddressId?: string | null };
}

export interface CreateSimpleProductResult {
    product: Product;
    variant: Variant;
    /** Why the pickup location ended up as it did — surfaced to the UI. */
    pickupReason: PickupResolutionReason;
}

/**
 * Creates a physical product and its single variant in one call.
 *
 * Unlike ProductDraftService (which creates, then reconciles media, then patches
 * — outside any transaction, so a failure strands a media-less orphan), this
 * runs as one unit. It has to: it writes across two collections, and a partial
 * failure here would leave a product with no variant — unsellable, uneditable
 * through the simple editor, and still counting against the vendor's plan cap.
 *
 * Activation is deliberately NOT part of this service. It happens after the
 * commit, in the controller, so a vendor whose delivery setup is incomplete
 * still keeps their product.
 */
export class SimpleProductCreateService {
    constructor(
        private readonly productRepository: IProductRepository,
        private readonly variantRepository: IVariantRepository,
        private readonly slugService: SlugService,
        private readonly fileReferenceService: FileReferenceService,
        private readonly pickupLocationResolver: PickupLocationResolver,
        private readonly transactionManager: TransactionManager,
    ) { }

    async execute(input: CreateSimpleProductInput): Promise<CreateSimpleProductResult> {
        const fileIds = input.fileIds ?? [];
        assertProductImageLimit('physical', fileIds.length);

        // Outside the transaction on purpose: existsBySlug ignores the session,
        // so generating in there would read pre-transaction state anyway. Same
        // residual slug race as ProductDraftService, backstopped by the unique
        // { vendorId, slug } index.
        const slug = await this.slugService.generate(input.title.trim(), input.vendorId);

        // A vendor-supplied SKU is checked up front so the 409 arrives before any
        // write. Generated SKUs need no check — they embed the product id and are
        // unique by construction (see sku-generator).
        const requestedSku = input.sku?.trim();
        if (requestedSku) {
            const clash = await this.variantRepository.findBySku(requestedSku);
            if (clash) {
                throw createAppError(ERROR_CODES.CATALOG_VARIANT_SKU_EXISTS, 409, undefined, { sku: requestedSku });
            }
        }

        return this.transactionManager.runInTransaction(async (session) => {
            // Explicit choice wins; otherwise derive from the vendor's profile.
            // Neither path can fail the create — an underivable location just
            // leaves the product as a draft with an activation blocker.
            const resolved = input.pickupLocation
                ? {
                    pickupLocation: {
                        source: input.pickupLocation.source,
                        vendor_address_id: input.pickupLocation.source === 'agency_storage'
                            ? null
                            : (input.pickupLocation.vendorAddressId ?? null),
                    },
                    reason: 'explicit' as PickupResolutionReason,
                }
                : await this.pickupLocationResolver.resolveForVendor(input.vendorId, { session });

            const delivery = mergeDeliveryConfig(undefined, {
                freeDelivery: input.freeDelivery,
                pickupLocation: resolved.pickupLocation
                    ? {
                        source: resolved.pickupLocation.source,
                        vendorAddressId: resolved.pickupLocation.vendor_address_id,
                    }
                    : null,
            });

            const product = await this.productRepository.create({
                vendorId: input.vendorId,
                type: 'physical',
                mode: 'simple',
                status: 'draft',
                title: input.title.trim(),
                description: input.description,
                slug,
                category: input.category,
                tags: input.tags ?? [],
                seo: { title: input.seoTitle ?? '', description: input.seoDescription ?? '' },
                hasVariants: false,
                // Media is attached only once the files are authorized — never
                // persist an unauthorized reference (mirrors ProductDraftService).
                fileIds: [],
                deletedAt: null,
                vectorisationEnabled: false,
                vectorisationStatus: 'not_started',
                vectorisedDataId: null,
                delivery: delivery as unknown as Product['delivery'],
            }, { session });

            // Authorize + register the media. A file the vendor doesn't own throws
            // here and aborts the whole transaction — which is precisely the orphan
            // bug the multi-step create path still has.
            if (fileIds.length > 0) {
                await this.fileReferenceService.reconcile({
                    previousFileIds: [],
                    nextFileIds: fileIds,
                    actor: { type: 'vendor', id: input.vendorId },
                    entityType: 'product',
                    entityId: product.id,
                }, { session });
            }

            const sku = requestedSku ?? generateSimpleSku(input.title, product.id);

            const variant = await this.variantRepository.create({
                productId: product.id,
                sku,
                status: 'active',
                // Option-less variants use the SKU as their signature — the unique
                // { productId, optionSignature } index rules out a constant here.
                // Matches VendorVariantController.createVariant.
                optionSignature: sku,
                price: input.price,
                compareAtPrice: input.compareAtPrice,
                stock: input.stock,
                isInfiniteStock: input.isInfiniteStock,
                weight: input.weight,
                length: input.length,
                width: input.width,
                height: input.height,
                optionValueIds: [],
                fileIds: [],
                // Only VariantRepositoryMongo.update maps these two to their
                // snake_case columns (low_stock_threshold / allow_oversell);
                // create() passes the object through raw, so Mongoose's strict
                // mode drops them and the columns take their schema defaults —
                // which are these same values. Passed for type completeness.
                lowStockThreshold: null,
                allowOversell: false,
                deletedAt: null,
                purgeAt: null,
            }, { session });

            // One write for what the multi-step flow does in two (ProductDraftService
            // patches fileIds; createVariant patches hasVariants/defaultVariantId).
            const finalised = await this.productRepository.update(product.id, input.vendorId, {
                fileIds,
                hasVariants: true,
                defaultVariantId: variant.id,
            }, { session });

            return {
                product: finalised ?? product,
                variant,
                pickupReason: resolved.reason,
            };
        });
    }
}
