import { z } from 'zod';
import { CommandHandler } from '../../command-bus/command-bus';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import {
  loginIdentityResolver,
  LoginIdentityResolution,
  ResetIdentityResolution,
} from '../services/identity-resolver.service';
import { pendingIntentStore } from '../services/pending-intent.store';
import { LoginCommandReply } from '../dto/messaging-login.dto';
import { buildLoginCommandReply } from './login.command';
import { buildResetCommandReply } from './reset-password.command';
import { LoginCommandContext, normalizeHandle, resolveSender } from './webhook-context';

export const command_name = 'login_contact';

/**
 * `login_contact` — the Telegram half of `/login`, completed.
 *
 * A `chat_id` bears no relation to any phone number, so a first-time Telegram
 * sender is anonymous to us. Storing a `telegram_chat_id` column would not fix
 * that: a column is storage, and what is missing is VERIFICATION — nothing can
 * populate it on a first interaction, because at that moment nothing has proved
 * which human the chat belongs to. Writing it from an unverified message would
 * be worse than not having it, because whoever sent the message would choose
 * whose account they log into.
 *
 * Telegram's `request_contact` supplies the missing proof: a keyboard button
 * that asks the sender to share their own number, answered with a `contact`
 * object carrying a `phone_number` **Telegram verified at signup**. That makes
 * the Telegram flow equivalent to WhatsApp's, where the sender id simply IS the
 * number.
 *
 * Dispatched when n8n sees a `contact` on an inbound message. The user never has to send the
 * original command again — this one completes it.
 *
 * ── IT COMPLETES TWO COMMANDS, NOT ONE ───────────────────────────────────────
 * `/login` and `/reset-password` hit the same wall on an unknown Telegram chat and both
 * answer it with this keyboard. What comes back carries the phone number and the sender and
 * **nothing about which command was asked** — so the prompt records a pending intent and this
 * handler reads it. The original `/login` design noted that no Redis state was needed here,
 * and that was true while there was exactly one intent; see `pending-intent.store.ts` for why
 * the state is ours rather than the automation layer's.
 *
 * n8n is unaffected: it still posts `login_contact` for any inbound contact, exactly as
 * before.
 */

/**
 * ⚠ THE GUARD THAT MAKES THIS SAFE — read before touching the schema.
 *
 * A Telegram user can share **somebody else's** contact card out of their
 * address book, and it arrives in exactly the same shape. Without a check,
 * anyone could forward a victim's contact and be signed in as them: a
 * one-message account takeover, needing nothing but the victim's phone number.
 *
 * Only a contact whose `user_id` is the SENDER'S OWN id is a
 * Telegram-verified number for this chat. A contact with a missing or
 * mismatched `user_id` is refused outright — never treated as a hint, never
 * "resolved anyway if the phone matches", because the phone matching is exactly
 * what the attacker arranged.
 *
 * ── The comparand is the CONTEXT's chat id, not a payload `from.id` ──────────
 * In a Telegram private chat, `chat.id` and the user's `from.id` are the same
 * number — and `chat_id` is the value the webhook controller put in the context,
 * so comparing against it keeps the guard independent of caller-supplied data.
 * Taking both sides of the comparison from the payload would let anyone who can
 * reach the webhook satisfy it by sending two matching numbers, which is not a
 * guard at all.
 *
 * A `from.id` is still accepted and, when present, must ALSO agree — belt and
 * braces. A group chat (negative `chat.id`, differing `from.id`) therefore fails
 * the comparison and is refused, which is the correct outcome: `request_contact`
 * is a private-chat mechanism and a group sign-in is meaningless.
 */
const TelegramIdSchema = z.union([z.string().trim().min(1).max(64), z.number()]);

export const schema = z.object({
  contact: z.object({
    /**
     * Telegram-verified at signup. Its leading `+` is inconsistent between
     * clients, which `messagingPhoneToE164` repairs — see that function.
     */
    phone_number: z.string().trim().min(1).max(64),
    /** Absent when the shared card is not a Telegram user. Refused in that case. */
    user_id: TelegramIdSchema.optional().nullable(),
    first_name: z.string().trim().max(120).optional(),
    last_name: z.string().trim().max(120).optional(),
  }),
  /** Optional corroboration; the context's chat id remains the authority. */
  from: z.object({ id: TelegramIdSchema.optional() }).partial().optional(),
  /** Cosmetic. Becomes the connection's `@handle`. */
  username: z.string().trim().max(120).optional(),
});

/** Telegram ids arrive as a JSON number or a string depending on the bridge. */
const sameId = (a: unknown, b: unknown): boolean =>
  a !== undefined && a !== null && String(a) === String(b);

export const handler: CommandHandler<z.infer<typeof schema>, LoginCommandReply> = async (
  payload,
  context: LoginCommandContext
) => {
  const { channel, externalIdentity: chatId } = resolveSender(context);

  if (channel !== 'telegram') {
    // `request_contact` is a Telegram mechanism. Reaching here on another channel
    // means the automation layer mapped something wrong.
    throw createAppError(ERROR_CODES.MESSAGING_IDENTITY_UNRESOLVED, 400, undefined, { channel });
  }

  const { contact, from } = payload;

  /**
   * The guard. Thrown rather than returned as chat copy, unlike every other
   * refusal in this feature — this is the one case that may be an attempted
   * account takeover, and it belongs in the logs as an error rather than in a
   * conversation as a pleasantry.
   *
   * The user is still told: the code's category is `validation`, which is
   * client-safe, so its registry message reaches the response body unfiltered
   * and n8n relays `error.message`. That message is deliberately written for a
   * chat window and does not read as an accusation — the ordinary way to hit
   * this is tapping the wrong contact.
   */
  if (!sameId(contact.user_id, chatId) || (from?.id !== undefined && !sameId(from.id, chatId))) {
    console.warn(
      `[MessagingLogin] refused a contact share on telegram:${chatId} — `
      + 'the shared contact is not the sender\'s own'
    );
    throw createAppError(ERROR_CODES.MAGIC_CONTACT_UNVERIFIED, 400);
  }

  const displayName = [contact.first_name, contact.last_name]
    .filter(Boolean)
    .join(' ')
    .trim();

  /**
   * WHICH command is this contact answering?
   *
   * The contact message carries the phone number and the sender and nothing about intent, so
   * the prompt that asked for it recorded one. An absent record falls back to `login` — the
   * historical meaning of a bare contact-share, and the lesser of the two outcomes. See
   * `pending-intent.store.ts`.
   */
  const intent = await pendingIntentStore.take('telegram', chatId);

  const resolution = await loginIdentityResolver.resolveFromVerifiedContact(
    intent,
    chatId,
    contact.phone_number,
    {
      displayName: displayName || null,
      handle: normalizeHandle(payload.username),
    }
  );

  /**
   * Mints and answers exactly as the command being completed does — one copy of each refusal
   * table and one copy of each success reply, so the direct and contact-share entrances
   * cannot drift. The user does NOT have to send the original command again.
   */
  return intent === 'reset'
    ? buildResetCommandReply(resolution as ResetIdentityResolution, 'telegram', chatId)
    : buildLoginCommandReply(resolution as LoginIdentityResolution, 'telegram', chatId);
};
