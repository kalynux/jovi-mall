import { getRedisClient, CONNECTION_CODE_DB } from '../../../infra/redis/redis.factory';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { MessagingChannel } from '../domain/channel';
import { generateConnectionCode, normalizeConnectionCode } from '../domain/connection-code';

/**
 * The temporary store for connection codes.
 *
 * ── THIS FILE IS THE SECURITY BOUNDARY ───────────────────────────────────────
 * A 6-character code is 2^30 of entropy (see `domain/connection-code.ts`), which
 * is NOT enough on its own. Three guards live here and each is load-bearing:
 *
 *   1. `issue()` revokes the identity's previous code, so one messaging identity
 *      never has more than one live code — the guessable set cannot accumulate
 *      over a ten-minute window no matter how often somebody sends /connect.
 *   2. `consume()` spends a code atomically, so it cannot be redeemed twice.
 *   3. `recordAttempt()` bounds guesses per redeeming account, on top of the
 *      identity rate limiter every authenticated route already inherits.
 *
 * Weaken any one of them and the code length becomes the whole defence.
 */

/** 10 minutes, in seconds. How long a code may actually be redeemed. */
export const CONNECTION_CODE_TTL_SECONDS = 600;

/**
 * How much longer the KEY survives past the code's validity.
 *
 * ── Why the key outlives the code ────────────────────────────────────────────
 * Redis expiry deletes the key, and a deleted key is indistinguishable from one
 * that never existed. So a store whose TTL *is* the validity can only ever
 * answer "invalid" — and "invalid" is the wrong thing to tell the overwhelmingly
 * common failure, which is a person who read the code, got distracted, and came
 * back twelve minutes later. "Expired, send /connect again" is actionable;
 * "invalid" sends them hunting for a typo that is not there.
 *
 * So the record carries `expiresAt`, the key lives `TTL + GRACE`, and `consume`
 * compares. Past `expiresAt` the code is dead — it is never redeemable during
 * the grace window, only *explicable*.
 *
 * The cost is a bounded oracle: for `GRACE` seconds after expiry, a caller who
 * guesses a real code learns it was once real rather than being told nothing.
 * That is worth the trade here and is not worth it everywhere — the code names
 * no account (it is minted before anyone claims it), the search space is 2^30,
 * and `CONNECTION_CODE_MAX_ATTEMPTS` bounds guesses to 5 per account per window.
 * Contrast `AUTH_RESET_TOKEN_INVALID`, which stays deliberately undifferentiated
 * because a password-reset token DOES name an account.
 */
export const CONNECTION_CODE_GRACE_SECONDS = 600;

/** Redemption attempts per account per window. */
export const CONNECTION_CODE_MAX_ATTEMPTS = 5;

/**
 * Candidates tried before giving up. One collision against a ~10-minute
 * population is astronomically unlikely; five in a row means the RNG is broken,
 * and failing loudly beats looping — the same argument and the same number as
 * `TrackingNumberGenerator`'s MAX_GENERATION_ATTEMPTS.
 */
const MAX_GENERATION_ATTEMPTS = 5;

/**
 * Read-and-delete, atomically, on any Redis from 2.6 onwards.
 *
 * `GETDEL` says this in one word and is the obvious choice — but it landed in **Redis 6.2**,
 * and this platform's own development Redis is 3.0, where it is an unknown command. That is
 * not a hypothetical portability worry: it is a hard failure the first time anybody redeems
 * a code, on a server that is otherwise fine.
 *
 * A Lua script is the portable form of the same guarantee — Redis runs one atomically, so
 * nothing can observe or spend the key between the GET and the DEL. It is one round trip,
 * exactly as `GETDEL` is. `core/jobs/worker-lock.ts` already reaches for `eval` for its
 * compare-and-delete, so this is the established shape here rather than a new mechanism.
 *
 * What must NOT be done is a `get` followed by a `del`: two concurrent redemptions both see
 * a live code and both succeed, which is precisely the defect that made the predecessor
 * Telegram token redeemable twice while its docstring called it single-use.
 */
const CONSUME_SCRIPT = `
local value = redis.call("get", KEYS[1])
if value then
  redis.call("del", KEYS[1])
end
return value`;

const codeKey = (code: string): string => `connection:code:${code}`;
const identityKey = (channel: MessagingChannel, externalId: string): string =>
  `connection:identity:${channel}:${externalId}`;
const attemptKey = (userId: string): string => `connection:attempts:${userId}`;

/**
 * What a code stands for: a messaging identity, and nothing about any platform
 * account. The code is minted before anybody knows who will claim it — that
 * inversion is the whole design, and it is why a leaked code discloses a
 * WhatsApp number at worst and never an account.
 */
export interface ConnectionCodeRecord {
  channel: MessagingChannel;
  externalIdentity: string;
  displayName?: string | null;
  handle?: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface IssuedConnectionCode {
  code: string;
  expiresAt: Date;
  ttlSeconds: number;
}

/**
 * The outcome of spending a code, as a discriminated union.
 *
 * Three outcomes, not two, and the caller maps them to three different errors.
 * `missing` covers never-existed, already-spent and long-gone together —
 * deliberately one bucket, because distinguishing "already used" would confirm
 * both that a guessed code was real AND that somebody had used it.
 */
export type ConsumeResult =
  | { status: 'ok'; record: ConnectionCodeRecord }
  | { status: 'expired' }
  | { status: 'missing' };

export interface IssueConnectionCodeInput {
  channel: MessagingChannel;
  externalIdentity: string;
  displayName?: string | null;
  handle?: string | null;
}

export class ConnectionCodeStore {
  /**
   * Mint a code for a messaging identity. Called by the bot ingress (`/connect`).
   *
   * Two properties, both structural:
   *
   * **`SET … NX` is what makes the collision check atomic.** A `GET`-then-`SET`
   * lets two concurrent mints agree that a code is free and both take it — the
   * second silently overwriting the first person's identity, so they redeem and
   * bind somebody else's WhatsApp account. `NX` is the whole guard; do not
   * "simplify" it into a read followed by a write.
   *
   * **The previous code for this identity is revoked first.** Otherwise sending
   * /connect ten times leaves ten live codes for one person, multiplying the odds
   * of a blind guess landing by ten for no benefit — the user only ever uses the
   * newest one.
   */
  async issue(input: IssueConnectionCodeInput): Promise<IssuedConnectionCode> {
    const redis = await getRedisClient(CONNECTION_CODE_DB);

    await this.revokeForIdentity(input.channel, input.externalIdentity);

    for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt++) {
      // Normalised on the way in as well as on the way out, so the key written
      // here and the key looked up at redemption come from one function and
      // cannot drift. Generated codes are fixed points of `normalize`, so this
      // is a no-op today — it stays because it is what keeps that true.
      const code = normalizeConnectionCode(generateConnectionCode());

      const now = new Date();
      const expiresAt = new Date(now.getTime() + CONNECTION_CODE_TTL_SECONDS * 1000);

      const record: ConnectionCodeRecord = {
        channel: input.channel,
        externalIdentity: input.externalIdentity,
        displayName: input.displayName ?? null,
        handle: input.handle ?? null,
        createdAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
      };

      const claimed = await redis.set(codeKey(code), JSON.stringify(record), {
        NX: true,
        // Outlives the code's validity on purpose — see CONNECTION_CODE_GRACE_SECONDS.
        // `expiresAt` in the record, not this TTL, is what decides redeemability.
        EX: CONNECTION_CODE_TTL_SECONDS + CONNECTION_CODE_GRACE_SECONDS,
      });

      if (claimed === null) continue; // taken — draw again

      // The reverse pointer, so the next /connect from this identity can revoke
      // this code. Only the VALIDITY, not the grace: an expired code needs no
      // revoking, and a pointer outliving usefulness would make the next
      // /connect do a pointless delete.
      await redis.set(identityKey(input.channel, input.externalIdentity), code, {
        EX: CONNECTION_CODE_TTL_SECONDS,
      });

      return { code, expiresAt, ttlSeconds: CONNECTION_CODE_TTL_SECONDS };
    }

    throw createAppError(
      ERROR_CODES.CONNECTION_CODE_GENERATION_FAILED,
      500,
      undefined,
      { attempts: MAX_GENERATION_ATTEMPTS }
    );
  }

  /**
   * Spend a code, atomically. See `CONSUME_SCRIPT` for why this is a Lua script
   * and not `GETDEL`, and why it must never become a `get` then a `del`.
   *
   * The key is deleted either way — an expired code is spent by the attempt to
   * use it, so the grace window explains one failure per code and never becomes
   * a repeatable probe.
   *
   * @returns `ok` with the identity, `expired`, or `missing` (never real,
   *   already spent, or older than the grace window — one bucket, deliberately).
   */
  async consume(rawCode: string): Promise<ConsumeResult> {
    const code = normalizeConnectionCode(rawCode);
    const redis = await getRedisClient(CONNECTION_CODE_DB);

    const raw = (await redis.eval(CONSUME_SCRIPT, { keys: [codeKey(code)] })) as string | null;
    if (!raw) return { status: 'missing' };

    let record: ConnectionCodeRecord;
    try {
      record = JSON.parse(raw) as ConnectionCodeRecord;
    } catch {
      // A key we wrote that we cannot read is a bug, not a user error. The code
      // is already spent by the script above, so there is nothing to clean up.
      console.error('[ConnectionCodeStore] Malformed record for a live connection code');
      return { status: 'missing' };
    }

    // Drop the reverse pointer so a later /connect does not try to revoke a code
    // that is already gone. Best-effort: it expires on its own regardless.
    await redis.del(identityKey(record.channel, record.externalIdentity));

    const expiresAt = Date.parse(record.expiresAt);
    // An unparseable stamp is our bug, and the safe reading of "I cannot tell
    // when this expires" is that it has.
    if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) {
      return { status: 'expired' };
    }

    return { status: 'ok', record };
  }

  /**
   * Count one redemption attempt against an account.
   *
   * Called BEFORE `consume`, deliberately: counting only failures would let a
   * guesser spend other people's live codes for free, and the point is to bound
   * how many codes one account may test at all.
   *
   * @returns false when the account is over its ceiling for this window.
   */
  async recordAttempt(userId: string): Promise<boolean> {
    const redis = await getRedisClient(CONNECTION_CODE_DB);
    const key = attemptKey(userId);

    const attempts = await redis.incr(key);
    if (attempts === 1) {
      // Only on creation — a sliding expiry would let a steady drip of guesses
      // hold the window open indefinitely and never reset the counter.
      await redis.expire(key, CONNECTION_CODE_TTL_SECONDS);
    }

    return attempts <= CONNECTION_CODE_MAX_ATTEMPTS;
  }

  /** Clear the counter after a successful bind, so a typo costs nothing later. */
  async clearAttempts(userId: string): Promise<void> {
    const redis = await getRedisClient(CONNECTION_CODE_DB);
    await redis.del(attemptKey(userId));
  }

  /** Drop whatever live code this identity currently owns, if any. */
  private async revokeForIdentity(
    channel: MessagingChannel,
    externalId: string
  ): Promise<void> {
    const redis = await getRedisClient(CONNECTION_CODE_DB);
    const pointer = identityKey(channel, externalId);

    // Same script, same reason — and atomic here too, so two simultaneous
    // /connect messages from one identity cannot both read the same pointer and
    // race to revoke each other's fresh code.
    const previous = (await redis.eval(CONSUME_SCRIPT, { keys: [pointer] })) as string | null;
    if (previous) {
      await redis.del(codeKey(previous));
    }
  }
}

export const connectionCodeStore = new ConnectionCodeStore();
