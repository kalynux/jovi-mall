#!/usr/bin/env ts-node

/**
 * Backfill the actor-stamp discriminator — `<prefix>_source` and `<prefix>_name`.
 *
 * Closes **J6** (ADR-004 § Deferred), the last of the actor-provenance work. Every
 * `actorStampFields()` site now declares the pair in its schema; this fills them in on the
 * rows that were written **before** their field existed, which is where a mongoose default
 * never reaches.
 *
 * ── Why a default is not enough, and this is not busywork ─────────────────────
 * `actorStampFields()` gives `<prefix>_source` a schema default of `'platform'`. Mongoose
 * applies that when it **writes** a new document — it does not apply it to documents already
 * in the collection, and a `$set` update on an existing row does not add a missing path
 * either. So an old row simply has no such field.
 *
 * That would be invisible if everything read through mongoose. It is not: **wi-admin reads
 * `jovi_mall` with the raw MongoDB driver**, so it sees `undefined` where a hydrated mongoose
 * document would show `'platform'`.
 *
 * ── What this does and does not change ────────────────────────────────────────
 * ⚠ **It changes no value any client renders today.** Every wi-admin read site already
 * writes `row.<prefix>_source ?? 'platform'` — in the agent, agency, user, vendor, billing,
 * COD and money surfaces. This migration makes the stored data agree with
 * what is already displayed, so the fallback becomes a redundancy rather than a guess, and
 * an analyst querying `jovi_mall` directly stops seeing a field that is present on some rows
 * and absent on others for no reason they can discover.
 *
 * ── Why `'platform'` is CORRECT for every row this touches, not merely a default ─
 * A row with no `<prefix>_source` was written before that field existed on its model. Two
 * facts make the value certain rather than assumed:
 *
 *  1. The only actor ids that existed then came from the `users` collection — **including
 *     the legacy `admin` role**, which is a platform user row by definition and therefore
 *     genuinely `'platform'`.
 *  2. wi-admin's synthetic actor reaches this database only through `requireAdminCaller`
 *     on `/api/internal/admin/*`, and each of those write paths landed in the **same
 *     change** as the `actorStampFields()` call on the field it stamps — the ADR's "belongs
 *     with the endpoints that use them". So there is no window in which an administrator
 *     could write a row whose model had no discriminator.
 *
 * What would falsify that: an `/api/internal/admin/*` writer touching a stamped field whose
 * model gained `actorStampFields()` in a *later* commit. None exists today.
 *
 * ── Nested stamps require their PARENT to exist ───────────────────────────────
 * **Five of the twelve** live inside a subdocument (`kyc`, `platform_ban`, `tracking`,
 * `kyc_details` ×2). A bare `$set` on `tracking.changed_by_source` against a document with no
 * `tracking` at all would **create** the subdocument holding only that one field — leaving
 * `tracking.allowed` absent on a row where the schema promises a boolean. So every nested
 * filter requires the parent path first. That is the one way this migration could do harm,
 * and it is the reason the filter is not simply `{ <path>: { $exists: false } }`.
 *
 * ── Idempotent, and forward-only ──────────────────────────────────────────────
 * The filter is `$exists: false`, so a second run matches nothing. There is no down
 * migration, for the reason `migrate.ts` gives: a down migration for a backfill is a fiction
 * — it cannot know which rows it wrote.
 *
 * Usage:
 *   npm run backfill:actor-source [-- --dry-run]
 */

import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { COLLECTIONS } from '../src/core/database/collections';

dotenv.config();

const DRY_RUN = process.argv.includes('--dry-run');

/**
 * One actor stamp: where it lives, and what has to exist before it can be written.
 *
 * Enumerated from the **source** — every `actorStampFields()` call site in `src/`, checked
 * against the schema it is spread into for its mount path. The plan's estimate was "~7";
 * the real number is **twelve** — eleven that already declared the pair, plus
 * `cod_discrepancies.resolved_by`, which gained it in this same step as J7's first domain.
 * Two of them (`subscriber_plans.assigned_by`, `payout_requests.resolved_by`) hold their id
 * in a column that does *not* carry the `_user_id` suffix, which is why `actorStamp()` takes
 * an `idField` override at all.
 */
interface ActorStamp {
    /** The collection, by its real name — this script talks to the driver, not to models. */
    collection: string;
    /** The stamp prefix, including any subdocument path. */
    prefix: string;
    /**
     * The subdocument that must already exist, or `null` for a top-level stamp.
     *
     * Writing into a missing parent would mint a partial subdocument. See the header.
     */
    parent: string | null;
    /** The column holding the id, for the record. Not written — only the pair is. */
    idField: string;
}

export const ACTOR_STAMPS: ActorStamp[] = [
    // ── Top-level ────────────────────────────────────────────────────────────
    {
        collection: COLLECTIONS.USER,
        prefix: 'suspended_by',
        parent: null,
        idField: 'suspended_by_user_id',
    },
    {
        collection: COLLECTIONS.VENDOR,
        prefix: 'suspended_by',
        parent: null,
        idField: 'suspended_by_user_id',
    },
    {
        collection: COLLECTIONS.SUBSCRIBER_PLAN,
        prefix: 'assigned_by',
        parent: null,
        // No `_user_id` suffix — the column predates the convention its siblings follow.
        idField: 'assigned_by',
    },
    {
        collection: COLLECTIONS.PAYOUT_REQUEST,
        prefix: 'resolved_by',
        parent: null,
        // Ditto. `actor-source.types.ts` documents this exact row as the reason `actorStamp`
        // accepts an `idField`.
        idField: 'resolved_by',
    },
    {
        collection: COLLECTIONS.AGENCY_REMITTANCE,
        prefix: 'resolved_by',
        parent: null,
        idField: 'resolved_by_user_id',
    },
    {
        collection: COLLECTIONS.AGENT_DEPOSIT,
        prefix: 'recorded_by',
        parent: null,
        idField: 'recorded_by_user_id',
    },
    {
        // The twelfth, and the newest: `cod_discrepancies` gained its stamp in this same
        // step (J7's first domain), so EVERY row predates the field rather than only the
        // old ones. That makes it the one entry here whose match count is the whole
        // collection on a first run.
        collection: COLLECTIONS.COD_DISCREPANCY,
        prefix: 'resolved_by',
        parent: null,
        idField: 'resolved_by_user_id',
    },

    // ── Nested: the parent must already be there ─────────────────────────────
    {
        collection: COLLECTIONS.VENDOR,
        prefix: 'kyc_details.reviewed_by',
        parent: 'kyc_details',
        idField: 'kyc_details.reviewed_by_user_id',
    },
    {
        collection: COLLECTIONS.DELIVERY_AGENCY,
        prefix: 'kyc_details.verified_by',
        parent: 'kyc_details',
        idField: 'kyc_details.verified_by_user_id',
    },
    {
        collection: COLLECTIONS.DELIVERY_AGENT,
        prefix: 'kyc.verified_by',
        parent: 'kyc',
        idField: 'kyc.verified_by_user_id',
    },
    {
        collection: COLLECTIONS.DELIVERY_AGENT,
        prefix: 'platform_ban.banned_by',
        parent: 'platform_ban',
        idField: 'platform_ban.banned_by_user_id',
    },
    {
        collection: COLLECTIONS.DELIVERY_AGENT,
        prefix: 'tracking.changed_by',
        parent: 'tracking',
        idField: 'tracking.changed_by_user_id',
    },
];

/** The filter that selects rows missing the discriminator, safely. */
function missingSourceFilter(stamp: ActorStamp): Record<string, unknown> {
    const filter: Record<string, unknown> = {
        [`${stamp.prefix}_source`]: { $exists: false },
    };
    if (stamp.parent) {
        // Ordered first in intent, not in the object: Mongo does not promise clause order,
        // but both must hold, and the parent one is what stops a partial subdocument.
        filter[stamp.parent] = { $exists: true, $ne: null };
    }
    return filter;
}

async function backfillOne(stamp: ActorStamp): Promise<{ matched: number; modified: number }> {
    const collection = mongoose.connection.collection(stamp.collection);
    const filter = missingSourceFilter(stamp);

    const matched = await collection.countDocuments(filter);
    if (DRY_RUN || matched === 0) return { matched, modified: 0 };

    const result = await collection.updateMany(filter, {
        $set: {
            [`${stamp.prefix}_source`]: 'platform',
            // Written together with the source, never separately — that is the whole
            // guarantee `actorStamp()` exists to provide, and a backfill is no exception.
            // `null` is right: a name is snapshotted only for an actor that cannot be
            // looked up here, and every row this touches names one that can.
            [`${stamp.prefix}_name`]: null,
        },
    });

    return { matched, modified: result.modifiedCount ?? 0 };
}

async function main(): Promise<void> {
    const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi-mall';

    console.log('[actor-source] Connecting to MongoDB...');
    await mongoose.connect(MONGO_URI);
    console.log(
        `[actor-source] Connected${DRY_RUN ? ' (DRY RUN — nothing will be written)' : ''}. ` +
        `${ACTOR_STAMPS.length} actor stamps to check.`,
    );

    try {
        let totalMatched = 0;
        let totalModified = 0;

        for (const stamp of ACTOR_STAMPS) {
            const { matched, modified } = await backfillOne(stamp);
            totalMatched += matched;
            totalModified += modified;

            const where = `${stamp.collection}.${stamp.prefix}`;
            if (matched === 0) {
                console.log(`[actor-source] ${where} — already complete`);
            } else if (DRY_RUN) {
                console.log(`[actor-source] ${where} — WOULD stamp ${matched} row(s)`);
            } else {
                console.log(`[actor-source] ${where} — stamped ${modified} of ${matched} row(s)`);
            }
        }

        console.log(
            DRY_RUN
                ? `[actor-source] DRY RUN — ${totalMatched} row(s) would be stamped. ` +
                  'Re-run without --dry-run to apply.'
                : `[actor-source] Stamped ${totalModified} row(s) across ${ACTOR_STAMPS.length} stamps.`,
        );
    } finally {
        await mongoose.disconnect();
        console.log('[actor-source] Done. Disconnected.');
    }
}

/**
 * Guarded so the registry test can import `ACTOR_STAMPS` without connecting to a database
 * and rewriting eleven collections. Same guard, same reason, as `migrate.ts` and
 * `migrate-drop-agent-invites.ts`.
 */
if (require.main === module) {
    main().catch((err) => {
        console.error('[actor-source] Failed:', err);
        process.exit(1);
    });
}
