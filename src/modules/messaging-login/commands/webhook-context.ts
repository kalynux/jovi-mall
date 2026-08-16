import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { isMessagingChannel, MessagingChannel } from '../../channel-connections';

/**
 * Which messaging account sent this, read from the webhook CONTEXT.
 *
 * ⚠ **NEVER FROM THE PAYLOAD.** The context is assembled by the webhook
 * controller out of the request's own sender fields (`body.reply_to` for
 * WhatsApp, `body.chat_id` for Telegram); the payload is free-form data the
 * caller supplies. They look interchangeable and are not.
 *
 * On `/connect` that rule was merely correct. Here it is load-bearing to the
 * point of being the feature's security: a caller-supplied identity on a command
 * that mints a SESSION is outright account takeover — name somebody else's
 * number, read the code out of the response, sign in as them. The deleted `link`
 * command made exactly this mistake one layer down (`payload.wa_data.wa_phone_id`),
 * and it is the one worth not repeating.
 *
 * The webhook itself is only as trustworthy as `requireBotWebhookSecret` makes
 * it. This function keeps the payload out of the decision either way, so the two
 * guards stay independent.
 */

export interface LoginCommandContext {
  source?: string;
  /** WhatsApp: the WA-assigned sender id. Set by `WhatsappController.handleWebhook`. */
  wa_phone_id?: string;
  /** Telegram: the chat id. Set by `TelegramController.handleWebhook`. */
  chat_id?: string;
}

export interface ResolvedSender {
  channel: MessagingChannel;
  externalIdentity: string;
}

export function resolveSender(context: LoginCommandContext): ResolvedSender {
  const source = context.source;

  if (!isMessagingChannel(source)) {
    throw createAppError(ERROR_CODES.MESSAGING_IDENTITY_UNRESOLVED, 400, undefined, { source });
  }

  const externalIdentity = source === 'whatsapp' ? context.wa_phone_id : context.chat_id;

  if (!externalIdentity || !externalIdentity.trim()) {
    throw createAppError(ERROR_CODES.MESSAGING_IDENTITY_UNRESOLVED, 400, undefined, {
      channel: source,
    });
  }

  return { channel: source, externalIdentity: externalIdentity.trim() };
}

/** Telegram handles are conventionally written with the `@`; store one form. */
export function normalizeHandle(username: string | undefined): string | null {
  if (!username) return null;
  const trimmed = username.trim().replace(/^@+/, '');
  return trimmed ? `@${trimmed}` : null;
}
