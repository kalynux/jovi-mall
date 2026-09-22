import type { MessagingChannel } from '../../channel-connections';

/**
 * A link that opens the conversation with the bot — for a SCREEN that cannot close itself.
 *
 * ── WHY A SCREEN NEEDS THIS AT ALL ──────────────────────────────────────────
 * A Telegram Mini App closes onto the chat with `Telegram.WebApp.close()`. A WhatsApp screen
 * has no such call: it is an ordinary page in WhatsApp's in-app browser, and `window.close()`
 * does nothing there. Without a way back, a press that ends in the chat — Bargain and Book,
 * whose question has just been posted into the thread — leaves the customer staring at a page
 * with a greyed button, and reads as "the button does nothing". Measured on a handset,
 * 2026-09-22.
 *
 * `wa.me` is the address WhatsApp itself opens from inside its own browser, so the customer
 * lands in the thread where the question is waiting. No `?text=`: the question is already
 * there, and a pre-filled composer would ask them to send something they did not write.
 *
 * ⚠ **The same two variables `channel-connection.dto.ts` reads, spelled as literal property
 * accesses** so `test:env`'s census sees this reader as well. Null when unset — the page then
 * tells the customer to go back to the chat in words rather than drawing a dead button.
 */
export function conversationUrl(channel: MessagingChannel): string | null {
    switch (channel) {
        case 'whatsapp': {
            const digits = (process.env.WA_BOT_NUMBER ?? '').replace(/[^0-9]/g, '');
            return digits ? `https://wa.me/${digits}` : null;
        }
        case 'telegram': {
            const name = (process.env.TELEGRAM_BOT_NAME ?? '').trim().replace(/^@/, '');
            return name ? `https://t.me/${name}` : null;
        }
        default: {
            const unreachable: never = channel;
            return unreachable;
        }
    }
}
