import { MessagingChannel } from '../../channel-connections';
import { escapeTelegramHtml } from '../../../core/richtext';
import { WA_LIMITS, truncate } from '../../whatsapp/constants/whatsapp-limits';
import type { BotProductCard } from './product-card';

/**
 * The messaging-platform request body this service wants sent to the customer.
 *
 * ── WHAT CHANGED, AND WHY IT IS THE BACKEND'S JOB NOW ───────────────────────
 * `api-doc/n8n/ARCHITECTURE.md` put a "PLATFORM RENDERER" in n8n and called it *"the ONLY
 * place platform-specific code lives"*. In practice that layer relays; it does not render.
 * It has no copy table, no translator and no way to know that WhatsApp caps a reply-button
 * title at twenty characters — so every rendering decision it was handed came back as
 * either an English string in a French conversation or a control that arrives malformed.
 *
 * The product owner settled it on 2026-08-26: **this service composes the outbound request
 * body, and the automation layer POSTs it unmodified.** The chain of custody for a sentence
 * is now unbroken — the code, the category, the customer's language, the channel's limits
 * and the widget are all known in one place, which is here.
 *
 * ── `method` IS A PATH SEGMENT, NOT AN HTTP VERB ────────────────────────────
 * It is appended to whatever base URL the automation layer has configured for the channel:
 *
 *   telegram   `https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>` + `/sendMessage`
 *   whatsapp   `https://graph.facebook.com/v26.0/<PHONE_NUMBER_ID>` + `/messages`
 *
 * Naming the segment rather than the whole URL is deliberate and is the reason no token,
 * phone-number id or API version appears in any response body. **A credential this service
 * holds must not travel through a webhook response**, and the base URL is where all three
 * of those live. It also means a Telegram turn that needs `sendPhoto` or
 * `answerCallbackQuery` is a new value in this field rather than a new branch in n8n.
 *
 * ── IT IS ALWAYS A POST WITH A JSON BODY ────────────────────────────────────
 * True of both platforms for every method this renderer emits, so the verb is not carried:
 * a field that is a constant is a field that eventually disagrees with the constant.
 */
export interface BotChannelReply {
    /** Which platform this body is for. Decides the base URL the caller appends to. */
    channel: MessagingChannel;
    /** The path segment to append to that base URL. Always POSTed, always JSON. */
    method: string;
    /** The request body, verbatim. Send it unmodified. */
    body: Record<string, unknown>;
}

/**
 * One option in a picker.
 *
 * `id` round-trips: Telegram returns it as `callback_query.data`, WhatsApp as
 * `interactive.list_reply.id` or `button_reply.id`. Whatever the caller must post back to
 * this service goes here, which is what keeps the automation layer STATELESS across the
 * turn — it never has to remember what row 2 was.
 */
export interface BotReplyOption {
    id: string;
    /** The full text of the option. Telegram shows this; it has room for it. */
    label: string;
    /**
     * A shorter form for channels that cap a control's title hard.
     *
     * ⚠ **This exists because the two platforms are not merely different sizes, they are
     * different SHAPES.** A Telegram inline button is one 64-character row and an address
     * fits; a WhatsApp list row is a 24-character *title* plus a 72-character
     * *description*, so feeding it one long string produces `Akwa, Douala I, Wour…` as the
     * heading with nothing under it. Naming the short form lets the WhatsApp renderer put
     * the distinguishing part in the title and the whole address in the description, while
     * Telegram keeps the full label. Falls back to `label` when absent.
     */
    shortLabel?: string | null;
    /** Rendered only where the channel has somewhere to put it (a WhatsApp list row). */
    description?: string | null;
}

/**
 * WHAT to say, described once, channel-neutrally.
 *
 * The intents are deliberately few and none of them is "send this raw payload". A caller
 * that could hand a platform body straight through would put platform knowledge back in the
 * controllers, which is the arrangement this file replaces. Adding a turn means adding an
 * intent here and rendering it for both channels in the same change — so a feature can
 * never ship working on Telegram and broken on WhatsApp.
 */
export type BotReplyIntent =
    /**
     * An open question — the customer answers by typing — optionally with ACTION BUTTONS
     * beside it for the answers that are known in advance.
     *
     * ⚠ **`actions` is how a closed answer stops being a typed word.** "Would you like to
     * add an email address?" needs free text for the address and a button for *no*; without
     * one, the copy has to teach a magic word (*"just say skip"*) and something downstream
     * has to know that word in five languages. The label is translated, the id is not —
     * see `bot-action-id.ts`.
     *
     * The distinction from `choice` is real and worth keeping: `choice` means *pick one of
     * these and nothing else*, so it carries the whole answer set. This is *answer freely,
     * or press one of these*. A yes/no is a `choice`; a skip is an action on a `text`.
     */
    | { kind: 'text'; text: string; actions?: readonly BotReplyOption[] }
    /**
     * Ask for a verified phone number.
     *
     * Telegram renders the `request_contact` keyboard; WhatsApp has no such control and
     * falls back to the text, which `bot-onboarding-copy.ts` already words for that case
     * ("send it with the country code") rather than telling somebody to tap a button their
     * client will never draw.
     */
    | { kind: 'contact_request'; text: string; buttonLabel: string }
    /**
     * Ask for a map pin — with typing still allowed.
     *
     * ⚠ **The one intent BOTH platforms draw natively**, and they draw it differently enough
     * that the difference reaches the caller. Telegram uses a reply keyboard
     * (`request_location`); WhatsApp uses `interactive.location_request_message`, which
     * renders its own button and takes no label — so `buttonLabel` is Telegram-only, exactly
     * as `contact_request`'s is.
     *
     * ⚠ **`skipLabel` is a REPLY-KEYBOARD button, so its press arrives as TEXT.** Telegram's
     * `reply_markup` is a union: a message asking for a location cannot also carry an inline
     * keyboard, so the Skip that a skippable step is entitled to has to ride the same custom
     * keyboard — and a custom-keyboard button sends its own label as an ordinary message.
     *
     * That is NOT a return to the magic-word parsing §14.6 abolished, and the distinction is
     * worth stating because the shapes look identical. The old design asked the automation
     * layer to know that `skip`, `passer`, `saltar`, `omitir` and `تخطٍّ` are one intent — a
     * translation table in the one layer with no copy table. Here the caller is HANDED the
     * exact string, per turn, in the customer's language, as `onboarding.next.skipLabel`, and
     * compares it for equality. It never has to know what the word means, only that this turn
     * said this string.
     *
     * ⚠ **WhatsApp cannot render it at all** — `location_request_message` permits one action
     * and no buttons — so a skippable step is not skippable by tapping on WhatsApp. Stated
     * rather than worked around: the alternative is dropping the native location button on
     * that channel, which is the more useful of the two.
     */
    | {
          kind: 'location_request';
          text: string;
          /** Telegram's keyboard button label. Ignored on WhatsApp, which draws its own. */
          buttonLabel: string;
          /** A second keyboard button meaning "skip this step". Telegram only. */
          skipLabel?: string;
      }
    /** Pick one of a short list. */
    | {
          kind: 'choice';
          text: string;
          options: readonly BotReplyOption[];
          /** WhatsApp's list-open button label. Ignored on Telegram. */
          listButton: string;
          /** WhatsApp's list section heading. Ignored on Telegram. */
          sectionTitle: string;
      }
    /** A sentence with one button that opens a URL. */
    | { kind: 'link'; text: string; label: string; url: string }
    /**
     * ⭐ **A sentence with one button that opens an IN-APP SCREEN** — the Telegram Mini App, or
     * a WhatsApp Flow.
     *
     * ── WHY THIS IS NOT `link` ──────────────────────────────────────────────
     * A `link` renders Telegram's ordinary `url` button, which leaves the chat for the system
     * browser. `product-display.service.ts` already argues that this is *worse* than the cards
     * it would replace: the customer loses the conversation, and on a phone they frequently do
     * not come back. A `web_app` button opens a page **inside** Telegram, and closing it
     * returns them to the thread they were in. Same sentence, same label, different control —
     * and only the renderer knows which one the channel can draw.
     *
     * ── ⚠ IT BREAKS THIS FILE'S OWN RULE, DELIBERATELY AND TEMPORARILY ──────
     * The header above says an intent must render for **both** channels in the same change, so
     * a feature can never ship working on Telegram and broken on WhatsApp. This one does not,
     * yet: Telegram gets the real screen and WhatsApp gets `cta_url`, which opens the
     * storefront in a browser. That is the agreed sequencing — build the four screens where
     * the page already exists and there is no encryption work, prove the design, then port it.
     *
     * ⚠ **The WhatsApp branch is NOT dead code and must not be deleted as such.** It is the
     * only thing a WhatsApp customer gets until Flows land, and it is why this intent is safe
     * to use today. `flow` below is the seam the port lands on.
     *
     * ── WHY `url` AND `flow` BOTH ───────────────────────────────────────────
     * So the intent's SHAPE does not change when Flows arrive. A WhatsApp Flow is a published
     * form named by id, not a URL; a Mini App is a URL. Carrying both means the port is a
     * renderer change plus a populated field, not a new intent and an edit at every call site.
     * `flow` absent — the ordinary case today — takes the `cta_url` path.
     */
    | {
          kind: 'inapp';
          text: string;
          label: string;
          /**
           * The screen's address. **Must be HTTPS** — Telegram refuses a `web_app` button on
           * any other scheme and refuses the whole message with it, so a non-HTTPS value here
           * degrades to an ordinary `url` button rather than being sent and dropped.
           */
          url: string;
          /**
           * The published WhatsApp Flow for this screen, when the deployment has one.
           *
           * ⚠ **Absent is the ordinary case and must stay cheap**, exactly as `carousel` is on
           * `product_list`. A Flow needs publishing in Business Manager, and anything it must
           * *fetch* needs an encrypted endpoint this platform has not built — so the absence of
           * one is a configuration state, never a fault.
           *
           * ⚠ **A Flow cannot be sent outside the 24-hour service window.** A caller reaching
           * for this intent on a proactive turn must not pass `flow`; the window will usually
           * be shut and Meta refuses the send.
           */
          flow?: { id: string; screen?: string | null; params?: Record<string, unknown> } | null;
      }
    /**
     * ⭐ **A LIST OF PRODUCTS, drawn rather than narrated** — and the one intent that renders
     * to SEVERAL messages.
     *
     * ── WHY THIS EXISTS, AND WHAT IT REVERSES ───────────────────────────────
     * `bot-surface.md` § 14.3 used to end *"a product … is data for your model to narrate,
     * and deliberately carries no `reply`"*, and that was right about a product and wrong
     * about a **list** of them. Narrating five products produces the thing this feature was
     * reported for: a numbered markdown list, no pictures, no prices anybody can tap, and no
     * way to buy — a catalogue read aloud. The sentence still stands for one product, for a
     * cart and for an order; it does not stand for a set the customer is meant to choose
     * from.
     *
     * ── IT IS THE FIRST INTENT WHOSE RENDERING IS NOT ONE MESSAGE ────────────
     * Which is why `renderBotReplies` exists beside `renderBotReply`. The three shapes it can
     * take are decided HERE, from the data, and never by the caller:
     *
     *   - **Telegram with a Mini App configured** — one `sendMessage` carrying a `web_app`
     *     button. The cards are drawn by the page, not by the chat.
     *   - **Telegram without one** — one `sendPhoto` per card, each with its own keyboard.
     *   - **WhatsApp** — a 5-card carousel template when one is configured and there are
     *     exactly five cards; otherwise one interactive image message per card.
     *
     * Every one of those degrades to the next when its prerequisite is absent, so an
     * unconfigured deployment renders cards rather than failing.
     */
    | {
          kind: 'product_list';
          /**
           * The line that introduces this page — **may be empty, and usually is.**
           *
           * On the first page the model has just written its own sentence in the
           * conversation it is having, and a second generic one over the top of it is the
           * talking-over `setOnboardingReply` refuses to do. A "See more" page has no such
           * sentence (nobody asked the model anything — a button was pressed), so the caller
           * supplies `moreProductsPrompt` there.
           */
          text: string;
          /**
           * The body of the Mini App button message. Never empty.
           *
           * ⚠ **A separate field from `text` because only the RENDERER knows which path it
           * is taking**, and Telegram refuses a `sendMessage` with an empty `text`. The
           * caller cannot pick between them without knowing the channel and whether a Mini
           * App is configured, which is exactly the platform knowledge it must not have.
           */
          browsePrompt: string;
          /** Already windowed by the caller. 1–10; a carousel needs exactly `WA_CAROUSEL_CARDS`. */
          cards: readonly BotProductCard[];
          /** The Telegram `web_app` target. Absent → photo cards. Must be HTTPS. */
          miniAppUrl?: string | null;
          /** Is there another page behind this one? */
          hasMore: boolean;
          /** `more:<setId>`. Meaningless unless `hasMore`. */
          moreToken?: string | null;
          /** Button labels, already in the customer's language — see `bot-chrome-copy.ts`. */
          labels: {
              browse: string;
              buyNow: string;
              addToCart: string;
              seeMore: string;
              details: string;
              /**
               * The two an out-of-stock card offers instead of a buy row.
               *
               * ⚠ **OPTIONAL, deliberately.** Every stream that composes a `product_list` builds
               * this object, so a required field here would fail the build in all of them at
               * once for a feature only the discovery stream draws. A button renders only when
               * its token AND its label are present — see `telegramCardKeyboard`.
               */
              similarItems?: string;
              saveForLater?: string;
          };
          /**
           * The approved WhatsApp carousel template, when the deployment has one.
           *
           * ⚠ **Absent is the ordinary case and must stay cheap.** A carousel on WhatsApp is
           * a *marketing-category template* that Meta pre-approves, and — the constraint that
           * shapes this whole intent — **an approved template can only ever be sent with the
           * exact number of cards it was created with.** That is why five is a hard number
           * rather than a maximum, and why a four-product answer takes the card path even on
           * a deployment that has the template.
           */
          carousel?: { templateName: string; languageCode: string } | null;
          /**
           * Where a carousel card's URL button points, as the **variable suffix** Meta
           * appends to the prefix declared in the template.
           *
           * ⚠ **Not a whole URL.** A template URL button is `https://…/shop/p/{{1}}` with one
           * variable, so what travels is the product id and nothing else. Passing an absolute
           * URL here produces `https://…/shop/p/https://…`, which Meta accepts and which
           * opens nothing.
           */
          carouselUrlSuffix?: ((card: BotProductCard) => string) | null;
      };

// ─────────────────────────────────────────────────────────────────────────────
// Platform limits this renderer is responsible for
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Telegram's caps. WhatsApp's live in `WA_LIMITS`, which is imported rather than copied —
 * the WhatsApp module already enforces them on its own sends, and two tables of one
 * platform's limits drift the first time Meta changes one.
 */
const TG_LIMITS = {
    /** `sendMessage.text`. */
    TEXT: 4096,
    /** Not a documented cap; a chat row wider than this wraps badly on a phone. */
    BUTTON_TEXT: 64,
    /**
     * ⚠ **A HARD cap, measured in BYTES, and Telegram enforces it silently** — an oversized
     * `callback_data` is not rejected with an error, the keyboard simply does not work.
     */
    CALLBACK_DATA_BYTES: 64,
} as const;

/** WhatsApp interactive maxima that are counts rather than lengths. */
const WA_MAX_BUTTONS = 3;
const WA_MAX_LIST_ROWS = 10;

/**
 * Options whose `id` Telegram cannot carry.
 *
 * Every id this service currently emits is a geo-candidate handle — `gc_` plus 43
 * base64url characters, 46 bytes — so this is unreachable today and `test:bot-surface`
 * pins it that way. It is written anyway because the failure it guards is invisible: a
 * truncated `callback_data` produces a keyboard that looks perfect and does nothing when
 * tapped, and nobody reports "the button is silent" as a backend bug.
 *
 * Dropping the keyboard and keeping the sentence is the right degradation. The customer
 * still sees the question and can answer it by typing; a picker they cannot use is worse
 * than no picker.
 */
function telegramCanCarry(options: readonly BotReplyOption[]): boolean {
    return options.every((o) => Buffer.byteLength(o.id, 'utf8') <= TG_LIMITS.CALLBACK_DATA_BYTES);
}

// ─────────────────────────────────────────────────────────────────────────────
// Telegram
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⚠ **A reply with no keyboard of its own carries `remove_keyboard`, always.**
 *
 * The only custom keyboard this service ever shows is the contact request, and it is a
 * dead control the moment the number arrives — but Telegram keeps a reply keyboard on
 * screen until something explicitly removes it, `one_time_keyboard` only collapsing it.
 * The walkthrough used to make this the automation layer's job ("`next.requestContact` is
 * absent now, so remove the keyboard"), which is a branch that has to be got right on every
 * future turn rather than once.
 *
 * Sending it unconditionally is safe: `remove_keyboard` against a chat with no keyboard is
 * a no-op, so the rule needs no knowledge of what the previous turn rendered — which this
 * service does not have and should not start storing.
 */
function telegramText(
    chatId: string,
    text: string,
    actions?: readonly BotReplyOption[],
): BotChannelReply {
    /**
     * ⚠ **`inline_keyboard` and `remove_keyboard` cannot travel in one `reply_markup`** —
     * Telegram's `reply_markup` is a union, not a bag of options. So a reply that carries
     * action buttons does NOT also remove a lingering custom keyboard.
     *
     * Bounded and deliberate rather than overlooked: the only custom keyboard this service
     * ever shows is the contact request, `one_time_keyboard` collapses it on use, and the
     * checklist order (phone → name → email → address) always puts a plain, keyboard-
     * removing `name` prompt between the two. A future turn that renders actions directly
     * after the contact share would need a separate `sendMessage` to clear it.
     */
    const markup = actions?.length && telegramCanCarry(actions)
        ? { inline_keyboard: actions.map((a) => [inlineButton(a)]) }
        : { remove_keyboard: true };

    return {
        channel: 'telegram',
        method: 'sendMessage',
        body: {
            chat_id: chatId,
            text: truncate(text, TG_LIMITS.TEXT) as string,
            reply_markup: markup,
        },
    };
}

/** One inline-keyboard button. The id round-trips as `callback_query.data`. */
function inlineButton(option: BotReplyOption): Record<string, unknown> {
    return {
        text: truncate(option.label, TG_LIMITS.BUTTON_TEXT) as string,
        callback_data: option.id,
    };
}

/**
 * Is this Telegram conversation a ONE-TO-ONE chat with a person?
 *
 * ⚠ **Three controls this renderer draws are "available in private chats only"**, in the Bot
 * API's own words: the inline `web_app` button (`inapp`, and `product_list`'s Mini App door),
 * and the reply-keyboard `request_contact` and `request_location` buttons. Nothing on this
 * surface used to know what kind of chat it was answering, so the day the bot answered in a
 * group every one of those turns would have been refused by Telegram — and a refused control
 * takes the sentence with it, which is the silence `inAppBaseUrl`'s HTTPS check exists to
 * prevent, arriving from a direction that check cannot see.
 *
 * ── WHY THE CHAT ID IS ENOUGH, AND NO ENVELOPE FIELD WAS ADDED ──────────────
 * Telegram's dialog-id scheme (core.telegram.org/api/bots/ids) puts the type in the SIGN. A
 * user is `1 … 0xffffffffff`, and a private chat's id IS its user's id; a basic group, a
 * supergroup, a channel and a monoforum are all negative. `recipient` is the `chat.id` of the
 * conversation the update arrived on — the n8n adapter copies it verbatim for a message and
 * for a tap (`cq.message.chat.id`), and the command path passes the webhook's `chat_id` — so
 * the renderer already holds the answer.
 *
 * ⚠ **Anything that is not a plain positive integer counts as NOT private.** That fails
 * towards the control that always arrives. A `web_app` button addressed to something that is
 * not a numeric chat id would not be delivered anyway, so nothing is lost by refusing it.
 *
 * ── A TELEGRAM BUSINESS ACCOUNT IS NOT DETECTABLE HERE, AND DOES NOT NEED TO BE ──
 * The Bot API also says `web_app` is "not supported for messages sent on behalf of a Telegram
 * Business account". Such a chat is private — positive id — so the sign cannot see it. What
 * makes a message "on behalf of" one is a `business_connection_id` in the body, and **this
 * renderer never writes one**; the automation layer also subscribes to `message` and
 * `callback_query` only, never `business_message`, so no turn arrives on a business connection
 * at all (verified against the live `UP-wi-mall-tg-adapter`, 2026-09-16). If either ever
 * changes, this predicate is where the second condition belongs.
 */
function telegramIsPrivateChat(chatId: string): boolean {
    return /^[1-9]\d*$/.test(chatId);
}

/**
 * The button that opens an in-app screen, as THIS chat can draw it.
 *
 * `web_app` only when both hold: the address is HTTPS and the chat is one-to-one. Otherwise an
 * ordinary `url` button to the same address — the customer leaves for the browser, which is
 * worse than the Mini App and far better than a message that never arrives. That fallback is
 * real rather than a dead end because the screens are built to run with no Telegram runtime:
 * every `Telegram.WebApp` touch in `miniapp/public/*.html` is guarded.
 *
 * ⚠ **Outside a private chat the link is visible to every member**, and the handle in it is
 * that screen's whole authorisation. That adds nothing a group did not already have — its
 * `chat_id` IS the identity this surface resolved, so any member is already acting as that
 * customer — but it is why this must never be widened into "always a url button".
 */
function telegramScreenButton(label: string, url: string, chatId: string): Record<string, unknown> {
    const text = truncate(label, TG_LIMITS.BUTTON_TEXT) as string;
    return url.startsWith('https://') && telegramIsPrivateChat(chatId)
        ? { text, web_app: { url } }
        : { text, url };
}

function renderTelegram(intent: BotReplyIntent, chatId: string): BotChannelReply {
    switch (intent.kind) {
        case 'text':
            return telegramText(chatId, intent.text, intent.actions);

        /**
         * ⚠ **`request_contact` and `request_location` are private-chat controls too.** In a
         * group the keyboard is dropped and the sentence goes alone, so the turn still arrives.
         * The step cannot be completed there whatever is drawn — the contact guard compares the
         * shared card's `user_id` with a chat id that belongs to the group — so the honest
         * outcome is a message, not a button that makes Telegram refuse it.
         */
        case 'contact_request':
            if (!telegramIsPrivateChat(chatId)) return telegramText(chatId, intent.text);
            return {
                channel: 'telegram',
                method: 'sendMessage',
                body: {
                    chat_id: chatId,
                    text: truncate(intent.text, TG_LIMITS.TEXT) as string,
                    reply_markup: {
                        keyboard: [[{ text: intent.buttonLabel, request_contact: true }]],
                        one_time_keyboard: true,
                        resize_keyboard: true,
                    },
                },
            };

        case 'location_request':
            if (!telegramIsPrivateChat(chatId)) return telegramText(chatId, intent.text);
            return {
                channel: 'telegram',
                method: 'sendMessage',
                body: {
                    chat_id: chatId,
                    text: truncate(intent.text, TG_LIMITS.TEXT) as string,
                    reply_markup: {
                        // One button per ROW, and the order is deliberate: the useful action
                        // is on top, the refusal underneath. A skippable step that renders
                        // Skip first invites the tap that ends the conversation.
                        keyboard: [
                            [{ text: intent.buttonLabel, request_location: true }],
                            ...(intent.skipLabel ? [[{ text: intent.skipLabel }]] : []),
                        ],
                        one_time_keyboard: true,
                        resize_keyboard: true,
                    },
                },
            };

        case 'choice': {
            if (intent.options.length === 0 || !telegramCanCarry(intent.options)) {
                return telegramText(chatId, intent.text);
            }
            return {
                channel: 'telegram',
                method: 'sendMessage',
                body: {
                    chat_id: chatId,
                    text: truncate(intent.text, TG_LIMITS.TEXT) as string,
                    // One option per ROW. Telegram allows several per row, and they arrive
                    // as unreadable slivers on a phone the moment a label is longer than a
                    // word — and every label this surface produces is an address.
                    reply_markup: { inline_keyboard: intent.options.map((o) => [inlineButton(o)]) },
                },
            };
        }

        case 'link':
            return {
                channel: 'telegram',
                method: 'sendMessage',
                body: {
                    chat_id: chatId,
                    text: truncate(intent.text, TG_LIMITS.TEXT) as string,
                    reply_markup: {
                        inline_keyboard: [
                            [
                                {
                                    text: truncate(intent.label, TG_LIMITS.BUTTON_TEXT) as string,
                                    url: intent.url,
                                },
                            ],
                        ],
                    },
                },
            };

        /**
         * A `web_app` button — the screen opens INSIDE Telegram and closing it returns the
         * customer to this thread.
         *
         * ⚠ **Telegram refuses the entire message if a `web_app` url is not HTTPS**, losing
         * the sentence as well as the button. So a non-HTTPS url degrades to an ordinary
         * `url` button: the customer leaves for the browser, which is worse than the Mini
         * App and far better than a message that never arrives. The caller should still pass
         * HTTPS — see `BOT_MINIAPP_BASE_URL` — this is the backstop, not the plan.
         *
         * ⚠ The same degradation applies OUTSIDE A PRIVATE CHAT, where Telegram refuses
         * `web_app` whatever the scheme — see `telegramIsPrivateChat`.
         */
        case 'inapp': {
            const button = telegramScreenButton(intent.label, intent.url, chatId);

            return {
                channel: 'telegram',
                method: 'sendMessage',
                body: {
                    chat_id: chatId,
                    text: truncate(intent.text, TG_LIMITS.TEXT) as string,
                    reply_markup: { inline_keyboard: [[button]] },
                },
            };
        }

        /**
         * ⚠ **Renders to SEVERAL messages, so this returns the first and callers that can
         * send more than one must use `renderBotReplies`.** Taking the first is the honest
         * degradation rather than a silent one: on the Mini App path there is only ever one
         * message, so nothing is lost at all; on the card path the customer sees the first
         * product instead of five, which is visibly incomplete rather than wrong.
         */
        case 'product_list':
            return telegramProductList(intent, chatId)[0];
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// WhatsApp — Meta Cloud API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The Cloud API envelope every WhatsApp body shares.
 *
 * Shaped to match `whatsapp/handlers/*.handler.ts` exactly, field for field, including
 * `recipient_type` and `preview_url` — the same wire body the platform already sends on its
 * own notification path. Two shapes for one API is how one of them silently stops matching
 * what Meta accepts.
 */
function waEnvelope(to: string, type: string, rest: Record<string, unknown>): BotChannelReply {
    return {
        channel: 'whatsapp',
        method: 'messages',
        body: { messaging_product: 'whatsapp', recipient_type: 'individual', to, type, ...rest },
    };
}

function whatsappText(to: string, text: string): BotChannelReply {
    return waEnvelope(to, 'text', {
        text: { body: truncate(text, WA_LIMITS.TEXT_BODY) as string, preview_url: false },
    });
}

/**
 * Buttons or a list — decided by the CONTENT, not by the count alone.
 *
 * Three or fewer options normally means reply buttons, which read better. Two things send a
 * picker to the list instead, and the second was found by a failing test rather than by
 * reasoning:
 *
 * - **A title that would be cut.** A reply-button title is capped at twenty characters.
 * - ⚠ **An option carrying a `description`.** A button has nowhere to put one — so two
 *   address candidates would render as `Akwa 0` and `Akwa 1`, which is not a choice anybody
 *   can make. A description exists precisely because the title alone does not identify the
 *   option, so its presence is the signal that a subtitle is load-bearing. A list row has
 *   both: a 24-character title and a 72-character description, which is enough to tell two
 *   streets apart.
 *
 * The consequence to hold on to: an address picker is ALWAYS a list on WhatsApp, however
 * few candidates come back, while a genuine yes/no stays a pair of buttons.
 */
function whatsappChoice(
    to: string,
    intent: Extract<BotReplyIntent, { kind: 'choice' }>,
): BotChannelReply {
    const body = { text: truncate(intent.text, WA_LIMITS.INTERACTIVE_BODY) as string };
    const titleOf = (o: BotReplyOption): string => o.shortLabel ?? o.label;
    const fitsButtons =
        intent.options.length <= WA_MAX_BUTTONS
        && intent.options.every(
            (o) => !o.description && titleOf(o).length <= WA_LIMITS.BUTTON_REPLY_TITLE,
        );

    if (fitsButtons) {
        return waEnvelope(to, 'interactive', {
            interactive: {
                type: 'button',
                body,
                action: {
                    buttons: intent.options.map((o) => ({
                        type: 'reply',
                        reply: { id: o.id, title: titleOf(o) },
                    })),
                },
            },
        });
    }

    // ⚠ Meta rejects a list with more than ten rows outright, so the excess is DROPPED
    // rather than sent. Every caller on this surface already caps its own candidates below
    // ten (`/geo/search` caps at 10); this is the backstop for the one that forgets.
    const rows = intent.options.slice(0, WA_MAX_LIST_ROWS).map((o) => ({
        id: o.id,
        title: truncate(titleOf(o), WA_LIMITS.LIST_ROW_TITLE) as string,
        ...(o.description
            ? { description: truncate(o.description, WA_LIMITS.LIST_ROW_DESCRIPTION) as string }
            : {}),
    }));

    return waEnvelope(to, 'interactive', {
        interactive: {
            type: 'list',
            body,
            action: {
                button: truncate(intent.listButton, WA_LIMITS.LIST_BUTTON) as string,
                sections: [
                    {
                        title: truncate(intent.sectionTitle, WA_LIMITS.LIST_SECTION_TITLE) as string,
                        rows,
                    },
                ],
            },
        },
    });
}

function renderWhatsApp(intent: BotReplyIntent, to: string): BotChannelReply {
    switch (intent.kind) {
        case 'text':
            /**
             * ⚠ **Action buttons are ALWAYS `button`, never a list, however many there
             * are** — unlike a `choice`, which picks its control by content. A list on
             * WhatsApp hides its rows behind a tap on "Choose", so an action beside an open
             * question would become invisible exactly when the customer is deciding whether
             * to answer or decline. `WA_MAX_BUTTONS` is 3; a fourth action is dropped
             * rather than sent, because Meta rejects the whole message otherwise.
             */
            return intent.actions?.length
                ? waEnvelope(to, 'interactive', {
                      interactive: {
                          type: 'button',
                          body: {
                              text: truncate(intent.text, WA_LIMITS.INTERACTIVE_BODY) as string,
                          },
                          action: {
                              buttons: intent.actions.slice(0, WA_MAX_BUTTONS).map((a) => ({
                                  type: 'reply',
                                  reply: {
                                      id: a.id,
                                      title: truncate(
                                          a.shortLabel ?? a.label,
                                          WA_LIMITS.BUTTON_REPLY_TITLE,
                                      ) as string,
                                  },
                              })),
                          },
                      },
                  })
                : whatsappText(to, intent.text);

        // No contact-share control exists on WhatsApp — and the step is normally already
        // satisfied there, because the sender id IS the number. The copy for this case is
        // written to be typed at, so relaying it plainly is the whole correct behaviour.
        case 'contact_request':
            return whatsappText(to, intent.text);

        /**
         * ⚠ **`location_request_message` takes ONE action and no buttons**, so `skipLabel`
         * is not rendered here. A skippable step is therefore not skippable by tapping on
         * WhatsApp — the customer answers, or types something else and the step is asked
         * again. The alternative was dropping the native location button on this channel to
         * keep a Skip reply-button, and the location button is the more useful of the two on
         * the one step that has ever needed either.
         */
        case 'location_request':
            return waEnvelope(to, 'interactive', {
                interactive: {
                    type: 'location_request_message',
                    body: { text: truncate(intent.text, WA_LIMITS.INTERACTIVE_BODY) as string },
                    action: { name: 'send_location' },
                },
            });

        case 'choice':
            return intent.options.length === 0
                ? whatsappText(to, intent.text)
                : whatsappChoice(to, intent);

        case 'link':
            return waEnvelope(to, 'interactive', {
                interactive: {
                    type: 'cta_url',
                    body: { text: truncate(intent.text, WA_LIMITS.INTERACTIVE_BODY) as string },
                    action: {
                        name: 'cta_url',
                        parameters: {
                            display_text: truncate(
                                intent.label,
                                WA_LIMITS.CTA_DISPLAY_TEXT,
                            ) as string,
                            url: intent.url,
                        },
                    },
                },
            });

        /**
         * A Flow when one is published, and `cta_url` until then.
         *
         * ⚠ **The `cta_url` branch is the WhatsApp half of this feature today, not a
         * placeholder to be tidied away.** Telegram-first is the agreed sequencing (see the
         * intent's docstring), and until a Flow exists this is what a WhatsApp customer gets:
         * the same sentence and the same label, opening the storefront in a browser. Deleting
         * it as "dead" would leave the channel with nothing.
         *
         * ⚠ **A Flow is refused outside the 24-hour service window**, so a caller must not
         * pass `flow` on a proactive turn — there is no way to detect that here, because this
         * renderer is pure and has no clock.
         */
        case 'inapp':
            return intent.flow
                ? waEnvelope(to, 'interactive', {
                      interactive: {
                          type: 'flow',
                          body: { text: truncate(intent.text, WA_LIMITS.INTERACTIVE_BODY) as string },
                          action: {
                              name: 'flow',
                              parameters: {
                                  flow_id: intent.flow.id,
                                  // `navigate` opens a screen with data already supplied;
                                  // `data_exchange` would require the encrypted endpoint this
                                  // platform has not built, so it is deliberately not offered.
                                  flow_action: 'navigate',
                                  flow_cta: truncate(intent.label, WA_LIMITS.CTA_DISPLAY_TEXT),
                                  ...(intent.flow.screen
                                      ? { flow_action_payload: {
                                            screen: intent.flow.screen,
                                            data: intent.flow.params ?? {},
                                        } }
                                      : {}),
                              },
                          },
                      },
                  })
                : waEnvelope(to, 'interactive', {
                      interactive: {
                          type: 'cta_url',
                          body: { text: truncate(intent.text, WA_LIMITS.INTERACTIVE_BODY) as string },
                          action: {
                              name: 'cta_url',
                              parameters: {
                                  display_text: truncate(intent.label, WA_LIMITS.CTA_DISPLAY_TEXT),
                                  url: intent.url,
                              },
                          },
                      },
                  });

        /** See the Telegram side: the first of several. `renderBotReplies` gets them all. */
        case 'product_list':
            return whatsappProductList(intent, to)[0];
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Product cards — the one intent that renders to more than one message
// ─────────────────────────────────────────────────────────────────────────────

type ProductListIntent = Extract<BotReplyIntent, { kind: 'product_list' }>;

/**
 * ⚠ **A HARD number, not a maximum**, and it is Meta's constraint rather than a taste.
 *
 * A WhatsApp carousel is a template, and *"an approved template can only be used to send the
 * same number of cards as defined during its creation"*. So a template approved with five
 * cards can send five cards and nothing else — four is not a shorter carousel, it is a
 * rejected send. That is the whole reason the card path exists beside this one and why the
 * renderer switches between them on an exact equality rather than a `<=`.
 */
export const WA_CAROUSEL_CARDS = 5;

/** `sendPhoto.caption`. Shorter than `sendMessage.text`, which is 4096. */
const TG_CAPTION = 1024;

/** One product's caption on Telegram, as escaped HTML. */
function telegramCardCaption(card: BotProductCard): string {
    const lines = [
        `<b>${escapeTelegramHtml(card.title)}</b>`,
        escapeTelegramHtml(`${card.priceText} · ${card.storeName}`),
    ];
    return truncate(lines.join('\n'), TG_CAPTION) as string;
}

/**
 * The keyboard under one Telegram card.
 *
 * The buy row is dropped whole when the product has no default variant — see
 * `BotProductCard.variantId`. A Details row survives that, because a product page is
 * reachable whether or not anything is sellable from a button.
 */
function telegramCardKeyboard(
    card: BotProductCard,
    intent: ProductListIntent,
    withMore: boolean,
): Record<string, unknown> | null {
    const rows: Record<string, unknown>[][] = [];

    if (card.buyToken && card.addToken) {
        rows.push([
            { text: truncate(intent.labels.buyNow, TG_LIMITS.BUTTON_TEXT), callback_data: card.buyToken },
            { text: truncate(intent.labels.addToCart, TG_LIMITS.BUTTON_TEXT), callback_data: card.addToken },
        ]);
    }

    /**
     * The out-of-stock row: Similar items · Save for later.
     *
     * ⚠ **Each button needs BOTH its token and its label**, and that is not belt-and-braces. The
     * two labels are optional on `labels` — making them required would fail the build in every
     * stream that composes a `product_list` — so a caller that sets the tokens and forgets the
     * copy would otherwise draw a button captioned `undefined`.
     *
     * ⚠ **This row is keyed on the TOKENS, never on "this card has no buy row".** A service has
     * no buy row either, by design, and `product-card.ts` gives it neither token — see the
     * WhatsApp side, where confusing the two closes the booking door.
     */
    const rescue = [
        ...(card.similarToken && intent.labels.similarItems
            ? [{ text: truncate(intent.labels.similarItems, TG_LIMITS.BUTTON_TEXT), callback_data: card.similarToken }]
            : []),
        ...(card.saveToken && intent.labels.saveForLater
            ? [{ text: truncate(intent.labels.saveForLater, TG_LIMITS.BUTTON_TEXT), callback_data: card.saveToken }]
            : []),
    ];
    if (rescue.length > 0) rows.push(rescue);

    if (card.detailUrl) {
        rows.push([
            { text: truncate(intent.labels.details, TG_LIMITS.BUTTON_TEXT), url: card.detailUrl },
        ]);
    }
    if (withMore && intent.moreToken) {
        rows.push([
            { text: truncate(intent.labels.seeMore, TG_LIMITS.BUTTON_TEXT), callback_data: intent.moreToken },
        ]);
    }

    return rows.length > 0 ? { inline_keyboard: rows } : null;
}

/**
 * Telegram: a Mini App button, or a photo per product.
 *
 * ⚠ **The Mini App path is ONE message and that is the requested design**, not a shortcut. A
 * chat is a bad place to compare five products — they arrive as a vertical stack you scroll
 * past — and a Mini App is a real page that can lay them out side by side and let somebody
 * pick several at once. The chat's job on that path is to say what happened and offer the
 * door.
 *
 * ⚠ **A `web_app` button requires an HTTPS URL and Telegram refuses the whole message
 * without one.** The caller is responsible for passing null when it has no HTTPS origin —
 * see `BOT_MINIAPP_BASE_URL` — and this falls back to cards rather than sending a keyboard
 * Telegram will reject.
 *
 * ⚠ **Outside a private chat the door stays ONE message but becomes a `url` button**
 * (`telegramScreenButton`), rather than falling back to cards. Same shape as the `inapp`
 * intent's degradation, so a chat type never changes how many messages a turn is; and the
 * page works in an ordinary browser. The helper also re-checks HTTPS here, which this path
 * used to leave entirely to the caller.
 */
function telegramProductList(intent: ProductListIntent, chatId: string): BotChannelReply[] {
    const message = (text: string, markup: Record<string, unknown> | null): BotChannelReply => ({
        channel: 'telegram',
        method: 'sendMessage',
        body: {
            chat_id: chatId,
            text: truncate(text, TG_LIMITS.TEXT) as string,
            ...(markup ? { reply_markup: markup } : {}),
        },
    });

    if (intent.miniAppUrl) {
        return [
            message(intent.text || intent.browsePrompt, {
                inline_keyboard: [[telegramScreenButton(intent.labels.browse, intent.miniAppUrl, chatId)]],
            }),
        ];
    }

    const replies: BotChannelReply[] = [];
    if (intent.text) replies.push(message(intent.text, null));

    intent.cards.forEach((card, index) => {
        const last = index === intent.cards.length - 1;
        const markup = telegramCardKeyboard(card, intent, last && intent.hasMore);
        const caption = telegramCardCaption(card);

        if (card.imageUrl) {
            replies.push({
                channel: 'telegram',
                method: 'sendPhoto',
                body: {
                    chat_id: chatId,
                    photo: card.imageUrl,
                    caption,
                    parse_mode: 'HTML',
                    ...(markup ? { reply_markup: markup } : {}),
                },
            });
            return;
        }

        /**
         * No picture we can serve. A `sendPhoto` with a null photo is a 400 that loses the
         * caption AND the keyboard, so the card degrades to a formatted text message with the
         * same buttons — the customer loses the photograph and nothing else.
         */
        replies.push({
            channel: 'telegram',
            method: 'sendMessage',
            body: {
                chat_id: chatId,
                text: caption,
                parse_mode: 'HTML',
                ...(markup ? { reply_markup: markup } : {}),
            },
        });
    });

    // Nothing to show and nothing said. Never emit an empty array — `renderBotReply` reads
    // `[0]`, and a caller that sends `undefined` produces a 400 nobody can trace back here.
    if (replies.length === 0) replies.push(message(intent.browsePrompt, null));
    return replies;
}

/** One product's body text on WhatsApp. `*bold*` is WhatsApp's own markup, not Markdown. */
function whatsappCardBody(card: BotProductCard): string {
    /**
     * ⚠ **The link joins the body on the out-of-stock path only**, because that is the one path
     * where a card carries reply buttons INSTEAD of the `cta_url` Details link — Meta will not
     * mix the two — and dropping it outright would leave the product page unreachable on the
     * channel most customers are on. Every other card still gets Details as a proper button, so
     * adding the URL there would be the same link twice.
     */
    const detailLine = card.similarToken && card.saveToken && card.detailUrl
        ? `\n${card.detailUrl}`
        : '';

    return truncate(
        `*${card.title}*\n${card.priceText}\n${card.storeName}${detailLine}`,
        WA_LIMITS.INTERACTIVE_BODY,
    ) as string;
}

/**
 * WhatsApp: a 5-card carousel template, or an interactive image message per product.
 *
 * ── THE CAROUSEL IS A TEMPLATE, AND THAT IS NOT AN IMPLEMENTATION DETAIL ────
 * There is no free-form carousel in the Cloud API — `interactive.type: 'carousel'` is not a
 * message type Meta accepts, whatever a handler elsewhere in this repository may build. A
 * carousel is a **marketing-category template**, pre-approved in Business Manager, with a
 * fixed card count and **at most two buttons per card**. Three consequences are visible in
 * the code below and none of them can be designed away:
 *
 *   - five cards exactly, or the card path (`WA_CAROUSEL_CARDS`);
 *   - "See more" cannot live on a card, so it follows as its own message;
 *   - the URL button carries a **suffix**, not a URL (`carouselUrlSuffix`).
 *
 * The card path has none of those constraints — it is free-form, needs no approval, and works
 * inside the 24-hour service window today — which is why it is the default and the carousel
 * is the upgrade.
 */
function whatsappProductList(intent: ProductListIntent, to: string): BotChannelReply[] {
    const replies: BotChannelReply[] = [];

    const seeMoreMessage = (): BotChannelReply =>
        waEnvelope(to, 'interactive', {
            interactive: {
                type: 'button',
                body: { text: truncate(intent.browsePrompt, WA_LIMITS.INTERACTIVE_BODY) as string },
                action: {
                    buttons: [
                        {
                            type: 'reply',
                            reply: {
                                id: intent.moreToken,
                                title: truncate(intent.labels.seeMore, WA_LIMITS.BUTTON_REPLY_TITLE),
                            },
                        },
                    ],
                },
            },
        });

    if (
        intent.carousel
        && intent.carouselUrlSuffix
        && intent.cards.length === WA_CAROUSEL_CARDS
        && intent.cards.every((card) => card.imageUrl)
    ) {
        const suffixOf = intent.carouselUrlSuffix;
        replies.push({
            channel: 'whatsapp',
            method: 'messages',
            body: {
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to,
                type: 'template',
                template: {
                    name: intent.carousel.templateName,
                    language: { code: intent.carousel.languageCode },
                    components: [
                        {
                            type: 'body',
                            parameters: [
                                {
                                    type: 'text',
                                    text: truncate(
                                        intent.text || intent.browsePrompt,
                                        WA_LIMITS.INTERACTIVE_BODY,
                                    ),
                                },
                            ],
                        },
                        {
                            type: 'carousel',
                            cards: intent.cards.map((card, index) => ({
                                card_index: index,
                                components: [
                                    {
                                        type: 'header',
                                        parameters: [
                                            { type: 'image', image: { link: card.imageUrl } },
                                        ],
                                    },
                                    {
                                        type: 'body',
                                        parameters: [
                                            { type: 'text', text: truncate(card.title, 60) },
                                            { type: 'text', text: card.priceText },
                                            { type: 'text', text: truncate(card.storeName, 60) },
                                        ],
                                    },
                                    {
                                        type: 'button',
                                        sub_type: 'quick_reply',
                                        index: 0,
                                        // ⚠ A card with no variant still needs a payload — the
                                        // template declares two buttons on every card and Meta
                                        // rejects a card that omits one. `more:` is the honest
                                        // stand-in: it does something, and it does not pretend
                                        // to add an unsellable product to a basket.
                                        parameters: [
                                            {
                                                type: 'payload',
                                                payload: card.addToken ?? intent.moreToken ?? 'more:none',
                                            },
                                        ],
                                    },
                                    {
                                        type: 'button',
                                        sub_type: 'url',
                                        index: 1,
                                        parameters: [{ type: 'text', text: suffixOf(card) }],
                                    },
                                ],
                            })),
                        },
                    ],
                },
            },
        });

        if (intent.hasMore && intent.moreToken) replies.push(seeMoreMessage());
        return replies;
    }

    if (intent.text) replies.push(whatsappText(to, intent.text));

    intent.cards.forEach((card, index) => {
        const last = index === intent.cards.length - 1;
        const buttons: Record<string, unknown>[] = [];

        if (card.buyToken && card.addToken) {
            buttons.push({
                type: 'reply',
                reply: {
                    id: card.buyToken,
                    title: truncate(intent.labels.buyNow, WA_LIMITS.BUTTON_REPLY_TITLE),
                },
            });
            buttons.push({
                type: 'reply',
                reply: {
                    id: card.addToken,
                    title: truncate(intent.labels.addToCart, WA_LIMITS.BUTTON_REPLY_TITLE),
                },
            });
        }

        /**
         * ⭐ **The out-of-stock pair, and the one place this renderer trades something away.**
         *
         * Meta will not mix a URL button with reply buttons in one interactive message, so a
         * card that offers Similar items and Save for later CANNOT also keep the `cta_url`
         * Details link below. The link loses: the product cannot be bought from that page
         * either, while Similar items is the one control that still helps. Agreed with the
         * discovery stream, who proposed it and owns the tokens.
         *
         * ⚠ **The link is moved, not dropped** — `whatsappCardBody` appends `card.detailUrl`
         * whenever a card takes this path, so the page is still reachable as text. Most clients
         * make it tappable; the ones that do not still show something a person can copy, which
         * beats the link not being there.
         *
         * ⚠ **Keyed on the tokens.** The `buttons.length === 0` branch below is NOT the
         * out-of-stock branch — a SERVICE reaches it too, with no buy tokens by design, and
         * Details is where its booking flow lives. `product-card.ts` gives a service neither
         * token, which is what keeps that door open.
         */
        const soldOutPair = card.similarToken && card.saveToken;
        if (soldOutPair && intent.labels.similarItems && intent.labels.saveForLater) {
            buttons.push({
                type: 'reply',
                reply: {
                    id: card.similarToken,
                    title: truncate(intent.labels.similarItems, WA_LIMITS.BUTTON_REPLY_TITLE),
                },
            });
            buttons.push({
                type: 'reply',
                reply: {
                    id: card.saveToken,
                    title: truncate(intent.labels.saveForLater, WA_LIMITS.BUTTON_REPLY_TITLE),
                },
            });
        }
        /**
         * ⚠ **A sold-out card on the last page is EXACTLY at Meta's cap of three**: Similar
         * items + Save for later + See more. Nothing is dropped today, and the guard below is
         * what keeps it that way — but the next person to add a card button will silently cost
         * the last card its "See more" rather than get an error. Count before adding one.
         */
        if (last && intent.hasMore && intent.moreToken && buttons.length < WA_MAX_BUTTONS) {
            buttons.push({
                type: 'reply',
                reply: {
                    id: intent.moreToken,
                    title: truncate(intent.labels.seeMore, WA_LIMITS.BUTTON_REPLY_TITLE),
                },
            });
        }

        const header = card.imageUrl
            ? { header: { type: 'image', image: { link: card.imageUrl } } }
            : {};

        /**
         * ⚠ **Meta rejects an interactive `button` message with zero buttons**, so a card
         * that can offer none takes one of two other shapes. It happens on a **service** —
         * a class is booked, not carted, so `product-card.ts` gives it no buy tokens — and
         * on a product whose variants have all been withdrawn.
         *
         * ⚠ **`cta_url` rather than a bare image, whenever there is a link**, and that was a
         * live finding: a yoga class first rendered as a caption with no way to reach it at
         * all. A URL cannot ride a reply button on WhatsApp — that is a different interactive
         * type — so the card becomes one, keeping its picture in the header and offering
         * Details, which is where the booking flow actually lives.
         */
        if (buttons.length === 0) {
            if (card.detailUrl) {
                replies.push(
                    waEnvelope(to, 'interactive', {
                        interactive: {
                            type: 'cta_url',
                            ...header,
                            body: { text: whatsappCardBody(card) },
                            action: {
                                name: 'cta_url',
                                parameters: {
                                    display_text: truncate(
                                        intent.labels.details,
                                        WA_LIMITS.CTA_DISPLAY_TEXT,
                                    ),
                                    url: card.detailUrl,
                                },
                            },
                        },
                    }),
                );
                return;
            }

            replies.push(
                card.imageUrl
                    ? waEnvelope(to, 'image', {
                          image: {
                              link: card.imageUrl,
                              caption: truncate(whatsappCardBody(card), WA_LIMITS.MEDIA_CAPTION),
                          },
                      })
                    : whatsappText(to, whatsappCardBody(card)),
            );
            return;
        }

        replies.push(
            waEnvelope(to, 'interactive', {
                interactive: {
                    type: 'button',
                    ...header,
                    body: { text: whatsappCardBody(card) },
                    action: { buttons },
                },
            }),
        );
    });

    if (replies.length === 0) replies.push(whatsappText(to, intent.browsePrompt));
    return replies;
}

// ─────────────────────────────────────────────────────────────────────────────
// The entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One intent, one channel, one recipient → the body to POST.
 *
 * `recipient` is the envelope's `externalId` and nothing else: Telegram's `chat_id` and
 * WhatsApp's bare-digit number are both exactly that value, so a reply is addressed to the
 * conversation the request arrived on and cannot be aimed anywhere else. **There is no
 * parameter for a destination**, which is what stops this from becoming a send-to-anyone
 * primitive on a surface reachable with a service token.
 *
 * Pure: no clock, no database, no environment. `test:bot-surface` drives every branch of it
 * with nothing running.
 */
export function renderBotReply(
    intent: BotReplyIntent,
    channel: MessagingChannel,
    recipient: string,
): BotChannelReply {
    return channel === 'telegram'
        ? renderTelegram(intent, recipient)
        : renderWhatsApp(intent, recipient);
}

/**
 * The same thing, for the turns that are more than one message.
 *
 * ── WHY A SECOND ENTRY POINT AND NOT A CHANGED SIGNATURE ────────────────────
 * `renderBotReply` returns one body and 81 routes plus the error path are built on that. A
 * `BotChannelReply[]` return would have been a change at every one of those call sites for a
 * feature none of them uses, and — the part that matters — `reply` is a **single object on
 * the wire**, consumed by an n8n expression (`$json.reply.channel`) this repository does not
 * own. Widening the field would break the automation layer for every existing turn.
 *
 * So the wire gained a sibling instead: `reply` stays the first body and `replies` carries
 * the whole ordered list when there is more than one. A caller that only knows about `reply`
 * keeps working and sends the first message; one that knows about `replies` sends them all.
 * See `bot-reply.middleware.ts`.
 *
 * ⚠ **Order is the rendering.** The intro precedes its cards and "See more" follows them,
 * and n8n's HTTP node iterates its input items in order — so the array must be sent as it
 * comes, never reordered or parallelised.
 */
export function renderBotReplies(
    intent: BotReplyIntent,
    channel: MessagingChannel,
    recipient: string,
): BotChannelReply[] {
    if (intent.kind === 'product_list') {
        return channel === 'telegram'
            ? telegramProductList(intent, recipient)
            : whatsappProductList(intent, recipient);
    }
    return [renderBotReply(intent, channel, recipient)];
}

/** ⚠ Exported for `test:bot-surface`, which asserts the guard above is unreachable in practice. */
export const __TG_LIMITS = TG_LIMITS;
