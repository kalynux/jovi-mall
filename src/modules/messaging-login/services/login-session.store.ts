import { getRedisClient, LOGIN_CODE_DB } from '../../../infra/redis/redis.factory';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { MessagingChannel } from '../../channel-connections/domain/channel';
import {
  generateLoginCode,
  isWellFormedLoginCode,
  normalizeLoginCode,
} from '../domain/login-code';
import {
  digestForKey,
  generateLoginSessionId,
  generateLoginToken,
  isWellFormedLoginToken,
} from '../domain/login-token';

/**
 * The ten-minute store behind a `/login` reply.
 *
 * ── ONE RECORD, SEVERAL POINTERS ─────────────────────────────────────────────
 * A sign-in session is ONE record with several keys pointing at it:
 *
 *   login:session:{sessionId}            the record            TTL + grace
 *   login:token:{h(token)}    → sessionId  the magic link      TTL + grace
 *   login:code:{h(CODE)}      → sessionId  the typed code      TTL + grace
 *   login:identity:{channel}:{h(extId)} → sessionId            TTL
 *   login:attempts:{h(identifier)}       a counter             TTL
 *
 * That shape is what makes "using either credential kills the other" TRUE rather
 * than merely enforced: spending is a single atomic delete of the RECORD, and
 * both credentials are pointers at it. There is no second source of truth to
 * keep in step, and no ordering in which one can be spent twice.
 *
 * ── THE RECORD IS A POINTER WITH A DEADLINE, NOT A SESSION ───────────────────
 * It stores **ids, never a snapshot**. A suspension, a role change or a deletion
 * inside those ten minutes must be visible at redemption, and a cached copy of
 * the account would not see it. `MessagingLoginService` re-checks every gate
 * against live data when it spends one.
 *
 * ── THE KEY NAMES ARE HASHED, THE VALUES ARE NOT ─────────────────────────────
 * `GET /api/internal/admin/system/cache/keys` lists key NAMES for any
 * catalogued database and deliberately offers no value read. So every secret and
 * every personal identifier this feature would otherwise put in a name is
 * hashed — see `digestForKey`. `sessionId` is left in the clear because it is
 * neither: it is opaque randomness that names nothing.
 */

/** 10 minutes, in seconds. How long a credential may actually be redeemed. */
export const LOGIN_SESSION_TTL_SECONDS = 600;

/**
 * How much longer the KEYS survive past the credential's validity.
 *
 * ── Why the keys outlive the session ─────────────────────────────────────────
 * Redis expiry deletes a key, and a deleted key is indistinguishable from one
 * that never existed — so a store whose TTL *is* its validity can only ever
 * answer "invalid". That is the wrong thing to tell the overwhelmingly common
 * failure: somebody read the message, got distracted, and came back twelve
 * minutes later. "Expired, send /login again" is actionable; "invalid" sends
 * them hunting for a typo that is not there.
 *
 * ⚠ THE GRACE MUST BE ON THE POINTERS TOO, not only on the record. The design
 * note this was built from put the record at `TTL + grace` and the pointers at
 * `TTL` — under which a token whose pointer had expired could never resolve to
 * its record at all, so `MAGIC_LINK_EXPIRED` and `MAGIC_CODE_EXPIRED` would be
 * unreachable and every late user would be told INVALID. The two credential
 * pointers therefore carry the same `TTL + grace` as the record.
 *
 * The IDENTITY pointer keeps the validity alone, and that asymmetry is correct:
 * it exists so a second `/login` can revoke the first, and an expired session
 * needs no revoking.
 *
 * The cost is a bounded oracle — for `GRACE` seconds after expiry, someone
 * holding a real credential learns it was once real. Worth it here for the same
 * reason it is worth it for connection codes, and bounded by the same things:
 * 2^40 (code) or 2^256 (token) of search space, and a per-identifier attempt
 * ceiling. Note a credential is SPENT by the attempt either way, so the grace
 * explains one failure per credential and never becomes a repeatable probe.
 */
export const LOGIN_SESSION_GRACE_SECONDS = 600;

/** Redemption attempts per identifier per window. */
export const LOGIN_MAX_ATTEMPTS = 5;

/**
 * Candidates tried before giving up. At 2^40 against a ten-minute population one
 * collision is already implausible; five in a row means the RNG is broken, and
 * failing loudly beats looping. Same number and same argument as the connection
 * code store and `TrackingNumberGenerator`.
 */
const MAX_GENERATION_ATTEMPTS = 5;

/**
 * Read-and-delete, atomically, on any Redis from 2.6 onwards.
 *
 * `GETDEL` says this in one word and landed in **Redis 6.2**; this platform's
 * development Redis is 3.0, where it is an unknown command — a hard failure on
 * the first redemption, on a server that is otherwise fine. A Lua script is the
 * portable form of the same guarantee and is the shape `core/jobs/worker-lock.ts`
 * and `connection-code.store.ts` already use.
 *
 * It must NEVER become a `get` followed by a `del`: two concurrent redemptions
 * would both see a live session and both succeed, which is exactly the defect
 * that once made the predecessor Telegram token redeemable twice while its
 * docstring called it single-use. Here it would mean two sessions minted from
 * one credential.
 */
const CONSUME_SCRIPT = `
local value = redis.call("get", KEYS[1])
if value then
  redis.call("del", KEYS[1])
end
return value`;

const sessionKey = (sessionId: string): string => `login:session:${sessionId}`;
const tokenKey = (token: string): string => `login:token:${digestForKey(token)}`;
const codeKey = (code: string): string => `login:code:${digestForKey(code)}`;
/**
 * Where a sign-in credential came from.
 *
 * `whatsapp` / `telegram` are messaging identities the sender PROVED they control, and
 * `externalIdentity` is that identity. `admin` is the third origin: an administrator
 * issued the link on somebody else's behalf, so there is no messaging identity to name
 * and `externalIdentity` is the target **user id** instead.
 *
 * Widened here rather than in `channel-connections`: that module's `MessagingChannel` is
 * the set of channels an account can be BOUND to, and nobody binds an account to an
 * administrator. What this type names is the origin of one credential, which is a
 * different question that happens to share two of its answers.
 *
 * Making `admin` a member of the identity namespace is what gives the administrative
 * path the same single-live-credential property the bot path has: re-issuing for the
 * same user revokes the previous link, because both land on the same identity key.
 */
export type LoginSessionChannel = MessagingChannel | 'admin';

const identityKey = (channel: LoginSessionChannel, externalId: string): string =>
  `login:identity:${channel}:${digestForKey(externalId)}`;
const attemptKey = (identifier: string): string =>
  `login:attempts:${digestForKey(identifier)}`;

/**
 * What a sign-in credential stands for.
 *
 * `userId` and `customerId` are the only things redemption needs — the customer
 * profile is resolved at mint so spending is one read rather than three. Both
 * are RE-VALIDATED at redemption; they are here to avoid a lookup, never to
 * avoid a check.
 *
 * `token`, `code` and `externalIdentity` are carried so that spending one
 * credential can delete EVERY pointer at the same instant. Without them the
 * record would know nothing about the keys aimed at it, and "using either kills
 * the other" would need a second index to make true.
 */
export interface LoginSessionRecord {
  sessionId: string;
  userId: string;
  customerId: string;
  channel: LoginSessionChannel;
  /**
   * The identity this was minted for — a messaging account on the bot paths, the target
   * user id on the administrative one. Used to revoke on re-issue.
   */
  externalIdentity: string;
  /** `••••3456` / `@handle`, for the "signed in from WhatsApp ••••3456" line. */
  identityHint: string | null;
  token: string;
  code: string;
  createdAt: string;
  expiresAt: string;
}

export interface IssuedLoginSession {
  sessionId: string;
  token: string;
  code: string;
  expiresAt: Date;
  ttlSeconds: number;
}

/**
 * The outcome of spending a credential.
 *
 * Three outcomes, and the caller maps them to different errors. `missing` covers
 * never-existed, already-spent and long-gone together — deliberately one bucket,
 * because distinguishing "already used" would confirm both that a guessed
 * credential was real AND that somebody had used it.
 */
export type ConsumeLoginResult =
  | { status: 'ok'; record: LoginSessionRecord }
  /**
   * Carries the record too, and that is not incidental. `redeemCode` must
   * confirm the credential belongs to the account the caller NAMED before it is
   * willing to say "expired" — otherwise expiry becomes the oracle that
   * `MAGIC_CODE_INVALID` exists to close, answering "that code was real" to
   * somebody who guessed it alongside a stranger's phone number.
   */
  | { status: 'expired'; record: LoginSessionRecord }
  | { status: 'missing' };

export interface IssueLoginSessionInput {
  userId: string;
  customerId: string;
  channel: LoginSessionChannel;
  externalIdentity: string;
  identityHint: string | null;
}

export class LoginSessionStore {
  /**
   * Mint one session and the two credentials that redeem it.
   *
   * Ordering, and why it is this way:
   *
   * 1. **The identity's previous session is revoked first.** Sending `/login`
   *    five times leaves ONE live credential pair, not five — so the guessable
   *    population stays flat however often somebody taps, and one person never
   *    holds several live ways into their own account.
   * 2. **Both credential pointers are claimed with `SET … NX`** before the
   *    record is written. `NX` is what makes the collision check atomic; a
   *    `GET`-then-`SET` lets two concurrent mints agree a code is free and both
   *    take it, the second silently overwriting the first person's session — so
   *    one user redeems and is signed in as the other. Do not "simplify" it.
   * 3. **The record is written last** (bar the identity pointer). For the
   *    sub-millisecond window in which a pointer exists and its record does not,
   *    a redemption answers `missing` — which is INVALID, the fail-closed
   *    direction, for a credential the user has not been shown yet.
   */
  async issue(input: IssueLoginSessionInput): Promise<IssuedLoginSession> {
    const redis = await getRedisClient(LOGIN_CODE_DB);

    await this.revokeForIdentity(input.channel, input.externalIdentity);

    const sessionId = generateLoginSessionId();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + LOGIN_SESSION_TTL_SECONDS * 1000);
    const pointerTtl = LOGIN_SESSION_TTL_SECONDS + LOGIN_SESSION_GRACE_SECONDS;

    let code: string | null = null;
    for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt++) {
      // Normalised on the way in as well as on the way out, so the key written
      // here and the key looked up at redemption come from one function and
      // cannot drift. Generated codes are fixed points of `normalize`, so this
      // is a no-op today — it stays because it is what keeps that true.
      const candidate = normalizeLoginCode(generateLoginCode());
      const claimed = await redis.set(codeKey(candidate), sessionId, {
        NX: true,
        EX: pointerTtl,
      });
      if (claimed !== null) {
        code = candidate;
        break;
      }
    }

    if (!code) {
      throw createAppError(
        ERROR_CODES.MAGIC_SESSION_GENERATION_FAILED,
        500,
        undefined,
        { attempts: MAX_GENERATION_ATTEMPTS }
      );
    }

    // 2^256. `NX` here is uniformity rather than necessity — but a token
    // collision that silently overwrote another session would be the worst bug
    // this file could have, so it is not left to arithmetic.
    const token = generateLoginToken();
    const tokenClaimed = await redis.set(tokenKey(token), sessionId, {
      NX: true,
      EX: pointerTtl,
    });
    if (tokenClaimed === null) {
      await redis.del(codeKey(code));
      throw createAppError(ERROR_CODES.MAGIC_SESSION_GENERATION_FAILED, 500);
    }

    const record: LoginSessionRecord = {
      sessionId,
      userId: input.userId,
      customerId: input.customerId,
      channel: input.channel,
      externalIdentity: input.externalIdentity,
      identityHint: input.identityHint,
      token,
      code,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };

    await redis.set(sessionKey(sessionId), JSON.stringify(record), { EX: pointerTtl });

    // The reverse pointer, so the NEXT /login from this identity can revoke this
    // session. Validity only, not the grace — an expired session needs no
    // revoking, and a pointer outliving its usefulness would only make the next
    // /login do a pointless delete.
    await redis.set(identityKey(input.channel, input.externalIdentity), sessionId, {
      EX: LOGIN_SESSION_TTL_SECONDS,
    });

    return { sessionId, token, code, expiresAt, ttlSeconds: LOGIN_SESSION_TTL_SECONDS };
  }

  /** Redeem the magic link. */
  async consumeByToken(rawToken: string): Promise<ConsumeLoginResult> {
    // A value that cannot be one of ours costs no round trip. It still costs an
    // attempt at the caller's layer, so shape-probing is not free either.
    if (!isWellFormedLoginToken(rawToken)) return { status: 'missing' };

    const redis = await getRedisClient(LOGIN_CODE_DB);
    const sessionId = await redis.get(tokenKey(rawToken));
    if (!sessionId) return { status: 'missing' };

    return this.spend(sessionId);
  }

  /** Redeem the typed code. */
  async consumeByCode(rawCode: string): Promise<ConsumeLoginResult> {
    const code = normalizeLoginCode(rawCode);
    if (!isWellFormedLoginCode(code)) return { status: 'missing' };

    const redis = await getRedisClient(LOGIN_CODE_DB);
    const sessionId = await redis.get(codeKey(code));
    if (!sessionId) return { status: 'missing' };

    return this.spend(sessionId);
  }

  /**
   * Spend a session, atomically, and revoke everything aimed at it.
   *
   * **The RECORD is deleted first, in one atomic operation** — that single
   * delete is what spends both credentials at once, and it is why two concurrent
   * redemptions (one by link, one by code, or two of either) produce exactly one
   * winner. The pointers are swept afterwards; they are bookkeeping, and they
   * expire on their own if this process dies between the two.
   *
   * The record is deleted even when EXPIRED. A credential is spent by the
   * attempt to use it, so the grace window explains one failure per credential
   * and never becomes a repeatable probe.
   */
  private async spend(sessionId: string): Promise<ConsumeLoginResult> {
    const redis = await getRedisClient(LOGIN_CODE_DB);

    const raw = (await redis.eval(CONSUME_SCRIPT, {
      keys: [sessionKey(sessionId)],
    })) as string | null;
    if (!raw) return { status: 'missing' };

    let record: LoginSessionRecord;
    try {
      record = JSON.parse(raw) as LoginSessionRecord;
    } catch {
      // A key we wrote that we cannot read is a bug, not a user error. The
      // session is already spent by the script above, so nothing is left open.
      console.error('[MessagingLogin] Malformed record for a live sign-in session');
      return { status: 'missing' };
    }

    await this.dropPointers(record);

    const expiresAt = Date.parse(record.expiresAt);
    // An unparseable stamp is our bug, and the safe reading of "I cannot tell
    // when this expires" is that it has.
    if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) {
      return { status: 'expired', record };
    }

    return { status: 'ok', record };
  }

  /**
   * Revoke a session by id, whether or not anybody redeemed it.
   *
   * Used by `revokeForIdentity` on re-issue. Reads the record to learn which
   * pointers exist, then removes all of them — a session whose record is already
   * gone needs nothing, since its pointers expire on their own.
   */
  async revokeSession(sessionId: string): Promise<void> {
    const redis = await getRedisClient(LOGIN_CODE_DB);

    const raw = (await redis.eval(CONSUME_SCRIPT, {
      keys: [sessionKey(sessionId)],
    })) as string | null;
    if (!raw) return;

    try {
      await this.dropPointers(JSON.parse(raw) as LoginSessionRecord);
    } catch {
      /* A record we cannot parse is already deleted; its pointers will lapse. */
    }
  }

  /** Best-effort: the record is what counts, and it is gone by the time we get here. */
  private async dropPointers(record: LoginSessionRecord): Promise<void> {
    const redis = await getRedisClient(LOGIN_CODE_DB);
    await redis.del([
      tokenKey(record.token),
      codeKey(record.code),
      identityKey(record.channel, record.externalIdentity),
    ]);
  }

  /** Drop whatever live session this identity currently owns, if any. */
  private async revokeForIdentity(
    channel: LoginSessionChannel,
    externalId: string
  ): Promise<void> {
    const redis = await getRedisClient(LOGIN_CODE_DB);

    // Atomic here too, so two simultaneous /login messages from one identity
    // cannot both read the same pointer and race to revoke each other's fresh
    // session.
    const previous = (await redis.eval(CONSUME_SCRIPT, {
      keys: [identityKey(channel, externalId)],
    })) as string | null;
    if (previous) await this.revokeSession(previous);
  }

  /**
   * Count one redemption attempt against the identifier being TARGETED.
   *
   * Keyed on the account somebody is trying to reach, not on the caller, because
   * the caller is anonymous here — this endpoint takes no session. That is also
   * why it must be called BEFORE the credential is consumed: counting only
   * failures would let a guesser spend other people's live codes for free.
   *
   * The identifier is hashed into the key. It is a phone number or an email
   * address, and Redis key names are listable on the operations surface.
   *
   * @returns false when this identifier is over its ceiling for the window.
   */
  async recordAttempt(identifier: string): Promise<boolean> {
    const redis = await getRedisClient(LOGIN_CODE_DB);
    const key = attemptKey(identifier);

    const attempts = await redis.incr(key);
    if (attempts === 1) {
      // Only on creation — a sliding expiry would let a steady drip of guesses
      // hold the window open indefinitely and never reset the counter.
      await redis.expire(key, LOGIN_SESSION_TTL_SECONDS);
    }

    return attempts <= LOGIN_MAX_ATTEMPTS;
  }

  /** Clear the counter after a successful sign-in, so a typo costs nothing later. */
  async clearAttempts(identifier: string): Promise<void> {
    const redis = await getRedisClient(LOGIN_CODE_DB);
    await redis.del(attemptKey(identifier));
  }
}

export const loginSessionStore = new LoginSessionStore();
