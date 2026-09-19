import { randomBytes } from 'crypto';
import { BOT_SURFACE_DB, getRedisClient } from '../../../infra/redis/redis.factory';
import { digestForKey } from '../domain/bot-key-digest';

/**
 * Opaque, single-use handles for files a customer sent in a chat (Step 7b).
 *
 * ── THE PROBLEM THIS SOLVES ─────────────────────────────────────────────────
 * A photo arrives on WhatsApp or Telegram as a channel-hosted id, and only the automation
 * layer can turn it into bytes — it holds the channel tokens and this service must never
 * hold them. So the bytes reach us on `POST /files/inbound`, which stores the file and
 * hands back a handle; the model then names that handle when it decides where the file
 * belongs. Three things fall out, and each one is the reason this is not simply a `fileId`:
 *
 *   1. **A model cannot invent a handle**, and it cannot invent a file id either — but a
 *      file id is a real, guessable-shaped identifier for a row that outlives the
 *      conversation. A handle is 16 random bytes that expire, so a caller that guesses is
 *      refused rather than reaching somebody else's upload.
 *   2. **The handle is OWNED.** `consume` refuses a mismatch, so a bug in the automation
 *      layer that crosses two conversations is a clean refusal instead of one customer's
 *      photo landing on another's support ticket.
 *   3. **It expires.** An uploaded file nobody attaches is left to orphan garbage
 *      collection, which is what that collector is for; the handle going stale is what
 *      stops a photo from three days ago being attached to today's ticket.
 *
 * ── WHY THIS IS NOT `GeoCandidateStore` WITH A DIFFERENT PREFIX ─────────────
 * It is the same shape deliberately — same TTL discipline, same owner check, same
 * one-bucket refusal — and the two were kept separate rather than generalised because the
 * *recovery* differs, which is the part below that has no counterpart there. A spent geo
 * handle costs a customer one re-typed address. A spent file handle costs them re-sending a
 * photo they may no longer have, so a failed attach puts the handle back.
 */

/** The same 30 minutes `GeoCandidateStore` uses, for the same reason: it is a chat turn. */
export const INBOUND_FILE_TTL_SECONDS = 30 * 60;

/**
 * 16 random bytes of base64url behind a readable prefix, so a handle is recognisable in a log.
 *
 * ── ⚠ WHY 16, AND WHY IT WAS 32 ─────────────────────────────────────────────
 * It was 32 (a 47-character handle) until 2026-09-19, and nothing about the threat changed: it
 * shrank because the handle now rides a BUTTON. A photo that arrives while the customer has open
 * support requests is answered with "which request is this for?", and each row carries
 * `tkt:<ticketId>:<handle>` — 4 + 24 + 1 + 47 = 76 bytes at 32, past Telegram's 64-byte
 * `callback_data` cap, which Telegram enforces by TRUNCATING the payload in silence. At 16 it is
 * 55 bytes. `domain/bot-ticket-actions.ts` asserts that budget from `INBOUND_FILE_HANDLE_LENGTH`
 * at import, so raising this number back fails the boot rather than every "which request" button.
 *
 * 128 bits is the same strength as every other handle on this surface (`ia_` screen handles,
 * the confirmation MAC), and it guards less than they do: a guess must also match the OWNER on
 * `consume`, inside thirty minutes, once.
 *
 * ⚠ **`consume` deliberately checks the prefix and NOT the length.** Handles minted at 32 bytes
 * before a deploy live for thirty minutes after it, and a length check would refuse a photo the
 * customer sent a minute before the restart.
 */
const HANDLE_BYTES = 16;
const HANDLE_PREFIX = 'att_';

/**
 * How long a handle is, in bytes — every character is base64url, so bytes and characters agree.
 * Derived rather than written, so the budget assertion that reads it cannot drift from the mint.
 */
export const INBOUND_FILE_HANDLE_LENGTH =
    HANDLE_PREFIX.length + Buffer.alloc(HANDLE_BYTES).toString('base64url').length;

/**
 * What a handle stands for. Deliberately NOT the bytes — those are already in storage
 * under `fileId` by the time a handle exists, and holding a second copy in Redis would put
 * a multi-megabyte value on a database sized for session state.
 */
export interface StoredInboundFile {
    /** The `files` row created by the upload pipeline. */
    fileId: string;
    fileName: string;
    mimeType: string;
    size: number;
}

interface StoredRecord extends StoredInboundFile {
    /** The `users` row the handle was minted for. */
    owner: string;
}

/**
 * Read-and-delete atomically, on any Redis from 2.6.
 *
 * ⚠ **Not `GETDEL`.** That is one word for this and landed in Redis 6.2; the development
 * Redis on this platform is 3.0, where it is an unknown command — a hard failure on the
 * first attach, on a server that is otherwise fine. Measured once already on the
 * connections path and invisible to every source scan. It must also never become a `get`
 * then a `del`: two concurrent attaches would both see a live handle and both write an
 * attachment row for one file.
 */
const CONSUME_SCRIPT = `
local value = redis.call("get", KEYS[1])
if value then
  redis.call("del", KEYS[1])
end
return value`;

const handleKey = (ref: string): string => `bot:file:${digestForKey(ref)}`;

export class InboundFileStore {
    /** Mint one handle for a file that is already stored. */
    async mint(owner: string, file: StoredInboundFile): Promise<string> {
        const redis = await getRedisClient(BOT_SURFACE_DB);
        const ref = `${HANDLE_PREFIX}${randomBytes(HANDLE_BYTES).toString('base64url')}`;
        const record: StoredRecord = { owner, ...file };

        await redis.set(handleKey(ref), JSON.stringify(record), { EX: INBOUND_FILE_TTL_SECONDS });

        return ref;
    }

    /**
     * Spend a handle.
     *
     * Returns null for unknown, expired, already-spent AND wrong-owner alike — deliberately
     * one bucket, which the caller turns into `BOT_INBOUND_FILE_EXPIRED`. Distinguishing
     * them would tell a caller that a handle it does not own is real, and all four have the
     * same remedy: ask the customer to send the file again.
     */
    async consume(owner: string, ref: string): Promise<StoredInboundFile | null> {
        if (!ref.startsWith(HANDLE_PREFIX)) return null;

        const redis = await getRedisClient(BOT_SURFACE_DB);
        const raw = (await redis.eval(CONSUME_SCRIPT, { keys: [handleKey(ref)] })) as string | null;
        if (!raw) return null;

        let record: StoredRecord;
        try {
            record = JSON.parse(raw) as StoredRecord;
        } catch {
            // A key we wrote that we cannot read is our bug. It is already spent by the
            // script above, so nothing is left dangling.
            console.error('[BotSurface] malformed inbound-file record');
            return null;
        }

        if (record.owner !== owner) return null;

        const { owner: _owner, ...file } = record;
        return file;
    }

    /**
     * Put a spent handle back, because the attach it was spent on failed.
     *
     * ⚠ **This has no counterpart in `GeoCandidateStore`, and the asymmetry is the point.**
     * The attach can fail for reasons that are the customer's to fix and not the file's —
     * the five-per-ticket limit, a ticket they are not on, a ticket id the model got wrong.
     * Burning the handle on those turns "you already have five files on that ticket" into
     * "…and now send the photo again", for a file that is sitting in storage, correct and
     * unused.
     *
     * Safe against a double attach: only the caller that WON `consume` can reach this, so
     * a concurrent second attempt has already been refused by the time the handle reappears.
     *
     * Best-effort by construction — the caller is already on its way to raising the real
     * error, and a Redis failure here must not replace that error with this one.
     */
    async restore(owner: string, ref: string, file: StoredInboundFile): Promise<void> {
        try {
            const redis = await getRedisClient(BOT_SURFACE_DB);
            const record: StoredRecord = { owner, ...file };
            await redis.set(handleKey(ref), JSON.stringify(record), {
                EX: INBOUND_FILE_TTL_SECONDS,
            });
        } catch {
            /* the original error is the one worth reporting */
        }
    }
}

export const inboundFileStore = new InboundFileStore();
