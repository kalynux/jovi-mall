import { getRedisClient, LOGIN_CODE_DB } from '../../../infra/redis/redis.factory';
import { digestForKey } from '../domain/otp';
import { PHONE_VERIFICATION_CONFIG } from '../config/phone-verification.config';

/**
 * The ten-minute store behind a phone-verification code.
 *
 * ── ONE RECORD, KEYED ON A NAMESPACED SUBJECT ────────────────────────────────
 *
 *   phoneverify:{h(subject)}   the record (target number, code, attempts, sentAt)
 *
 * One record per subject rather than per (subject, number), and that is what makes the resend
 * cooldown bound anything: a per-number record would let one account request a code for a
 * hundred different strangers' phones at full speed, each a real WhatsApp message that costs
 * money and that the recipient reads as an unsolicited message from this platform. Requesting a
 * code for a different number REPLACES the outstanding one, which is also the behaviour a
 * person expects after correcting a typo.
 *
 * ⚠ **The subject is NAMESPACED, never a bare id** — `platformSubject()` / `adminSubject()` in
 * `domain/subject.ts`. Two identity spaces reach this store: platform users, and wi-admin
 * administrators who hold no `users` row here at all. Both are ObjectId-shaped, so a bare id
 * would let an administrator and a customer collide on one key — one person's code silently
 * overwriting another's, and the cooldown of one throttling the other. The namespace makes that
 * impossible rather than unlikely.
 *
 * ── ⚠ IT SHARES `LOGIN_CODE_DB` (14) BEHIND A PREFIX ─────────────────────────
 *
 * A concession, not the rule. This service may only assign Redis databases 5–15, all eleven are
 * taken, and two already hold two things each — `infra/redis/redis.factory.ts` states that the
 * next feature wanting a logical database has to raise `databases` everywhere or share. Sharing
 * with `LOGIN_CODE_DB` is the honest pairing available: both hold short-lived credentials with
 * the same blast radius and the same "losing it costs the user one retry" recovery, so a flush
 * of that database is equally (in)convenient for both halves. `login:` and `phoneverify:`
 * prefixes keep them independently clearable.
 *
 * ── THE KEY NAME IS HASHED, THE VALUE IS NOT ─────────────────────────────────
 *
 * `GET /api/internal/admin/system/cache/keys` lists key NAMES and offers no value read, so a
 * raw user id in a key name is personal data in an operations listing. The same rule
 * `messaging-login`'s store applies, for the same reason. The code lives in the value, where
 * that endpoint cannot reach it.
 */

const PREFIX = 'phoneverify:';

export interface OtpRecord {
    /** E.164, the number being proved. */
    phone: string;
    code: string;
    attempts: number;
    sentAt: Date;
    expiresAt: Date;
    /**
     * Whether this record completes a PENDING CHANGE or merely verifies the number already on
     * the account. Stored rather than re-derived at confirm time, because `pending_phone` can
     * be cancelled in between and the two outcomes write different fields.
     */
    intent: 'verify_current' | 'complete_change';
}

interface StoredOtp {
    phone: string;
    code: string;
    attempts: number;
    sentAt: string;
    expiresAt: string;
    intent: OtpRecord['intent'];
}

function keyFor(subject: string): string {
    return `${PREFIX}${digestForKey(subject)}`;
}

/**
 * The key outlives the code's validity by a grace window.
 *
 * Redis expiry deletes a key, and a deleted key is indistinguishable from one that never
 * existed — so a store whose TTL *is* its validity can only ever answer "invalid". That is the
 * wrong thing to tell the commonest failure: somebody read the message, got distracted, and
 * came back twelve minutes later. `expiresAt` in the value decides redeemability; the key
 * survives long enough to say "expired, request a new one", which is actionable where
 * "invalid" sends them hunting for a typo that is not there. Same reasoning, same numbers, as
 * `messaging-login`'s store.
 */
const GRACE_SECONDS = 600;

export async function putOtp(subject: string, record: OtpRecord): Promise<void> {
    const client = await getRedisClient(LOGIN_CODE_DB);
    const stored: StoredOtp = {
        phone: record.phone,
        code: record.code,
        attempts: record.attempts,
        sentAt: record.sentAt.toISOString(),
        expiresAt: record.expiresAt.toISOString(),
        intent: record.intent,
    };
    await client.set(keyFor(subject), JSON.stringify(stored), {
        EX: PHONE_VERIFICATION_CONFIG.OTP_TTL_SECONDS + GRACE_SECONDS,
    });
}

export async function readOtp(subject: string): Promise<OtpRecord | null> {
    const client = await getRedisClient(LOGIN_CODE_DB);
    const raw = await client.get(keyFor(subject));
    if (!raw) return null;

    try {
        const parsed = JSON.parse(raw) as StoredOtp;
        return {
            phone: parsed.phone,
            code: parsed.code,
            attempts: parsed.attempts,
            sentAt: new Date(parsed.sentAt),
            expiresAt: new Date(parsed.expiresAt),
            intent: parsed.intent,
        };
    } catch {
        // A corrupt value is treated as absent rather than thrown: the remedy is identical
        // (request a new code) and a parse error must not 500 a verification attempt.
        return null;
    }
}

/**
 * Record one wrong guess.
 *
 * ⚠ Read-modify-write, and the race is accepted DELIBERATELY. Two simultaneous wrong guesses
 * could both read `attempts: 2` and both write `3`, costing one attempt of slack. The
 * alternative — a separate `INCR` counter — splits the record's state across two keys that can
 * expire independently, which is a worse failure (a counter surviving its record is a lockout
 * nobody can clear). One extra guess out of five is not the margin this rests on.
 */
export async function recordFailedAttempt(subject: string, record: OtpRecord): Promise<void> {
    await putOtp(subject, { ...record, attempts: record.attempts + 1 });
}

/** Spend or abandon the record. Idempotent — deleting an absent key is not an error. */
export async function clearOtp(subject: string): Promise<void> {
    const client = await getRedisClient(LOGIN_CODE_DB);
    await client.del(keyFor(subject));
}
