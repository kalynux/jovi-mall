import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { sendSuccess } from '../../../core/responses';
import { paymentMethodService } from '../../payment-methods/services/payment-method.service';
import { botCallerOf, botResponseLanguageOf } from '../middlewares/bot-identity.middleware';
import { windowForChat } from '../domain/bot-list-window';
import { toBotPaymentMethodDto } from '../dto/bot-projections';
import { setBotReply } from '../middlewares/bot-reply.middleware';
import { botChrome } from '../domain/bot-chrome-copy';
import { unknownBotAction } from '../domain/bot-action-dispatch';
import {
    parseSavedItemAction,
    setSavedItemReply,
    setSavedListReply,
    type SavedListRow,
} from '../domain/bot-saved-list-reply';
import {
    BotNoArgsSchema,
    BotPaymentMethodAddSchema,
    BotPaymentMethodParamSchema,
} from '../validators/bot.validators';

import { providerForSavedWallet } from '../../payments/domain/payment-provider';

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
 * A saved wallet IS a phone number: the customer API stores the E.164 value in
 * `phone_number` (legacy rows: `gateway_customer_id`) and returns it only masked. That rule is
 * inherited whole — this projection does not even carry the mask. A chat can name a wallet and set it as the default; it
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
            (a, b) => Number(b.isDefault) - Number(a.isDefault),
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
     * ⚠ **Wallets only**, as on every surface since 2026-09-30 (owner decision 1): no card is
     * saved anywhere until card payments exist.
     *
     * ⚠ **The INPUT is unchanged — `mtn_momo` / `orange_money` / `moov_money` — because the
     * live n8n MCP sends it.** What is STORED is the canonical form every other door writes
     * (`MTN` · `ORANGE` · `MOOV` + `phone_number`), through the one service, so this door also
     * gets the network check (`422 PAYMENT_PROVIDER_PHONE_MISMATCH`) and the composed label.
     *
     * ⚠ **The number is proven E.164 at the door**, by the platform's own `PhoneNumberSchema`
     * rather than by a check here. The stored value is what a gateway will later be asked to
     * debit, so a locally-formatted number saved today is a payment that fails at checkout
     * weeks later with nothing to point at.
     */
    static add = asyncHandler(async (req: Request, res: Response) => {
        const input = BotPaymentMethodAddSchema.parse(req.body ?? {});
        const caller = botCallerOf(req);

        // The enum admits only the three wallet names, each of which maps; the `!` states that.
        const method = await paymentMethodService.add('customer', caller.customerId, {
            provider: providerForSavedWallet(input.provider)!,
            // Already normalised and proven E.164 by `PhoneNumberSchema` at the door.
            phoneNumber: input.phoneNumber,
            isDefault: input.makeDefault ?? false,
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
        const sorted = [...methods].sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
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
            hasDefault: remaining.some((m) => m.isDefault),
        });
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// `acct:pay:…` — the saved ways to pay
// ─────────────────────────────────────────────────────────────────────────────

/** The saved methods, default first, projected for the shared list shape. */
async function paymentRows(customerId: string): Promise<SavedListRow[]> {
    const methods = await paymentMethodService.list('customer', customerId);

    return [...methods]
        .sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
        .map((m) => toBotPaymentMethodDto(m))
        .map((m) => ({
            id: m.id,
            title: m.label,
            detail: m.expires ? `${m.expires}${m.expired ? ' ⚠' : ''}` : null,
            isDefault: m.isDefault,
            /**
             * ⚠ **A card may be REMOVED but not made the default.** Only a legacy row can be a
             * card (none is saved since 2026-09-30) and card payments do not exist, so the
             * button's only outcome would be a customer discovering at the till that the thing
             * they just chose cannot pay. See `SavedListRow.mayBeDefault`.
             */
            mayBeDefault: m.type !== 'card',
        }));
}

/**
 * `acct:pay` · `acct:pay:<id>` · `acct:pay:<id>:def|rm`.
 *
 * The address book's twin, deliberately — same gestures, same stale-row rule, same silence on
 * an empty list. See `addressSection` for why each of those is what it is; the two sit two rows
 * apart in one menu and must not behave differently.
 */
export async function paymentSection(req: Request, res: Response, rest: string): Promise<void> {
    const caller = botCallerOf(req);
    const language = botResponseLanguageOf(req);
    const rows = await paymentRows(caller.customerId);

    if (rest === '') {
        if (rows.length > 0) setSavedListReply(req, language, 'pay', 'paymentMethodsPrompt', rows);
        sendSuccess(res, rows);
        return;
    }

    const parsed = parseSavedItemAction(rest);
    if (!parsed) throw unknownBotAction();

    const row = rows.find((r) => r.id === parsed.id);
    if (!row) {
        if (rows.length > 0) setSavedListReply(req, language, 'pay', 'paymentMethodsPrompt', rows);
        sendSuccess(res, rows);
        return;
    }

    if (parsed.op === null) {
        setSavedItemReply(req, language, 'pay', row);
        sendSuccess(res, row);
        return;
    }

    if (parsed.op === 'def') {
        /**
         * ⚠ **Re-checked here, not merely left off the keyboard.** `paymentRows` declines to
         * draw the button for a card; this declines to ACT on the token. A tap is a
         * string a client can send without ever having been drawn one, and the two together
         * are what make "a card cannot become the default" a property rather than a
         * rendering habit.
         */
        if (row.mayBeDefault === false) throw unknownBotAction();

        await paymentMethodService.setDefault('customer', caller.customerId, row.id);
        setBotReply(req, { kind: 'text', text: botChrome('defaultSet', language) });
        sendSuccess(res, await paymentRows(caller.customerId));
        return;
    }

    await paymentMethodService.remove('customer', caller.customerId, row.id);
    const remaining = await paymentRows(caller.customerId);
    setBotReply(req, { kind: 'text', text: botChrome('itemRemoved', language) });
    sendSuccess(res, {
        removed: true,
        remaining: remaining.length,
        hasDefault: remaining.some((m) => m.isDefault),
    });
}
