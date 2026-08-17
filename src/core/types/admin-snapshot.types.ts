import { Schema } from 'mongoose';
import { ActorSource, ACTOR_SOURCES } from './actor-source.types';

/**
 * A wi-admin administrator, copied onto a row in THIS database because they cannot be
 * looked up from here.
 *
 * ── Why this exists beside `actor-source.types.ts` rather than inside it ──────
 * That file solves identity *resolution*: an id, which database it resolves in, and a name
 * so a dangling id is legible. Three flat fields, spread into a schema, and it is the right
 * shape for "who confirmed this remittance".
 *
 * This solves something else — a **profile a non-admin reader is shown**. A customer
 * opening their ticket sees who is handling it: their name, their photo, what they do. That
 * is four more fields, and two of them (`tier`, `id`) must NEVER reach that reader. Spread
 * flat in the actor-stamp style it would be seven columns per stamp and fourteen on a
 * ticket, with the disclosure rule living nowhere. As a block it is one path, one
 * projection function, and a rule that is applied rather than remembered.
 *
 * So the two coexist deliberately: `actorStamp` for *an actor was here*, this for *and here
 * is who to show*. Use the first unless a non-admin reader renders the person.
 *
 * ── The snapshot is a snapshot, and that is the point ─────────────────────────
 * jovi-mall cannot read the wi-admin database — that is the separation, not a gap in it —
 * so `resolveAdmins()` in `ticket-enrichment.service.ts` finds nothing for a wi-admin id
 * and renders `null`. The copy is the only record there will ever be. It records who acted
 * **at the time**, and it does not follow a rename, a promotion or a departure. Anything
 * that must be current cannot live here.
 *
 * ── Who writes it ────────────────────────────────────────────────────────────
 * wi-admin, over the internal admin API, from its own `admin_accounts` collection. Note the
 * asymmetry with `requireAdminCaller`: headers (`X-Actor-*`) describe the **caller**, so
 * they build the `assigned_by` half; the **target** administrator arrives in the request
 * body, because the caller is assigning somebody else and only wi-admin knows that person.
 *
 * `tier` is stored, and storing it is what makes the read-scope rule expressible. wi-admin's
 * scope filter for tickets asks "assigned to me, or to a Tier 3, or to nobody" — and its
 * administrators are in a different database, so a join cannot answer it. The tier on the
 * row can. That is not a re-decision of `X-Actor-Tier` being advisory: wi-admin **wrote**
 * this value from its own records and is querying its own data, rather than trusting a
 * header at decision time.
 */

/** Lower is more privileged: 1 Developer, 2 Admin, 3 Support. Mirrors wi-admin's `AdminTier`. */
export type AdminSnapshotTier = 1 | 2 | 3;

export const ADMIN_SNAPSHOT_TIERS: readonly AdminSnapshotTier[] = [1, 2, 3] as const;

export interface IAdminSnapshot {
    /** A wi-admin `admin_accounts._id`. Deliberately a plain string — it refs nothing here. */
    id: string;
    /**
     * Which identity space `id` belongs to. Always `'admin'` for a wi-admin administrator.
     *
     * Carried even though it is near-constant, because the legacy migration needs the other
     * value: a pre-Phase-17 ticket locked to a jovi-mall `admins` row is `'platform'`, and it
     * IS resolvable here. A reader that cannot tell them apart will either render nothing for
     * the legacy rows or look up the new ones forever.
     */
    source: ActorSource;
    name: string;
    /** Internal. Drives wi-admin's read scope; never rendered to a non-admin. */
    tier: AdminSnapshotTier;
    job_title: string | null;
    department: string | null;
    avatar_url: string | null;
}

/**
 * What a NON-ADMIN reader is shown — a ticket follower, so a customer, vendor, agency or
 * agent.
 *
 * `id`, `source` and `tier` are absent by construction rather than by omission. The id and
 * source are internal plumbing, and the tier is the sharp one: it publishes the platform's
 * internal hierarchy to a customer, and since the read scope is keyed on it, it is also the
 * one field that tells an outsider something about how access is decided here.
 */
export interface PublicAdminSnapshot {
    name: string;
    job_title: string | null;
    department: string | null;
    avatar_url: string | null;
}

/**
 * The sub-schema, ready to embed.
 *
 * `_id: false` because the block is a value, not a document — a generated ObjectId on every
 * snapshot would be a second id beside `id`, which is exactly the confusion this whole file
 * exists to remove.
 */
export const AdminSnapshotSchema = new Schema<IAdminSnapshot>({
    id: { type: String, required: true, trim: true },
    source: { type: String, enum: ACTOR_SOURCES, required: true, default: 'admin' },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    tier: { type: Number, enum: ADMIN_SNAPSHOT_TIERS, required: true },
    job_title: { type: String, default: null, trim: true, maxlength: 120 },
    department: { type: String, default: null, trim: true, maxlength: 120 },
    avatar_url: { type: String, default: null, trim: true, maxlength: 2048 },
}, { _id: false });

/**
 * Narrow a snapshot to what a non-admin may see.
 *
 * **This is the disclosure boundary — call it on every path that serialises a snapshot to a
 * non-admin reader.** Written as an explicit projection rather than a spread-and-delete for
 * the reason the public catalog DTOs give: a spread publishes whatever the interface gains
 * next, silently, and the next field added here is as likely to be internal as not.
 */
export function publicAdminSnapshot(snapshot: IAdminSnapshot | null | undefined): PublicAdminSnapshot | null {
    if (!snapshot) return null;

    return {
        name: snapshot.name,
        job_title: snapshot.job_title ?? null,
        department: snapshot.department ?? null,
        avatar_url: snapshot.avatar_url ?? null,
    };
}

/** Whether a value is a usable snapshot. Used by the write paths before they persist one. */
export function isAdminSnapshot(value: unknown): value is IAdminSnapshot {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Partial<IAdminSnapshot>;

    return typeof candidate.id === 'string' && candidate.id.trim().length > 0
        && typeof candidate.name === 'string' && candidate.name.trim().length > 0
        && typeof candidate.tier === 'number'
        && ADMIN_SNAPSHOT_TIERS.includes(candidate.tier as AdminSnapshotTier);
}
