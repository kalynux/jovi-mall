import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { sendSuccess } from '../../../core/responses';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
// The barrel, never a file inside it: that module's header makes `ConnectionMapper` the one
// way `external_id` may leave, and reaching past it is how a second way appears.
import { connectionService, ConnectionMapper } from '../../channel-connections';
import { AccountClosureService } from '../../users/account-closure.service';
import { AccountClosureRepository } from '../../users/account-closure.repository';
import { UserRepository } from '../../users/user.repository';
import { ERROR_CATEGORIES } from '../../../core/error-category';
import { botCallerOf, botResponseLanguageOf } from '../middlewares/bot-identity.middleware';
import { setBotReply } from '../middlewares/bot-reply.middleware';
import { botChrome } from '../domain/bot-chrome-copy';
import { customerMessageFor } from '../domain/bot-error-copy';
import { confirmActionId, declineActionId } from '../domain/bot-action-id';
import { unknownBotAction, type BotActionHandlers, type ParsedBotAction } from '../domain/bot-action-dispatch';
import { mintConfirmationRef, verifyConfirmationRef } from '../domain/bot-confirmation-ref';
import type { ResolvedBotCaller } from '../services/bot-identity.service';
import { toBotConnectionDto } from '../dto/bot-projections';
import { BotAccountCloseSchema, BotConnectionParamSchema, BotNoArgsSchema } from '../validators/bot.validators';
import { ACCOUNT_CLOSURE_CONFIRMATION } from '../../users/user.validator';

/**
 * The account itself — which messaging apps reach it, and closing it (MCP parity step 7).
 *
 * ── TWO READS ARE MODEL-FACING AND TWO WRITES ARE NOT ───────────────────────
 * `connections_list` and `account_close_preview` are `extended`; `connections_disconnect`
 * and `account_close` are `flow_only`. The split is the ordinary one for this surface, with
 * one thing worth naming: the PREVIEW of a closure is a read, and making it model-facing is
 * what lets a chat answer *"how do I delete my account?"* and *"can I?"* honestly — with the
 * real consequence and the real blockers — while the irreversible verb stays behind a flow.
 *
 * ── THE ONE RULE THIS FILE ADDS OVER THE CUSTOMER API ───────────────────────
 * A chat may not disconnect the channel it arrived on. Everything else here delegates
 * unchanged to the same services `/api/me/connections` and `/api/me/close` call.
 */

/**
 * Instantiated here, as `UserController` does — `AccountClosureService` exports no
 * singleton, and adding one for a second caller would be a change to that module made from
 * this one.
 */
const accountClosureService = new AccountClosureService();
const closureRepo = new AccountClosureRepository();
const userRepo = new UserRepository();

export class BotAccountController {
    /**
     * `POST /connections/list` — which messaging apps are bound to this account.
     *
     * ⚠ **Deliberately NOT windowed, and it is the third route on this surface with a
     * written exemption.** `CONNECTION_CHANNELS` has exactly two members and the response
     * always carries both — connected or not — so the set is closed at two, can never
     * exceed the five-row cap, and has nothing a "see the rest" link could point at. A
     * window here would be `hasMore: false` and `moreUrl: null` on every call for ever,
     * which is noise rather than a guarantee.
     *
     * ⚠ **`howToConnect` is dropped** and `isCurrentChannel` is added — see
     * `toBotConnectionDto` for both reasons.
     */
    static listConnections = asyncHandler(async (req: Request, res: Response) => {
        BotNoArgsSchema.parse(req.body ?? {});
        const caller = botCallerOf(req);

        const states = await connectionService.getStates(caller.userId);
        const dtos = ConnectionMapper.toDtoList(states).map((c) => toBotConnectionDto(c, caller.channel));

        sendSuccess(res, dtos);
    });

    /**
     * `DELETE /connections/:channel` — unbind a messaging app from the account.
     *
     * ⚠ **REFUSES the channel this request arrived on**, and that refusal is the whole
     * reason this route is not a straight relay. A `channel_connections` row is step 1 of
     * the identity ladder and wins outright, so cutting the current one leaves this surface
     * unable to resolve the sender it is mid-conversation with — and the remedy (send
     * `/connect` to the bot, then redeem the code while signed in) needs a session the
     * customer reaches from the storefront, not from the chat that has just gone anonymous.
     * A customer cannot undo this from where they did it, which is the property that makes
     * it worth refusing rather than warning about.
     *
     * ⚠ **The check is BEFORE the delegate call**, so a refusal changes nothing. The
     * ordering matters more than it looks: `disconnect` is not transactional and there is no
     * re-bind verb, so a refusal that arrived after the unbind would be a refusal reported
     * about something that had already happened.
     *
     * ⚠ **Disconnecting the OTHER channel stays permitted.** This is not a blanket guard on
     * the verb: a customer on WhatsApp removing their Telegram connection breaks nothing
     * they are using, and refusing it would make the tool useless on the one surface it is
     * reachable from.
     */
    static disconnect = asyncHandler(async (req: Request, res: Response) => {
        const { channel } = BotConnectionParamSchema.parse(req.params);
        BotNoArgsSchema.parse(req.body ?? {});
        const caller = botCallerOf(req);

        if (channel === caller.channel) {
            throw createAppError(ERROR_CODES.BOT_CONNECTION_ACTIVE_CHANNEL, 409, undefined, {
                channel,
            });
        }

        await connectionService.disconnect(caller.userId, channel);

        setBotReply(req, {
            kind: 'text',
            text: botChrome('connectionDisconnected', botResponseLanguageOf(req)),
        });
        sendSuccess(res, { disconnected: true, channel });
    });

    /**
     * `POST /account/close/preview` — what closing does, and whether it can be done.
     *
     * ── ⭐ WHY THIS ROUTE EXISTS AT ALL ─────────────────────────────────────
     * The plan asked for closure to be a **two-step confirmation** whose first step states
     * that orders are retained pseudonymously (ADR-A02 D-2). Neither half is deliverable
     * without a read:
     *
     *   - **The sentence.** The automation layer has no copy table and no translator — the
     *     argument that already put `error.customerMessage`, `onboarding.next.prompt` and
     *     the whole `reply` body on this side of the wire. Leaving the single most
     *     consequential sentence in the product to be composed by a flow is how a customer
     *     is told their orders will be deleted, in English, on the one turn that cannot be
     *     taken back. `botChrome('accountClosurePrompt')` is authored here, in five
     *     languages, and this route is how a flow gets it *before* it acts.
     *   - **The blockers.** `close` refuses a dual-role account and one with orders in
     *     flight. Discovering that by attempting the irreversible verb and reading a `422`
     *     is a poor way to find out — and worse, it happens *after* the customer has been
     *     asked to confirm.
     *
     * ⚠ **It is a READ, and it had to be a separate route rather than a no-argument branch
     * of `account_close`.** That row is `mutating`, so `botIdempotency` demands a key on it;
     * a preview and a close sharing one key would collide on the request fingerprint and
     * answer `BOT_IDEMPOTENCY_KEY_REUSED`, and a caller working around that by minting two
     * keys is a caller one mistake away from spending the close's key on the preview. A
     * non-mutating sibling has none of that.
     *
     * ⚠ **It is a deviation from the plan's "3 tools", taken deliberately** — the same shape
     * as Step 4's refusal of the lock/unlock pair. Recorded in `MCP-PARITY-PLAN.md`.
     *
     * ⚠ **The blockers are computed by the same repository calls `close` uses**, not by a
     * second reading of the rule. A preview that disagreed with the verb would be worse than
     * no preview: it would promise a closure that then refuses, or refuse one that would
     * have worked.
     */
    static closePreview = asyncHandler(async (req: Request, res: Response) => {
        BotNoArgsSchema.parse(req.body ?? {});
        const caller = botCallerOf(req);
        const language = botResponseLanguageOf(req);

        const preview = await readClosurePreview(caller, language);
        setClosureReply(req, caller, preview, language);
        sendSuccess(res, preview);
    });

    /**
     * `POST /account/close` — close and anonymise the caller's own account (ADR-A02 D-1).
     *
     * ⚠ **Irreversible, and nothing here pretends otherwise.** There is no un-close verb and
     * there cannot be one: the identifiers are removed, not archived.
     *
     * ── THE ACCOUNT IS ALWAYS THE CALLER'S ──────────────────────────────────
     * There is no id in the path and none accepted in the body — the schema is `.strict()`
     * — and both ids come from the resolved bot caller. This endpoint cannot be aimed at
     * anybody else, which is the same property `UserController.closeAccount` has and the
     * reason neither takes a subject.
     *
     * ⚠ **No cookies to clear, and no session to revoke, because this surface never minted
     * one.** The customer API's own handler calls `clearAuthCookies`; there is nothing here
     * to clear. What the closure DOES do that reaches this surface is delete the
     * `channel_connections` rows — so the sender that just closed their account becomes
     * unresolvable, and their next message resolves as a stranger. That is correct and is
     * why the `reply` below is the last thing the platform says to them.
     *
     * ⚠ **The role guard the customer API applies from `req.auth.role` has no counterpart
     * here and needs none**: every caller on this surface is a customer by construction. The
     * service's own `blockingRoles` refusal still runs and is the one that matters — it is
     * what catches a customer who is also a vendor.
     */
    static close = asyncHandler(async (req: Request, res: Response) => {
        BotAccountCloseSchema.parse(req.body ?? {});
        await closeAndReply(req, res, botCallerOf(req));
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Closure — the preview, the two buttons, and the tap that acts on them
// ─────────────────────────────────────────────────────────────────────────────

interface ClosurePreview {
    canClose: boolean;
    /** Roles beyond `customer`. Non-empty means closure is refused outright. */
    blockingRoles: string[];
    /** Orders still moving. Closure waits until this is zero. */
    activeOrderCount: number;
    /** The sentence the customer must read before confirming, localised. */
    consequence: string;
    /**
     * The token a flow sends back on `account_close`. Untranslated on purpose — it is an id,
     * not a sentence. Kept for callers already using the literal path; the buttons below do
     * not use it.
     */
    confirmWith: string;
}

/**
 * ⚠ **The blockers are computed by the same repository calls `close` uses**, not by a second
 * reading of the rule. A preview that disagreed with the verb would be worse than no preview:
 * it would promise a closure that then refuses, or refuse one that would have worked.
 */
async function readClosurePreview(caller: ResolvedBotCaller, language: string | null): Promise<ClosurePreview> {
    const user = await userRepo.findById(caller.userId);
    if (!user) throw createAppError(ERROR_CODES.USER_NOT_FOUND, 404);

    const blockingRoles = (user.roles ?? []).filter((role) => role !== 'customer');
    const activeOrderCount = await closureRepo.countActiveOrders(caller.customerId);

    return {
        canClose: blockingRoles.length === 0 && activeOrderCount === 0,
        blockingRoles,
        activeOrderCount,
        consequence: botChrome('accountClosurePrompt', language),
        confirmWith: ACCOUNT_CLOSURE_CONFIRMATION,
    };
}

/**
 * ⭐ **The preview SPEAKS now, and carries the two buttons** — which reverses this route's
 * original "data, not reply" rule, for the reason the atlas gave: the most consequential action
 * on the surface had no Confirm button, so whatever sat in front of it had to improvise one out
 * of what the customer typed.
 *
 * ⚠ **"Keep my account" comes FIRST, and carries no reference.** It is the answer that costs
 * nothing, so it is the one nearest the thumb; declining needs no protection, and refusing a
 * stale decline would refuse the one answer that is always safe.
 *
 * ⚠ **The confirm carries a reference** (`bot-confirmation-ref.ts`) bound to this account, this
 * conversation's channel and ten minutes. A button scrolled past three weeks ago cannot close
 * anything.
 *
 * ⚠ **When closure is not possible there are NO buttons** — the sentence says why, using the
 * very refusal copy `close` would raise, so the preview and the verb cannot tell a customer two
 * different things.
 *
 * ⚠ Reaches the customer on the FLOW paths only (a tap, a command). When the model calls
 * `account_close_preview` over MCP the reply lands in its context and is not sent — the n8n gap
 * recorded as A5. Setting it here anyway means that path lights up with no second change.
 */
function setClosureReply(
    req: Request,
    caller: ResolvedBotCaller,
    preview: ClosurePreview,
    language: string | null,
): void {
    if (!preview.canClose) {
        const code = preview.blockingRoles.length > 0
            ? ERROR_CODES.ACCOUNT_CLOSURE_ROLE_NOT_ELIGIBLE
            : ERROR_CODES.ACCOUNT_CLOSURE_ORDERS_IN_FLIGHT;
        setBotReply(req, {
            kind: 'text',
            text: customerMessageFor(code, ERROR_CATEGORIES.BUSINESS_RULE, language),
        });
        return;
    }

    const ref = mintConfirmationRef('close', { userId: caller.userId, channel: caller.channel });
    setBotReply(req, {
        kind: 'text',
        text: preview.consequence,
        actions: [
            { id: declineActionId('close'), label: botChrome('declineButton', language) },
            { id: confirmActionId(`close:${ref}`), label: botChrome('confirmButton', language) },
        ],
    });
}

/**
 * The irreversible part, shared by the literal-confirm route and the button.
 *
 * `AccountClosureService.close` re-checks both blockers inside its own transaction, so a tap
 * that arrives after an order was placed is refused there, with its own customer sentence.
 */
async function closeAndReply(req: Request, res: Response, caller: ResolvedBotCaller): Promise<void> {
    /**
     * Read the language BEFORE the closure. `botResponseLanguageOf` reads what the identity
     * middleware stamped, so it survives — but the profile it was read from is about to be
     * anonymised, and depending on a value that is being deleted in the same request is a
     * dependency worth not having.
     */
    const language = botResponseLanguageOf(req);

    const { closedAt } = await accountClosureService.close(caller.userId, caller.customerId);

    setBotReply(req, { kind: 'text', text: botChrome('accountClosed', language) });
    sendSuccess(res, { closed: true, closedAt });
}

/**
 * `yes:close:<ref>` — the Confirm button.
 *
 * ⚠ **A stale or unverifiable reference ASKS AGAIN rather than refusing.** The customer who
 * tapped is the account's own conversation (the dispatcher resolved them), and they could get
 * a fresh confirm by asking; answering with the consequence and new buttons is that, one step
 * shorter, and it re-states what the tap would do before anything happens.
 */
async function confirmCloseTap(req: Request, res: Response, action: ParsedBotAction): Promise<void> {
    const caller = botCallerOf(req);
    const verdict = verifyConfirmationRef(action.argument, 'close', {
        userId: caller.userId,
        channel: caller.channel,
    });

    if (verdict !== 'valid') {
        const language = botResponseLanguageOf(req);
        const preview = await readClosurePreview(caller, language);
        setClosureReply(req, caller, preview, language);
        sendSuccess(res, { closed: false, confirmation: verdict, ...preview });
        return;
    }

    await closeAndReply(req, res, caller);
}

/** `no:close` — Keep my account. Changes nothing, whenever it is tapped. */
async function keepAccountTap(req: Request, res: Response, action: ParsedBotAction): Promise<void> {
    botCallerOf(req);
    if (action.argument !== '') throw unknownBotAction();
    sendSuccess(res, { closed: false, kept: true });
}

/**
 * The keys this stream answers, for the dispatcher's registry. Exported as a map, never
 * registered from here — see `bot-action.controller.ts`.
 */
export const ACCOUNT_ACTION_HANDLERS: BotActionHandlers = Object.freeze({
    'yes:close': confirmCloseTap,
    'no:close': keepAccountTap,
});
