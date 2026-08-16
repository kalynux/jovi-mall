/**
 * Which `/api/auth` paths are SESSION MAINTENANCE rather than credential presentation.
 *
 * ── Why the credential bucket had to be split ─────────────────────────────────
 * The whole `/api/auth` prefix used to share one 20/min/IP counter. That number is a security
 * control — it bounds one source spraying a common password across many accounts, which a
 * per-account lockout cannot see — and it is the only strict number in `policy.ts`. But it was
 * also being spent by traffic that presents no password at all: `/auth/me` on every dashboard
 * poll, `/auth/auth-me/:role` on every app launch and role switch, and `/auth/browser/refresh`
 * on every token renewal (the Flutter agent app calls that one on every refresh today).
 *
 * Behind an office NAT or a Cameroonian mobile carrier, that is dozens of people contending for
 * one counter — and the failure mode is the bad one: a user whose refresh is refused is signed
 * out, tries to sign back in, and the sign-in is refused too, by their neighbours' traffic.
 * Raising the number instead would have bought that at the price of the login gate, which is
 * the one thing in that file worth being strict about.
 *
 * So the split is by PURPOSE. Presenting a credential stays at 20. Extending a session a
 * caller already holds gets its own, looser counter.
 *
 * ── The list is an ALLOWLIST, and that direction is the safety property ───────
 * Anything under `/api/auth` that is not named here stays in the strict bucket. A route added
 * next year therefore inherits 20/min by default and has to be moved here deliberately —
 * the opposite arrangement would silently hand a new credential endpoint the loose ceiling.
 *
 * Matching is anchored exactly as `exempt-paths.ts` does it, and for the same reason:
 * `/api/auth/me` must not swallow `/api/auth/mefoo`. Each entry carries the reason it is here,
 * following the discipline `modules/system/domain/maintenance-mode.ts` established — an
 * exemption without a stated cause is indistinguishable from an oversight, and the next person
 * either deletes it or copies it.
 */

interface AuthSessionPath {
    prefix: string;
    reason: string;
}

export const AUTH_SESSION_PATHS: readonly AuthSessionPath[] = Object.freeze([
    {
        prefix: '/api/auth/mobile/refresh',
        reason:
            'The only way a bearer client extends a session — it cannot silently refresh on an '
            + 'ordinary route the way a cookie client does, so every renewal is an explicit call '
            + 'here, roughly four times an hour per active user. It presents an unguessable signed '
            + 'JWT, never a password, so the brute-force reasoning behind the 20 does not apply.',
    },
    {
        prefix: '/api/auth/browser/refresh',
        reason:
            'The cookie twin of the above, driven by the refresh cookie. Not only browsers use it: '
            + 'the Flutter agent app calls it on EVERY token refresh, against the credential bucket, '
            + 'today — an agent in the street retrying on a bad connection is exactly who should not '
            + 'be sharing a counter with a password sprayer.',
    },
    {
        prefix: '/api/auth/me',
        reason:
            'A GET behind `requireAuth`, and the highest-frequency route under this prefix — a '
            + 'dashboard polls it. Layer B already counts it per USER (600-1200), which is the '
            + 'ceiling that actually bounds the person; the IP counter here is a flood backstop, not '
            + 'a budget. It presents no credential and mints none.',
    },
    {
        prefix: '/api/auth/auth-me',
        reason:
            'Prefix, so it covers `/:role`. Called on every app launch and every role switch, by '
            + 'every client on the platform. Also behind `requireAuth`, so Layer B bounds the person. '
            + 'It re-issues a pair, but only for a caller who already proved they hold one.',
    },
    {
        prefix: '/api/auth/mobile/auth-me',
        reason:
            'The bearer twin of the line above, same shape and same reasoning. Named separately '
            + 'because the anchored match is on the full path and `/api/auth/auth-me` does not '
            + 'cover it.',
    },
]);

/** Prefix set, precomputed — this runs on every `/api/auth` request. */
const AUTH_SESSION_PREFIXES: readonly string[] = Object.freeze(
    AUTH_SESSION_PATHS.map((entry) => entry.prefix),
);

/**
 * Is this an absolute pathname that belongs in the session bucket?
 *
 * Takes the pathname rather than the request, so the classification can be asserted without
 * building one — `test:mobile-auth` reads this directly.
 *
 * ⚠ The caller must pass an ABSOLUTE path (`req.baseUrl + req.path`). Inside a `use`-mounted
 * layer Express has already stripped the mount prefix off `req.url`, and `req.path` is a getter
 * over it — so at `router.use('/auth', …)` a bare `req.path` reads `/mobile/refresh` and would
 * match nothing here. Failing to match is at least the safe direction (everything stays
 * strict), which is exactly why the mistake would be silent.
 */
export function isAuthSessionPathname(pathname: string): boolean {
    return AUTH_SESSION_PREFIXES.some(
        (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
    );
}
