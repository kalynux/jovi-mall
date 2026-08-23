import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { ProductRepositoryMongo } from '../repositories/mongo/product.repository.mongo';
import { StoreRepository } from '../../store/repositories/store.repository';
import { productShareService } from '../domain/services/ProductShareService';
import { ShareProductSchema } from '../validators/product-share.validator';

const productRepository = new ProductRepositoryMongo();
const storeRepository = new StoreRepository();

/**
 * Sharing a product over a connected messaging channel — Phase 6 Step 5 (6.J).
 *
 * The send path `core/richtext/`'s WhatsApp and Telegram formatters were written for and
 * which, until this, nothing called.
 *
 * Its own controller rather than a method on `VendorProductController`: that file already
 * wires eleven services for the CRUD surface, and this one needs two of them plus the
 * messaging stack. Keeping them apart means a share cannot drag WhatsApp and Telegram into
 * the import graph of every product read.
 */
export class VendorProductShareController {
    /**
     * POST /api/vendor/products/:id/share — body `{ channel }`.
     *
     * Ownership is the ordinary vendor-scoped `findById(id, vendorId)` → 404, never 403:
     * another vendor's product is not found for this caller, which is the rule every route
     * on this router follows.
     */
    static share = asyncHandler(async (req: Request, res: Response) => {
        const vendorId = req.auth!.role_entity._id.toString();
        const userId = req.auth!.user._id.toString();
        const input = ShareProductSchema.parse(req.body);

        const product = await productRepository.findById(req.params.id, vendorId);
        if (!product) throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);

        // Resolve the target BEFORE rendering: a vendor with no connection should be told
        // that, not have a message built for nobody.
        const target = await productShareService.resolveTarget(userId, input.channel);

        // The store slug is only needed for the link, so a vendor without a store still
        // shares — they get the title and the description without a URL.
        const store = await storeRepository.findByVendorIdOrNull(vendorId);
        const message = productShareService.render(product, input.channel, store?.slug ?? null);

        await productShareService.dispatch(target, message, userId);

        res.json({
            success: true,
            data: { channel: input.channel, sentTo: target.handle },
            message: `Product sent to your ${input.channel}.`,
        });
    });
}
