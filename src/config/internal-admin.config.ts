/**
 * The shared secret the **wi-admin service** presents on `/api/internal/admin/*`.
 *
 * ── Why this is not `INTERNAL_SERVICE_TOKEN` ──────────────────────────────────
 * That one is geo-tracker's. The two callers have very different blast radii — geo-tracker
 * may ask whether an agent can be tracked; wi-admin may confirm a remittance and move
 * money — so a single shared secret would make either compromise the other's. Separate
 * variables, rotated separately.
 *
 * ── Fail closed ───────────────────────────────────────────────────────────────
 * Unset means the internal admin API is DISABLED, exactly as an unset
 * `INTERNAL_SERVICE_TOKEN` disables the agent one. There is no development default and no
 * fallback: `JWT_SECRET` **used to** fall back to the literal `'secret'`, and that is the
 * pattern this file exists not to repeat. Both it and geo-tracker's copy fail closed as of
 * 2026-08-19; the pattern is what is being avoided here, not a live defect.
 *
 * Read through the accessor rather than at module load, so a test can set the variable
 * before the first call without racing the import order.
 */

const MIN_TOKEN_LENGTH = 16;

/** Values that mean "somebody pasted the example" — refused in production. */
const PLACEHOLDER_TOKENS = new Set([
    'changeme',
    'secret',
    'token',
    'internal-admin-service-token',
    'replace-me',
]);

export function INTERNAL_ADMIN_SERVICE_TOKEN(): string {
    return process.env.INTERNAL_ADMIN_SERVICE_TOKEN || '';
}

export function internalAdminApiEnabled(): boolean {
    return INTERNAL_ADMIN_SERVICE_TOKEN() !== '';
}

/**
 * Boot-time check, called from `server.ts` alongside `assertSigningSecrets()`.
 *
 * Deliberately does NOT require the token to be set: the internal admin API is optional
 * until the admin service cuts over, and a jovi-mall running without it is a valid
 * deployment. What it refuses is a token that is set to something worthless — a
 * placeholder or a 6-character string is more dangerous than no token at all, because the
 * API is then open and looks configured.
 */
export function assertInternalAdminToken(): void {
    const token = INTERNAL_ADMIN_SERVICE_TOKEN();
    if (token === '') return;

    if (process.env.NODE_ENV !== 'production') return;

    if (token.length < MIN_TOKEN_LENGTH) {
        throw new RangeError(
            `INTERNAL_ADMIN_SERVICE_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters in production. `
            + 'It authorises every administrative operation on this service.'
        );
    }

    if (PLACEHOLDER_TOKENS.has(token.toLowerCase())) {
        throw new RangeError(
            'INTERNAL_ADMIN_SERVICE_TOKEN is set to a placeholder value. '
            + 'Generate a real secret — this token grants full administrative access.'
        );
    }
}
