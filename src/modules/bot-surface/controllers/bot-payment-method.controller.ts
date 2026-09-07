import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { sendSuccess } from '../../../core/responses';
import { paymentMethodService } from '../../payment-methods/services/payment-method.service';
import { botCallerOf, botResponseLanguageOf } from '../middlewares/bot-identity.middleware';
import { windowForChat } from '../domain/bot-list-window';
import { toBotPaymentMethodDto } from '../dto/bot-projections';
import {
    BotNoArgsSchema,
    BotPaymentMethodAddSchema,
    BotPaymentMethodParamSchema,
} from '../validators/bot.validators';

/**
 * The label a saved wallet is known by, composed here rather than accepted.
 *
 * ⚠ Mirrors the storefront's own format — `"MTN Mobile Money · ••••4417"` — so a customer
 * who saved a wallet on the website and one who saved it in chat see the same wallet
 * described the same way. Two formats for one thing reads as two different wallets.
 */
const WALLET_LABELS: Readonly<Record<string, string>> = Object.freeze({
    mtn_momo: 'MTN Mobile Money',
    orange_money: 'Orange Money',
    moov_money: 'Moov Money',
});

/**
 * The customer's saved ways to pay.
 *
 * ── THESE SCOPE ON `customerId`, NOT `userId` ───────────────────────────────
 * `PaymentMethodController` reads its owner from `req.auth.role_entity._id`, which for a
 * customer is the `Customer` profile — the same id the cart, orders and addresses use, and
 * NOT the `users` row that bookings key on. The resolved bot caller carries both, so
 * neither has to be derived here.
 *
 * ── THE NUMBER NEVER COMES BACK ─────────────────────────────────────────────
 * A saved wallet IS a phone number: the customer API stores the E.164 value as both
 * `gateway_customer_id` and `gateway_instrument_id`, and returns neither on any endpoint.
 * That rule is inherited whole. A chat can name a wallet and set it as the default; it
 * cannot read the number out, and checkout asks for it again.
 */
export class BotPaymentMethodController {
    /**
     * `POST /payment-methods/list` — everything the customer has saved.
     *
     * ⚠ **Unpaginated underneath**, like `addresses_list`: the service answers the whole set
     * (capped at ten per owner by `MAX_METHODS_PER_OWNER`), so the chat window's slice IS
     * the cap here rather than a page boundary.
     *
     * ⚠ **The default is sorted first**, for the reason `addresses_list` does the same:
     * capping a stored-order list at five could drop the one method a chat answer is most
     * likely to be about, and the one checkout reaches for by itself.
     */
    static list = asyncHandler(async (req: Request, res: Response) => {
        BotNoArgsSchema.parse(req.body ?? {});
        const caller = botCallerOf(req);

        const methods = await paymentMethodService.list('customer', caller.customerId);
        const sorted = [...methods].sort(
            (a, b) => Number(b.is_default) - Number(a.is_default),
        );

        const chat = windowForChat({
            items: sorted.map((m) => toBotPaymentMethodDto(m)),
            total: sorted.length,
            surface: 'paymentMethods',
            language: botResponseLanguageOf(req),
        });

        sendSuccess(res, chat.items, { meta: { ...chat.window } });
    });

    /**
     * `POST /payment-methods` — save a mobile-money wallet.
     *
     * ⚠ **Wallets only. A card cannot be saved from a chat and this is not a policy
     * choice.** The customer API needs `gateway_customer_id` and `gateway_instrument_id`,
     * which for a card the payment gateway's SDK mints in a browser after the shopper types
     * a number the platform never sees. There is no chat equivalent, so a model asked for
     * those fields would invent them. For a wallet they are simply the phone number, twice.
     *
     * ⚠ **The number is proven E.164 at the door**, by the platform's own `PhoneNumberSchema`
     * rather than by a check here. The stored value is what a gateway will later be asked to
     * debit, so a locally-formatted number saved today is a payment that fails at checkout
     * weeks later with nothing to point at.
     */
    static add = asyncHandler(async (req: Request, res: Response) => {
        const input = BotPaymentMethodAddSchema.parse(req.body ?? {});
        const caller = botCallerOf(req);

        // Already normalised and proven E.164 by `PhoneNumberSchema`, so there is nothing
        // left to check here — the door did it, in the platform's own words.
        const e164 = input.phoneNumber;
        const last4 = e164.slice(-4);
        const network = WALLET_LABELS[input.provider] ?? 'Mobile money';

        const method = await paymentMethodService.add('customer', caller.customerId, {
            provider: input.provider,
            /**
             * ⚠ The same value twice, and that is the customer API's own shape rather than a
             * shortcut: for mobile money the customer and the instrument are one thing, and
             * `frontend/landing` sends it exactly this way.
             */
            gateway_customer_id: e164,
            gateway_instrument_id: e164,
            method_type: 'mobile_money',
            display_label: `${network} · ${last4.padStart(8, '•')}`,
            last4,
            brand: null,
            exp_month: null,
            exp_year: null,
            holder_name: null,
            is_default: input.makeDefault ?? false,
        });

        sendSuccess(res, toBotPaymentMethodDto(method), { status: 201 });
    });

    /**
     * `PATCH /payment-methods/:methodId/default` — the one checkout reaches for first.
     *
     * Answers the WHOLE list rather than the one row, for the reason `addresses_set_default`
     * does: setting a default clears the flag on every sibling, and a caller left holding
     * one updated row believes a stale list about the others.
     */
    static setDefault = asyncHandler(async (req: Request, res: Response) => {
        const { methodId } = BotPaymentMethodParamSchema.parse(req.params);
        BotNoArgsSchema.parse(req.body ?? {});
        const caller = botCallerOf(req);

        await paymentMethodService.setDefault('customer', caller.customerId, methodId);

        const methods = await paymentMethodService.list('customer', caller.customerId);
        const sorted = [...methods].sort((a, b) => Number(b.is_default) - Number(a.is_default));
        sendSuccess(res, sorted.map((m) => toBotPaymentMethodDto(m)));
    });

    /**
     * `DELETE /payment-methods/:methodId` — forget it.
     *
     * ⚠ **Removing the DEFAULT does not elect a replacement**, and that is the customer
     * API's behaviour rather than an omission here. The response reports whether one is
     * still set so a chat can say so, instead of the customer finding out at checkout —
     * the same shape `addresses_remove` settled on.
     */
    static remove = asyncHandler(async (req: Request, res: Response) => {
        const { methodId } = BotPaymentMethodParamSchema.parse(req.params);
        BotNoArgsSchema.parse(req.body ?? {});
        const caller = botCallerOf(req);

        await paymentMethodService.remove('customer', caller.customerId, methodId);

        const remaining = await paymentMethodService.list('customer', caller.customerId);
        sendSuccess(res, {
            removed: true,
            remaining: remaining.length,
            hasDefault: remaining.some((m) => m.is_default),
        });
    });
}
