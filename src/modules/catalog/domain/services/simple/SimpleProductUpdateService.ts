import { createAppError } from '../../../../../core/errors';
import { ERROR_CODES } from '../../../../../core/error-codes';
import { IProductRepository } from '../../../repositories/interfaces/product.repository.interface';
import { IVariantRepository } from '../../../repositories/interfaces/variant.repository.interface';
import { Product } from '../../../repositories/mappers/product.mapper';
import { Variant } from '../../../repositories/mappers/variant.mapper';
import { ProductUpdateService } from '../ProductUpdateService';
import { assertSimpleMode } from './mode-guard';
import { PickupLocationSource } from '../../../models/product.model';
// Concrete files, not the stock-requests barrel: that module imports catalog
// repositories, so a barrel import here risks a require cycle.
import { StockChangeGate, stockChangeGate } from '../../../../stock-requests/services/stock-change-gate';
import { StockRequestDto } from '../../../../stock-requests/dto/stock-adjustment-request.dto';

export interface UpdateSimpleProductInput {
    title?: string;
    description?: string;
    category?: string;
    tags?: string[];
    fileIds?: string[];
    seoTitle?: string;
    seoDescription?: string;

    price?: number;
    compareAtPrice?: number;
    stock?: number;
    isInfiniteStock?: boolean;
    lowStockThreshold?: number | null;
    allowOversell?: boolean;
    sku?: string;
    weight?: number;
    length?: number;
    width?: number;
    height?: number;

    freeDelivery?: boolean;
    pickupLocation?: {
        source: PickupLocationSource;
        vendorAddressId?: string | null;
        /** Which agency depot, for `agency_storage`. Omitted/null = the primary. */
        agencyAddressId?: string | null;
    } | null;
}

export interface UpdateSimpleProductResult {
    product: Product;
    variant: Variant;
    /**
     * Set when the product is agency-warehoused and the body touched `stock` /
     * `isInfiniteStock`: the quantity was NOT written, and this is the request the
     * agency has to approve. `variant` reflects the unchanged quantity.
     */
    stockAdjustment?: StockRequestDto | null;
}

/**
 * Edits a simple product and its single variant from one flat body.
 *
 * Without this, changing a price would mean the vendor's client has to know that
 * price lives on a variant and go find `defaultVariantId` — re-imposing exactly
 * the model the simple editor hides.
 *
 * The product half delegates to ProductUpdateService rather than reimplementing
 * it: that service already owns the delivery merge, the agency-connection gate,
 * the pickup validation and the file reconcile, and a parallel copy is how the
 * two would drift.
 *
 * Consequence worth knowing: ProductUpdateService is not session-aware, so this
 * is two sequential writes, not a transaction. A mid-way failure leaves a
 * product whose title changed but whose price didn't — annoying, not corrupting,
 * and the caller's revalidateActiveStatus still repairs the status invariant.
 * That matches how PATCH /products/:id and PATCH /variants/:id already behave.
 */
export class SimpleProductUpdateService {
    constructor(
        private readonly productRepository: IProductRepository,
        private readonly variantRepository: IVariantRepository,
        private readonly productUpdateService: ProductUpdateService,
        private readonly stockGate: StockChangeGate = stockChangeGate,
    ) { }

    /**
     * @param actorUserId who is editing — recorded on the stock-adjustment request
     *   when the quantity has to be countersigned. Optional so the one existing
     *   call site needn't be threaded if it has no user to hand.
     */
    async execute(
        productId: string,
        vendorId: string,
        input: UpdateSimpleProductInput,
        actorUserId?: string | null,
    ): Promise<UpdateSimpleProductResult> {
        const product = await this.productRepository.findById(productId, vendorId);
        if (!product) throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);

        assertSimpleMode(product);

        // Defensive: unreachable while the invariant holds, but a simple product
        // that somehow wasn't physical would make the delivery block nonsense.
        if (product.type !== 'physical') {
            throw createAppError(
                ERROR_CODES.CATALOG_PRODUCT_INVALID_TYPE,
                400,
                'Simple products are always physical.',
            );
        }

        const variant = await this.resolveDefaultVariant(product);

        const requestedSku = input.sku?.trim();
        if (requestedSku && requestedSku !== variant.sku) {
            const clash = await this.variantRepository.findBySku(requestedSku);
            if (clash) {
                throw createAppError(ERROR_CODES.CATALOG_VARIANT_SKU_EXISTS, 409, undefined, { sku: requestedSku });
            }
        }

        const hasDeliveryPatch = input.freeDelivery !== undefined || input.pickupLocation !== undefined;

        const updatedProduct = await this.productUpdateService.execute(productId, vendorId, {
            title: input.title,
            description: input.description,
            category: input.category,
            tags: input.tags,
            fileIds: input.fileIds,
            seoTitle: input.seoTitle,
            seoDescription: input.seoDescription,
            ...(hasDeliveryPatch && {
                delivery: {
                    freeDelivery: input.freeDelivery,
                    pickupLocation: input.pickupLocation,
                },
            }),
        });

        // The stock gate, AFTER the product write: a body that switches pickup to
        // `agency_storage` and sets a quantity in one call must be judged against the
        // arrangement it just created, not the one it replaced. Same reasoning in
        // reverse for a body switching storage off — that quantity applies directly.
        const stockAdjustment = await this.stockGate.intercept({
            productId,
            variantId: variant.id,
            vendorId,
            userId: actorUserId ?? null,
            quantity: input.stock,
            isInfiniteStock: input.isInfiniteStock,
        });

        const variantUpdates: Partial<Variant> = {};
        if (input.price !== undefined) variantUpdates.price = input.price;
        if (input.compareAtPrice !== undefined) variantUpdates.compareAtPrice = input.compareAtPrice;
        // Skipped entirely when the gate queued a request — the quantity is the
        // agency's to confirm, and writing it here would defeat the whole flow.
        if (!stockAdjustment) {
            if (input.stock !== undefined) variantUpdates.stock = input.stock;
            if (input.isInfiniteStock !== undefined) variantUpdates.isInfiniteStock = input.isInfiniteStock;
        }
        if (input.lowStockThreshold !== undefined) variantUpdates.lowStockThreshold = input.lowStockThreshold;
        if (input.allowOversell !== undefined) variantUpdates.allowOversell = input.allowOversell;
        if (input.weight !== undefined) variantUpdates.weight = input.weight;
        if (input.length !== undefined) variantUpdates.length = input.length;
        if (input.width !== undefined) variantUpdates.width = input.width;
        if (input.height !== undefined) variantUpdates.height = input.height;
        if (requestedSku && requestedSku !== variant.sku) {
            variantUpdates.sku = requestedSku;
            // Keep the signature in step with the SKU it mirrors. Safe here (one
            // variant, so the unique { productId, optionSignature } index can't
            // clash) and it stops the stale-signature drift that the generic
            // updateVariant path leaves behind.
            variantUpdates.optionSignature = requestedSku;
        }

        const updatedVariant = Object.keys(variantUpdates).length > 0
            ? (await this.variantRepository.update(variant.id, variantUpdates)) ?? variant
            : variant;

        return { product: updatedProduct, variant: updatedVariant, stockAdjustment };
    }

    /**
     * A simple product without a usable default variant has lost its invariant —
     * report it as the activation gate would rather than writing to nothing.
     */
    private async resolveDefaultVariant(product: Product): Promise<Variant> {
        if (!product.defaultVariantId) {
            throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NO_DEFAULT_VARIANT, 422, undefined, { type: product.type });
        }

        const variant = await this.variantRepository.findById(product.defaultVariantId);
        if (!variant || variant.productId !== product.id || variant.status !== 'active') {
            throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NO_DEFAULT_VARIANT, 422, undefined, { type: product.type });
        }

        return variant;
    }
}
