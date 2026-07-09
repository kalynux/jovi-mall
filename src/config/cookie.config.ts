import { CookieOptions } from 'express';

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

// ─── Legacy Session Cookie Config (OAuth / browser-session flow) ─────────────
/**
 * @deprecated Use accessCookieOptions / refreshCookieOptions
 */
export const cookieConfig: CookieOptions = {
    ...base,
    maxAge: 30 * 24 * 60 * 60 * 1000,
};
