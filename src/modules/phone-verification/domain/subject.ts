/**
 * Who a verification code belongs to.
 *
 * ── Why a namespace rather than a bare id ────────────────────────────────────
 *
 * TWO identity spaces reach this module, and they are not the same space:
 *
 *   - **platform users** — a `users._id` in this service's database;
 *   - **administrators** — an `admin_accounts._id` in **wi-admin's own database**, who hold no
 *     `users` row here at all (`requireAdminCaller` synthesises the whole `req.auth` shape from
 *     request headers with no database query, and `X-Actor-Id` becomes `user.id`).
 *
 * Both are ObjectIds. Both are 24 hex characters. So a store keyed on the bare id lets an
 * administrator and a customer collide on one Redis key the day their ids happen to match —
 * one person's code silently overwriting another's, and one person's resend cooldown throttling
 * the other. That is not a likely collision; it is an *unbounded* one, because the two id
 * spaces are generated independently and neither knows the other exists.
 *
 * Prefixing makes it impossible rather than improbable, and it costs one function.
 *
 * ⚠ The prefixes are part of the Redis key and therefore part of the stored state. Renaming one
 * orphans every code in flight — harmless (the person requests another) but it is why they are
 * literals here rather than derived from anything.
 */

export type SubjectSpace = 'user' | 'admin';

/** A platform user — vendor, agency, agent or customer, all of whom have a `users` row. */
export function platformSubject(userId: string): string {
    return `user:${userId}`;
}

/**
 * A wi-admin administrator.
 *
 * ⚠ The id comes from `X-Actor-Id`, which this service **trusts without verifying** — the
 * token authenticating that call is a full-privilege credential, so anyone holding it could set
 * the header, and re-checking it here would be theatre (the rule `requireAdminCaller` states).
 * The consequence for THIS module is bounded and worth naming: the worst a forged header buys
 * is a code sent to a number the forger already supplied, on an account they already control
 * the credential for. It does not let them verify somebody else's number, because jovi-mall
 * writes no administrator record — wi-admin does, against its own session.
 */
export function adminSubject(adminId: string): string {
    return `admin:${adminId}`;
}
