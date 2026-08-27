import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { sendSuccess } from '../../../core/responses';
import { reviewService } from '../../reviews/services/review.service';
import { ReviewAuthorRole } from '../../reviews/models/review.model';
import { ReviewAuthor } from '../../reviews/domain/services/review-eligibility.service';
import { toAuthorReviewDto } from '../../reviews/dto/review.dto';
import { botCallerOf } from '../middlewares/bot-identity.middleware';
import { BotReviewCreateSchema, BotReviewEligibilitySchema } from '../validators/bot.validators';

/**
 * Reviews, written from a chat.
 *
 * ── THE AUTHOR IS BUILT THE SAME WAY IT IS ON EVERY OTHER MOUNT ─────────────
 * `buildReviewController(role)` takes the role from the MOUNT and never from the request,
 * and it needs BOTH identities: `userId` is what a review is authored by and what "one
 * review per subject" is keyed on, while `roleEntityId` is what ownership of an order or a
 * shipment is checked against. They are different collections and never interchangeable —
 * passing the role entity as the author would let somebody holding two roles review one
 * delivery twice. The resolved bot caller carries both, so the same object is assembled
 * here from the same two facts.
 *
 * This does not reuse `buildReviewController` itself: that factory reads `req.auth`, which
 * this surface deliberately does not build. What is shared is the service beneath it,
 * which is where every rule actually lives.
 */
function authorOf(req: Request): ReviewAuthor {
    const caller = botCallerOf(req);
    return {
        userId: caller.userId,
        role: 'customer' as ReviewAuthorRole,
        roleEntityId: caller.customerId,
    };
}

export class BotReviewController {
    /**
     * `POST /reviews/eligibility` — may I write one?
     *
     * A 200 with `eligible: false` rather than the refusal the write path would raise. This
     * is a question, and "no, and here is the code why" is a successful answer to it — the
     * `reason` is the same error code the write would have thrown, so one copy table serves
     * both. Asking first is what stops a chat inviting somebody to rate a delivery they
     * cannot rate.
     *
     * ⚠ `delivery` takes a SHIPMENT id, never an order id. An order with three parcels is
     * three deliveries by three possible agents, and there is no such thing as a review of
     * the order's delivery.
     */
    static eligibility = asyncHandler(async (req: Request, res: Response) => {
        const { subjectType, subjectId } = BotReviewEligibilitySchema.parse(req.body ?? {});
        const verdict = await reviewService.checkEligibility(authorOf(req), subjectType, subjectId);
        sendSuccess(res, verdict);
    });

    /**
     * `POST /reviews` — submit.
     *
     * ⚠ **A bare star PUBLISHES IMMEDIATELY and moves a public rating; prose is held for a
     * human moderator.** That is `initialStatusOf`, and it is the single most
     * consequence-bearing thing on this route: sending `body` is the difference between a
     * review that appears now and one that appears when somebody reads it. A model
     * "helpfully" summarising the customer's spoken praise into prose would silently take
     * their rating out of the published average.
     *
     * A delivery review is internal, is attributed to the carrying agent SERVER-SIDE, and
     * feeds that agent's trust score — 50 of the composite's 100 weight is rating factors.
     * The customer never names an agent and could not if they wanted to.
     *
     * A repeat answers `409 REVIEW_ALREADY_EXISTS`, enforced by a unique index rather than
     * by the service's pre-check, which is a race.
     */
    static create = asyncHandler(async (req: Request, res: Response) => {
        const input = BotReviewCreateSchema.parse(req.body ?? {});
        const review = await reviewService.submit(authorOf(req), input);
        sendSuccess(res, toAuthorReviewDto(review), { status: 201 });
    });
}
