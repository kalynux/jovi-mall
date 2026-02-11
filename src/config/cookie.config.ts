export const cookieConfig = {
    httpOnly: true,
    sameSite: 'lax' as const, // Required for OAuth redirects
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    domain: undefined, // Prevent subdomain leakage
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days absolute
};

export const COOKIE_NAME = 'session_id';
