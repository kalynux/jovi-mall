import { Request, Response } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { asyncHandler } from '../../../../api/middlewares/async-handler';
import { sendSuccess } from '../../../../core/responses';
import { createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import { OrderModel } from '../../../orders/order.model';
import { CustomerOrderGroup, OrderRepository } from '../../../orders/order.repository';
import { StoreRepository } from '../../../store/repositories/store.repository';
import { aggregatePaymentStatus } from '../../controllers/bot-order.controller';
import { formatBotPrice } from '../../domain/product-card';
import {
    botFulfillmentStateLabel,
    botPaymentStateLabel,
    toBotOrderPaymentState,
} from '../../domain/bot-order-status-copy';
import { BotCopyLanguage, toBotCopyLanguage } from '../../domain/bot-error-copy';
import { InAppSurfaceSession, inAppSurfaceStore } from '../../services/inapp-surface.store';

/**
 * `inAppOrderListing` — the customer's whole order history, on one scrollable screen.
 *
 * ── WHAT THIS SCREEN IS FOR, AND WHY IT IS NOT THE CHAT LIST ────────────────
 * Chat answers with five orders and a "show me the rest" row, because five is what a chat
 * window can carry without becoming a wall of text. This is the rest. Its job is therefore
 * completeness and recognisability, not decisions: nothing here cancels, reorders, tracks or
 * pays. Every action a customer can take on an order stays in chat, where it can be confirmed
 * in one tap and where the model can explain what happened.
 *
 * ── ⚠ THE COD DELIVERY CODE CANNOT REACH THIS SCREEN, BY CONSTRUCTION ───────
 * `stripDeliveryCodes` exists because `customerOrderViewService.toDtos` resolves COD blocks
 * **with** the code in them — it is the customer's own secret, and the chat surface strips it
 * on every read because a chat transcript is forwarded, screenshotted and fed to a model. A
 * code read out on a *screen* is the same leak arriving from a new direction.
 *
 * So this controller does not strip the code. **It never loads it.** Nothing on this path
 * touches `cashCollectionService`, `customerOrderViewService` or `codCollections`: the data
 * comes from the order aggregate, one `items.title` projection and one store-name lookup, and
 * the delivery code lives in a different collection entirely. A projection you must remember
 * to apply is a projection somebody eventually forgets; a query that cannot reach the field is
 * not. `test:inapp-orders` § 2 pins the absence of all three names here.
 *
 * ── THE PAGE DOES NO MONEY MATHS AND NO VOCABULARY MAPPING ──────────────────
 * Totals arrive as `formatBotPrice` strings and statuses arrive as words already in the
 * customer's language. The page renders what it is told. That is the same rule the product
 * screens follow about prices, extended to statuses for the same reason: a second
 * implementation in a WebView is a second set of bugs in the one place nothing tests.
 *
 * ── THE MOUNT IS THE SECURITY DECISION, AND IT IS INHERITED ─────────────────
 * `/api/bot/miniapp/**` carries neither `INTERNAL_SERVICE_TOKEN` nor `BOT_WEBHOOK_SECRET` — a
 * browser can hold neither. The opaque handle in the URL is the only credential; it is
 * kind-checked on read, it names one conversation, and it dies in thirty minutes. Nothing here
 * reads an identity out of the request and nothing may start: the session already knows whose
 * it is, and `customerId` comes from the session and from nowhere else.
 */

const orderRepository = new OrderRepository();
const storeRepository = new StoreRepository();

/**
 * How many checkout groups a page of history holds.
 *
 * Larger than the chat's five and than `BOT_DISPLAY_MAX_PRODUCTS`, for the reason the grid
 * gives: those constants bound what a *chat answer* may carry. A scrolling screen has no such
 * constraint, and a history that asks for "load more" after nine rows is showing the customer
 * the seams of an implementation. Twenty is also `findGroupsByCustomer`'s own default.
 */
const PAGE_SIZE = 20;

/**
 * The furthest a customer may walk forward.
 *
 * A bound on a deep `$skip` inside an aggregation, not a product decision — twenty groups times
 * two hundred pages is four thousand checkouts, which nobody scrolls to.
 */
const MAX_PAGE = 200;

/**
 * ⚠ **The cursor is a page number and is deliberately not opaque**, exactly as the product
 * grid's is. Encoding it would imply it carries something worth hiding; what bounds this read
 * is the session, which pins the customer, and the cursor only says how far down *their own*
 * history they have scrolled. An edited cursor reaches a different page of the same history —
 * the same thing scrolling reaches.
 */
const CursorSchema = z.object({
    cursor: z.coerce.number().int().min(1).max(MAX_PAGE).optional(),
});

const HandleSchema = z.object({ handle: z.string().trim().min(3).max(64) });

export class OrderListingController {
    /**
     * `GET /api/bot/miniapp/s/ol/:handle/data` — one page of history.
     *
     * ⚠ **Read live on every page, never cached onto the session.** A screen lives for thirty
     * minutes and a parcel can be delivered inside one; page two must say where the order is
     * now. The session holds *whose* history this is and nothing else — see
     * `InAppSurfaceSession`, whose `ol` member deliberately carries no query at all.
     */
    static data = asyncHandler(async (req: Request, res: Response) => {
        const { handle } = HandleSchema.parse(req.params);
        const { cursor } = CursorSchema.parse(req.query);
        const session = await readOrderSession(handle);

        const language = toBotCopyLanguage(session.language);
        const page = cursor ?? 1;

        /**
         * ⚠ **No filters are passed, and that is the screen's whole point.** The chat list
         * narrows by status, payment state and search term because a chat answer has to fit;
         * this one is the unfiltered history a customer came here to scroll. Filtering belongs
         * to the conversation, which can ask what they are looking for.
         */
        const { data: groups, meta } = await orderRepository.findGroupsByCustomer(
            session.customerId,
            { page, limit: PAGE_SIZE },
        );

        const [storeNames, titles] = await Promise.all([
            storeRepository.findNamesByVendorIds(
                groups.flatMap((group) => group.orders.map((order) => order.vendorId)),
            ),
            titlesByCart(session.customerId, groups.map((group) => group.cartId)),
        ]);

        /**
         * ⚠ **Extended on a READ, the one place a customer's attention is visible.** Somebody
         * scrolling their history is using the screen, and letting it lapse under them because
         * the clock started when they tapped a chat button is a lapse they did nothing to earn.
         *
         * Not awaited for its result: a failed extension costs a re-tap much later, and failing
         * this read over it would cost them the page they are looking at now.
         */
        void inAppSurfaceStore.touch('ol', handle).catch(() => undefined);

        sendSuccess(res, {
            groups: groups.map((group) =>
                toGroupCard(group, language, storeNames, titles.get(group.cartId) ?? []),
            ),
            emptyText: ORDERS_EMPTY[language],
            cursor: nextCursor(page, meta.total),
        });
    });
}

/**
 * Resolve an order-history handle, or refuse the way the chat would have.
 *
 * One refusal bucket for unknown, lapsed, wrong-owner **and wrong-kind** — the position every
 * other handle on this surface takes, because all four have the same remedy (go back to the
 * chat and ask again) and distinguishing them would confirm to a caller that a handle it does
 * not own is real.
 *
 * ⚠ The kind is named here rather than checked afterwards: `read('ol', …)` refuses a `pl`,
 * `pd`, `sl` or `co` handle by construction, so a handle pasted onto this path cannot open
 * somebody's order history.
 *
 * ⚠ **The code says "product list" and the fault is an order screen**, which is wrong in a log
 * and invisible to a customer — `ol.html` maps every 404 to the same "ask me again" sentence.
 * There is no generic in-app-screen-lapsed code and `core/error-codes.ts` is a shared file this
 * stream does not own; raised with the coordinator rather than added quietly. If a
 * `BOT_SCREEN_SESSION_EXPIRED` lands, this call site and the store screen's are the two to move.
 */
async function readOrderSession(
    handle: string,
): Promise<Extract<InAppSurfaceSession, { kind: 'ol' }>> {
    const session = await inAppSurfaceStore.read('ol', handle);
    if (!session) {
        throw createAppError(
            ERROR_CODES.BOT_PRODUCT_LIST_EXPIRED,
            404,
            'That order screen is no longer held',
        );
    }
    return session;
}

/**
 * The next page's cursor, or null when there is not one this endpoint would accept.
 *
 * ⚠ **`MAX_PAGE` is in this condition as well as in the schema, and leaving it out was a real
 * defect rather than a tidiness point.** `CursorSchema` refuses anything above `MAX_PAGE`, so a
 * cursor of `MAX_PAGE + 1` is a page the customer can be OFFERED and this endpoint will then
 * refuse: "Load more" appears, the tap 400s, and the page renders "Something went wrong" — a
 * customer told the screen is broken when they have simply reached the end of it.
 *
 * The ceiling has to be stated in both places because they answer different questions: the
 * schema bounds what a caller may ask for, and this bounds what we may offer. A bound that
 * exists only on the refusing side turns a natural end into a fault.
 *
 * ⚠ **The same shape exists wherever a page number is both capped and advertised.** It was
 * found here and reported to the coordinator rather than fixed across other streams' files.
 */
function nextCursor(page: number, total: number): string | null {
    if (page >= MAX_PAGE) return null;
    return page * PAGE_SIZE < total ? String(page + 1) : null;
}

// ─────────────────────────────────────────────────────────────────────────────
//  What the page renders
// ─────────────────────────────────────────────────────────────────────────────

/** One per-vendor order inside a checkout. */
interface OrderRow {
    orderNumber: string;
    /** The shop's business name, from the Store — never the vendor's display name. */
    storeName: string | null;
    /**
     * Already in the customer's language. An unrecognised status reads as the shared neutral
     * "Status not available" — never the raw internal word, and never silence — which is the
     * same floor the chat uses, so the two surfaces cannot disagree about it.
     */
    statusText: string;
}

/**
 * One checkout group — what the customer thinks of as "an order".
 *
 * ⚠ **Every field is a named string built here, and the object is never spread from a DTO.**
 * That is `bot-projections.ts`'s rule one layer further out: a spread republishes whatever the
 * underlying shape gains next, silently, onto a screen that is opened on a phone and shown to
 * whoever is standing there. It is also what makes the COD-code guarantee structural rather
 * than a habit — there is no field here that could carry one.
 */
interface OrderGroupCard {
    cartId: string;
    dateText: string;
    totalText: string;
    paymentText: string;
    /** The first few things bought, so a customer can recognise the checkout. */
    summaryText: string | null;
    orders: OrderRow[];
}

function toGroupCard(
    group: CustomerOrderGroup,
    language: BotCopyLanguage,
    storeNames: Map<string, { name: string }>,
    titles: string[],
): OrderGroupCard {
    return {
        cartId: group.cartId,
        dateText: formatDate(group.createdAt, language),
        totalText: formatBotPrice(group.totalAmount, group.currency),
        paymentText: paymentTextOf(group, language),
        summaryText: summarise(titles),
        orders: group.orders.map((order) => ({
            orderNumber: order.orderNumber,
            storeName: storeNames.get(order.vendorId)?.name ?? null,
            statusText: botFulfillmentStateLabel(order.fulfillmentStatus, language),
        })),
    };
}

/**
 * The line that tells a customer which checkout this was.
 *
 * Three titles and a count, rather than a sentence: "+2" needs no translation and no plural
 * rule, and Arabic alone has six of those. Duplicates are collapsed because two lines of the
 * same product read as two different things.
 */
function summarise(titles: string[]): string | null {
    const unique = [...new Set(titles.map((t) => t.trim()).filter((t) => t.length > 0))];
    if (unique.length === 0) return null;
    const shown = unique.slice(0, 3).join(' · ');
    return unique.length > 3 ? `${shown} +${unique.length - 3}` : shown;
}

/**
 * Cart id → the titles bought in it.
 *
 * ⚠ **One indexed query for the whole page**, on `{ customer_id, cart_id }` — the same index
 * `findGroupsByCustomer` is built around. Per group it would be twenty round trips for a screen
 * somebody scrolls.
 *
 * ⚠ **`customer_id` is in the filter as well as `cart_id`**, though the cart ids came from a
 * read already scoped to this customer. Belt and braces on the one query in this file that
 * names documents by ids the customer's own history handed us: a scoping clause that is
 * *implied* by the caller is a scoping clause that disappears the first time somebody reuses
 * the helper.
 *
 * ⚠ **The projection is `items.title` and nothing else.** An order document carries payment
 * intents, price breakdowns and dispute holds; a `find()` without a `select` would pull all of
 * it into a screen's payload builder, where the next person adds a field to the card.
 */
async function titlesByCart(customerId: string, cartIds: string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (cartIds.length === 0) return out;

    const rows = await OrderModel.find({
        customer_id: new Types.ObjectId(customerId),
        cart_id: { $in: cartIds },
    })
        .select('cart_id items.title')
        .lean()
        .exec();

    for (const row of rows as unknown as Array<{ cart_id?: unknown; items?: Array<{ title?: string }> }>) {
        const cartId = row.cart_id ? String(row.cart_id) : null;
        if (!cartId) continue;
        const titles = (row.items ?? [])
            .map((item) => item.title)
            .filter((title): title is string => typeof title === 'string');
        out.set(cartId, [...(out.get(cartId) ?? []), ...titles]);
    }

    return out;
}

/**
 * The date, in the customer's language.
 *
 * ⚠ **ICU is used here and deliberately NOT for money.** `formatBotPrice` avoids
 * `Intl.NumberFormat` because it renders XAF with a narrow no-break space whose code point
 * differs between Node builds, and because its grouping character would disagree with every
 * other price this platform prints. Neither hazard exists for a date: nothing else on this
 * platform prints one to a customer, so there is no house style to diverge from, and a
 * hand-rolled date in five languages would be a calendar implementation nobody asked for.
 *
 * ⚠ **No `timeZone` is pinned**, so this renders in the server's zone — the same thing every
 * other date on this platform does. A customer ordering late in the evening can therefore see
 * yesterday's date on a host running UTC. Named rather than fixed: the platform holds no
 * per-customer timezone, and inventing one here would make this screen disagree with the
 * emails and notifications about the same order.
 */
function formatDate(at: Date, language: BotCopyLanguage): string {
    try {
        return new Intl.DateTimeFormat(language, { dateStyle: 'medium' }).format(new Date(at));
    } catch {
        // A locale ICU does not carry is not worth losing the row over.
        return new Date(at).toISOString().slice(0, 10);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  The status words — IMPORTED, and this screen holds no vocabulary of its own
//
//  ⚠ **ONE table, in `domain/bot-order-status-copy.ts`, read by the chat and by this screen.**
//  The chat order list is literally the first five rows of the list this screen continues, so
//  a customer who taps "Load more" must not watch the same order change state. On 2026-09-16
//  the two surfaces were found to word four of the nine fulfilment statuses differently —
//  `pending` read "Order received" in chat and "Preparing" here — with each file total, each
//  rationale sound, and no assertion able to see across them.
//
//  A guard comparing two tables would have caught the NEXT drift after somebody wrote it. One
//  table cannot drift at all, so this file's copies were deleted and it imports the shared one.
//  The collapse itself — seven words for nine statuses, `received` split from `preparing`,
//  `partly_delivered` kept apart from "on its way", cash on delivery shown as a method — is
//  documented there, beside the words, and is not repeated here to drift.
//
//  ⚠ **A domain file rather than a screen controller is the right home**, because two surfaces
//  read it. Changing a word means changing it there, once, for both.
// ─────────────────────────────────────────────────────────────────────────────

type Copy = Record<BotCopyLanguage, string>;

const CASH_ON_DELIVERY_METHOD = 'cash_on_delivery';

/**
 * The payment word for a checkout group.
 *
 * ⚠ **`aggregatePaymentStatus` is imported rather than re-implemented** — a checkout group is
 * several orders and they can disagree, and `customer-order.controller.ts` already holds a
 * private second copy of that collapse. A third would be a third opinion about what "partly
 * paid" means.
 *
 * ⚠ **Cash on delivery is shown as a METHOD, not as a debt**, when every order in the checkout is
 * COD and none is paid: a COD order sits at `pending` until the agent collects, and "awaiting
 * payment" would tell a customer who owes nothing yet that they are behind. The rule itself lives
 * in `botPaymentStateLabel`; this only decides whether the checkout qualifies. It is the METHOD —
 * the delivery code is a credential this screen's data path cannot even read (see the header).
 */
function paymentTextOf(group: CustomerOrderGroup, language: BotCopyLanguage): string {
    const allCash =
        group.orders.length > 0
        && group.orders.every((order) => order.paymentMethod === CASH_ON_DELIVERY_METHOD);

    return botPaymentStateLabel(
        toBotOrderPaymentState(aggregatePaymentStatus(group.paymentStatuses)),
        language,
        { cashOnDelivery: allCash },
    );
}

/**
 * The empty state.
 *
 * ⚠ **Its own sentence rather than the grid's `listingEmpty`**, which reads "Nothing here yet.
 * Ask me in the chat and I will look for something else" — right for a search that found no
 * products, wrong for a customer who has simply never bought anything. It arrives in the data
 * payload rather than through `/copy` because `/copy` is Stream 0's shared table; see the
 * vocabulary note above.
 */
const ORDERS_EMPTY: Copy = Object.freeze({
    en: 'You have no orders yet. Ask me in the chat and I will help you find something.',
    fr: "Vous n'avez pas encore de commandes. Demandez-moi dans la discussion et je vous aiderai à trouver quelque chose.",
    pt: 'Ainda não tem encomendas. Pergunte-me na conversa e ajudo-o a encontrar algo.',
    es: 'Todavía no tienes pedidos. Pídemelo en el chat y te ayudo a encontrar algo.',
    ar: 'ليس لديك طلبات بعد. اسألني في المحادثة وسأساعدك في العثور على شيء.',
});

/**
 * ⚠ Exported for `test:inapp-orders` § 2. No status table is exported, because there is none
 * here any more — the suite imports the shared one directly and checks this screen is wired to it.
 */
export const __ORDER_LISTING = Object.freeze({
    PAGE_SIZE,
    MAX_PAGE,
    ORDERS_EMPTY,
    paymentTextOf,
    summarise,
    toGroupCard,
    nextCursor,
});
