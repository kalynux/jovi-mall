/**
 * HTTP handlers for the bargaining sub-agent's five read tools.
 *
 * Thin by construction: parse, delegate, envelope. Every decision worth arguing about is in
 * `services/negotiation-tools.service.ts` or in `domain/`, which is what lets
 * `test:negotiation-tools` cover them without a server or a database.
 *
 * `asyncHandler` + `sendSuccess`, like every other controller here — no `res.status().json`
 * and no `throw new Error()`; a refusal is a `createAppError` raised in the domain and
 * forwarded by the wrapper.
 */
import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { sendSuccess } from '../../../core/responses';
import { negotiationToolsService } from '../services/negotiation-tools.service';
import {
    CheckPromotionSchema,
    FindAlternativesSchema,
    FindComplementsSchema,
    ProductDetailsSchema,
    QuoteDeliverySchema,
} from '../validators/negotiation-tools.validators';

export class NegotiationToolsController {
    /** `POST /product-details` — `get_product_details`. */
    static productDetails = asyncHandler(async (req: Request, res: Response) => {
        const input = ProductDetailsSchema.parse(req.body ?? {});
        sendSuccess(res, await negotiationToolsService.productDetails(input));
    });

    /** `POST /alternatives` — `find_alternative_product`. */
    static findAlternatives = asyncHandler(async (req: Request, res: Response) => {
        const input = FindAlternativesSchema.parse(req.body ?? {});
        sendSuccess(res, await negotiationToolsService.findAlternatives(input));
    });

    /** `POST /complements` — `find_complementary_products`. */
    static findComplements = asyncHandler(async (req: Request, res: Response) => {
        const input = FindComplementsSchema.parse(req.body ?? {});
        sendSuccess(res, await negotiationToolsService.findComplements(input));
    });

    /** `POST /delivery-promise` — `quote_delivery`. */
    static quoteDelivery = asyncHandler(async (req: Request, res: Response) => {
        const input = QuoteDeliverySchema.parse(req.body ?? {});
        sendSuccess(res, await negotiationToolsService.quoteDelivery(input));
    });

    /**
     * `POST /promotion` — `check_promotion`.
     *
     * Synchronous, and the only handler here that touches no collection. It is still a
     * route rather than a constant the n8n flow holds, because the point of the tool is
     * that the model *asks*: a constant in the workflow is a fact the model never
     * requested and therefore never has to reconcile against what it was about to say.
     */
    static checkPromotion = asyncHandler(async (req: Request, res: Response) => {
        const input = CheckPromotionSchema.parse(req.body ?? {});
        sendSuccess(res, negotiationToolsService.checkPromotion(input));
    });
}
