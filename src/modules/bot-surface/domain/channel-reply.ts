import { MessagingChannel } from '../../channel-connections';
import { WA_LIMITS, truncate } from '../../whatsapp/constants/whatsapp-limits';

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
 *   whatsapp   `https://graph.facebook.com/v18.0/<PHONE_NUMBER_ID>` + `/messages`
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
    | { kind: 'link'; text: string; label: string; url: string };

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

function renderTelegram(intent: BotReplyIntent, chatId: string): BotChannelReply {
    switch (intent.kind) {
        case 'text':
            return telegramText(chatId, intent.text, intent.actions);

        case 'contact_request':
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
    }
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

/** ⚠ Exported for `test:bot-surface`, which asserts the guard above is unreachable in practice. */
export const __TG_LIMITS = TG_LIMITS;
