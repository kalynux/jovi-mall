import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { transactionManager } from '../../../core/database/transaction.manager';
import { getStorageProvider } from '../../../core/storage';
import { ProductRepositoryMongo } from '../repositories/mongo/product.repository.mongo';
import { VariantRepositoryMongo } from '../repositories/mongo/variant.repository.mongo';
import { FileRepositoryMongo } from '../repositories/mongo/file.repository.mongo';
import { FileReferenceRepositoryMongo } from '../repositories/mongo/file-reference.repository.mongo';
import { Product } from '../repositories/mappers/product.mapper';
import { Variant } from '../repositories/mappers/variant.mapper';
import { enrichProduct, enrichVariant } from '../read-models/enrich-product-detail';
import { pickupLocationDetailResolver } from '../read-models/pickup-location-detail.resolver';
import { ActivationBlocker } from '../read-models/product-detail.read-model';
import { SlugService } from '../domain/services/SlugService';
import { FileReferenceService } from '../domain/services/media/FileReferenceService';
import { ProductUpdateService } from '../domain/services/ProductUpdateService';
import {
    ProductStatusValidationService,
    toActivationBlocker,
} from '../domain/services/ProductStatusValidationService';
import { PickupLocationResolver, PickupResolutionReason } from '../domain/services/PickupLocationResolver';
import { SimpleProductCreateService } from '../domain/services/simple/SimpleProductCreateService';
import { SimpleProductUpdateService } from '../domain/services/simple/SimpleProductUpdateService';
import {
    CreateSimpleProductSchema,
    UpdateSimpleProductSchema,
} from '../validators/simple-product.validator';
import { vectorisationService } from '../domain/services/VectorisationService';
import { entitlementService } from '../../billing/services/entitlement.service';

const productRepository = new ProductRepositoryMongo();
const variantRepository = new VariantRepositoryMongo();
const fileRepository = new FileRepositoryMongo();
const fileReferenceRepository = new FileReferenceRepositoryMongo();
const storageProvider = getStorageProvider();
const slugService = new SlugService(productRepository);
const fileReferenceService = new FileReferenceService(fileRepository, fileReferenceRepository);
const pickupLocationResolver = new PickupLocationResolver();
const productStatusValidationService = new ProductStatusValidationService(productRepository, variantRepository);
const productUpdateService = new ProductUpdateService(productRepository, slugService, fileReferenceService);
const simpleProductCreateService = new SimpleProductCreateService(
    productRepository,
    variantRepository,
    slugService,
    fileReferenceService,
    pickupLocationResolver,
    transactionManager,
);
const simpleProductUpdateService = new SimpleProductUpdateService(
    productRepository,
    variantRepository,
    productUpdateService,
);

/** What the frontend needs to render the publish state and its checklist. */
interface ActivationOutcome {
    attempted: boolean;
    published: boolean;
    blockers: ActivationBlocker[];
    pickupReason?: PickupResolutionReason;
}

/**
 * Try to publish, best-effort.
 *
 * Runs AFTER the create/update transaction has committed, never inside it. The
 * product is already safely saved at this point, so a vendor whose delivery
 * setup is incomplete keeps their work and simply sees what to fix — which is
 * the whole premise of the simple editor. Doing this inside the transaction
 * would either risk rolling back a perfectly good product or leave a
 * catch-without-rethrow sitting in a transaction callback, where any future
 * `throw` added below it silently poisons the write.
 *
 * Returns every unmet requirement, not just the first: a vendor who has set up
 * neither an agency nor a pickup location should be told both at once rather
 * than discovering them across three round-trips.
 */
async function attemptPublish(product: Product, vendorId: string): Promise<{ product: Product; outcome: ActivationOutcome }> {
    const collected = await productStatusValidationService.collectActivationBlockers(product);
    if (collected.length > 0) {
        return {
            product,
            outcome: { attempted: true, published: false, blockers: collected.map(toActivationBlocker) },
        };
    }

    // Freshly created products are 'draft', and draft -> active is always an
    // allowed vendor transition, so assertVendorTransition adds nothing here.
    const activated = await productRepository.update(product.id, vendorId, { status: 'active' });
    return {
        product: activated ?? product,
        outcome: { attempted: true, published: true, blockers: [] },
    };
}

async function buildDetail(product: Product, variant: Variant): Promise<Record<string, unknown>> {
    const [enrichedProduct, enrichedVariant] = await Promise.all([
        enrichProduct(product, fileRepository, storageProvider, pickupLocationDetailResolver),
        enrichVariant(variant, fileRepository, storageProvider, product),
    ]);
    return { ...enrichedProduct, defaultVariant: enrichedVariant };
}

/**
 * VendorSimpleProductController
 *
 * The one-shot editor for vendors who sell a single thing at a single price.
 * Everything here is a convenience over the layered endpoints in
 * vendor-product.controller / vendor-variant.controller — it creates no
 * capability those lack, it just collapses six calls into one and holds the
 * product to a shape simple enough that a one-screen form can express it.
 */
export class VendorSimpleProductController {
    /**
     * POST /api/vendor/products/simple
     * Create a physical product, its single variant and its delivery config,
     * then attempt to publish.
     */
    static createSimpleProduct = asyncHandler(async (req: Request, res: Response) => {
        const vendorId = req.auth!.role_entity._id.toString();
        const input = CreateSimpleProductSchema.parse(req.body);

        // Same plan cap the multi-step create enforces. Outside the transaction:
        // it throws 403 before any write, and it isn't backed by a unique
        // constraint, so wrapping it would buy nothing.
        const activeCount = await productRepository.countActiveByVendor(vendorId);
        await entitlementService.assertCanAddProduct(vendorId, activeCount);

        const created = await simpleProductCreateService.execute({ vendorId, ...input });

        let product = created.product;
        let outcome: ActivationOutcome = { attempted: false, published: false, blockers: [] };
        if (input.publish) {
            // Re-read so the gate sees the variant and delivery config the
            // transaction just attached.
            const persisted = await productRepository.findById(product.id, vendorId);
            const result = await attemptPublish(persisted ?? product, vendorId);
            product = result.product;
            outcome = result.outcome;
        }
        outcome.pickupReason = created.pickupReason;

        const data = await buildDetail(product, created.variant);

        res.status(201).json({
            success: true,
            data,
            meta: { activation: outcome },
            message: outcome.published
                ? 'Product created and published'
                : `Product saved as a draft${outcome.blockers.length > 0 ? `. Resolve ${outcome.blockers.length} issue(s) to publish.` : '.'}`,
        });

        // Fire-and-forget after the response, mirroring the multi-step create.
        void vectorisationService.vectoriseSingle(product.id);
    });

    /**
     * PATCH /api/vendor/products/:id/simple
     * Edit the product and its single variant from one flat body.
     */
    static updateSimpleProduct = asyncHandler(async (req: Request, res: Response) => {
        const vendorId = req.auth!.role_entity._id.toString();
        const { id } = req.params;
        const input = UpdateSimpleProductSchema.parse(req.body);

        const updated = await simpleProductUpdateService.execute(
            id,
            vendorId,
            input,
            req.auth!.user._id.toString(),
        );

        let product = updated.product;
        let outcome: ActivationOutcome;

        if (input.publish === true && product.status === 'draft') {
            // Explicit opt-in only. An edit must never silently republish a
            // product the vendor deliberately unpublished via /status.
            //
            // ⚠ **No plan-quota check here, and that is deliberate — do not add one.**
            // `draft -> active` takes no catalog slot: `countActiveByVendor` counts
            // drafts, so both sides of this transition already occupy one and the number
            // the plan caps does not move. A gate here would refuse a vendor who is
            // comfortably inside their plan, for publishing a product they had already
            // been allowed to create. The slot was charged at creation
            // (`createSimpleProduct` above), which is the only moment it is owed.
            //
            // A quota-suspended product cannot reach this branch either way: it sits at
            // `status: 'suspended'`, not `draft`.
            const result = await attemptPublish(product, vendorId);
            product = result.product;
            outcome = result.outcome;
        } else if (input.publish === true && product.status === 'active') {
            outcome = { attempted: true, published: true, blockers: [] };
        } else {
            // Same demote-if-broken hook the layered update paths run. Unlike
            // them, we then say WHY it dropped out of active instead of leaving
            // the vendor to guess.
            const demoted = await productStatusValidationService.revalidateActiveStatus(id, vendorId);
            if (demoted) {
                const collected = await productStatusValidationService.collectActivationBlockers(product);
                outcome = { attempted: false, published: false, blockers: collected.map(toActivationBlocker) };
                product = (await productRepository.findById(id, vendorId)) ?? product;
            } else {
                outcome = { attempted: false, published: product.status === 'active', blockers: [] };
            }
        }

        const data = await buildDetail(product, updated.variant);

        res.json({
            success: true,
            data,
            meta: {
                activation: outcome,
                // Present only when this product is agency-warehoused and the body
                // touched the quantity: it was NOT written, `data` still shows the old
                // number, and the agency has to approve the change. One status code —
                // 200 — so a client never branches on 200-vs-202 for a body it must
                // read either way.
                ...(updated.stockAdjustment
                    ? { stockAdjustment: { status: 'pending_agency_approval', request: updated.stockAdjustment } }
                    : {}),
            },
            message: updated.stockAdjustment
                ? 'Product updated. The stock change is awaiting the storage agency’s approval.'
                : 'Product updated successfully',
        });

        void vectorisationService.vectoriseSingle(product.id);
    });

    /**
     * POST /api/vendor/products/:id/convert-to-advanced
     *
     * Flips `mode` and nothing else — no data migration, no repair step. That is
     * possible because the simple editor creates a structurally ordinary
     * product: physical, one option-less variant whose `optionSignature` is its
     * SKU, which is exactly what the advanced flow produces for a variant with
     * no options. If this needed to fix anything, the create path would be wrong.
     *
     * One-way. A product with twelve variants cannot collapse back into one, and
     * choosing which survives is not a decision to make on a vendor's behalf.
     */
    static convertToAdvanced = asyncHandler(async (req: Request, res: Response) => {
        const vendorId = req.auth!.role_entity._id.toString();
        const { id } = req.params;

        const product = await productRepository.findById(id, vendorId);
        if (!product) throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);

        if (product.mode === 'advanced') {
            // Idempotent, like the same-status no-op in changeStatus.
            res.json({
                success: true,
                data: await enrichProduct(product, fileRepository, storageProvider, pickupLocationDetailResolver),
                message: 'Product already uses the advanced editor',
            });
            return;
        }

        const updated = await productRepository.update(id, vendorId, { mode: 'advanced' });
        if (!updated) throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);

        res.json({
            success: true,
            data: await enrichProduct(updated, fileRepository, storageProvider, pickupLocationDetailResolver),
            message: 'Product converted to the advanced editor',
        });
    });
}
