import { ERROR_CATEGORIES, ErrorCategory } from '../../../core/error-category';
import { ERROR_CODES } from '../../../core/error-codes';
import { maintenanceMessageFor } from './bot-error-copy';
import { openSurfaceActionId, orderActionId } from './bot-action-id';
import { botChrome } from './bot-chrome-copy';
import { BotReplyOption } from './channel-reply';
import { supportFormActionId } from './bot-ticket-actions';

/**
 * THE WAY OUT of a refusal — the recovery half of every dead end (atlas phase 11).
 *
 * ── WHAT WAS ACTUALLY MISSING, WHICH IS NOT WHAT IT LOOKS LIKE ──────────────
 * The sentences were never the problem. `bot-error-copy.ts` already tells a customer *"That
 * button is no longer active"* and *"That list is no longer available… I will search again"*,
 * in five languages, and has for months. What no refusal on this surface has ever carried is a
 * **way to act on it**. Every one of those sentences invites the customer to do something —
 * and then hands them a chat window with nothing in it but their own keyboard.
 *
 * So this file adds no copy for the ordinary cases and rewords nothing. It decides, per
 * refusal, which of the buttons this surface *already has* can honestly be offered.
 *
 * ── ⛔ THE RULE, AND IT IS THE WHOLE DESIGN: NEVER A BUTTON THAT CANNOT WORK ─
 * A dead end with a button that does nothing is worse than a dead end, because the customer
 * spends a tap and their patience finding out. Two categories therefore get **no button at
 * all**, and that is the considered answer rather than an omission:
 *
 *   `validation` — the remedy is to retype. No button can retype for them.
 *   `rate_limit` — the remedy is to wait. A button is tapped immediately and fails again.
 *
 * ── ⛔ WHY THERE IS NO GENERIC "TRY AGAIN", although the copy key exists ────
 * `tryAgainButton` is in `bot-chrome-copy.ts` and this table deliberately never reaches for
 * it. **A retry button is honest only where the last action is repeatable from a token this
 * service minted**, and nothing here holds one: the tap dispatcher keeps no copy of the
 * request that failed, so a button built from this table would re-issue *nothing*. `pay:rt`
 * remains the only retry on the surface precisely because it carries the transaction id it
 * retries. The key stays — the notification catalogue draws it on messages that *do* carry
 * their own token — so if you came here to add it to a category, that is the reason not to.
 *
 * ── ⛔ A SECOND DELIBERATE BLANK: no "Bargain again" on the lock refusals ───
 * `BOT_BARGAIN_LOCK_*` genuinely deserves one, and it cannot come from here. The product and
 * variant ids it would need live in `error.details`, which the boundary strips for every
 * category outside 403/429 (`error-detail-policy.ts`) — so a button minted here would carry a
 * reference that resolves to nothing, which is the failure this file exists to prevent. The
 * discovery stream's own press handler offers it at the point where it still holds the ids.
 *
 * ── ⚠ EVERY ACTION HERE WORKS WITH `BOT_MINIAPP_BASE_URL` UNSET ─────────────
 * Which is production today, so this is a live constraint and not a hypothetical. All three
 * are **callback tokens, not URL buttons**, so they render identically either way — the
 * variable changes only what the handler does when tapped, and all three already degrade:
 * `open:pl` falls back to the storefront link, `ord:list` is drawn in chat and never opens a
 * screen at all, and `tkt:new` sets no reply by design and hands the turn to the model with
 * `supportRequest: true`. Anything added to this table must be checked the same way.
 */

/**
 * The three doors that are always open.
 *
 * ⚠ **Reused verbatim from the welcome message** (`bot-identity.controller.ts`), builders and
 * copy keys both, rather than minted here. That is what makes this whole phase cost zero new
 * verbs and zero new copy keys — and it means a customer who reaches a dead end is offered the
 * same three doors, with the same words, as one arriving for the first time.
 */
function browseAction(language: string | null): BotReplyOption {
    /**
     * ⚠ **`open:pl` with NO reference**, which is the form documented as "the whole shelf,
     * minted on the tap". A referenced listing would need a session handle — and the commonest
     * reason to be drawing this button is that a session handle just expired.
     */
    return { id: openSurfaceActionId('pl'), label: botChrome('browseProductsButton', language) };
}

function ordersAction(language: string | null): BotReplyOption {
    // `orderActionId('list')` rather than the literal `'ord:list'`, for the reason the welcome
    // message states: `list` is the orders stream's documented sentinel, and going through the
    // builder keeps the token inside `token()`'s 64-byte check.
    return { id: orderActionId('list'), label: botChrome('myOrdersButton', language) };
}

function helpAction(language: string | null): BotReplyOption {
    return { id: supportFormActionId(), label: botChrome('getHelpButton', language) };
}

/**
 * What a refusal should say, and what it should offer.
 *
 * `text` is the error's own sentence in all but one situation — see `maintenanceMessageFor`,
 * where the accurate sentence depends on a fact only the error's `details` carries.
 */
export interface BotRecovery {
    text: string;
    /** 0–2 buttons. Empty means no button could honestly work; see the rule above. */
    actions: readonly BotReplyOption[];
}

/**
 * The per-category doors, consulted only when no code-specific rule matched.
 *
 * ⚠ **Category is the FALLBACK, never the first question.** The same category covers codes
 * whose remedies differ completely — `not_found` holds both "that product is gone" (browse)
 * and "that order is gone" (orders) — so a code that knows better overrides below.
 */
const CATEGORY_ACTIONS: Readonly<
    Record<ErrorCategory, (language: string | null) => readonly BotReplyOption[]>
> = Object.freeze({
    /**
     * ⛔ **No button, and NOT for the obvious reason.** A suspended or closed account is
     * indeed unfixable by tapping — but the decisive fact is narrower and applies to every
     * door: **every bot route sits behind `requireBotIdentity`** (`bot.routes.ts`), and an
     * authentication refusal *is that guard refusing*. So a Get help button here would be
     * routed straight back into the guard that just said no, and the customer would spend a
     * tap to read the same sentence again. See `IDENTITY_GATE_CODES` below.
     */
    [ERROR_CATEGORIES.AUTHENTICATION]: () => [],
    /**
     * Reaching something that is not theirs — a resolved customer asking after somebody
     * else's order. Identity is intact here, so the help door genuinely opens; nothing is
     * retryable, and a human should look.
     */
    [ERROR_CATEGORIES.AUTHORIZATION]: (l) => [helpAction(l)],
    /** ⛔ No button — see the rule at the top. The remedy is to retype. */
    [ERROR_CATEGORIES.VALIDATION]: () => [],
    /** The thing is gone, so the useful offer is a different thing. */
    [ERROR_CATEGORIES.NOT_FOUND]: (l) => [browseAction(l)],
    /**
     * ⛔ No button, and this one is the least obvious of the three.
     *
     * A conflict means the state moved under the customer — a compare-and-set miss, a
     * duplicate. The remedy is to look at what the state *now* is, and this table cannot know
     * whether that is a cart, an order or a booking. Offering "My orders" to somebody whose
     * cart write lost a race sends them to the wrong screen with confidence.
     */
    [ERROR_CATEGORIES.CONFLICT]: () => [],
    /** Well-formed, permitted, refused by a rule. Repeating it fails identically. */
    [ERROR_CATEGORIES.BUSINESS_RULE]: (l) => [helpAction(l)],
    /** ⛔ No button — see the rule at the top. The remedy is to wait. */
    [ERROR_CATEGORIES.RATE_LIMIT]: () => [],
    /**
     * A provider failed. A retry is genuinely the right remedy and we cannot offer one — see
     * the "Try again" note at the top — so help is what is left.
     */
    [ERROR_CATEGORIES.EXTERNAL_SERVICE]: (l) => [helpAction(l)],
    /** Our bug. */
    [ERROR_CATEGORIES.INTERNAL]: (l) => [helpAction(l)],
});

/**
 * Codes whose remedy is more precise than their category's.
 *
 * Each entry exists because the category answer would be actively wrong, not merely vague.
 */
const CODE_ACTIONS: Readonly<
    Record<string, (language: string | null) => readonly BotReplyOption[]>
> = Object.freeze({
    /**
     * ⛔ **THE IDENTITY GATE'S OWN REFUSALS — no button, whatever their category says.**
     *
     * These three are raised **by `requireBotIdentity`**, and `bot.routes.ts` puts that guard
     * in front of *every* route on the surface. So every door this file can offer is behind
     * the thing that just refused: a button here would answer a dead end by walking the
     * customer into the same dead end, one tap later.
     *
     * ⚠ **They are listed BY CODE because their categories do not group them and one of them
     * is actively misleading.** `BOT_IDENTITY_UNRESOLVED` is raised at **404**
     * (`bot-identity.service.ts:210`), so it derives `not_found` — the one category whose
     * table entry offers Browse. Left to the category, the customer the platform could not
     * identify would be invited to go shopping, and the tap would fail identically.
     * `BOT_IDENTITY_NOT_CUSTOMER` is a 403 (`:216`, `:228`) and so derives `authorization`,
     * whose entry offers help — also behind the guard.
     *
     * ⚠ `BOT_IDENTITY_NEEDS_CONTACT` never reaches this table, because `errorReply` answers it
     * with the contact keyboard first. It is listed anyway: the day somebody reorders those
     * two branches, the belt is already on.
     */
    [ERROR_CODES.BOT_IDENTITY_UNRESOLVED]: () => [],
    [ERROR_CODES.BOT_IDENTITY_NOT_CUSTOMER]: () => [],
    [ERROR_CODES.BOT_IDENTITY_NEEDS_CONTACT]: () => [],
    /**
     * *Search again.* The copy already promises it; this is the button that keeps the promise.
     * `not_found` would have offered browse anyway — this entry is here so the pairing is
     * explicit rather than incidental, since the sentence names the remedy in words.
     */
    [ERROR_CODES.BOT_PRODUCT_LIST_EXPIRED]: (l) => [browseAction(l)],
    /**
     * A stale button. The customer has done nothing they can correct by repeating it, so both
     * doors are offered: a retired button is as often an order button as a product one, and
     * the token is unreadable by definition, so we cannot tell which.
     */
    [ERROR_CODES.BOT_ACTION_TOKEN_UNKNOWN]: (l) => [browseAction(l), ordersAction(l)],
    /**
     * ⛔ Deliberately NO button, matching its copy's own reasoning.
     *
     * One sentence serves checkout, orders, stores and the support form, and it says nothing
     * about which screen precisely because it cannot know. A Browse button would be wrong for
     * the customer whose *checkout* screen expired — and that is the one who can least afford
     * to be sent somewhere else. "Ask me again" stays the honest remedy.
     */
    [ERROR_CODES.BOT_SCREEN_SESSION_EXPIRED]: () => [],
});

/**
 * The maintenance window — the one refusal whose correct answer depends on which window it is.
 *
 * ⚠ **Read from `error.details.mode`, which survives the boundary only because this code is
 * categorised `business_rule`** (`error-detail-policy.ts` strips `details` wholesale for
 * `internal` and `external_service`, and allowlists keys for `authorization` and `rate_limit`).
 * That is a load-bearing dependency on another module's policy, so `test:dead-ends` asserts it
 * rather than trusting this comment — if the policy ever scrubs the key, the buttons would
 * become *wrong* rather than absent, which is the failure that would not announce itself.
 *
 * ⚠ **An unreadable mode is treated as a full stop**, which is the conservative direction: the
 * customer is told the shop is briefly closed and offered nothing, rather than offered a door
 * that answers 503.
 */
function maintenanceRecovery(
    details: Record<string, unknown> | undefined,
    language: string | null,
): BotRecovery {
    const mode = details?.mode;
    const readonly = mode === 'readonly';

    return {
        text: maintenanceMessageFor(readonly ? 'readonly' : 'down', language),
        /**
         * In a read-only window the bot's READ routes are exempt (`maintenance-mode.ts`), so
         * browsing and looking at orders genuinely still work and these two buttons are true.
         * In a full stop nothing does, and every button would 503 — so there is none.
         */
        actions: readonly ? [browseAction(language), ordersAction(language)] : [],
    };
}

/**
 * Decide the sentence and the buttons for one refusal.
 *
 * Pure: everything it needs is on the error envelope the boundary already built. That is what
 * lets `test:dead-ends` drive the whole table with no database, no server and no clock.
 */
export function recoveryFor(input: {
    code: string | null;
    category: string | null;
    details: Record<string, unknown> | undefined;
    /** The error's own customer sentence — kept unless a situation needs a more precise one. */
    text: string;
    language: string | null;
}): BotRecovery {
    if (input.code === ERROR_CODES.SYSTEM_MAINTENANCE_ACTIVE) {
        return maintenanceRecovery(input.details, input.language);
    }

    const byCode = input.code ? CODE_ACTIONS[input.code] : undefined;
    if (byCode) return { text: input.text, actions: byCode(input.language) };

    const byCategory = input.category
        ? CATEGORY_ACTIONS[input.category as ErrorCategory]
        : undefined;

    /**
     * ⚠ **An unknown category yields NO buttons, not a default door.** A category this file
     * does not recognise means the taxonomy moved under it, and guessing a remedy for a
     * refusal we cannot classify is exactly how a button that cannot work gets drawn.
     */
    return { text: input.text, actions: byCategory ? byCategory(input.language) : [] };
}
