import { MessagingChannel } from '../../channel-connections';
import { TelegramBotService } from '../../telegram/services/telegram-bot.service';
import { messagingPhoneToE164 } from '../../messaging-login/services/identity-resolver.service';
import { WA_LIMITS, truncate } from '../../whatsapp/constants/whatsapp-limits';
import { BotReplyOption } from '../domain/channel-reply';

const telegramBotService = new TelegramBotService();

/** WhatsApp's hard cap on reply buttons in one message — the renderer's `WA_MAX_BUTTONS`. */
const WHATSAPP_MAX_BUTTONS = 3;

/**
 * A sentence with tap buttons under it, sent INTO a conversation by this service.
 *
 * ── WHY A SCREEN NEEDS THIS AT ALL ──────────────────────────────────────────
 * An in-app screen cannot write to the chat it was opened from: a Telegram Mini App launched
 * from an inline button has no `sendData`, and a WhatsApp screen is a page in WhatsApp's own
 * browser. So when a press on a screen has to continue in the conversation, this service —
 * which holds both channels' credentials — posts the next message itself and the page goes
 * back to the chat onto it.
 *
 * ⚠ **The buttons carry ordinary tap tokens**, the same ones a chat turn would have drawn, so
 * a press on a pushed card comes back through the automation layer's existing tap door and is
 * answered exactly like a press on any other card. Nothing new has to be routed.
 *
 * ⚠ **It answers whether the message was SENT, and the caller must look.** The two older pushes
 * (`bot-purchase.controller.ts`, `booking.controller.ts`) ignore the outcome, correctly: each
 * reports something that already happened. Here the message IS the outcome — a page that says
 * "it is in the chat" over a send that was refused has sent a customer to look for nothing.
 *
 * ⚠ **Inside WhatsApp's 24-hour window, and no template fallback.** The customer opened this
 * screen from a chat they wrote in moments ago. The messaging service still checks the window;
 * outside it the send is refused, and this answers `false`.
 */
export async function pushCardIntoConversation(
    conversation: { channel: MessagingChannel; externalId: string },
    card: { text: string; actions: readonly BotReplyOption[] },
): Promise<boolean> {
    if (conversation.channel === 'telegram') {
        return telegramBotService.sendMessage(conversation.externalId, card.text, {
            buttons: card.actions.map((action) => ({
                text: action.label,
                callbackData: action.id,
            })),
            // One per row, as the chat renderer draws a `text` turn's actions.
            buttonLayout: 'column',
        });
    }

    try {
        /**
         * Lazily imported, as the other two pushes do: the WhatsApp stack constructs its
         * provider on load and throws when it is unconfigured, which must not take a Telegram
         * customer's screen down with it.
         */
        const { WhatsAppServiceMessenger } = await import('../../whatsapp/services/whatsapp-service-messenger');
        const messenger = new WhatsAppServiceMessenger();
        // Meta's bare-digit `wa_id` → strict E.164, or the messenger refuses it outright.
        const to = messagingPhoneToE164(conversation.externalId) ?? conversation.externalId;

        const sent = card.actions.length > 0
            ? await messenger.sendButtons({
                to,
                body: truncate(card.text, WA_LIMITS.INTERACTIVE_BODY) as string,
                /**
                 * ⚠ **The same three limits `channel-reply.ts` applies to a `text` turn's
                 * actions** — three buttons, the short label where there is one, twenty
                 * characters — because the messaging service REFUSES an over-long title
                 * rather than cutting it, and the whole card would go with it.
                 */
                buttons: card.actions.slice(0, WHATSAPP_MAX_BUTTONS).map((action) => ({
                    id: action.id,
                    title: truncate(
                        action.shortLabel ?? action.label,
                        WA_LIMITS.BUTTON_REPLY_TITLE,
                    ) as string,
                })),
            })
            : await messenger.sendText({ to, body: card.text });

        if (!sent.success) {
            console.warn(`[BotSurface] card push to WhatsApp was refused: ${sent.error?.code ?? 'unknown'}`);
        }
        return sent.success;
    } catch (err) {
        console.warn(`[BotSurface] card push to WhatsApp failed: ${(err as Error).message}`);
        return false;
    }
}
