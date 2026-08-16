import { createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import { IProductRepository } from '../../repositories/interfaces/product.repository.interface';
import { IVariantRepository } from '../../repositories/interfaces/variant.repository.interface';
import { Product } from '../../repositories/mappers/product.mapper';
import { SlugService } from './SlugService';
import { FileReferenceService } from './media/FileReferenceService';
import { generateSimpleSku } from './simple/sku-generator';

/**
 * ProductDuplicateService: Duplicate a product with collision-safe slug generation
 *
 * Variants are deliberately NOT copied for advanced products — the vendor
 * recreates them on the clone (digital assets and service configs can't be
 * cloned meaningfully anyway). Simple products are the exception: their whole
 * contract is "exactly one variant", so a variant-less copy would be born
 * violating its own invariant, uneditable through the simple editor and
 * unpublishable. See duplicateSimpleVariant below.
 */
export class ProductDuplicateService {
    constructor(
        private readonly productRepository: IProductRepository,
        private readonly slugService: SlugService,
        private readonly fileReferenceService: FileReferenceService,
        private readonly variantRepository?: IVariantRepository,
    ) { }

    async execute(productId: string, vendorId: string): Promise<Product> {
        const originalProduct = await this.productRepository.findById(productId, vendorId);

        if (!originalProduct) {
            throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);
        }

        const newTitle = `${originalProduct.title} (copy)`;
        const baseSlug = `${originalProduct.slug}-copy`;
        const newSlug = await this.generateUniqueSlug(baseSlug, vendorId);

        const clonedData: Omit<Product, 'id' | 'createdAt' | 'updatedAt'> = {
            vendorId,
            type: originalProduct.type,
            mode: originalProduct.mode,
            status: 'draft',
            title: newTitle,
            description: originalProduct.description || '',
            // Copied with its projection, never dropped: the two are one value in
            // two representations, and a clone that kept the prose but lost the
            // formatting would silently downgrade the vendor's work at exactly the
            // moment they expected an identical starting point.
            descriptionRich: originalProduct.descriptionRich ?? null,
            slug: newSlug,
            category: originalProduct.category,
            tags: [...(originalProduct.tags ?? [])],
            seo: { ...originalProduct.seo },
            hasVariants: false,
            defaultVariantId: undefined,
            deletedAt: null,
            fileIds: [...(originalProduct.fileIds ?? [])],
            // Duplicated products start with vectorisation reset — vendor must re-enable
            vectorisationEnabled: false,
            vectorisationStatus: 'not_started',
            vectorisedDataId: null,
        };

        if (originalProduct.type === 'digital' && originalProduct.digitalConfig) {
            // Duplicates start disabled. Per-variant assets/limits are not copied — vendor
            // must re-upload assets per variant on the clone via the variant upload endpoints.
            clonedData.digitalConfig = {
                isActive: false,
            };
        }

        // Service config + price live on the variant, which (like digital assets) is not
        // copied — the vendor recreates the service variant on the clone.

        const duplicate = await this.productRepository.create(clonedData);

        // The clone references the same media as the original — register a
        // reference row per file so the clone counts as a distinct user of each.
        if (clonedData.fileIds.length > 0) {
            await this.fileReferenceService.reconcile({
                previousFileIds: [],
                nextFileIds: clonedData.fileIds,
                actor: { type: 'vendor', id: vendorId },
                entityType: 'product',
                entityId: duplicate.id,
            });
        }

        if (originalProduct.mode === 'simple') {
            return (await this.duplicateSimpleVariant(originalProduct, duplicate, newTitle)) ?? duplicate;
        }

        return duplicate;
    }

    /**
     * Clone a simple product's lone variant onto the copy so the invariant
     * ("simple ⇒ exactly one variant") holds from birth.
     *
     * The SKU is regenerated rather than copied — it is globally unique, and it
     * doubles as the option-less variant's `optionSignature`. Deriving it from
     * the CLONE's id keeps that guarantee without a probe.
     */
    private async duplicateSimpleVariant(
        originalProduct: Product,
        duplicate: Product,
        newTitle: string,
    ): Promise<Product | null> {
        // Optional dependency: callers that never duplicate simple products
        // (none today, but the constructor arg is optional for compatibility)
        // simply get the variant-less copy.
        if (!this.variantRepository || !originalProduct.defaultVariantId) return null;

        const source = await this.variantRepository.findById(originalProduct.defaultVariantId);
        if (!source) return null;

        const sku = generateSimpleSku(newTitle, duplicate.id);

        const variant = await this.variantRepository.create({
            productId: duplicate.id,
            sku,
            name: source.name,
            status: 'active',
            optionSignature: sku,
            price: source.price,
            compareAtPrice: source.compareAtPrice,
            // The price is copied verbatim, so `minPrice === price` still holds and
            // the window needs no re-resolution. The duplicate is born
            // `vectorisationEnabled: false` (above), so it arrives configured but
            // inert — which is exactly what the flag is defined to mean.
            bargain: source.bargain ?? undefined,
            stock: source.stock,
            isInfiniteStock: source.isInfiniteStock,
            lowStockThreshold: source.lowStockThreshold,
            allowOversell: source.allowOversell,
            weight: source.weight,
            length: source.length,
            width: source.width,
            height: source.height,
            optionValueIds: [],
            // Variant media is not carried over — matching how product-level
            // duplication treats per-variant assets elsewhere.
            fileIds: [],
            deliveryAgencyId: source.deliveryAgencyId,
            deletedAt: null,
            purgeAt: null,
        });

        return this.productRepository.update(duplicate.id, duplicate.vendorId, {
            hasVariants: true,
            defaultVariantId: variant.id,
        });
    }

    private async generateUniqueSlug(baseSlug: string, vendorId: string): Promise<string> {
        let candidate = baseSlug;
        let exists = await this.productRepository.existsBySlug(candidate, vendorId);

        if (!exists) return candidate;

        let counter = 2;
        while (counter < 1000) {
            candidate = `${baseSlug}-${counter}`;
            exists = await this.productRepository.existsBySlug(candidate, vendorId);
            if (!exists) return candidate;
            counter++;
        }

        return `${baseSlug}-${Date.now()}`;
    }
}
