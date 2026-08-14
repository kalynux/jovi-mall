import { CookieOptions, Response } from 'express';

// ─── Cookie Names ────────────────────────────────────────────────────────────
export const AUTH_COOKIE = {
    ACCESS: 'access_token',
    REFRESH: 'refresh_token',
} as const;

/**
 * @deprecated Use AUTH_COOKIE.ACCESS / AUTH_COOKIE.REFRESH
 * Kept for backward compatibility with browser-auth and OAuth session flow.
 */
export const COOKIE_NAME = 'session_id';

// ─── Shared Base Attributes ──────────────────────────────────────────────────
const base: CookieOptions = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    // Configurable via env (e.g. ".example.com" for subdomain sharing)
    domain: process.env.NODE_ENV === 'production' 
        ? process.env.AUTH_COOKIE_DOMAIN 
        : undefined,
};

// ─── Access Token Cookie (short-lived, default 15 min) ───────────────────────
export const accessCookieOptions: CookieOptions = {
    ...base,
    maxAge: parseInt(process.env.AUTH_ACCESS_TOKEN_TTL || '900') * 1000,
};

// ─── Refresh Token Cookie (long-lived, default 30 days) ──────────────────────
export const refreshCookieOptions: CookieOptions = {
    ...base,
    maxAge: parseInt(process.env.AUTH_REFRESH_TOKEN_TTL || '2592000') * 1000,
};

// ─── Clear Cookie Options (exact same attrs, no maxAge = browser clears) ─────
// IMPORTANT: Must match set-options exactly or cookie won't be cleared on some browsers.
export const clearCookieOptions: CookieOptions = {
    httpOnly: base.httpOnly,
    secure: base.secure,
    sameSite: base.sameSite,
    path: base.path,
    domain: base.domain,
};

// ─── Setting and clearing the pair ───────────────────────────────────────────
/**
 * The two auth cookies are set together and cleared together, always.
 *
 * These lived as private helpers in `auth.controller.ts` until a second place needed to
 * issue a pair — `UserController.updatePassword`, which re-issues the caller's own tokens
 * after a password change invalidates them. They are here rather than exported from that
 * controller because the pairing is a property of the cookies, not of the auth routes: an
 * access cookie refreshed without its refresh cookie is a session that dies in 15 minutes
 * for no visible reason.
 *
 * Note `requireAuth`'s silent refresh deliberately sets only ACCESS — it is extending a
 * session from a refresh cookie that is still valid, not issuing a new pair.
 */
export function setAuthCookies(res: Response, accessToken: string, refreshToken: string): void {
    res.cookie(AUTH_COOKIE.ACCESS, accessToken, accessCookieOptions);
    res.cookie(AUTH_COOKIE.REFRESH, refreshToken, refreshCookieOptions);
}

export function clearAuthCookies(res: Response): void {
    res.clearCookie(AUTH_COOKIE.ACCESS, clearCookieOptions);
    res.clearCookie(AUTH_COOKIE.REFRESH, clearCookieOptions);
}

// ─── Legacy Session Cookie Config (OAuth / browser-session flow) ─────────────
/**
 * @deprecated Use accessCookieOptions / refreshCookieOptions
 */
export const cookieConfig: CookieOptions = {
    ...base,
    maxAge: 30 * 24 * 60 * 60 * 1000,
};
