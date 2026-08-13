/**
 * Which identity space an actor id belongs to.
 *
 * ── The problem this solves ───────────────────────────────────────────────────
 * Every `*_by_user_id` column on this platform is declared `ref: MODELS.USER` and holds an
 * id from the `users` collection. Since the admin backend was split out, administrators
 * live in a **separate database** and hold no `users` row — so an operation performed by an
 * administrator stamps an id that resolves to nothing here.
 *
 * That is a deliberate trade (see `admin/docs/ADR-004-DOMAIN-OWNERSHIP.md` D-1): no
 * `.populate()` in this repo dereferences an actor field, so nothing breaks. But an
 * unmarked dangling id is indistinguishable from a bug, and a reader has no way to tell
 * "this user was deleted" from "this actor was never in this database".
 *
 * These two fields make the difference legible:
 *
 *   *_source  which identity space the id belongs to
 *   *_name    a snapshot of who they were, taken at write time
 *
 * ── Why the name is denormalised ──────────────────────────────────────────────
 * jovi-mall cannot read the admin database — that is the point of the separation — so
 * without a snapshot an agency viewing a remittance would see "resolved by
 * <unresolvable id>". A cross-database join is not available at any price, so the name is
 * copied at write time and is deliberately a snapshot: it records who acted, not who they
 * are now.
 *
 * ── Adding these to a model ───────────────────────────────────────────────────
 * Use `actorStampFields('resolved_by')` in the schema, and write all three together via
 * `actorStamp(...)`. Existing rows have neither field; `'platform'` is the default, which
 * is correct for every row written before the split.
 */

export type ActorSource =
    /** A `users` row in this database — a vendor, agency, agent, customer or legacy admin. */
    | 'platform'
    /** An `admin_accounts` row in the wi-admin database. Does not resolve here. */
    | 'admin';

export const ACTOR_SOURCES: readonly ActorSource[] = ['platform', 'admin'] as const;

/**
 * The three fields that describe one actor stamp, ready to spread into a schema.
 *
 * @param prefix the existing id field WITHOUT its `_user_id` suffix — `'resolved_by'`
 *               produces `resolved_by_source` and `resolved_by_name` beside
 *               `resolved_by_user_id`.
 */
export function actorStampFields(prefix: string): Record<string, unknown> {
    return {
        [`${prefix}_source`]: {
            type: String,
            enum: ACTOR_SOURCES,
            default: 'platform',
        },
        [`${prefix}_name`]: { type: String, default: null, trim: true, maxlength: 200 },
    };
}

export interface ActorRef {
    userId: string;
    source: ActorSource;
    name?: string | null;
}

/**
 * Build the `$set` payload for one actor stamp.
 *
 * Writing the three fields together, from one call, is what stops a source drifting from
 * the id beside it — the failure mode being an admin-written row that claims `'platform'`
 * and sends a future reader looking for a `users` document that was never there.
 *
 * @param idField the column holding the id, when it is not `<prefix>_user_id`.
 *        `payout_requests.resolved_by` predates the convention its siblings follow, and
 *        renaming it is a data migration. Passing the real column name here keeps that row
 *        inside the one-call guarantee instead of hand-writing three fields beside it,
 *        which is the only way the pair drifts.
 */
export function actorStamp(
    prefix: string,
    actor: ActorRef,
    idField: string = `${prefix}_user_id`,
): Record<string, unknown> {
    return {
        [idField]: actor.userId,
        [`${prefix}_source`]: actor.source,
        [`${prefix}_name`]: actor.name ?? null,
    };
}

/**
 * The `$set` payload for a stamp that is CLEARED when the thing it records is undone.
 *
 * `actorStamp` writes an actor; this writes an actor OR three nulls, from one call. The
 * pairing matters because the clearing direction is the one that gets forgotten: an unban
 * that leaves `banned_by_name` populated reads as "still banned by X" on any screen that
 * renders the stamp without checking the flag beside it first — the same failure the
 * user-suspension DTO guards against by keying the whole block on `status`.
 *
 * The cleared `_source` is `'platform'`, not null, because that is the schema default and
 * a stamp with no actor should look like a row written before the admin split rather than
 * like a half-written one.
 */
export function actorStampOrCleared(
    prefix: string,
    actor: ActorRef | null,
): Record<string, unknown> {
    if (actor) return actorStamp(prefix, actor);
    return {
        [`${prefix}_user_id`]: null,
        [`${prefix}_source`]: 'platform',
        [`${prefix}_name`]: null,
    };
}

/**
 * An actor plus the role they acted in.
 *
 * The two answer different questions and both are stored: `role` is WHAT KIND of actor
 * decided (it appears on the row as `*_by_role`), `source` is WHICH DATABASE the id
 * resolves in. A reader needs the second before it can try to resolve the first.
 */
export type RoleActorRef = ActorRef & { role: string };

/**
 * Which identity space a role belongs to.
 *
 * `role === 'admin'` is the discriminator, and it is reliable: since the Phase 0.5 patch
 * there is no way to hold the `admin` role on a platform `users` row — `auth.schemas.ts`
 * refuses it on both register and add-role — so every `admin` caller arrives through
 * `requireAdminCaller` carrying a wi-admin id.
 */
export function actorSourceOfRole(role: string | undefined): ActorSource {
    return role === 'admin' ? 'admin' : 'platform';
}

/** The shape `actorFromRequest` needs. Structural, so this file imports no Express types. */
interface RequestWithAuth {
    auth?: {
        user: { id?: string; _id?: unknown };
        role: string;
        role_entity?: { name?: string } | null;
    };
}

/**
 * Build an actor stamp from an authenticated request.
 *
 * ── Why only admins get a name snapshot ───────────────────────────────────────
 * A platform id resolves in this database, so denormalising the name beside it would be a
 * second copy that goes stale the moment the person is renamed. An admin id resolves
 * nowhere here, so the snapshot is the only record there will ever be. The asymmetry is
 * the rule, not an omission: **snapshot exactly what cannot be looked up.**
 */
export function actorFromRequest(req: RequestWithAuth): ActorRef {
    const auth = req.auth;
    const userId = auth?.user?.id ?? String(auth?.user?._id ?? '');
    const source = actorSourceOfRole(auth?.role);

    return {
        userId,
        source,
        name: source === 'admin' ? (auth?.role_entity?.name ?? null) : null,
    };
}

/**
 * `actorFromRequest` plus the role the caller acted in.
 *
 * The shape a write that records BOTH `*_by_role` and `*_source` needs — the shipment
 * rejection and the reassignment claim are the two today. Taking the role from the same
 * request that produced the id is what keeps the pair honest: deriving `source` here and
 * `role` at the call site is how a row ends up claiming `'platform'` beside an admin id.
 */
export function roleActorFromRequest(req: RequestWithAuth): RoleActorRef {
    return { ...actorFromRequest(req), role: req.auth?.role ?? 'unknown' };
}
