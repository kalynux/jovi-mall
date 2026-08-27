import { Request, Response } from 'express';
import { Types } from 'mongoose';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { sendSuccess } from '../../../core/responses';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { WhatsappService } from '../../whatsapp/whatsapp.service';
import { PaymentTransactionModel } from '../../payments/models/payment-transaction.model';
import { buildPayLinkUrl, payLinkTtlMinutes } from '../../payments/domain/pay-link';
import { payLinkService } from '../../payments/services/pay-link.service';
import { getCustomerNotificationHandler } from '../../notifications/customer-notification-event-consumer';
import { botCallerOf } from '../middlewares/bot-identity.middleware';
import { BotMessagingNotifySchema, BotNoArgsSchema } from '../validators/bot.validators';

const whatsappWindow = new WhatsappService();

/**
 * The automation layer's two proactive-messaging operations — GAP-012.
 *
 * ── THE ASYMMETRY THIS EXISTS FOR ────────────────────────────────────────────
 * WhatsApp permits a free-form message only inside a 24-hour service window opened by the
 * customer's own message. Outside it, only pre-approved templates send. **Telegram has no
 * equivalent**, so this is not symmetrical and must not be designed as if it were.
 *
 * Everything proactive the platform says to a customer already goes through the customer
 * notification stack, which has handled that split correctly since it shipped: inside the
 * window it sends free-form text with a CTA button, outside it it sends the approved
 * template. What was missing was not the machinery — it was that **a bot-registered
 * customer had no channel enabled at all** (fixed at registration; see
 * `bot-registration.service.ts`), and that the automation layer had no way to see the
 * window or to hand off a message it could not send itself.
 *
 * ── WHY `notify` IS NOT A "SEND A MESSAGE" ROUTE ─────────────────────────────
 * It takes a SITUATION from a closed set, never a body of text. Three consequences, and
 * each is the reason:
 *
 *   - **The copy stays in the catalog**, in five languages, beside every other thing this
 *     platform says to a customer. n8n has no copy table and no translator.
 *   - **A template exists for it.** A free-text route would be unable to send anything at
 *     all outside the window, which is the exact situation it would be reached in.
 *   - **It cannot become a marketing channel.** `ARCHITECTURE.md` § 12 lists proactive
 *     marketing as deliberately not built, and the `marketing` preference defaults to false
 *     and gates nothing yet. A route that relayed arbitrary text would make that decision
 *     unenforceable by anything except good intentions.
 */
export class BotMessagingController {
    /**
     * `POST /messaging/window` — may I still say something in my own words?
     *
     * The read a flow consults before deciding whether it can finish in chat, or has to end
     * with "we will message you" and hand off to `notify`.
     *
     * ⚠ **Telegram answers `open: true` forever, and `applicable: false` says why.** Two
     * fields rather than one, because "the window is open" and "there is no window" are
     * different facts and a caller that collapses them will eventually write a Telegram
     * flow around a deadline that does not exist. `expiresAt` is null there for the same
     * reason it is null on a closed WhatsApp window: there is no deadline to report.
     *
     * ⚠ **`expiresAt` is OUR window, not Meta's.** The platform tracks 23 hours against
     * Meta's 24 so free-form sends stop a safe margin early rather than racing the
     * boundary. Read it as "after this we switch to a template".
     */
    static window = asyncHandler(async (req: Request, res: Response) => {
        BotNoArgsSchema.parse(req.body ?? {});
        const caller = botCallerOf(req);

        if (caller.channel !== 'whatsapp') {
            sendSuccess(res, {
                channel: caller.channel,
                applicable: false,
                open: true,
                expiresAt: null,
                mustUseTemplate: false,
            });
            return;
        }

        const status = await whatsappWindow.windowStatus(caller.externalIdentity);
        sendSuccess(res, {
            channel: caller.channel,
            applicable: true,
            open: status.open,
            expiresAt: status.expiresAt?.toISOString() ?? null,
            mustUseTemplate: !status.open,
        });
    });

    /**
     * `POST /messaging/notify` — deliver one of a closed set of situations.
     *
     * ── THE SET HAS ONE MEMBER TODAY, AND THAT IS HONEST RATHER THAN THIN ────
     * `order.payment_link` is the only thing the automation layer knows that the platform
     * does not. Every other proactive message — the order shipped, the parcel is out for
     * delivery, the support request was answered — is the consequence of something the
     * platform did, so the platform raises it from its own event and n8n has no part in it.
     * Adding a second member is a deliberate act: a situation in the catalog, copy in five
     * languages, and a template approved in Business Manager.
     *
     * ── DELIVERY IS THE NOTIFICATION STACK'S, NOT THIS ROUTE'S ───────────────
     * It calls `notify()` and nothing else. That is what buys the in-app record, the push,
     * the customer's own language, the one-secondary-channel rule and — the part GAP-012 is
     * actually about — the free-form-vs-template branch. A second send path here would be a
     * second place to get the window rule wrong.
     *
     * ⚠ **`notify()` never throws**, by design: a notification failure must not fail the
     * business action that triggered it. So a 200 here means "accepted for delivery", NOT
     * "delivered" — the automation layer must not tell the customer a message was sent. The
     * refusals below are the things that CAN be decided synchronously, and they are all
     * about whether there is anything legitimate to send.
     *
     * ⚠⚠ **THIS IS THE FIRST ROUTE ON THIS SURFACE WHOSE SIDE EFFECT REACHES A PERSON AND
     * COSTS MONEY, AND NOTHING BOUNDS ITS RATE.** Every other bot route reads or writes the
     * customer's own records; this one sends them a WhatsApp message, which outside the
     * service window is a paid template conversation. `Idempotency-Key` makes a RETRY free —
     * the stored response is replayed and nothing is sent twice — but it does not bound a
     * LOOP: a workflow that mints a new key each pass sends a new message each pass, because
     * each mint produces a new token and therefore a new notification idempotency key.
     *
     * That is **GAP-006's** job (a per-messaging-identity limiter at this surface) and
     * GAP-006 is open. Until it lands, the bound is the two credentials and whatever the
     * automation layer does to itself. Worth knowing before adding a second situation here:
     * the set stays at one partly because one is easy to reason about.
     */
    static notify = asyncHandler(async (req: Request, res: Response) => {
        const input = BotMessagingNotifySchema.parse(req.body ?? {});
        const caller = botCallerOf(req);

        if (!Types.ObjectId.isValid(input.transactionId)) {
            throw createAppError(ERROR_CODES.PAYMENT_TRANSACTION_NOT_FOUND, 404, 'Transaction not found');
        }

        const transaction = await PaymentTransactionModel.findById(input.transactionId)
            .select('userId amountSnapshot currencySnapshot orderId orderIds cartId payLink')
            .lean();

        /**
         * Owner-scoped, and 404 rather than 403 — the same rule and the same reason as
         * `payment_get_transaction`: confirming that a transaction id exists is itself the
         * disclosure. Both ids are accepted because `userId` holds a CUSTOMER id on order
         * and cart payments and a USER id on booking ones.
         */
        const owner = transaction?.userId?.toString();
        if (!transaction || (owner !== caller.customerId && owner !== caller.userId)) {
            throw createAppError(ERROR_CODES.PAYMENT_TRANSACTION_NOT_FOUND, 404, 'Transaction not found');
        }

        /**
         * ⚠ **Checked BEFORE the mint, and the order is the point: minting REVOKES the
         * previous link.** `buildPayLinkUrl` returns null when `STOREFRONT_URL` is unset,
         * which is a legitimate deployment — one that takes only mobile money — and a
         * refusal raised after the mint would have destroyed a working link on its way to
         * failing. An error path must not mutate.
         *
         * Sending the notification anyway is the other wrong answer: it would put a button
         * pointing at a bare `pay/pl_…` in front of a customer. The refusal names the
         * condition instead, and the automation layer offers mobile money.
         */
        if (!buildPayLinkUrl('probe')) {
            throw createAppError(
                ERROR_CODES.PAYMENT_LINK_NOT_APPLICABLE,
                422,
                'This deployment has no payment page configured. Offer mobile money instead.',
            );
        }

        /**
         * ⚠ **A link is MINTED here rather than read off the transaction**, and that is the
         * decision worth stating. Reading an existing one would send whatever handle is
         * sitting on the row — possibly minted twenty-nine minutes ago, so the message
         * arrives with a link that dies in sixty seconds. Minting means the customer gets
         * the full window from the moment they are told.
         *
         * It also means this route inherits `mint`'s two refusals: a mobile-money
         * transaction (which needs no page at all) and one that is already settled or
         * closed (which must never be offered a fresh way to pay). Both are 422s naming the
         * reason, and both are the right answer to "message them about paying".
         */
        const link = await payLinkService.mint(input.transactionId);

        await getCustomerNotificationHandler().notify({
            situation: 'order.payment_link',
            customerId: caller.customerId,
            aggregateType: 'payment',
            aggregateId: input.transactionId,
            /**
             * Keyed on the TOKEN, not the transaction. A re-mint is a genuinely new thing to
             * tell somebody — the previous link no longer works — so keying on the
             * transaction would silently swallow every resend after the first, which is the
             * one case a customer asks for.
             */
            idempotencyKey: `customer.order.payment_link:${link.token}`,
            context: {
                payToken: link.token,
                orderNumber: await BotMessagingController.orderLabel(transaction),
                currency: transaction.currencySnapshot,
                amountFormatted: new Intl.NumberFormat('en-US').format(
                    Math.round(transaction.amountSnapshot),
                ),
                expiresInMinutes: String(payLinkTtlMinutes()),
            },
        });

        sendSuccess(res, {
            situation: input.situation,
            transactionId: input.transactionId,
            expiresAt: link.expiresAt.toISOString(),
        }, {
            // "Accepted", never "sent" — see the note above `notify()`'s throwing contract.
            message: 'The payment link is on its way to the customer.',
        });
    });

    /**
     * What to call this payment in the message.
     *
     * A cart payment settles SEVERAL orders, so there is no single order number to quote —
     * `{{orderNumber}}` becomes "your order" rather than one of them arbitrarily, which
     * would name a fraction of what the customer is paying for. A single-order payment
     * quotes its real number, because that is what the customer has in front of them.
     */
    private static async orderLabel(transaction: {
        orderId?: unknown;
        orderIds?: unknown[];
    }): Promise<string> {
        const single = transaction.orderId;
        if (!single || (Array.isArray(transaction.orderIds) && transaction.orderIds.length > 1)) {
            return 'your order';
        }

        // Lazily imported for the same reason the notification handler does it: the orders
        // module reaches back into this graph and a top-level import risks a require cycle.
        const { OrderModel } = await import('../../orders/order.model');
        const order = await OrderModel.findById(single).select('order_number').lean();
        return order?.order_number ?? 'your order';
    }
}
