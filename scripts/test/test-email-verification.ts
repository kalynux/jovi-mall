/**
 * Test: emailed-token links — one page per flow, for all four apps.
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no framework).
 * DB-free, and deliberately SOURCE-SCAN heavy: what this feature guarantees is a statement
 * about a URL that is built once and read by a browser somewhere else, so almost none of it
 * is observable from inside a request. The same argument `test:password-epoch` makes about
 * a predicate nobody calls — a link nobody clicks reports success either way.
 *
 * ── What this guards ─────────────────────────────────────────────────────────
 *
 * TWO emailed-token flows, and both must point at a PAGE rather than at this API:
 *
 *  1. **Registration verification** (`AuthService.sendEmailVerification`) — until this
 *     landed, its link was `{API_PUBLIC_URL}/api/auth/verify-email?token=…`, with three
 *     live consequences: a person who clicked it got a raw JSON envelope in their browser;
 *     the token was spent by whatever prefetched the mail, because it was a `GET` that
 *     mutates; and the landing app's `/verify-email` page had nothing pointing at it.
 *  2. **Email change** (`buildEmailChangeLink`) — already pointed at the storefront and
 *     already POSTed. What it lacked was `app=`, so the page could not tell which of the
 *     four audiences it was serving and sent everybody to storefront destinations.
 *
 * The through-line is that the confirming half of each flow is **role-free** — it reads no
 * session and resolves the account from the token — so one page can serve four apps. The
 * one thing it cannot work out for itself is where to send the person afterwards, which is
 * what `app=` answers, stamped by the half of the flow that HAS a session.
 *
 * ⚠ The `GET /verify-email` survivor is asserted as loudly as the `POST`. Deleting it is
 * the tempting tidy-up, and it breaks every link minted in the 24 hours before a deploy.
 *
 * Run: npm run test:email-verification
 */
import fs from 'fs';
import path from 'path';
import { buildEmailChangeLink } from '../../src/modules/users/services/contact-change.service';
import { VerifyEmailSchema } from '../../src/modules/auth/auth.schemas';
import { ConfirmEmailChangeSchema } from '../../src/modules/users/user.validator';
import { isAuthSessionPathname } from '../../src/api/rate-limit/auth-paths';

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

const SRC = path.resolve(__dirname, '../../src');
const read = (relative: string): string => fs.readFileSync(path.join(SRC, relative), 'utf8');

/**
 * Comments are stripped before scanning, exactly as `test:connections` does it — a scan
 * that matches its own explanatory prose passes for the wrong reason, and the tombstone
 * explaining what a line is for is the most useful thing in the diff.
 */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const authServiceSrc = stripComments(read('modules/auth/auth.service.ts'));
const authRoutesSrc = stripComments(read('modules/auth/auth.routes.ts'));
const authControllerSrc = stripComments(read('modules/auth/auth.controller.ts'));
const contactServiceSrc = stripComments(read('modules/users/services/contact-change.service.ts'));

/** Build a link with the environment temporarily set, then put it back. */
function withStorefront<T>(base: string | undefined, fn: () => T): T {
  const before = process.env.STOREFRONT_URL;
  if (base === undefined) delete process.env.STOREFRONT_URL;
  else process.env.STOREFRONT_URL = base;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.STOREFRONT_URL;
    else process.env.STOREFRONT_URL = before;
  }
}

function main(): void {
  console.log('\n▶ Registration verification — the link points at a PAGE, not at this API');

  assert('the link is built from STOREFRONT_URL, falling back to API_PUBLIC_URL', () =>
    /const verifyBase = \(process\.env\.STOREFRONT_URL \|\| API_PUBLIC_URL\)/.test(authServiceSrc));

  assert('…and the fallback strips a trailing slash, so the path cannot double up', () =>
    /const verifyBase = \([^)]*\)\.replace\([^)]*\)/.test(authServiceSrc));

  assert('⚠ the link no longer points at /api/auth/verify-email — that is the whole defect', () =>
    !/\$\{API_PUBLIC_URL\}\/api\/auth\/verify-email/.test(authServiceSrc));

  assert('it points at the page path /verify-email, carrying the token', () =>
    /verifyLink = `\$\{verifyBase\}\/verify-email\?token=\$\{token\}/.test(authServiceSrc));

  assert('…and stamps the requesting role as app=', () =>
    /\/verify-email\?token=\$\{token\}&app=\$\{encodeURIComponent\(role\)\}/.test(authServiceSrc));

  assert('`role` is the method parameter, not re-read from anywhere else', () =>
    /async sendEmailVerification\(userId: string, role: string\)/.test(authServiceSrc));

  console.log('\n▶ POST /auth/verify-email — spending the token deliberately');

  assert('the POST route exists', () =>
    /router\.post\('\/verify-email', AuthController\.verifyEmailPost\)/.test(authRoutesSrc));

  assert('⚠ the legacy GET SURVIVES — tokens live 24h, so pre-deploy links must keep working', () =>
    /router\.get\('\/verify-email', AuthController\.verifyEmail\)/.test(authRoutesSrc));

  assert('neither verb is behind requireAuth — the token arrives in a mail client', () => {
    const lines = authRoutesSrc.split('\n').filter((l) => l.includes("'/verify-email'"));
    return lines.length === 2 && lines.every((l) => !l.includes('requireAuth'));
  });

  assert('the POST handler parses the BODY through the schema', () =>
    /static verifyEmailPost = asyncHandler\([\s\S]{0,300}?VerifyEmailSchema\.parse\(req\.body\)/
      .test(authControllerSrc));

  assert('…and calls the SAME service method as the GET — one code path, no drift', () => {
    const start = authControllerSrc.indexOf('static verifyEmailPost');
    return /authService\.verifyEmail\(token\)/.test(authControllerSrc.slice(start, start + 400));
  });

  assert('the POST handler reads no req.auth — the token is the credential', () => {
    const start = authControllerSrc.indexOf('static verifyEmailPost');
    return !authControllerSrc.slice(start, start + 400).includes('req.auth');
  });

  console.log('\n▶ The rate-limit bucket — a bearer-secret spend counts as a credential');

  assert('/api/auth/verify-email stays in the STRICT credential bucket (20/min/IP)', () =>
    isAuthSessionPathname('/api/auth/verify-email') === false);

  assert('…and so does the email-change confirm beside it', () =>
    isAuthSessionPathname('/api/auth/email-change/confirm') === false);

  console.log('\n▶ VerifyEmailSchema — mirrors ConfirmEmailChangeSchema on purpose');

  assert('a 64-hex token parses', () =>
    VerifyEmailSchema.safeParse({ token: 'ab'.repeat(32) }).success);

  assert('an empty token is refused', () =>
    !VerifyEmailSchema.safeParse({ token: '' }).success);

  assert('a missing token is refused', () =>
    !VerifyEmailSchema.safeParse({}).success);

  assert('the 512-char bound refuses a pathological body before anything is looked up', () =>
    !VerifyEmailSchema.safeParse({ token: 'x'.repeat(513) }).success
    && VerifyEmailSchema.safeParse({ token: 'x'.repeat(512) }).success);

  assert('surrounding whitespace is trimmed — a copy-paste out of a mail client', () =>
    VerifyEmailSchema.parse({ token: '  abc  ' }).token === 'abc');

  assert('.strict() — an unknown key is a 400 rather than a silently ignored field', () =>
    !VerifyEmailSchema.safeParse({ token: 'abc', app: 'vendor' }).success);

  assert('the two token schemas agree on their bound — they are the same kind of secret', () =>
    VerifyEmailSchema.safeParse({ token: 'x'.repeat(512) }).success
      === ConfirmEmailChangeSchema.safeParse({ token: 'x'.repeat(512) }).success
    && VerifyEmailSchema.safeParse({ token: 'x'.repeat(513) }).success
      === ConfirmEmailChangeSchema.safeParse({ token: 'x'.repeat(513) }).success);

  console.log('\n▶ The email-change link — app= is stamped, and it is OPTIONAL');

  assert('with a role, the link carries app=', () =>
    withStorefront('https://shop.example.com', () =>
      buildEmailChangeLink('tok', 'vendor')
        === 'https://shop.example.com/account/confirm-email?token=tok&app=vendor'));

  assert('⚠ without one, the link is byte-identical to what it was before — inbox links', () =>
    withStorefront('https://shop.example.com', () =>
      buildEmailChangeLink('tok')
        === 'https://shop.example.com/account/confirm-email?token=tok'));

  assert('all four roles round-trip', () =>
    withStorefront('https://shop.example.com', () =>
      (['customer', 'vendor', 'agency', 'agent'] as const).every(
        (r) => buildEmailChangeLink('tok', r).endsWith(`&app=${r}`))));

  assert('the value is encoded — it is a key, and anything else must not break the query', () =>
    withStorefront('https://shop.example.com', () =>
      buildEmailChangeLink('tok', 'a&b=c').endsWith('&app=a%26b%3Dc')));

  assert('the link still points at the STOREFRONT, never at this API', () =>
    withStorefront('https://shop.example.com', () =>
      buildEmailChangeLink('tok', 'agent').startsWith('https://shop.example.com/')
      && !buildEmailChangeLink('tok', 'agent').includes('/api/')));

  console.log('\n▶ Where app= comes from — the half of the flow that has a session');

  assert('the ONE call site passes actor.role, resolved from the verified token', () =>
    /buildEmailChangeLink\(token, actor\.role\)/.test(contactServiceSrc));

  // Lookbehind excludes the declaration, so this counts INVOCATIONS. One builder with one
  // caller is what stops the mail and the api-doc drifting on the path or the parameters.
  assert('…and it is the only call site in the service', () =>
    (contactServiceSrc.match(/(?<!function )buildEmailChangeLink\(/g) ?? []).length === 1);

  assert('⚠ the parameter is a role KEY, never a caller-supplied URL — no ?return= anywhere', () =>
    !/[?&]return=/.test(contactServiceSrc) && !/[?&]return=/.test(authServiceSrc));

  assert('the confirm service takes NO actor — role-free is why one page serves four apps', () =>
    /async confirmEmailChange\(token: string\)/.test(contactServiceSrc));
}

main();
console.log(`\n${failed === 0 ? '✔' : '✖'} test:email-verification — ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
