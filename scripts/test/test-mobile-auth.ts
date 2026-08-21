/**
 * Test: bearer auth for clients that cannot hold a cookie — the `/api/auth/mobile/*` namespace,
 * the token-extraction precedence it depends on, and the rate-limit bucket split it forced.
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no framework).
 * DB-free.
 *
 * ── Why this suite exists at all ──────────────────────────────────────────────
 * Three of the four invariants here are STRUCTURAL, and a regression in any of them is
 * invisible from every other angle — the same argument `test:storefront-checkout` makes about
 * stock and `test:bargain-price` makes about rule ordering:
 *
 *  1. **The silent-refresh asymmetry.** `requireAuth` must keep refreshing a caller who
 *     presented NO token (the ordinary browser path once the access cookie expires, and the
 *     Flutter agent app's fallback) while refusing one who presented an EXPIRED BEARER. Tidying
 *     the two branches into symmetry signs out every browser session older than 15 minutes,
 *     and nothing else in the codebase would say so.
 *  2. **The rate-limit allowlist direction.** A route added under `/api/auth` must inherit the
 *     STRICT bucket. Get that backwards and a future credential endpoint silently gets 300/min.
 *  3. **No cookie in the mobile controller.** The one rule the whole namespace exists for.
 *
 * The fourth — that the session ceiling sits strictly between the credential ceiling and
 * Layer A — is arithmetic nothing else asserts, and if it drifts the split is either pointless
 * or a lie.
 *
 * Run: npm run test:mobile-auth
 */
import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';
import { AUTH_SESSION_PATHS, isAuthSessionPathname } from '../../src/api/rate-limit/auth-paths';
import {
    AUTH_POLICY,
    AUTH_SESSION_POLICY,
    CALLER_CLASSES,
    ceilingFor,
    GLOBAL_POLICY,
    POLICIES,
} from '../../src/api/rate-limit/policy';
import {
    ABSOLUTE_SESSION_CAP_S,
    ACCESS_TOKEN_TTL_S,
    issueTokenPair,
    REFRESH_TOKEN_TTL_S,
    tokenEnvelope,
} from '../../src/core/auth/token.issuer';
import { isSessionCapReached, resolveAuthTime } from '../../src/core/auth/session-cap';
import { ERROR_CODES } from '../../src/core/error-codes';
import { DEFAULT_ERROR_MESSAGES } from '../../src/core/errors';
import { categoryFor } from '../../src/core/error-category';
import { accessCookieOptions, refreshCookieOptions } from '../../src/config/cookie.config';
import { evaluateMaintenance, MaintenanceState } from '../../src/modules/system/domain/maintenance-mode';

let passed = 0;
let failed = 0;

function assert(name: string, fn: () => boolean): void {
    let ok: boolean;
    try {
        ok = fn();
    } catch (err) {
        console.error(`  ❌ THROW: ${name} — ${(err as Error).message}`);
        failed++;
        return;
    }
    if (ok) {
        console.log(`  ✅ ${name}`);
        passed++;
    } else {
        console.error(`  ❌ FAIL: ${name}`);
        failed++;
    }
}

const ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(ROOT, 'src');
const read = (relative: string): string => fs.readFileSync(path.join(SRC, relative), 'utf8');

/** Strip block and line comments, so a source scan cannot be satisfied by prose about the code. */
function code(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function main(): void {
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n▶ The namespace exists and is mounted');

    const apiIndex = code(read('api/index.ts'));
    const routes = code(read('modules/auth/routes/mobile-auth.routes.ts'));

    assert('/auth/mobile is mounted on the api router', () =>
        /router\.use\(\s*'\/auth\/mobile'\s*,\s*mobileAuthRoutes\s*\)/.test(apiIndex));
    assert('it is mounted BEHIND the auth rate-limit dispatcher', () =>
        apiIndex.indexOf("router.use('/auth', authBucketDispatcher)")
        < apiIndex.indexOf("router.use('/auth/mobile'"));
    assert('the dispatcher import is the HOISTED one at the top of the file', () =>
        apiIndex.indexOf('authBucketDispatcher') < apiIndex.indexOf('const router = express.Router()'));

    for (const route of ['/login', '/register', '/refresh', '/auth-me/:role', '/add-role']) {
        assert(`route ${route} is declared`, () => routes.includes(`'${route}'`));
    }
    assert('auth-me and add-role are behind requireAuth', () =>
        /'\/auth-me\/:role',\s*requireAuth/.test(routes) && /'\/add-role',\s*requireAuth/.test(routes));
    assert('login, register and refresh are NOT behind requireAuth', () =>
        !/'\/login',\s*requireAuth/.test(routes)
        && !/'\/register',\s*requireAuth/.test(routes)
        && !/'\/refresh',\s*requireAuth/.test(routes));
    assert('there is no /logout — the cookie one is already a no-op for a bearer client', () =>
        !routes.includes("'/logout'"));

    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n▶ The one rule of the mobile controller: it sets NO cookie');

    const mobileController = code(read('modules/auth/controllers/mobile-auth.controller.ts'));

    assert('it never calls setAuthCookies', () => !mobileController.includes('setAuthCookies'));
    assert('it never calls res.cookie', () => !/res\.cookie\s*\(/.test(mobileController));
    assert('it does not even import from cookie.config', () =>
        !mobileController.includes('cookie.config'));
    assert('every token-bearing response goes through tokenEnvelope', () =>
        (mobileController.match(/tokenEnvelope\(/g) ?? []).length === 5);

    // The cookie twin must keep doing the opposite — that is the browser regression guard.
    const cookieController = code(read('modules/auth/auth.controller.ts'));
    assert('the cookie controller still calls setAuthCookies on all four minting routes', () =>
        (cookieController.match(/setAuthCookies\(/g) ?? []).length === 4);
    assert('the cookie controller returns NO tokens in its body', () =>
        !cookieController.includes('tokenEnvelope') && !/tokens\s*:/.test(cookieController));

    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n▶ The published lifetimes are the lifetimes we signed');

    const envelope = tokenEnvelope({ accessToken: 'a', refreshToken: 'r' });

    assert('the envelope carries all four fields', () =>
        Object.keys(envelope).sort().join(',')
        === 'accessExpiresIn,accessToken,refreshExpiresIn,refreshToken');
    assert('accessExpiresIn is the constant jwt.sign is given', () =>
        envelope.accessExpiresIn === ACCESS_TOKEN_TTL_S);
    assert('refreshExpiresIn is the constant jwt.sign is given', () =>
        envelope.refreshExpiresIn === REFRESH_TOKEN_TTL_S);
    assert('the lifetimes are SECONDS, not milliseconds', () =>
        envelope.accessExpiresIn === 900 && envelope.refreshExpiresIn === 2_592_000);

    // The drift this closes: cookie.config used to parseInt the same env vars a second time.
    assert('the access COOKIE maxAge is derived from the same constant', () =>
        accessCookieOptions.maxAge === ACCESS_TOKEN_TTL_S * 1000);
    assert('the refresh COOKIE maxAge is derived from the same constant', () =>
        refreshCookieOptions.maxAge === REFRESH_TOKEN_TTL_S * 1000);
    assert('cookie.config no longer re-reads the TTL environment variables', () => {
        const cookieConfig = code(read('config/cookie.config.ts'));
        return !cookieConfig.includes('AUTH_ACCESS_TOKEN_TTL')
            && !cookieConfig.includes('AUTH_REFRESH_TOKEN_TTL');
    });

    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n▶ Token extraction — the bearer wins, and an empty one is no token');

    const middleware = read('modules/../api/middlewares/auth.middleware.ts');
    const middlewareCode = code(middleware);

    assert('the bearer is read BEFORE the cookie', () =>
        middlewareCode.indexOf('req.headers.authorization')
        < middlewareCode.indexOf('req.cookies?.[AUTH_COOKIE.ACCESS]'));
    assert('extraction reports a source alongside the token', () =>
        /source:\s*'bearer'/.test(middlewareCode) && /source:\s*'cookie'/.test(middlewareCode));
    assert('an empty bearer is discarded rather than reported as a token', () =>
        /slice\('Bearer '\.length\)\.trim\(\)/.test(middlewareCode)
        && /if\s*\(bearer\)\s*return/.test(middlewareCode));
    assert('the old split(\' \')[1] form is gone', () =>
        !middlewareCode.includes("split(' ')[1]"));

    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n▶ The silent-refresh ASYMMETRY — the load-bearing one');

    // Anatomy of the two branches. `if (!token) {` opens block (a); the TokenExpiredError arm
    // inside the `else` is block (b).
    const noTokenAt = middlewareCode.indexOf('if (!token) {');
    const expiredAt = middlewareCode.indexOf("err.name === 'TokenExpiredError'");
    const bearerGuardAt = middlewareCode.indexOf("extracted?.source === 'bearer'");

    assert('both branches are still present', () => noTokenAt > -1 && expiredAt > -1);
    assert('the bearer guard exists', () => bearerGuardAt > -1);
    assert('the bearer guard is inside the EXPIRED branch, not the no-token one', () =>
        bearerGuardAt > expiredAt);
    assert('block (a) — no token at all — is NOT gated on the source', () => {
        const blockA = middlewareCode.slice(noTokenAt, expiredAt);
        return !blockA.includes('source');
    });
    assert('block (a) still reaches rotateRefreshToken', () => {
        const blockA = middlewareCode.slice(noTokenAt, expiredAt);
        return blockA.includes('rotateRefreshToken(');
    });
    assert('the guard fires BEFORE the refresh cookie is read in block (b)', () => {
        const blockB = middlewareCode.slice(expiredAt);
        return blockB.indexOf("extracted?.source === 'bearer'")
            < blockB.indexOf('AUTH_COOKIE.REFRESH');
    });
    assert('an expired bearer is answered AUTH_TOKEN_EXPIRED, not AUTH_SESSION_EXPIRED', () => {
        const guard = middlewareCode.slice(bearerGuardAt, bearerGuardAt + 200);
        return guard.includes('AUTH_TOKEN_EXPIRED');
    });
    // The comment naming the two dependent callers is what stops the next reader "tidying"
    // the asymmetry away. A source scan is the only thing that can keep a comment present.
    assert('the asymmetry is explained in the file, naming the agent app', () =>
        middleware.includes('agent_token_refresher'));

    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n▶ rotateRefreshToken issues a PAIR, and the cookie paths ignore half of it');

    const authService = code(read('modules/auth/auth.service.ts'));

    assert('it returns a refreshToken as well as an accessToken', () =>
        /rotateRefreshToken\([\s\S]{0,200}?Promise<\{[^}]*refreshToken: string/.test(authService));
    assert('it mints through issueTokenPair', () =>
        /rotateRefreshToken[\s\S]*?this\.issueTokenPair\(user, payload\.role, authTime\)/.test(authService));
    assert('it still asserts the type: refresh claim', () =>
        authService.includes("payload.type !== 'refresh'"));
    assert('it still refuses a suspended account and a stale password epoch', () =>
        /rotateRefreshToken[\s\S]*?AUTH_ACCOUNT_SUSPENDED[\s\S]*?isTokenPredatingPasswordChange/
            .test(authService));

    // The browser must keep receiving ONE cookie from its refresh — reissuing the refresh
    // cookie there would be a behaviour change nobody asked for.
    const browserController = code(read('modules/auth/controllers/browser-auth.controller.ts'));
    assert('POST /auth/browser/refresh still sets the ACCESS cookie only', () => {
        const refreshFn = browserController.slice(
            browserController.indexOf('refresh = asyncHandler'),
            browserController.indexOf('logout = asyncHandler'),
        );
        const sets = refreshFn.match(/res\.cookie\(/g) ?? [];
        return sets.length === 1 && refreshFn.includes('AUTH_COOKIE.ACCESS');
    });
    assert('…and does not destructure the new refresh token it now receives', () => {
        const refreshFn = browserController.slice(
            browserController.indexOf('refresh = asyncHandler'),
            browserController.indexOf('logout = asyncHandler'),
        );
        return /const \{ accessToken, user, role \} = await authService\.rotateRefreshToken/
            .test(refreshFn);
    });
    assert("requireAuth's silent refresh still sets the ACCESS cookie only", () => {
        const blockA = middlewareCode.slice(noTokenAt, expiredAt);
        return blockA.includes('AUTH_COOKIE.ACCESS') && !/res\.cookie\(AUTH_COOKIE\.REFRESH/.test(middlewareCode);
    });

    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n▶ C0 — the login password check is enforced');

    assert('the verdict is acted on, not discarded', () =>
        /const isValid = await bcrypt\.compare\([\s\S]{0,80}?if \(!isValid\) throw/.test(authService));
    assert('it raises AUTH_INVALID_CREDENTIALS', () =>
        /if \(!isValid\) throw createAppError\(ERROR_CODES\.AUTH_INVALID_CREDENTIALS, 401\)/
            .test(authService));
    // Scoped to `login` — `AUTH_ACCOUNT_SUSPENDED` is also raised in `rotateRefreshToken`,
    // which is declared earlier in the file, so a whole-file indexOf would compare the wrong
    // two positions and pass or fail for reasons that have nothing to do with this rule.
    assert('the suspension check still runs AFTER the comparison (not an enumeration oracle)', () => {
        const login = authService.slice(
            authService.indexOf('async login(input: LoginInput)'),
            authService.indexOf('async authMe('),
        );
        return login.indexOf('bcrypt.compare(input.password') < login.indexOf('AUTH_ACCOUNT_SUSPENDED')
            && login.includes('AUTH_ACCOUNT_SUSPENDED');
    });
    assert('there is no environment bypass of the password check', () =>
        !/AUTH_ALLOW_ANY_PASSWORD/i.test(authService));

    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n▶ The rate-limit split — classification');

    const LOOSE = [
        '/api/auth/me',
        '/api/auth/auth-me',
        '/api/auth/auth-me/agency',
        '/api/auth/mobile/auth-me/agent',
        '/api/auth/mobile/refresh',
        '/api/auth/browser/refresh',
    ];
    for (const p of LOOSE) {
        assert(`${p} → session bucket`, () => isAuthSessionPathname(p) === true);
    }

    const STRICT = [
        '/api/auth/login',
        '/api/auth/register',
        '/api/auth/forgot-password',
        '/api/auth/reset-password',
        '/api/auth/add-role',
        '/api/auth/browser/login',
        '/api/auth/mobile/login',
        '/api/auth/mobile/register',
        '/api/auth/mobile/add-role',
        '/api/auth/send-email-verification',
        '/api/auth/request-wa-verification',
        '/api/auth/verify-email',
        '/api/auth/logout',
    ];
    for (const p of STRICT) {
        assert(`${p} → credential bucket`, () => isAuthSessionPathname(p) === false);
    }

    console.log('\n▶ …and the properties that make the allowlist safe');

    assert('matching is ANCHORED — /api/auth/mefoo is not /api/auth/me', () =>
        isAuthSessionPathname('/api/auth/mefoo') === false);
    assert('…nor is /api/auth/auth-media', () =>
        isAuthSessionPathname('/api/auth/auth-media') === false);
    assert('a route invented next year defaults to the STRICT bucket', () =>
        isAuthSessionPathname('/api/auth/something-invented-later') === false);
    assert('a relative path (the req.path mistake) matches nothing — fails safe', () =>
        isAuthSessionPathname('/mobile/refresh') === false
        && isAuthSessionPathname('/me') === false);
    assert('a percent-encoded path does not sneak in', () =>
        isAuthSessionPathname('/api/auth/%6Dobile/refresh') === false);
    assert('nothing outside /api/auth can land in this bucket', () =>
        AUTH_SESSION_PATHS.every((entry) => entry.prefix.startsWith('/api/auth/')));
    assert('every entry states its reason at length', () =>
        AUTH_SESSION_PATHS.every((entry) => entry.reason.length > 40));

    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n▶ The rate-limit split — ceilings');

    assert('the session policy is registered in POLICIES', () =>
        POLICIES.includes(AUTH_SESSION_POLICY));
    assert('it names every caller class', () =>
        CALLER_CLASSES.every((c) => ceilingFor(AUTH_SESSION_POLICY, c) !== undefined));
    assert('internal_service is NOT exempt — nothing internal holds a user session', () =>
        ceilingFor(AUTH_SESSION_POLICY, 'internal_service') !== 'exempt');
    assert('it is IP-scoped — /auth/mobile/refresh runs no requireAuth to key on', () =>
        AUTH_SESSION_POLICY.scope === 'ip');
    assert('it uses the same 60s window as every other policy', () =>
        AUTH_SESSION_POLICY.windowSeconds === 60);

    const session = ceilingFor(AUTH_SESSION_POLICY, 'anonymous') as number;
    const credential = ceilingFor(AUTH_POLICY, 'anonymous') as number;
    const layerA = ceilingFor(GLOBAL_POLICY, 'anonymous') as number;

    assert('it is LOOSER than the credential bucket, or the split bought nothing', () =>
        session > credential);
    assert('…and no looser than Layer A, or the extra headroom is a lie', () =>
        session <= layerA);
    assert('the credential bucket is untouched at 20', () => credential === 20);

    assert('the two buckets have distinct keys, so their counters cannot collide', () =>
        AUTH_SESSION_POLICY.key !== AUTH_POLICY.key);
    assert('every policy key is unique', () =>
        new Set(POLICIES.map((p) => p.key)).size === POLICIES.length);

    console.log('\n▶ …and the dispatcher reads an ABSOLUTE path');

    const limiter = code(read('api/rate-limit/rate-limit.middleware.ts'));
    assert('it composes req.baseUrl with req.path', () =>
        /\$\{req\.baseUrl\}\$\{req\.path\}/.test(limiter));
    assert('it does not classify on req.path alone', () =>
        !/isAuthSessionPathname\(\s*req\.path\s*\)/.test(limiter));
    assert('exactly one of the two limiters runs per request', () =>
        /isAuthSessionPathname\([\s\S]{0,60}?\?\s*authSessionRateLimiter\s*:\s*authRateLimiter/
            .test(limiter));

    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n▶ Maintenance — a read-only window must not sign out every bearer client');

    const readonlyState: MaintenanceState = {
        mode: 'readonly', reason: null, expiresAt: null, blockWebhooks: false,
    } as MaintenanceState;
    const downState: MaintenanceState = {
        mode: 'down', reason: null, expiresAt: null, blockWebhooks: false,
    } as MaintenanceState;
    const now = new Date('2026-08-14T12:00:00Z');

    assert('POST /api/auth/mobile/refresh survives readonly', () =>
        evaluateMaintenance(readonlyState, now, 'POST', '/api/auth/mobile/refresh').allowed === true);
    assert('…and is blocked in down, where extending a session is the point of the window', () =>
        evaluateMaintenance(downState, now, 'POST', '/api/auth/mobile/refresh').allowed === false);
    assert('the exemption says why', () =>
        (evaluateMaintenance(readonlyState, now, 'POST', '/api/auth/mobile/refresh').exemption ?? '')
            .includes('bearer session'));
    assert('POST /api/auth/login is still blocked in readonly — this is not a blanket /auth pass', () =>
        evaluateMaintenance(readonlyState, now, 'POST', '/api/auth/login').allowed === false);
    assert('GET /api/auth/me is allowed in readonly because it is a read, not by exemption', () =>
        evaluateMaintenance(readonlyState, now, 'GET', '/api/auth/me').exemption
            === 'read-only window, and this is a read');

    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n▶ CORS — the Capacitor origins are admissible');

    const envSource = code(read('config/env.ts'));

    assert('the origin rule admits the capacitor scheme', () =>
        envSource.includes('/^(https?|capacitor):\\/\\/[^/]+$/'));

    // Re-derive the rule rather than trusting the literal, so the assertions below describe
    // behaviour and not a string.
    const ORIGIN_RE = /^(https?|capacitor):\/\/[^/]+$/;
    assert('capacitor://localhost passes', () => ORIGIN_RE.test('capacitor://localhost'));
    assert('https://localhost passes', () => ORIGIN_RE.test('https://localhost'));
    assert('an ordinary dashboard origin still passes', () =>
        ORIGIN_RE.test('http://localhost:5174') && ORIGIN_RE.test('https://app.example.com'));
    assert('a TRAILING SLASH is still rejected (test:env depends on this)', () =>
        ORIGIN_RE.test('https://app.example.com/') === false);
    assert('a path is still rejected', () =>
        ORIGIN_RE.test('https://app.example.com/api') === false);
    assert('the scheme set is CLOSED — an arbitrary scheme is refused', () =>
        ORIGIN_RE.test('javascript://localhost') === false
        && ORIGIN_RE.test('file://localhost') === false);

    // The header design was declined, and this is what stops it creeping back in as a second,
    // parallel way to be "mobile" that can disagree with the route namespace. Comments are
    // stripped first — `mobile-auth.controller.ts` names the rejected design in its own header,
    // and explaining why something was not built is not building it.
    assert('no client-type header is READ anywhere in src/', () => {
        const hits: string[] = [];
        const walk = (dir: string): void => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) walk(full);
                else if (entry.name.endsWith('.ts')
                    && /x-client-type/i.test(code(fs.readFileSync(full, 'utf8')))) hits.push(full);
            }
        };
        walk(SRC);
        return hits.length === 0;
    });

    // ─────────────────────────────────────────────────────────────────────────
    // ADR-A03 / plan step 4.A.5. The cap is carried in a CLAIM rather than a store, so what
    // can be asserted DB-free is more than usual: the arithmetic, the copy and the D-9
    // fallback are all pure. What is NOT reachable without a database is the two raise sites
    // themselves — both load a user row first — so those are source scans, and the LAST one
    // in this group is the load-bearing assertion of the whole feature.
    console.log('\n▶ The 90-day absolute session cap');

    // The three minting cases below sign real JWTs, so a secret has to exist. This suite is
    // DB-free but not env-free; a locally-run one may have neither variable, and refusing to
    // mint is `getJwtSecret`'s correct production behaviour (step 3.E.2). A throwaway value
    // is set only when there is none — never overwriting a real one, because these tokens are
    // decoded, never verified, and a suite that quietly rewrote the signing key would be a
    // trap for whatever ran after it.
    if (!process.env.JWT_SECRET?.trim()) {
        process.env.JWT_SECRET = 'test-only-secret-for-test-mobile-auth-0123456789';
    }

    const CAP = ABSOLUTE_SESSION_CAP_S;
    const nowS = Math.floor(Date.now() / 1000);

    assert('the cap is 90 days by default', () => CAP === 7776000);
    assert('a session inside the cap is admitted', () =>
        isSessionCapReached({ auth_time: nowS - (CAP - 3600), iat: nowS }) === false);
    assert('a session past the cap is REFUSED, however fresh the token itself is', () =>
        isSessionCapReached({ auth_time: nowS - (CAP + 1), iat: nowS }) === true);
    // Distinctness from AUTH_SESSION_EXPIRED / AUTH_PASSWORD_CHANGED is enforced by the
    // compiler — the registry is `Object.freeze`d with literal types, so writing that
    // comparison here is a type error rather than a passing assertion. What is worth
    // asserting is that the code EXISTS under the name the api-doc publishes.
    assert('…and the refusal has its own code, under the published name', () =>
        ERROR_CODES.AUTH_SESSION_CAP_REACHED === 'AUTH_SESSION_CAP_REACHED');
    assert('it carries a registry message a client can show', () => {
        const message = DEFAULT_ERROR_MESSAGES[ERROR_CODES.AUTH_SESSION_CAP_REACHED];
        return typeof message === 'string' && message.length > 0;
    });
    assert('its taxonomy category is authentication, DERIVED from (code, 401)', () =>
        categoryFor(ERROR_CODES.AUTH_SESSION_CAP_REACHED, 401) === 'authentication');

    // A token that cannot be dated at all fails CLOSED. Unreachable for anything this
    // service signs (jsonwebtoken always stamps `iat`), which is exactly why a payload
    // arriving without either claim was assembled by hand.
    assert('an undateable payload is refused rather than granted forever', () =>
        isSessionCapReached({}) === true);

    // ── `auth_time` survives a re-issue BYTE-IDENTICAL ────────────────────────
    // Mint → decode → re-issue with what was decoded → decode again → compare. This is the
    // issuer half of the rotation; the service half is the source scan below, and neither
    // is sufficient alone.
    const originalAuthTime = nowS - 86_400 * 10;
    const first = issueTokenPair('64b7f0000000000000000001', 'agent', originalAuthTime);
    const firstPayload = jwt.decode(first.refreshToken) as Record<string, number>;
    assert('a minted pair carries auth_time on BOTH halves', () => {
        const access = jwt.decode(first.accessToken) as Record<string, number>;
        return access.auth_time === originalAuthTime && firstPayload.auth_time === originalAuthTime;
    });

    const rotated = issueTokenPair(
        '64b7f0000000000000000001', 'agent', resolveAuthTime(firstPayload)!,
    );
    assert('auth_time survives a re-issue byte-identical', () => {
        const access = jwt.decode(rotated.accessToken) as Record<string, number>;
        const refresh = jwt.decode(rotated.refreshToken) as Record<string, number>;
        return access.auth_time === originalAuthTime && refresh.auth_time === originalAuthTime;
    });
    assert('…while iat DOES move, so the two claims are not the same thing', () => {
        const refresh = jwt.decode(rotated.refreshToken) as Record<string, number>;
        return refresh.iat !== originalAuthTime && refresh.auth_time === originalAuthTime;
    });

    // ── D-9: a legacy token is dated from its own `iat` ───────────────────────
    const legacyIat = nowS - 86_400 * 20;   // minted 20 days ago, before this feature existed
    assert('a token with no auth_time is dated from its iat', () =>
        resolveAuthTime({ iat: legacyIat }) === legacyIat);
    assert('…so a legacy session inside the cap is ACCEPTED — nobody is signed out on deploy', () =>
        isSessionCapReached({ iat: legacyIat }) === false);
    assert('…and a legacy session past the cap is refused on its iat alone', () =>
        isSessionCapReached({ iat: nowS - (CAP + 1) }) === true);
    assert('…and its re-issue comes back carrying a REAL auth_time', () => {
        const healed = issueTokenPair('64b7f0000000000000000001', 'agent',
            resolveAuthTime({ iat: legacyIat })!);
        return (jwt.decode(healed.refreshToken) as Record<string, number>).auth_time === legacyIat;
    });

    // ── The source scans. No behavioural test can catch a re-stamp in under 90 days ──
    assert('rotateRefreshToken COPIES auth_time — it does not re-stamp', () =>
        /const authTime = resolveAuthTime\(payload\)!/.test(authService)
        && !/rotateRefreshToken[\s\S]*?this\.issueTokenPair\(user, payload\.role\)\s*;/.test(authService));
    assert('rotateRefreshToken raises the cap code', () =>
        /rotateRefreshToken[\s\S]*?isSessionCapReached\(payload\)[\s\S]{0,200}?AUTH_SESSION_CAP_REACHED/
            .test(authService));

    /**
     * ⚠ **The cutover's security half** — Phase 5 Part E, step E.1 — and it is here for the
     * same reason the `auth_time` scans above are: **no behavioural test can see it.**
     *
     * `rotateRefreshToken` copies the role out of the PRESENTED token; nothing in the method
     * re-reads `user.roles`. So proving the guard works needs a refresh token carrying
     * `role: 'admin'`, and there is no supported way to obtain one — `login`, `register`,
     * `authMe` and `addRole` have all refused that role for phases, which is precisely how
     * this path came to be the only one left open. A test that cannot mint the input cannot
     * assert the output; a source scan can.
     *
     * Two halves, both load-bearing:
     *   1. The guard is present, inside this method, and reads `payload.role` — the value that
     *      arrives from the token — rather than something derived from the user row.
     *   2. It sits BEFORE `issueTokenPair`. A guard after the mint is not a guard.
     */
    assert('rotateRefreshToken FILTERS the role — no legacy admin token can refresh itself', () =>
        /rotateRefreshToken[\s\S]*?if \(!isAuthenticatableRole\(payload\.role\)\)[\s\S]{0,200}?AUTH_ROLE_NOT_FOUND/
            .test(authService));
    assert('…and the filter runs BEFORE the pair is issued, not after', () => {
        const body = authService.slice(authService.indexOf('async rotateRefreshToken('));
        const guard = body.indexOf('isAuthenticatableRole(payload.role)');
        const mint = body.indexOf('this.issueTokenPair(user, payload.role, authTime)');
        return guard !== -1 && mint !== -1 && guard < mint;
    });
    assert('…using the same code login and authMe answer for the same condition', () =>
        (authService.match(/AUTH_ROLE_NOT_FOUND, 403, undefined, \{ role/g) ?? []).length === 3);

    /**
     * ⚠ **The one that makes the feature real.** `authMe` and `addRole` both mint a FULL
     * FRESH PAIR from a valid access token, and every client calls `auth-me` on launch — so
     * if either stamps a new `auth_time`, `nowS − auth_time` never approaches 90 days and the
     * cap is unreachable while looking completely implemented. Plan step 4.A.5.2 lists both
     * among the sites that stamp fresh; that is the correction this suite pins.
     */
    assert('authMe and addRole take an authTime and COPY it', () =>
        /async authMe\(input: AuthMeInput, authTime: number\)/.test(authService)
        && /async addRole\(userId: string, input: AddRoleInput, authTime: number\)/.test(authService)
        && (authService.match(/this\.issueTokenPair\(user, role, authTime\)/g) ?? []).length === 2);
    assert('…and neither takes the fresh-stamp default', () =>
        !/async authMe[\s\S]*?this\.issueTokenPair\(user, role\)\s*;/.test(authService));

    // The other half of that: the value has to reach them, and requireAuth is where the
    // verified claim lives. All four call sites (browser + mobile) must pass one.
    const authController = code(read('modules/auth/auth.controller.ts'));
    assert('requireAuth publishes the verified auth_time on req.auth', () =>
        /req\.auth = \{ user, role, role_entity: entity, auth_time: resolveAuthTime\(payload\)!/
            .test(middlewareCode));
    assert('requireAuth enforces the cap too — auth-me/add-role never reach the rotation', () =>
        /isSessionCapReached\(payload\)[\s\S]{0,120}?AUTH_SESSION_CAP_REACHED/.test(middlewareCode));
    assert('all four re-issue call sites pass an authTime through', () =>
        (authController.match(/authService\.(authMe|addRole)\([^)]*authTime\)/g) ?? []).length === 2
        && (mobileController.match(/authService\.(authMe|addRole)\([^)]*authTime\)/g) ?? []).length === 2);

    // Fresh at the four credential proofs, and nowhere else. `login`/`register` take the
    // default; the password change and the messaging login mint through the free function.
    assert('login and register take the FRESH default', () =>
        (authService.match(/\n\s*const tokens = this\.issueTokenPair\(user, role\);/g) ?? []).length === 2);
    assert('the password-change re-issue stamps fresh', () =>
        /issueTokenPair\(userId, req\.auth!\.role\)/.test(code(read('modules/users/user.controller.ts'))));
    assert('the messaging login stamps fresh', () =>
        /issueTokenPair\(String\(user\._id\), 'customer'\)/
            .test(code(read('modules/messaging-login/services/messaging-login.service.ts'))));

    assert('api-doc/auth documents the cap and tells a client not to retry', () => {
        const doc = fs.readFileSync(path.join(ROOT, 'api-doc/auth/README.md'), 'utf8');
        return doc.includes('AUTH_SESSION_CAP_REACHED')
            && /90[\s-]day/i.test(doc)
            && /never retry/i.test(doc);
    });

    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n▶ The environment contract');

    const envExample = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');

    assert('RATE_LIMIT_AUTH_SESSION_PER_MIN is documented', () =>
        envExample.includes('RATE_LIMIT_AUTH_SESSION_PER_MIN'));
    assert('…and is registered as a positive integer variable', () =>
        envSource.includes("'RATE_LIMIT_AUTH_SESSION_PER_MIN'"));
    assert('the Capacitor origins are documented on ALLOWED_ORIGINS', () =>
        envExample.includes('capacitor://localhost'));
    assert('…with the production caveat about https://localhost stated', () =>
        /https:\/\/localhost.{0,400}loopback/s.test(envExample));

    // The two above read the PROSE, and prose is what let this gap survive: both
    // origins were described here in full while the assignment below carried
    // neither. `ci.yml` literally does `cp .env.example .env`, so every
    // environment built from the template CORS-refused the WebView client this
    // whole namespace exists for — while the running `.env`, hand-edited, worked.
    // A test that reads the comment cannot see that. Assert the VALUE.
    assert('…and the ALLOWED_ORIGINS VALUE carries both, not just the comment', () => {
        const line = envExample.split('\n').find((l) => /^ALLOWED_ORIGINS\s*=/.test(l)) ?? '';
        return line.includes('capacitor://localhost') && line.includes('https://localhost');
    });

    console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
    if (failed > 0) process.exit(1);
}

main();
