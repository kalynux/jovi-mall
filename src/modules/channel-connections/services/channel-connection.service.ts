import mongoose from 'mongoose';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { BindConnectionData, ConnectionRepository, connectionRepository } from '../channel-connection.repository';
import { IChannelConnection } from '../channel-connection.model';
import { MessagingChannel, CONNECTION_CHANNELS } from '../domain/channel';
import { isWellFormedConnectionCode, normalizeConnectionCode } from '../domain/connection-code';
import { ConnectionCodeStore, connectionCodeStore } from './connection-code.store';

/**
 * The one mechanism by which a messaging identity becomes a connected account.
 *
 * ── THE FLOW, AND WHY IT IS INVERTED ─────────────────────────────────────────
 * The two predecessors both had the PLATFORM mint a secret which the user then
 * carried to the bot. That put an account identifier into a value a user pastes
 * into a chat window, and it meant the bot side had to be trusted to report
 * which identity had presented it — an unauthenticated webhook body decided
 * whose WhatsApp number got bound.
 *
 * Here the BOT mints the code against the identity it can actually observe (the
 * sender of the message), and the platform side binds it to whoever is
 * authenticated when it is redeemed. Neither half has to be told something it
 * cannot verify: the bot knows the sender, the API knows the account, and the
 * code carries no claim about either.
 */

/** One channel's state, as the account owner sees it. */
export interface ChannelConnectionState {
  channel: MessagingChannel;
  connection: IChannelConnection | null;
}

export class ConnectionService {
  constructor(
    private readonly repository: ConnectionRepository = connectionRepository,
    private readonly codeStore: ConnectionCodeStore = connectionCodeStore
  ) {}

  // ── Reads (also the notification stacks' entry point) ──────────────────────

  /**
   * Every channel's state for an account, connected or not.
   *
   * Always returns one entry per channel in `CONNECTION_CHANNELS`, so a caller
   * renders a complete settings screen without knowing the channel list.
   */
  async getStates(userId: string | mongoose.Types.ObjectId): Promise<ChannelConnectionState[]> {
    const connections = await this.repository.findByUser(userId);
    const byChannel = new Map(connections.map((c) => [c.channel, c]));

    return CONNECTION_CHANNELS.map((channel) => ({
      channel,
      connection: byChannel.get(channel) ?? null,
    }));
  }

  /**
   * One channel's connection, or null.
   *
   * This is what the four notification stacks call — both to decide whether a
   * secondary channel may be *enabled* (`computeVerification`) and to resolve
   * the address to send to. It replaces `entity.wa?.verified` and
   * `TelegramRepository.findByUserId`, which were two different answers to the
   * same question living in two different collections.
   */
  async getConnection(
    userId: string | mongoose.Types.ObjectId,
    channel: MessagingChannel
  ): Promise<IChannelConnection | null> {
    return this.repository.findByUserAndChannel(userId, channel);
  }

  /**
   * Both channels in one query, for the notification handlers — they ask about
   * WhatsApp and Telegram for the same person while rendering one notification,
   * and two round trips per notification is a cost worth not paying.
   */
  async getConnectionMap(
    userId: string | mongoose.Types.ObjectId
  ): Promise<Record<MessagingChannel, IChannelConnection | null>> {
    const connections = await this.repository.findByUser(userId);
    const byChannel = new Map(connections.map((c) => [c.channel, c]));

    return {
      whatsapp: byChannel.get('whatsapp') ?? null,
      telegram: byChannel.get('telegram') ?? null,
    };
  }

  /**
   * Which account, if any, holds this messaging identity.
   *
   * The inverse of `getConnection`, and the entry point for a caller that starts
   * from a chat rather than from a session — today that is passwordless `/login`
   * (`modules/messaging-login/`), whose FIRST resolution step is exactly this
   * question. `channel_connections` already *is* that mapping, with unique
   * indexes in both directions, which is why `/login` reads it instead of
   * growing a `telegram_chat_id` column of its own: two mappings drift, and the
   * drift would be a login bug.
   *
   * Exposed on the service rather than leaving callers to reach for the
   * repository, so this module keeps one door.
   */
  async resolveIdentityOwner(
    channel: MessagingChannel,
    externalId: string
  ): Promise<IChannelConnection | null> {
    return this.repository.findByIdentity(channel, externalId);
  }

  /**
   * Bind an identity whose ownership was proved WITHOUT a platform session.
   *
   * ── The second verified way to create a connection row ───────────────────────
   * `redeemCode` proves the pairing with a code the user carried from the bot to
   * an authenticated screen. This proves it the other way round: the *channel*
   * vouches for the number. Two things arrive with that proof today —
   * a WhatsApp `wa_phone_id`, which IS the sender's number and matches
   * `User.login_phone` directly, and a Telegram `request_contact` payload, which
   * carries a phone Telegram verified at signup.
   *
   * ⚠ **The proof is the caller's to establish, and it is not optional.** This
   * method performs no verification of its own — in particular it does NOT check
   * `contact.user_id === from.id`, the guard that stops a Telegram user sharing
   * somebody else's contact card and signing in as them. That check belongs to
   * the command that reads the payload, and this method must never be called on
   * an identity whose owner has not been established.
   *
   * Ownership POLICY is likewise the caller's: an identity already held by a
   * different account has to be refused, and the two callers want different copy
   * and different error codes for it. `(channel, external_id)` is unique, so the
   * index remains the backstop when a caller forgets.
   */
  async bindVerifiedIdentity(
    userId: string | mongoose.Types.ObjectId,
    data: BindConnectionData
  ): Promise<IChannelConnection> {
    const connection = await this.repository.bind(userId, data);

    console.log(
      `[Connections] ${data.channel} connected for user ${userId.toString()} (channel-verified)`
    );

    return connection;
  }

  // ── Writes ────────────────────────────────────────────────────────────────

  /**
   * Redeem a code and bind the identity behind it to this account.
   *
   * The ordering is deliberate at every step:
   *
   * 1. **Attempt counted first.** Counting only failures would let a guesser
   *    spend other people's live codes for free.
   * 2. **Shape checked before Redis.** A code that cannot exist costs no round
   *    trip — but it still costs an attempt, so shape-probing is not free either.
   * 3. **Consumed before binding**, not after. If the bind then fails the code
   *    is spent and the user sends /connect again, which is a fine outcome;
   *    binding first and consuming after leaves a replay window open, which is
   *    not.
   * 4. **Ownership checked before writing.** The unique index would catch it
   *    anyway, but a duplicate-key error cannot say *which* rule was broken.
   */
  async redeemCode(
    userId: string | mongoose.Types.ObjectId,
    rawCode: string
  ): Promise<IChannelConnection> {
    const userIdString = userId.toString();

    const withinLimit = await this.codeStore.recordAttempt(userIdString);
    if (!withinLimit) {
      throw createAppError(ERROR_CODES.CONNECTION_CODE_ATTEMPTS_EXCEEDED, 429);
    }

    const normalized = normalizeConnectionCode(rawCode);
    if (!isWellFormedConnectionCode(normalized)) {
      throw createAppError(ERROR_CODES.CONNECTION_CODE_INVALID, 400);
    }

    const outcome = await this.codeStore.consume(normalized);

    if (outcome.status === 'expired') {
      throw createAppError(ERROR_CODES.CONNECTION_CODE_EXPIRED, 400);
    }
    if (outcome.status === 'missing') {
      // Never-existed, already-spent and long-gone answer identically: saying
      // "already used" would confirm both that a guessed code was real and that
      // somebody had redeemed it.
      throw createAppError(ERROR_CODES.CONNECTION_CODE_INVALID, 400);
    }

    const { record } = outcome;
    const existing = await this.repository.findByIdentity(record.channel, record.externalIdentity);

    if (existing && existing.user_id.toString() !== userIdString) {
      /**
       * Owned by somebody else — refuse, and never transfer.
       *
       * The message names no account, no email and no masked identifier. The
       * caller already knows the messaging account (they hold a code minted
       * from it); what they must not learn is *who else* on this platform holds
       * it, which would turn a phone number into an account-existence probe.
       * `details` carries the channel only, because the client needs to know
       * which card to mark.
       */
      throw createAppError(ERROR_CODES.MESSAGING_IDENTITY_ALREADY_LINKED, 409, undefined, {
        channel: record.channel,
      });
    }

    /**
     * Already ours, or not connected at all — both land here, and `bind` upserts
     * on `(user_id, channel)`. Re-connecting the identity a caller already holds
     * is therefore idempotent: it refreshes the display name and returns
     * success, and can never produce a second row. Replaying the same *code* is
     * still refused, by `consume` above.
     */
    const connection = await this.repository.bind(userId, {
      channel: record.channel,
      externalId: record.externalIdentity,
      displayName: record.displayName,
      handle: record.handle,
    });

    await this.codeStore.clearAttempts(userIdString);

    console.log(
      `[Connections] ${record.channel} connected for user ${userIdString}`
    );

    return connection;
  }

  /** Remove a connection. 404 when there was nothing to remove. */
  async disconnect(
    userId: string | mongoose.Types.ObjectId,
    channel: MessagingChannel
  ): Promise<void> {
    const removed = await this.repository.unbind(userId, channel);
    if (!removed) {
      throw createAppError(ERROR_CODES.MESSAGING_CONNECTION_NOT_FOUND, 404, undefined, { channel });
    }

    console.log(`[Connections] ${channel} disconnected for user ${userId.toString()}`);
  }

  /**
   * Stamp inbound activity on a connection. Best-effort — never let a bookkeeping
   * write fail the message that triggered it.
   */
  async touch(channel: MessagingChannel, externalId: string): Promise<void> {
    try {
      await this.repository.touch(channel, externalId);
    } catch (error) {
      console.error('[Connections] Failed to stamp last_seen_at:', error);
    }
  }
}

export const connectionService = new ConnectionService();
