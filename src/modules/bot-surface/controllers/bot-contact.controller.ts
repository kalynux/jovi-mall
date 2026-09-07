import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { sendSuccess } from '../../../core/responses';
import { contactChangeService } from '../../users/services/contact-change.service';
import { botCallerOf, botResponseLanguageOf } from '../middlewares/bot-identity.middleware';
import { setBotReply } from '../middlewares/bot-reply.middleware';
import { botChrome } from '../domain/bot-chrome-copy';
import { maskPhone, toBotContactState } from '../dto/bot-projections';
import {
    BotContactEmailSchema,
    BotContactPhoneSchema,
    BotNoArgsSchema,
} from '../validators/bot.validators';

/**
 * Changing what the account signs in with, from a chat (MCP parity step 6).
 *
 * ── ONE READ IS MODEL-FACING AND FIVE WRITES ARE NOT ────────────────────────
 * `contact_get_state` is `extended`; the five writes below are all `flow_only`, which is
 * the same boundary every address and payment-method write already sits behind. The reason
 * is not that they are rare or fiddly: each one MOVES OR ABANDONS THE IDENTIFIER
 * `POST /auth/login` resolves the account by, and the two failure directions are the same
 * from the customer's side — *"I cannot get in and I do not know why"*. A model that starts
 * a change off a half-understood sentence and a model that cancels one off *"I did not get
 * the email"* both produce it, so neither verb is handed over.
 *
 * ⚠ **The cancels are flow_only too, and that is a decision rather than a copy-paste.** A
 * cancel destroys nothing durable — the customer simply starts again — so it looks like the
 * safe one to expose. It is not: cancelling invalidates a link that is already sitting in a
 * mail client, so the customer's next action (opening it) fails for a reason the chat never
 * mentioned.
 *
 * ── EVERYTHING DELEGATES; THE ACTOR IS BUILT, NEVER READ ────────────────────
 * `ContactChangeController` resolves its actor from `req.auth`, which does not exist here.
 * `botActorOf` builds the same shape from the RESOLVED bot caller — never from a body — so
 * the service below cannot tell which door a request came through, and the identity rule
 * this surface is built on holds unchanged.
 *
 * ⚠ **`role` is the literal `'customer'`, and it is load-bearing rather than filler.** It
 * travels into `buildEmailChangeLink` as the `app=` parameter that tells the confirmation
 * page where to send the person afterwards. Every caller of this surface is a customer by
 * construction (`requiresCustomerRole` on all six rows), so the literal is true — but it is
 * a value with a consequence, not a placeholder.
 */

/** The actor shape `ContactChangeService` wants, from the resolved bot caller. */
function botActorOf(req: Request): { userId: string; role: string; roleEntityId: string } {
    const caller = botCallerOf(req);
    return { userId: caller.userId, role: 'customer', roleEntityId: caller.customerId };
}

export class BotContactController {
    /**
     * `POST /contact` — what the account signs in with, and what is in flight.
     *
     * ⚠ **It answers a THIRD thing the customer API does not: whether a pending phone
     * change can be completed from here at all.** The proof the platform accepts is a
     * WhatsApp connection whose identity IS the pending number, so a customer on Telegram —
     * or on WhatsApp from their old number — is holding a request they cannot finish, and
     * the only signal `GET /api/me/contact` gives them is silence followed by a `422` when
     * they try. `phoneChangeProved` turns that into something a chat can say up front.
     *
     * The predicate is `ContactChangeService.isPhoneChangeProved`, called rather than
     * re-derived: the WhatsApp `external_id` arrives as bare digits while a login phone is
     * strict E.164, and a second copy of that comparison is the single easiest way to ship
     * this reading `false` for everybody while looking correct.
     */
    static getState = asyncHandler(async (req: Request, res: Response) => {
        BotNoArgsSchema.parse(req.body ?? {});
        const caller = botCallerOf(req);

        const state = await contactChangeService.getState(caller.userId);
        const proved = state.pendingPhone
            ? await contactChangeService.isPhoneChangeProved(caller.userId, state.pendingPhone.target)
            : null;

        sendSuccess(res, toBotContactState(state, proved));
    });

    /**
     * `PATCH /contact/email` — open a change of login email.
     *
     * Writes a pending block and sends a link to the NEW address; `login_email` does not
     * move until that link is opened, on a storefront page this surface has no part in.
     * The `reply` says so, because a customer who is not told it will believe the change
     * has already happened and read the old address still working as a fault.
     *
     * ⚠ **A second request supersedes the first** — the service replaces the pending block,
     * which invalidates the previous token. That is the right behaviour for the mistyped
     * address a chat produces most often, and it means "just tell me the address again" is
     * a complete recovery with no cancel in between.
     */
    static changeEmail = asyncHandler(async (req: Request, res: Response) => {
        const { email } = BotContactEmailSchema.parse(req.body ?? {});
        const pending = await contactChangeService.requestEmailChange(botActorOf(req), email);

        setBotReply(req, {
            kind: 'text',
            text: botChrome('contactEmailChangeStarted', botResponseLanguageOf(req)),
        });
        sendSuccess(res, { target: pending.target, expiresAt: pending.expiresAt });
    });

    /** `DELETE /contact/email/pending` — abandon a change of email. */
    static cancelEmailChange = asyncHandler(async (req: Request, res: Response) => {
        BotNoArgsSchema.parse(req.body ?? {});
        await contactChangeService.cancelPending(botActorOf(req), 'email');

        setBotReply(req, {
            kind: 'text',
            text: botChrome('contactChangeCancelled', botResponseLanguageOf(req)),
        });
        sendSuccess(res, { cancelled: true });
    });

    /**
     * `PATCH /contact/phone` — open a change of login phone.
     *
     * ⚠ **This is the row the plan flagged, and the flag is only half right.** Changing the
     * login phone was expected to be able to orphan the conversation, because WhatsApp
     * identity resolution falls back to `login_phone`. It cannot, for an already-bound
     * sender: `channel_connections` is step 1 of the ladder and wins outright, so the
     * binding survives the identifier moving underneath it.
     *
     * ⚠ **What is true, and is the sharper constraint, is that the change usually cannot be
     * FINISHED from the chat it was started in.** The proof is a WhatsApp connection whose
     * identity IS the new number, and an account holds at most one WhatsApp connection —
     * so a customer whose WhatsApp is bound to the OLD number must disconnect it and
     * reconnect from the new one, and a customer on Telegram must connect WhatsApp for the
     * first time. The `reply` states the path; `contact_get_state.phoneChangeProved` reports
     * whether they have walked it yet.
     *
     * ⚠ **Nothing here refuses the request on that ground**, deliberately. Opening a pending
     * change is harmless and reversible, the customer may well be about to go and connect
     * the number, and a door that refused would make the flow unreachable for the exact
     * person it is for.
     */
    static changePhone = asyncHandler(async (req: Request, res: Response) => {
        const { phone } = BotContactPhoneSchema.parse(req.body ?? {});
        const pending = await contactChangeService.requestPhoneChange(botActorOf(req), phone);

        setBotReply(req, {
            kind: 'text',
            text: botChrome('contactPhoneChangeStarted', botResponseLanguageOf(req)),
        });
        sendSuccess(res, { target: pending.target, expiresAt: pending.expiresAt });
    });

    /**
     * `POST /contact/phone/confirm` — complete the change, once the number is proved.
     *
     * Takes no arguments: the pending block names the number and the caller's own account
     * carries the proof. A caller that has not connected the new number gets
     * `422 CONTACT_CHANGE_PHONE_UNPROVEN`, whose customer copy names the remedy rather than
     * inviting a retry.
     */
    static confirmPhone = asyncHandler(async (req: Request, res: Response) => {
        BotNoArgsSchema.parse(req.body ?? {});
        const result = await contactChangeService.confirmPhoneChange(botActorOf(req));

        setBotReply(req, {
            kind: 'text',
            text: botChrome('contactPhoneChanged', botResponseLanguageOf(req)),
        });
        /**
         * ⚠ **Masked on the way out**, unlike the pending target above. The number is now
         * the account's own identifier rather than a value the customer typed a moment ago
         * to be checked, so `toBotProfileSummary`'s rule applies to it again.
         */
        sendSuccess(res, { phoneChanged: true, phoneMasked: maskPhone(result.phone) });
    });

    /** `DELETE /contact/phone/pending` — abandon a change of phone. */
    static cancelPhoneChange = asyncHandler(async (req: Request, res: Response) => {
        BotNoArgsSchema.parse(req.body ?? {});
        await contactChangeService.cancelPending(botActorOf(req), 'phone');

        setBotReply(req, {
            kind: 'text',
            text: botChrome('contactChangeCancelled', botResponseLanguageOf(req)),
        });
        sendSuccess(res, { cancelled: true });
    });
}
