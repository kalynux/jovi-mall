import { getRedisClient, LOGIN_CODE_DB } from '../../../infra/redis/redis.factory';
import { MessagingChannel } from '../../channel-connections';
import { digestForKey } from '../domain/login-token';
import { MessagingAuthIntent } from './identity-resolver.service';

/**
 * What a Telegram chat asked for, remembered just long enough to finish asking.
 *
 * ── WHY THIS EXISTS AT ALL ───────────────────────────────────────────────────
 * Telegram's contact-share is one mechanism serving two commands. `/login` and
 * `/reset-password` both hit the same wall on an unknown chat — a `chat_id` matches no column
 * anywhere — and both answer it the same way, by asking for a `request_contact`. But what
 * comes back is just a `contact` on an inbound message. It carries the phone number and the
 * sender, and **nothing about which command the user was answering.**
 *
 * The original `/login` design noted that "no Redis state is needed between `/login` and
 * `login_contact`", and that was true while there was exactly one intent. With two, something
 * has to remember which — otherwise a user who asked to reset their password is silently
 * signed in instead, which is both wrong and confusing.
 *
 * ── WHY THE STATE IS OURS AND NOT THE AUTOMATION LAYER'S ─────────────────────
 * n8n renders the keyboard, so it *could* track the intent and post a different command. That
 * was rejected: it puts security-relevant state in a workflow we do not version, do not test,
 * and cannot fix from this repository — and it would mean the bot bridge had to be re-edited
 * every time a third command wanted a contact. n8n keeps posting `login_contact` for any
 * inbound contact, exactly as it already does, and this service decides what that means.
 *
 * ── IT IS A HINT, NOT A CREDENTIAL ───────────────────────────────────────────
 * Nothing is authorised by what is stored here. The contact-share guard, the identity
 * resolution and the refusal table all run identically whatever the intent says; it only
 * selects which of two outcomes a *successfully verified* sender gets. So a lost key degrades
 * to the default rather than failing anything, and a forged one could at most give an
 * attacker the outcome they could have had by sending the other command.
 */

/**
 * Ten minutes — the same window as the credentials it precedes.
 *
 * Long enough to read a prompt, find the button and tap it; short enough that a contact shared
 * an hour later is treated as a fresh, unprompted share rather than answering a question the
 * person has forgotten they were asked.
 */
export const PENDING_INTENT_TTL_SECONDS = 600;

/**
 * What an unremembered contact-share means.
 *
 * `login` for two reasons: it is what a bare contact-share meant before `/reset-password`
 * existed, so nothing that already works changes; and it is the *lesser* outcome — a session
 * the sender could have had by typing `/login`, rather than a password-reset link. Defaulting
 * the other way would hand out a reset credential to somebody who never asked for one.
 */
export const DEFAULT_PENDING_INTENT: MessagingAuthIntent = 'login';

// The identity is hashed for the same reason every other key name here is: key names are
// listable on the operations surface and a chat id is personal data. See `digestForKey`.
const intentKey = (channel: MessagingChannel, externalId: string): string =>
  `login:intent:${channel}:${digestForKey(externalId)}`;

export class PendingIntentStore {
  /** Record what this chat is answering, just before we ask them for a contact. */
  async remember(
    channel: MessagingChannel,
    externalId: string,
    intent: MessagingAuthIntent
  ): Promise<void> {
    const redis = await getRedisClient(LOGIN_CODE_DB);
    await redis.set(intentKey(channel, externalId), intent, {
      EX: PENDING_INTENT_TTL_SECONDS,
    });
  }

  /**
   * Read and clear the pending intent.
   *
   * Cleared on read so one prompt answers one contact-share. A second, unprompted share
   * afterwards falls back to the default rather than silently repeating whatever the person
   * last asked for.
   *
   * Best-effort by design: Redis being unreachable degrades this to the default, which is a
   * worse guess but never a failed sign-in. Nothing is authorised by the value.
   */
  async take(channel: MessagingChannel, externalId: string): Promise<MessagingAuthIntent> {
    try {
      const redis = await getRedisClient(LOGIN_CODE_DB);
      const key = intentKey(channel, externalId);
      const stored = await redis.get(key);
      if (stored) await redis.del(key);

      return stored === 'reset' || stored === 'login' ? stored : DEFAULT_PENDING_INTENT;
    } catch (error) {
      console.error('[MessagingLogin] Could not read the pending contact intent:', error);
      return DEFAULT_PENDING_INTENT;
    }
  }
}

export const pendingIntentStore = new PendingIntentStore();
