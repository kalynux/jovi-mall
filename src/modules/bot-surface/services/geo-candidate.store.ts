import { randomBytes } from 'crypto';
import { BOT_SURFACE_DB, getRedisClient } from '../../../infra/redis/redis.factory';
import { GeoCandidate } from '../../../core/geocoding';
import { digestForKey } from '../domain/bot-key-digest';

/**
 * Opaque, single-use handles for geocoding candidates (GAP-005).
 *
 * ── THE PROBLEM THIS SOLVES, AND WHY IT IS NOT TIDINESS ─────────────────────
 * `GET /api/geo/search` returns candidates and `POST /api/customer/addresses` takes a
 * `geo` object, so between them the CALLER holds coordinates and sends them back. For a
 * browser that is fine — a person picked the pin they can see. For a bot it is wrong
 * twice over:
 *
 *   1. **A machine that can construct a `geo` object can construct a wrong one**, and an
 *      address that looks right and points somewhere else is a delivery to the wrong
 *      street. Nothing downstream can tell the difference.
 *   2. **A `null` inside the 2dsphere-indexed saved-address array makes the WHOLE
 *      customer document unwritable.** Measured, and not fixed by a sparse or partial
 *      index — the key must be omitted, which is what `dropNullLocation` exists for. A
 *      caller assembling `geo` objects sends a null eventually, and the failure presents
 *      as "this customer cannot be edited at all", days later, on an unrelated screen.
 *
 * So the coordinates never leave the backend. `/geo/search` and `/geo/reverse` keep the
 * full candidate here and hand back a handle; `POST /addresses` takes the handle. Three
 * properties fall out for free: it is structurally impossible to save an ungeocoded
 * address, the backend never receives a null coordinate to write, and the handle being
 * single-use makes the save idempotent under retry.
 *
 * ── THE HANDLE IS OWNED ──────────────────────────────────────────────────────
 * A record names the account it was minted for, and `consume` refuses a mismatch. The
 * handle is 32 random bytes, so this is not the thing standing between two customers —
 * it is what makes "a handle belongs to one conversation" a property of the code rather
 * than of the arithmetic, and it turns a bug in the automation layer (one flow reusing
 * another's ref) into a clean refusal instead of an address saved to a stranger.
 *
 * ── WHY THE VALUE IS THE WHOLE CANDIDATE ────────────────────────────────────
 * Not a provider place id to re-resolve. Re-resolving would mean a second provider call
 * on the save path — rate-limited, and on the chain a different provider may answer — so
 * the address a customer confirmed and the address that gets stored could differ. What
 * they agreed to is what is kept.
 */

/** The flow window. GAP-005's stated 30 minutes. */
export const GEO_CANDIDATE_TTL_SECONDS = 30 * 60;

/** 32 bytes of base64url, behind a readable prefix so a handle is recognisable in a log. */
const HANDLE_BYTES = 32;
const HANDLE_PREFIX = 'gc_';

export interface StoredGeoCandidate {
    candidate: GeoCandidate;
    /** Exactly what the customer typed, carried onto the stored `GeoAddress.raw_input`. */
    rawInput: string | null;
}

/**
 * Read-and-delete atomically, on any Redis from 2.6.
 *
 * `GETDEL` says this in one word and landed in Redis 6.2; the development Redis on this
 * platform is 3.0, where it is an unknown command — a hard failure on the first save, on
 * a server that is otherwise fine. Caught once already by `verify:connections`, and
 * invisible to every source scan. It must never become a `get` then a `del`: two
 * concurrent saves would both see a live handle and both write an address.
 */
const CONSUME_SCRIPT = `
local value = redis.call("get", KEYS[1])
if value then
  redis.call("del", KEYS[1])
end
return value`;

const handleKey = (ref: string): string => `bot:geo:${digestForKey(ref)}`;

interface StoredRecord extends StoredGeoCandidate {
    /** The `users` row the handle was minted for. */
    owner: string;
}

export class GeoCandidateStore {
    /**
     * Mint one handle per candidate, in the order the provider ranked them.
     *
     * Pipelined into one round trip rather than awaited in a loop: a search returns up to
     * ten candidates, and ten sequential round trips on the path a person is waiting on is
     * a visible pause for no reason.
     */
    async mint(
        owner: string,
        candidates: readonly GeoCandidate[],
        rawInput: string | null,
    ): Promise<string[]> {
        if (candidates.length === 0) return [];

        const redis = await getRedisClient(BOT_SURFACE_DB);
        const refs = candidates.map(() => `${HANDLE_PREFIX}${randomBytes(HANDLE_BYTES).toString('base64url')}`);

        await Promise.all(
            candidates.map((candidate, i) => {
                const record: StoredRecord = { owner, candidate, rawInput };
                return redis.set(handleKey(refs[i]), JSON.stringify(record), {
                    EX: GEO_CANDIDATE_TTL_SECONDS,
                });
            }),
        );

        return refs;
    }

    /**
     * Spend a handle.
     *
     * Returns null for unknown, expired, already-spent AND wrong-owner alike — deliberately
     * one bucket, which the caller turns into `BOT_GEO_CANDIDATE_EXPIRED`. Distinguishing
     * them would tell a caller that a handle it does not own is real, and every one of the
     * four has the same remedy: run the search again. Never re-send held coordinates.
     */
    async consume(owner: string, ref: string): Promise<StoredGeoCandidate | null> {
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
            console.error('[BotSurface] malformed geo-candidate record');
            return null;
        }

        if (record.owner !== owner) return null;

        return { candidate: record.candidate, rawInput: record.rawInput };
    }
}

export const geoCandidateStore = new GeoCandidateStore();
