import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { sendSuccess } from '../../../core/responses';
import { reviewService } from '../../reviews/services/review.service';
import { ReviewAuthorRole } from '../../reviews/models/review.model';
import { ReviewAuthor } from '../../reviews/domain/services/review-eligibility.service';
import { toAuthorReviewDto } from '../../reviews/dto/review.dto';
import { publicCatalogService } from '../../catalog/services/public-catalog.service';
import { botCallerOf, botResponseLanguageOf } from '../middlewares/bot-identity.middleware';
import { windowForChat } from '../domain/bot-list-window';
import { toBotReviewDto } from '../dto/bot-projections';
import {
    BotReviewCreateSchema,
    BotReviewEligibilitySchema,
    BotReviewListSchema,
} from '../validators/bot.validators';

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
     * `POST /reviews/list` — what the customer has already said, and whether it landed.
     *
     * ── THE AUTHOR DTO, NOT THE PUBLIC ONE ──────────────────────────────────
     * `listMine` is keyed on `author_user_id` and returns **every status**, `pending` and
     * `rejected` included. That is the whole reason a "my reviews" read exists: somebody
     * who wrote a review and cannot find it on the product page has no other way to learn
     * it is simply waiting for a moderator. The public projection strips exactly that.
     *
     * ⚠ **`status` is relayed and `publiclyVisible` is computed, because the two disagree
     * on a delivery review.** A bare-star delivery review is written straight to
     * `published` by `initialStatusOf`, and it still appears on no page anywhere — the
     * only public review read is `listPublicForProduct`. Handing a model `status` alone
     * produces "your review is live" about something the customer will never find. See
     * `toBotReviewDto`.
     *
     * Product titles are hydrated in ONE batched read for the window's five rows, through
     * `publicCatalogService.listByIds` rather than a direct model query — it carries the
     * publishable predicate, so the bot cannot name a product a shopper could not open.
     * The alternative is five `catalog_get_product` calls the model would have to make to
     * narrate one list, which is the wall of round-trips § 14 exists to prevent.
     */
    static list = asyncHandler(async (req: Request, res: Response) => {
        const query = BotReviewListSchema.parse(req.body ?? {});
        const language = botResponseLanguageOf(req);

        const page = await reviewService.listMine(
            authorOf(req),
            query.page,
            query.limit,
            query.status,
        );

        /**
         * Hydrated AFTER the window rather than before it, so an unpublishable product on
         * row six costs nothing. `windowForChat` runs on the raw documents and the
         * projection runs on what survives it.
         */
        const chat = windowForChat({
            items: page.data,
            total: page.meta.total,
            offset: (query.page - 1) * query.limit,
            surface: 'reviews',
            language,
        });

        const productIds = chat.items
            .filter((r) => r.subject_type === 'product')
            .map((r) => r.subject_id.toString());
        const cards = await publicCatalogService.listByIds(productIds);
        const titles = new Map([...cards].map(([id, card]) => [id, card.title]));

        sendSuccess(
            res,
            chat.items.map((review) =>
                toBotReviewDto(
                    {
                        id: review._id.toString(),
                        rating: review.rating,
                        title: review.title ?? null,
                        body: review.body ?? null,
                        status: review.status,
                        createdAt: review.createdAt.toISOString(),
                        subjectType: review.subject_type,
                        subjectId: review.subject_id.toString(),
                    },
                    titles,
                    review.order_id ? review.order_id.toString() : null,
                ),
            ),
            {
                meta: {
                    page: page.meta.page,
                    limit: page.meta.limit,
                    // `pages` at the repository, `totalPages` on the wire — the customer
                    // API's own rename on this list, kept so the two doors agree.
                    totalPages: page.meta.pages,
                    // `total` comes from the WINDOW, not from `page.meta`, and there is one
                    // of it for a reason: `windowForChat` corrects a count that undershoots
                    // what it is holding, and two `total`s in one object is two answers to
                    // the same question with the spread order deciding which wins.
                    ...chat.window,
                },
            },
        );
    });

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
