import { Request, Response } from 'express';
import { Types } from 'mongoose';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { sendSuccess } from '../../../core/responses';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { reviewService } from '../../reviews/services/review.service';
import { ReviewAuthorRole } from '../../reviews/models/review.model';
import { ReviewAuthor } from '../../reviews/domain/services/review-eligibility.service';
import { toAuthorReviewDto } from '../../reviews/dto/review.dto';
import { publicCatalogService } from '../../catalog/services/public-catalog.service';
import { OrderModel } from '../../orders/order.model';
import { botCallerOf, botResponseLanguageOf } from '../middlewares/bot-identity.middleware';
import { setBotReply } from '../middlewares/bot-reply.middleware';
import { botChrome } from '../domain/bot-chrome-copy';
import { rateActionId, rateProductActionId } from '../domain/bot-action-id';
import { BotActionHandlers, ParsedBotAction, unknownBotAction } from '../domain/bot-action-dispatch';
import { BotReplyOption } from '../domain/channel-reply';
import { distinguishingPart } from './bot-discovery.controller';
import { BOT_CHAT_LIST_MAX, windowForChat } from '../domain/bot-list-window';
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

// ─────────────────────────────────────────────────────────────────────────────
//  Leaving a review, from a tap
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `rate:…` — the only path from "Leave a review" to a review.
 *
 * ── ⛔ WHAT WAS BROKEN ───────────────────────────────────────────────────────
 * A customer could not leave a review at all. `reviews_create` is `flow_only`, so the model may
 * never call it — correct, and it stays that way — but nothing else called it either: the route had
 * no caller of any kind, and the "Leave a review" button on two automatic messages carried a verb
 * that no handler map claimed. The platform invited a review twice and had no path from the
 * invitation to a review. The button was withdrawn until this existed.
 *
 * ── THE THREE ARITIES, AND WHY STARS COME FIRST ─────────────────────────────
 *     rate:<orderId>                       the invitation — asks for the stars
 *     rate:<orderId>:<stars>               one product on the order → reviewed; several → asks which
 *     rate:<orderId>:<stars>:<productId>   that product, at those stars
 *
 * Told apart by ARITY, as `shp:<orderId>` and `shp:<orderId>:<shipmentId>` already are. The stars
 * are the impulse at the moment a delivery lands, and a follow-up question costs the rating — so a
 * single-product order, which is most of them, is one tap after the invitation.
 *
 * ── ⚠ FIVE STARS DO NOT FIT THREE BUTTONS, AND DO NOT NEED TO ───────────────
 * A five-option `choice` renders as a LIST on WhatsApp (ten rows allowed) and as five inline
 * buttons on Telegram. So this needs no screen and no Flow — checked with the renderer's owner
 * rather than assumed.
 *
 * ── ⚠ STARS ONLY, AND THE REASON IS NOT SIMPLICITY ──────────────────────────
 * The owner's decision. A bare star **publishes immediately**; prose is held for a moderator
 * (`initialStatusOf`). So a star given in chat moves the public rating at once, while a written
 * review would sit invisible until somebody reads it — and words cannot arrive by tap anyway, on a
 * surface that deliberately holds no conversation state between turns. Written reviews from chat
 * would be a form, and that is a separate decision with a real cost.
 *
 * ── ⚠ BUILT BESIDE A RESTRICTION, NOT AROUND IT ─────────────────────────────
 * `reviews_create` remains `flow_only` in the tool catalogue: the model is never handed the ability
 * to write a review, because a model that can write one can be talked into writing one. This
 * handler calls `reviewService.submit` directly, from a tap this server minted — the same posture
 * the download tap takes toward `digital_create_download_link`.
 */
async function handleRateTap(req: Request, res: Response, action: ParsedBotAction): Promise<void> {
    const caller = botCallerOf(req);
    const language = botResponseLanguageOf(req);

    const [orderId, rawStars, productId] = action.argument.split(':');
    if (!isObjectId(orderId)) throw unknownBotAction();

    /**
     * ⚠ **Ownership is checked HERE, before anything is drawn**, so the invitation cannot be made
     * to ask about somebody else's order — the token arrives from a chat and a chat is not a
     * credential. A miss is NOT FOUND rather than forbidden: confirming that an order exists but
     * belongs to someone else is itself a disclosure.
     */
    const order = await OrderModel.findOne(
        { _id: new Types.ObjectId(orderId), customer_id: new Types.ObjectId(caller.customerId) },
        { items: 1 },
    ).lean();
    if (!order) throw createAppError(ERROR_CODES.REVIEW_SUBJECT_NOT_FOUND, 404);

    /** The invitation: ask for the stars and nothing else. */
    if (rawStars === undefined) {
        setBotReply(req, {
            kind: 'choice',
            text: botChrome('ratePrompt', language),
            options: starOptions(orderId),
            listButton: botChrome('chooseListButton', language),
            sectionTitle: botChrome('chooseSectionTitle', language),
        });
        sendSuccess(res, { asked: 'rating', orderId });
        return;
    }

    const stars = Number(rawStars);
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) throw unknownBotAction();

    /** The third arity: the customer has already said which product. */
    if (productId !== undefined) {
        if (!isObjectId(productId)) throw unknownBotAction();
        await submitStars(req, res, caller, language, productId, stars);
        return;
    }

    /**
     * ⚠ **Deduplicated by product, because an order may hold several LINES of one product** — two
     * sizes of the same shirt is one thing to review, not two, and `findByAuthorAndSubject` would
     * refuse the second as a duplicate anyway.
     */
    const products = distinctProducts(order.items ?? []);
    if (products.length === 0) throw createAppError(ERROR_CODES.REVIEW_SUBJECT_NOT_FOUND, 404);

    /** ⭐ The common case: one product, so the stars ARE the review. No second question. */
    if (products.length === 1) {
        await submitStars(req, res, caller, language, products[0].productId, stars);
        return;
    }

    const titles = products.map((product) => product.title);
    const options: BotReplyOption[] = products.slice(0, BOT_CHAT_LIST_MAX).map((product) => ({
        id: rateProductActionId(orderId, stars as 1 | 2 | 3 | 4 | 5, product.productId),
        label: product.title,
        /**
         * ⚠ **A row title built from DATA needs a short form.** A WhatsApp list row is cut at 24
         * characters mid-word, and two products of one order routinely share an opening — the
         * defect that put two identical rows in front of a customer choosing between files they
         * had paid for. The full title goes in the description, where there are 72.
         */
        shortLabel: distinguishingPart(product.title, titles),
        description: product.title,
    }));

    setBotReply(req, {
        kind: 'choice',
        text: botChrome('rateWhichProductPrompt', language),
        options,
        listButton: botChrome('chooseListButton', language),
        sectionTitle: botChrome('chooseSectionTitle', language),
    });
    sendSuccess(res, { asked: 'product', orderId, stars, choices: options.length });
}

/**
 * Write the review.
 *
 * Eligibility, the confirmed delivery and one-review-per-subject all stay inside the service, which
 * raises `REVIEW_NOT_ELIGIBLE`, `REVIEW_ALREADY_EXISTS` and `REVIEW_SUBJECT_NOT_FOUND` by name —
 * and each now has its own customer sentence, so "you have already reviewed this one" reaches the
 * customer instead of a category fallback that cannot say which of the three happened.
 */
async function submitStars(
    req: Request,
    res: Response,
    caller: { userId: string; customerId: string },
    language: string | null,
    productId: string,
    stars: number,
): Promise<void> {
    const review = await reviewService.submit(
        { userId: caller.userId, role: 'customer' as ReviewAuthorRole, roleEntityId: caller.customerId },
        {
            subjectType: 'product',
            subjectId: productId,
            rating: stars,
            /**
             * ⚠ **Both null, deliberately.** A bare star publishes immediately and moves the public
             * rating; prose is held for a moderator. Inventing a title or a body from a tap would
             * take the customer's rating out of the published average without their asking.
             */
            title: null,
            body: null,
        },
    );

    setBotReply(req, { kind: 'text', text: botChrome('rateThanksPrompt', language) });
    sendSuccess(res, { reviewed: productId, rating: stars, status: review.status });
}

/** ★★★★★ … ★☆☆☆☆ — the one picker on this surface whose labels need no translation. */
export function starOptions(orderId: string): BotReplyOption[] {
    return ([5, 4, 3, 2, 1] as const).map((stars) => ({
        id: rateActionId(orderId, stars),
        label: '★'.repeat(stars) + '☆'.repeat(5 - stars),
    }));
}

/** One entry per product on the order, first line wins the title snapshot. */
export function distinctProducts(items: ReadonlyArray<{ product_id?: unknown; title?: string }>): Array<{
    productId: string;
    title: string;
}> {
    const seen = new Map<string, string>();
    for (const item of items) {
        const productId = item.product_id ? String(item.product_id) : '';
        if (!productId || seen.has(productId)) continue;
        seen.set(productId, item.title || '—');
    }
    return [...seen].map(([productId, title]) => ({ productId, title }));
}

const isObjectId = (value: string | undefined): boolean => /^[0-9a-fA-F]{24}$/.test(value ?? '');

/**
 * The verb this controller answers, for the dispatcher's registry.
 *
 * ⚠ Landed AFTER this file compiles — the drawn-key guard reports `rate:` as drawn-but-unrouted
 * until it is, which is exactly the catch it made on the download button an hour earlier.
 */
export const REVIEW_ACTION_HANDLERS: BotActionHandlers = Object.freeze({
    rate: handleRateTap,
});
