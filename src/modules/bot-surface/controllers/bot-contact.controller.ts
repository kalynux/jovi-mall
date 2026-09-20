import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { sendSuccess } from '../../../core/responses';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { contactChangeService } from '../../users/services/contact-change.service';
import { botCallerOf, botResponseLanguageOf } from '../middlewares/bot-identity.middleware';
import { setBotReply } from '../middlewares/bot-reply.middleware';
import { botChrome } from '../domain/bot-chrome-copy';
import { accountActionId } from '../domain/bot-action-id';
import { unknownBotAction } from '../domain/bot-action-dispatch';
import { resendWaitSeconds } from '../domain/bot-resend-cooldown';
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

/**
 * The buttons that belong under a pending change — and the reason they are not symmetric.
 *
 * ⚠ **Only an email change can be re-sent, because only an email change SENDS anything.** A
 * phone change is proved by connecting that number on WhatsApp (see `changePhone`); there is
 * no code, no link and no message, so a "Send it again" button on it would be a control that
 * can do nothing whatever it is wired to. It is left off rather than wired to a no-op.
 */
function pendingChangeActions(field: 'email' | 'phone', language: string | null) {
    const cancel = {
        id: accountActionId('contact', field === 'email' ? 'em' : 'ph', 'cancel'),
        label: botChrome('cancelChangeButton', language),
    };
    if (field === 'phone') return [cancel];

    return [
        { id: accountActionId('contact', 'em', 'resend'), label: botChrome('resendCodeButton', language) },
        cancel,
    ];
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

        /**
         * ⚠ **A reply ONLY when there is a control to offer.** A pending change is the one
         * state this read can do something about, so it repeats the sentence that opened the
         * change and puts Cancel — and, for an email, Send it again — under it. With nothing
         * pending there is no button worth drawing, and a rendered sentence would be a second
         * narration of a state the model already has the data for and describes better in the
         * conversation it is having. See § 14.3's rule for the basket, which is the same one.
         */
        const language = botResponseLanguageOf(req);
        if (state.pendingEmail) {
            setBotReply(req, {
                kind: 'text',
                text: botChrome('contactEmailChangeStarted', language),
                actions: pendingChangeActions('email', language),
            });
        } else if (state.pendingPhone) {
            setBotReply(req, {
                kind: 'text',
                text: botChrome('contactPhoneChangeStarted', language),
                actions: pendingChangeActions('phone', language),
            });
        }

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

        const language = botResponseLanguageOf(req);
        setBotReply(req, {
            kind: 'text',
            text: botChrome('contactEmailChangeStarted', language),
            actions: pendingChangeActions('email', language),
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

        const language = botResponseLanguageOf(req);
        setBotReply(req, {
            kind: 'text',
            text: botChrome('contactPhoneChangeStarted', language),
            actions: pendingChangeActions('phone', language),
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

// ─────────────────────────────────────────────────────────────────────────────
// `acct:contact:…` — the taps under a pending change
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `acct:contact:em:resend` — send the confirmation link again.
 *
 * ⚠ **A resend is the SAME request repeated**, not a new verb: `requestEmailChange` replaces
 * the pending block against the same address, which mints a new token and invalidates the old
 * link. That is what a customer means by "it did not arrive" — and it is why the old link
 * stopping is correct rather than a side effect: two live links racing is the state that
 * produces "I clicked it and it said expired".
 *
 * ⚠ **The target comes from the STORED pending block, never from the tap.** The token carries
 * no address — an address in a tappable button is an address anybody who can craft a token can
 * point a confirmation link at.
 */
async function resendEmailTap(req: Request, res: Response): Promise<void> {
    const caller = botCallerOf(req);
    const language = botResponseLanguageOf(req);

    const state = await contactChangeService.getState(caller.userId);
    const pending = state.pendingEmail;

    /**
     * Nothing is waiting — the change was completed or cancelled since this button was drawn.
     * ⚠ **Answered with the CURRENT state rather than with a refusal**, and deliberately with
     * no sentence of our own: "that was cancelled" would be a lie if it had in fact succeeded,
     * and this surface cannot tell the two apart after the fact. The model has the state and
     * says the true thing. Same rule as a stale Skip in onboarding: a button that was true when
     * it was drawn is answered, not scolded.
     */
    if (!pending) {
        sendSuccess(res, toBotContactState(state, null));
        return;
    }

    const wait = resendWaitSeconds(pending.requestedAt, new Date());
    if (wait > 0) {
        throw createAppError(ERROR_CODES.BOT_CONTACT_CODE_RESEND_TOO_SOON, 429, undefined, {
            retryAfterSeconds: wait,
        });
    }

    const reissued = await contactChangeService.requestEmailChange(botActorOf(req), pending.target);

    setBotReply(req, {
        kind: 'text',
        text: botChrome('contactCodeResent', language),
        actions: pendingChangeActions('email', language),
    });
    sendSuccess(res, { target: reissued.target, expiresAt: reissued.expiresAt });
}

/** `acct:contact:em|ph:cancel` — abandon the change. Reversible, so no confirmation. */
async function cancelChangeTap(req: Request, res: Response, field: 'email' | 'phone'): Promise<void> {
    const caller = botCallerOf(req);

    const state = await contactChangeService.getState(caller.userId);
    const pending = field === 'email' ? state.pendingEmail : state.pendingPhone;

    // As above: a stale Cancel on a change that is already gone reports the state, not an error.
    if (!pending) {
        sendSuccess(res, toBotContactState(state, null));
        return;
    }

    await contactChangeService.cancelPending(botActorOf(req), field);

    setBotReply(req, {
        kind: 'text',
        text: botChrome('contactChangeCancelled', botResponseLanguageOf(req)),
    });
    sendSuccess(res, { cancelled: true, field });
}

/**
 * `acct:contact:<em|ph>:<resend|cancel>`, routed.
 *
 * ⚠ **`ph:resend` is not a missing branch, it is a refused one.** Nothing is ever sent for a
 * phone change, so the pair is deliberately incomplete and an unknown combination gets the one
 * unknown-token answer rather than a silent no-op that looks like it worked.
 */
export async function contactSection(req: Request, res: Response, rest: string): Promise<void> {
    switch (rest) {
        case 'em:resend':
            await resendEmailTap(req, res);
            return;
        case 'em:cancel':
            await cancelChangeTap(req, res, 'email');
            return;
        case 'ph:cancel':
            await cancelChangeTap(req, res, 'phone');
            return;
        default:
            throw unknownBotAction();
    }
}
