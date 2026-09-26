/**
 * The bot surface's public surface (GAP-001).
 *
 * ── WHAT MAY BE IMPORTED FROM OUTSIDE, AND WHY THE LIST IS SHORT ────────────
 * Almost nothing. This module is a DOOR: it holds no domain of its own, every route
 * delegates to a service that already exists, and there is therefore nothing here another
 * module could legitimately want except the route table.
 *
 * The table is exported because `modules/system/domain/maintenance-mode.ts` genuinely
 * needs it — it decides which bot routes survive a `readonly` window, and the only honest
 * source for "which of these are reads" is the table the router mounts from. That import
 * is pure-to-pure by construction: `domain/bot-route-table.ts` imports nothing at all, so
 * a module that reads it does not acquire Express, Mongoose or forty controllers.
 *
 * ⚠ **The ROUTER is deliberately NOT re-exported**, for the reason
 * `channel-connections/index.ts` gives about its own: re-exporting a router puts the
 * Express controllers — and through them the cart, order, ticket, booking, review and
 * geocoding services — into the import graph of everything that touches this barrel.
 * `api/index.ts` imports `./bot.routes` directly. It is the one caller that wants a
 * router, and it is already an HTTP file.
 *
 * ⚠ **The two Redis stores are NOT exported either.** An idempotency record and a geo
 * candidate handle are meaningful only inside one request on this surface; a caller
 * outside it holding either would be a caller acting on a chat's behalf without going
 * through the door that resolves who the chat is.
 *
 * ⚠ **ONE store is now written from outside this module, by direct path and not through this
 * barrel** — `services/bot-recently-sent.store.ts`, by
 * `notifications/services/customer-notification-event-handler.service.ts`. It does not breach
 * the rule above, and the distinction is worth stating because the next person will read it as
 * one: that rule is about ACTING on a chat's behalf, and this caller acts on nobody's behalf —
 * it reports, after the fact, that it delivered a message to a chat it had already resolved a
 * connection for. It is also the only way that half of the record can exist at all: a
 * notification is dispatched by a background consumer that never touches this surface, so
 * nothing inside this module can see it happen. The import is by path because the barrel would
 * put forty controllers in a consumer's import graph; the store's own graph is Redis plus a
 * pure rules file.
 */

export {
    BOT_ROUTES,
    BOT_SURFACE_PREFIX,
    botRouteFor,
    isBotReadRequest,
    isBotSurfacePath,
} from './domain/bot-route-table';
export type { BotRouteMethod, BotRouteSpec } from './domain/bot-route-table';

/**
 * The customer-facing error copy (GAP-002).
 *
 * Exported for the same reason the route table is: a module outside this one genuinely
 * needs it. `api/middlewares/error-handler.middleware.ts` adds `error.customerMessage` to
 * every bot-surface failure, and `lifecycle.ts` runs the completeness assert at boot —
 * neither belongs to this module, and the copy cannot live in either of them, because the
 * decision "which sentence does a customer get for this code" is a property of the chat
 * surface rather than of the error system.
 *
 * Pure-to-pure again: this file imports the error codes and the categories and nothing
 * else, so the handler does not acquire a controller by reading it.
 */
export {
    assertBotErrorCopyComplete,
    BOT_COPY_LANGUAGES,
    customerMessageFor,
    toBotCopyLanguage,
} from './domain/bot-error-copy';
export type { BotCopyLanguage } from './domain/bot-error-copy';

/**
 * The chat-collection checklist (GAP-002).
 *
 * `customers/customer.model.ts` spreads the step and state vocabularies into its Mongoose
 * `enum` — the one-declaration rule every notification stack follows — so the model needs
 * this import and must not type the literals a second time.
 */
export {
    BOT_ONBOARDING_STATES,
    BOT_ONBOARDING_STEP_VALUES,
    BOT_ONBOARDING_STEPS,
    isOnboardingComplete,
    isOnboardingStep,
    isRequiredStep,
    nextOnboardingStep,
    normalizeOnboarding,
    outstandingRequired,
} from './domain/bot-onboarding';
export type {
    BotOnboardingNext,
    BotOnboardingRecord,
    BotOnboardingStep,
    BotOnboardingStepState,
} from './domain/bot-onboarding';

/**
 * The prompt copy, for the same reason the error copy is exported: `lifecycle.ts` runs its
 * completeness assert at boot, and that file belongs to nobody's module.
 */
export { assertBotOnboardingCopyComplete, onboardingPromptFor } from './domain/bot-onboarding-copy';
export type { BotOnboardingPrompt } from './domain/bot-onboarding-copy';

/**
 * The channel reply — the outbound message body this service composes for the automation
 * layer to POST unmodified.
 *
 * Exported for the same reason the copy tables are: `lifecycle.ts` runs the chrome
 * completeness assert at boot. Nothing outside this module RENDERS one —
 * `renderBotReply` is reached through `setBotReply` on `req`, so a controller elsewhere
 * cannot address a message at a conversation it is not already serving.
 */
export { assertBotChromeCopyFits, botChrome } from './domain/bot-chrome-copy';
export type { BotChromeKey } from './domain/bot-chrome-copy';
export type { BotChannelReply, BotReplyIntent, BotReplyOption } from './domain/channel-reply';

/**
 * The button-token vocabulary.
 *
 * ⚠ **The rule it encodes outlives the one verb in it today: an answer drawn from a set
 * known in advance is a BUTTON, never typed text.** A typed word has to be understood in
 * five languages by a layer that holds no copy table; a token comes back byte-identical
 * whatever the label said. Adding a verb means documenting its token → request-body mapping
 * in `api-doc/n8n/bot-surface.md` § 14 in the same change.
 */
export { BOT_ACTION_VERBS, skipActionId } from './domain/bot-action-id';
export type { BotActionVerb } from './domain/bot-action-id';

/**
 * Which purchase button a product gets — Bargain, Add to cart, Buy now or Book.
 *
 * ⚠ **Exported because FIVE surfaces ask this question and only one may answer it**: the chat
 * card, the in-app listing, the in-app detail screen, the slash-command answer and the
 * bargaining hand-off. Every rung mirrors a refusal `CartService.addToCart` already enforces,
 * so a second implementation is a second chance to offer a button that answers `400` — which
 * is the defect this replaces, found live on a bookable yoga class.
 *
 * Consumers render what they are handed and decide nothing.
 */
export { resolvePurchaseAffordance } from './domain/purchase-affordance';
export type {
    PurchaseAffordance,
    PurchaseAffordanceInput,
    PurchaseVerb,
} from './domain/purchase-affordance';

/**
 * The resolved-caller type, so a signature elsewhere can name it without reaching into a
 * service file. Nothing outside this module produces one — `botIdentityService.resolve` is
 * the only path, and it runs in this module's own middleware.
 */
export type { BotSenderReason, BotSenderState, ResolvedBotCaller } from './services/bot-identity.service';

/**
 * An administrator's reset of one customer's bot conversation memory
 * (`POST /api/internal/admin/users/:userId/bot-memory/reset`).
 *
 * ⚠ **Exported because the door is the users admin router, and the thing reset is this module's.**
 * The memory epoch is read by `/identity/sync` and the waiting-question store is this module's own,
 * so the write belongs here; `users/admin-user.controller.ts` only checks the user exists and calls
 * it. The store itself stays unexported — see the header.
 */
export { botMemoryService } from './services/bot-memory.service';
export type { BotMemoryResetResult } from './services/bot-memory.service';
