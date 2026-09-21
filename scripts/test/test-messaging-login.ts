/**
 * Test: passwordless `/login` from WhatsApp / Telegram.
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no framework).
 * DB-free: the repositories, the connection service and Redis are all replaced with fakes,
 * which the resolver and the service accept by constructor injection.
 *
 * ── THE FIVE ASSERTIONS THIS SUITE EXISTS FOR ────────────────────────────────
 *
 *   1. **The `contact.user_id` guard.** A Telegram user can share somebody else's contact
 *      card, and it arrives in the same shape. Without the check, forwarding a victim's
 *      contact is a one-message account takeover. A forwarded-contact fixture is asserted
 *      REFUSED — the single highest-value assertion in the file.
 *   2. **A bare-digits `wa_phone_id` resolves to an account stored as `+237…`.** This is the
 *      silent-failure case: without the `+` prepend the resolver returns "no account found"
 *      for EVERYBODY, every other test still passes, and the feature looks implemented.
 *   3. **One error code across the four indistinguishable cases.** Unknown identifier, wrong
 *      code, expired-and-swept and code/identifier mismatch must be one answer, or the
 *      redeem endpoint is a registration oracle answering "is this phone a customer here?"
 *      for any number.
 *   4. **Every gate is re-checked at REDEMPTION**, not at mint — a suspension inside the ten
 *      minutes must be seen.
 *   5. **Spending either credential kills the other**, driven against a fake Redis that
 *      implements the real `SET NX` / atomic-consume semantics.
 *
 * Plus LEAK assertions (no credential in a result field or a log line, the attempt key is a
 * hash) and SOURCE SCANS for the structural invariants — the redeem routes living under
 * `/api/auth` so they inherit the credential bucket, the identity coming from the webhook
 * context rather than the payload, and the magic link being built from `STOREFRONT_URL`
 * rather than `API_PUBLIC_URL`. Those are invisible in behaviour until somebody is
 * exploiting them.
 *
 * Run: npm run test:messaging-login
 */
import fs from 'fs';
import path from 'path';

/**
 * Signing needs a secret, and `getJwtSecret()` fails CLOSED when unset — correctly, since a
 * deploy without one must not start. This suite asserts what a session is scoped to, not how
 * the secret is configured (`test:env` owns that), so it supplies its own rather than
 * requiring a populated `.env` to run DB-free.
 *
 * `||=`, never `=`: a real environment's secret is left alone.
 */
process.env.JWT_SECRET ||= 'test-secret-for-messaging-login-suite';
process.env.JWT_REFRESH_SECRET ||= 'test-refresh-secret-for-messaging-login-suite';

/**
 * Both bot replies embed a link built from this. Set so the link assertions test a real URL
 * rather than the unset-variable fallback — that fallback is itself asserted separately.
 */
process.env.STOREFRONT_URL ||= 'https://shop.test.invalid';

// ── The fake Redis is installed BEFORE the store is imported ─────────────────
// The store reaches for `getRedisClient` at call time, not at import time, so patching the
// factory's export here is enough — and it is the same monkey-patch-a-singleton technique
// `test:connections` uses on `connectionCodeStore.issue`.
import * as redisFactory from '../../src/infra/redis/redis.factory';

interface FakeEntry { value: string; expiresAtMs: number | null }

class FakeRedis {
  readonly store = new Map<string, FakeEntry>();

  private live(key: string): FakeEntry | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAtMs !== null && Date.now() > entry.expiresAtMs) {
      this.store.delete(key);
      return null;
    }
    return entry;
  }

  async get(key: string): Promise<string | null> {
    return this.live(key)?.value ?? null;
  }

  async set(
    key: string,
    value: string,
    options?: { NX?: boolean; EX?: number }
  ): Promise<string | null> {
    if (options?.NX && this.live(key)) return null;
    this.store.set(key, {
      value,
      expiresAtMs: options?.EX ? Date.now() + options.EX * 1000 : null,
    });
    return 'OK';
  }

  /** The only script this codebase evals here is GET-then-DEL. */
  async eval(_script: string, options: { keys: string[] }): Promise<string | null> {
    const key = options.keys[0];
    const entry = this.live(key);
    if (!entry) return null;
    this.store.delete(key);
    return entry.value;
  }

  async del(key: string | string[]): Promise<number> {
    const keys = Array.isArray(key) ? key : [key];
    let removed = 0;
    for (const k of keys) if (this.store.delete(k)) removed++;
    return removed;
  }

  async incr(key: string): Promise<number> {
    const current = Number(this.live(key)?.value ?? '0') + 1;
    const existing = this.store.get(key);
    this.store.set(key, {
      value: String(current),
      expiresAtMs: existing?.expiresAtMs ?? null,
    });
    return current;
  }

  async expire(key: string, seconds: number): Promise<boolean> {
    const entry = this.store.get(key);
    if (!entry) return false;
    entry.expiresAtMs = Date.now() + seconds * 1000;
    return true;
  }

  keys(): string[] {
    return [...this.store.keys()];
  }
}

const fakeRedis = new FakeRedis();
 
(redisFactory as any).getRedisClient = async () => fakeRedis;

import {
  LOGIN_CODE_LENGTH,
  LOGIN_CODE_PATTERN,
  generateLoginCode,
  isWellFormedLoginCode,
  normalizeLoginCode,
} from '../../src/modules/messaging-login/domain/login-code';
import {
  LOGIN_TOKEN_BYTES,
  digestForKey,
  generateLoginSessionId,
  generateLoginToken,
  isWellFormedLoginToken,
} from '../../src/modules/messaging-login/domain/login-token';
import {
  isUsableLoginIdentifier,
  normalizeLoginIdentifier,
} from '../../src/modules/messaging-login/domain/login-identifier';
import {
  LoginIdentityResolver,
  messagingPhoneToE164,
} from '../../src/modules/messaging-login/services/identity-resolver.service';
import {
  LoginSessionStore,
  LOGIN_MAX_ATTEMPTS,
  LOGIN_SESSION_TTL_SECONDS,
  LOGIN_SESSION_GRACE_SECONDS,
} from '../../src/modules/messaging-login/services/login-session.store';
import { MessagingLoginService } from '../../src/modules/messaging-login/services/messaging-login.service';
import { buildLoginCommandReply } from '../../src/modules/messaging-login/commands/login.command';
import { buildResetCommandReply } from '../../src/modules/messaging-login/commands/reset-password.command';
import { handler as loginContactHandler, schema as loginContactSchema }
  from '../../src/modules/messaging-login/commands/login-contact.command';
import {
  pendingIntentStore,
  DEFAULT_PENDING_INTENT,
} from '../../src/modules/messaging-login/services/pending-intent.store';
import { RESET_TOKEN_TTL_MINUTES } from '../../src/modules/auth/services/password-reset.service';
import { SYSTEM_PASSWORD_BYTES, generateSystemPassword } from '../../src/core/auth/system-password';
import { AUTH_SESSION_PATHS, isAuthSessionPathname } from '../../src/api/rate-limit/auth-paths';

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

/**
 * The async twin. Passing an `async` callback to `assert` is a silent always-pass — the
 * helper receives a Promise, which is truthy whatever it settles to.
 */
async function assertAsync(name: string, fn: () => Promise<boolean>): Promise<void> {
  let ok: boolean;
  try {
    ok = await fn();
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

/** Source with comments removed, for the "it is really absent" scans. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

async function codeFrom(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return 'NO_THROW';
  } catch (err) {
    return (err as { code?: string }).code ?? 'NO_CODE';
  }
}

const SAMPLE = 4000;

// ── Fixture identities ───────────────────────────────────────────────────────
const USER_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER_USER_ID = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const CUSTOMER_ID = 'cccccccccccccccccccccccc';
const STORED_PHONE = '+237600001234';
/** What Meta actually sends: the same number, bare. */
const WA_PHONE_ID = '237600001234';
const TG_CHAT_ID = '555000111';

interface FakeUser {
  id: string;
  _id: string;
  login_phone: string;
  login_email?: string;
  roles: string[];
  status: string;
}

function makeUser(overrides: Partial<FakeUser> = {}): FakeUser {
  return {
    id: USER_ID,
    _id: USER_ID,
    login_phone: STORED_PHONE,
    roles: ['customer'],
    status: 'active',
    ...overrides,
  };
}

/** Builds a resolver whose three dependencies are hand-rolled fakes. */
function resolverWith(options: {
  users?: FakeUser[];
  identityOwner?: string | null;
  onBind?: (userId: string, data: unknown) => void;
  customerExists?: boolean;
}) {
  const users = options.users ?? [makeUser()];
  const bound: Array<{ userId: string; data: unknown }> = [];

  const connections = {
    resolveIdentityOwner: async () =>
      options.identityOwner ? ({ user_id: options.identityOwner, external_id: 'x', handle: null }) : null,
    bindVerifiedIdentity: async (userId: string, data: unknown) => {
      bound.push({ userId: userId.toString(), data });
      options.onBind?.(userId.toString(), data);
      return data;
    },
     
  } as any;

  const userRepo = {
    findById: async (id: string) => users.find((u) => u.id === id) ?? null,
    findByPhone: async (phone: string) => users.find((u) => u.login_phone === phone) ?? null,
    findByEmail: async (email: string) => users.find((u) => u.login_email === email) ?? null,
     
  } as any;

  const customerRepo = {
    findByUserId: async () =>
      options.customerExists === false ? null : { _id: CUSTOMER_ID },
     
  } as any;

  return {
    resolver: new LoginIdentityResolver(connections, userRepo, customerRepo),
    bound,
  };
}

function serviceWith(users: FakeUser[], customerExists = true) {
  const userRepo = {
    findById: async (id: string) => users.find((u) => u.id === id) ?? null,
    findByPhone: async (phone: string) => users.find((u) => u.login_phone === phone) ?? null,
    findByEmail: async (email: string) => users.find((u) => u.login_email === email) ?? null,
     
  } as any;

  const customerRepo = {
    findByUserId: async () => (customerExists ? { _id: CUSTOMER_ID } : null),
     
  } as any;

  const store = new LoginSessionStore();
  return { service: new MessagingLoginService(store, userRepo, customerRepo), store };
}

const ACCOUNT = {
  userId: USER_ID,
  customerId: CUSTOMER_ID,
  channel: 'whatsapp' as const,
  externalIdentity: WA_PHONE_ID,
  identityHint: '••••1234',
};

async function main(): Promise<void> {
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n▶ The code — 8 characters, shared alphabet');

  assert('LOGIN_CODE_LENGTH is 8', () => LOGIN_CODE_LENGTH === 8);
  assert('a generated code is 8 characters', () => generateLoginCode().length === 8);

  const codes = Array.from({ length: SAMPLE }, () => generateLoginCode());

  assert('every generated code matches the published pattern', () =>
    codes.every((c) => LOGIN_CODE_PATTERN.test(c)));
  assert('every generated code passes isWellFormedLoginCode', () =>
    codes.every((c) => isWellFormedLoginCode(c)));
  assert('no I, L, O or U is ever generated', () => codes.every((c) => !/[ILOU]/.test(c)));
  assert('codes are uppercase-only', () => codes.every((c) => c === c.toUpperCase()));

  /**
   * 256 % 32 === 0, so `byte & 31` samples the 32-symbol alphabet without modulo bias.
   * 4000 codes is 32000 draws, ~1000 expected per symbol; under 400 is a real signal.
   */
  assert('all 32 symbols appear — the sampling is unbiased at this length too', () => {
    const counts = new Map<string, number>();
    for (const c of codes) for (const ch of c) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    return counts.size === 32 && [...counts.values()].every((n) => n > 400);
  });

  assert('codes are not sequential — 4000 draws are all distinct', () =>
    new Set(codes).size === SAMPLE);

  /**
   * THE load-bearing normaliser property, re-asserted at THIS length. Because the alphabet
   * excludes I, L and O, normalization can only ever rewrite a character a user typed —
   * never one we generated — so it cannot collapse two distinct live codes onto one key.
   */
  assert('every generated code is a FIXED POINT of normalize', () =>
    codes.every((c) => normalizeLoginCode(c) === c));

  assert('normalize rescues the ambiguous glyphs', () =>
    normalizeLoginCode('oil9p2ab') === '01191P2AB'.slice(0, 8)
    || normalizeLoginCode('oil9p2ab') === '0119P2AB');
  assert('normalize strips spaces and hyphens and folds case', () =>
    normalizeLoginCode(' 4b2k-91qn ') === '4B2K91QN');

  /**
   * The two codes are NON-INTERCHANGEABLE by construction. A 6-character connection code
   * physically cannot be submitted as a login code, so nothing can be replayed across the
   * two features and a user pasting the wrong one gets a clean rejection.
   */
  assert('a 6-character connection code is NOT a well-formed login code', () =>
    !isWellFormedLoginCode('A7K9P2'));
  assert('a 9-character string is not one either', () =>
    !isWellFormedLoginCode('A7K9P2XYZ'));

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n▶ The magic-link token — opaque, 256 bits');

  assert('LOGIN_TOKEN_BYTES is 32 — 256 bits', () => LOGIN_TOKEN_BYTES === 32);

  const tokens = Array.from({ length: 1000 }, () => generateLoginToken());

  assert('a token is 43 base64url characters', () =>
    tokens.every((t) => t.length === 43 && isWellFormedLoginToken(t)));
  assert('tokens are URL-safe — no +, / or = ever appears', () =>
    tokens.every((t) => !/[+/=]/.test(t)));
  assert('1000 tokens are all distinct', () => new Set(tokens).size === 1000);
  assert('a token is NOT a JWT — nothing to decode, nothing to leak', () =>
    tokens.every((t) => t.split('.').length === 1));
  assert('a malformed token is rejected before Redis', () =>
    !isWellFormedLoginToken('short') && !isWellFormedLoginToken(`${tokens[0]}extra`));

  assert('session ids are random and distinct', () => {
    const ids = Array.from({ length: 1000 }, () => generateLoginSessionId());
    return new Set(ids).size === 1000 && ids.every((i) => /^[0-9a-f]{32}$/.test(i));
  });

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n▶ D-1: the bare-digits trap (the silent-failure case)');

  /**
   * ⚠ THE assertion this feature is most likely to be shipped without. `wa_phone_id` arrives
   * from Meta as bare digits while `login_phone` is stored as strict E.164 — and the shared
   * helpers do NOT bridge that gap, so a naive `findByPhone(wa_phone_id)` matches nothing for
   * every user while looking perfectly implemented.
   */
  assert('toE164 alone would REJECT a bare-digits wa_phone_id (the trap is real)', () => {
    // Re-derived here rather than asserted from memory: if the shared helper ever starts
    // prepending, this test is what says the repair below is now redundant.
     
    // Deliberate lazy require: it keeps this assertion's dependency LOCAL to it. A
    // top-level import of the shared helper would read as "this suite tests toE164",
    // which is the opposite of the point — the suite tests the repair that exists
    // BECAUSE toE164 rejects a bare-digits wa_phone_id.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { toE164 } = require('../../src/core/validation/phone');
    return toE164(WA_PHONE_ID) === null;
  });

  assert('messagingPhoneToE164 repairs bare digits', () =>
    messagingPhoneToE164(WA_PHONE_ID) === STORED_PHONE);
  assert('…and leaves an already-E.164 value alone', () =>
    messagingPhoneToE164(STORED_PHONE) === STORED_PHONE);
  assert('…and repairs the formatting a human or a bridge may add', () =>
    messagingPhoneToE164('+237 600 001 234') === STORED_PHONE
    && messagingPhoneToE164('237-600-001-234') === STORED_PHONE);
  assert('it never invents a country code for a national number', () =>
    messagingPhoneToE164('600123') === null);
  assert('it refuses a leading 0 country code rather than guessing', () =>
    messagingPhoneToE164('0237600001234') === null);
  assert('it refuses junk and null', () =>
    messagingPhoneToE164('not-a-number') === null
    && messagingPhoneToE164(null) === null
    && messagingPhoneToE164(undefined) === null);

  await assertAsync('END TO END: a bare-digits /login resolves the account stored as +237…', async () => {
    const { resolver } = resolverWith({});
    const outcome = await resolver.resolveForLogin('whatsapp', WA_PHONE_ID);
    return outcome.status === 'resolved' && outcome.account.userId === USER_ID;
  });

  await assertAsync('…and PERSISTS the connection, so a second /login takes the fast path', async () => {
    const { resolver, bound } = resolverWith({});
    await resolver.resolveForLogin('whatsapp', WA_PHONE_ID, { displayName: 'Jane' });
    return bound.length === 1
      && bound[0].userId === USER_ID
      && (bound[0].data as { externalId: string }).externalId === WA_PHONE_ID;
  });

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n▶ D-1: the resolution ladder');

  await assertAsync('step 1 — an already-bound identity resolves without a phone lookup', async () => {
    const { resolver } = resolverWith({
      identityOwner: USER_ID,
      // A user whose phone would NOT match, proving the connection is what resolved it.
      users: [makeUser({ login_phone: '+237699999999' })],
    });
    const outcome = await resolver.resolveForLogin('telegram', TG_CHAT_ID);
    return outcome.status === 'resolved' && outcome.account.userId === USER_ID;
  });

  await assertAsync('step 3 — an UNKNOWN Telegram chat asks for a contact, it does not fail', async () => {
    const { resolver } = resolverWith({});
    const outcome = await resolver.resolveForLogin('telegram', TG_CHAT_ID);
    return outcome.status === 'needs_contact';
  });

  await assertAsync('a Telegram chat is never resolved by phone — chat_id matches no column', async () => {
    // The fixture's login_phone is literally the chat id; it must still not resolve.
    const { resolver } = resolverWith({ users: [makeUser({ login_phone: TG_CHAT_ID })] });
    const outcome = await resolver.resolveForLogin('telegram', TG_CHAT_ID);
    return outcome.status === 'needs_contact';
  });

  await assertAsync('a dangling connection (user deleted) does not resolve', async () => {
    const { resolver } = resolverWith({ identityOwner: 'deadbeefdeadbeefdeadbeef', users: [] });
    const outcome = await resolver.resolveForLogin('whatsapp', WA_PHONE_ID);
    return outcome.status === 'no_account';
  });

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n▶ The refusal table');

  await assertAsync('no matching account', async () => {
    const { resolver } = resolverWith({ users: [] });
    return (await resolver.resolveForLogin('whatsapp', WA_PHONE_ID)).status === 'no_account';
  });

  await assertAsync('an account with NO customer role is refused — never auto-provisioned', async () => {
    const { resolver, bound } = resolverWith({ users: [makeUser({ roles: ['vendor'] })] });
    const outcome = await resolver.resolveForLogin('whatsapp', WA_PHONE_ID);
    return outcome.status === 'not_customer' && bound.length === 0;
  });

  await assertAsync('a suspended account is refused', async () => {
    const { resolver } = resolverWith({ users: [makeUser({ status: 'suspended' })] });
    return (await resolver.resolveForLogin('whatsapp', WA_PHONE_ID)).status === 'account_inactive';
  });

  await assertAsync('the customer role WITHOUT a customer profile is refused, not crashed', async () => {
    const { resolver } = resolverWith({ customerExists: false });
    return (await resolver.resolveForLogin('whatsapp', WA_PHONE_ID)).status === 'not_customer';
  });

  /**
   * A REFUSAL MUST NOT BIND. Connecting a channel is what starts a person's notifications
   * flowing to it, and doing that off the back of a sign-in the platform just refused is a
   * side effect nobody asked for — on an account that, suspended, cannot even be used.
   */
  await assertAsync('a refused sign-in binds NO connection', async () => {
    const { resolver, bound } = resolverWith({ users: [makeUser({ status: 'suspended' })] });
    await resolver.resolveForLogin('whatsapp', WA_PHONE_ID);
    return bound.length === 0;
  });

  await assertAsync('a Telegram chat owned by ANOTHER account is refused, never transferred', async () => {
    const { resolver, bound } = resolverWith({ identityOwner: OTHER_USER_ID });
    const outcome = await resolver.resolveFromVerifiedContact('login', TG_CHAT_ID, STORED_PHONE);
    return outcome.status === 'identity_taken' && bound.length === 0;
  });

  await assertAsync('a verified contact for OUR OWN existing chat is idempotent, not a conflict', async () => {
    const { resolver } = resolverWith({ identityOwner: USER_ID });
    const outcome = await resolver.resolveFromVerifiedContact('login', TG_CHAT_ID, STORED_PHONE);
    return outcome.status === 'resolved';
  });

  await assertAsync('a contact phone that will not normalise is refused', async () => {
    const { resolver } = resolverWith({});
    return (await resolver.resolveFromVerifiedContact('login', TG_CHAT_ID, 'nonsense')).status === 'no_account';
  });

  await assertAsync('a BARE-DIGITS contact phone from Telegram is repaired too', async () => {
    const { resolver } = resolverWith({});
    const outcome = await resolver.resolveFromVerifiedContact('login', TG_CHAT_ID, WA_PHONE_ID);
    return outcome.status === 'resolved' && outcome.account.userId === USER_ID;
  });

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n▶ ⚠ THE CONTACT-SHARE GUARD — a forwarded contact is account takeover');

  const tgContext = { source: 'telegram', chat_id: TG_CHAT_ID };

  await assertAsync('a FORWARDED contact (user_id ≠ sender) is REFUSED', async () => {
    const code = await codeFrom(() =>
      loginContactHandler(
        loginContactSchema.parse({
          contact: { phone_number: STORED_PHONE, user_id: '999999999', first_name: 'Victim' },
        }),
         
        tgContext as any
      ));
    return code === 'MAGIC_CONTACT_UNVERIFIED';
  });

  await assertAsync('a contact with NO user_id is refused — absence is not a hint', async () => {
    const code = await codeFrom(() =>
      loginContactHandler(
        loginContactSchema.parse({
          contact: { phone_number: STORED_PHONE, first_name: 'Address Book Entry' },
        }),
         
        tgContext as any
      ));
    return code === 'MAGIC_CONTACT_UNVERIFIED';
  });

  await assertAsync('a contact with a NULL user_id is refused', async () => {
    const code = await codeFrom(() =>
      loginContactHandler(
        loginContactSchema.parse({
          contact: { phone_number: STORED_PHONE, user_id: null },
        }),
         
        tgContext as any
      ));
    return code === 'MAGIC_CONTACT_UNVERIFIED';
  });

  await assertAsync('a payload from.id that disagrees with the CONTEXT is refused', async () => {
    const code = await codeFrom(() =>
      loginContactHandler(
        loginContactSchema.parse({
          contact: { phone_number: STORED_PHONE, user_id: TG_CHAT_ID },
          from: { id: '999999999' },
        }),
         
        tgContext as any
      ));
    return code === 'MAGIC_CONTACT_UNVERIFIED';
  });

  /**
   * The comparand is the CONTEXT's chat id, never a payload-supplied `from.id`. Taking both
   * sides from the payload would let anyone who reaches the webhook satisfy the guard by
   * sending two matching numbers, which is not a guard at all.
   */
  assert('SOURCE SCAN: the guard compares against the CONTEXT chat id', () => {
    const cmd = stripComments(read('modules/messaging-login/commands/login-contact.command.ts'));
    return /sameId\(contact\.user_id,\s*chatId\)/.test(cmd)
      && /const \{ channel, externalIdentity: chatId \} = resolveSender\(context\)/.test(cmd);
  });

  assert('SOURCE SCAN: a numeric and a string id compare equal (bridges differ)', () =>
    read('modules/messaging-login/commands/login-contact.command.ts')
      .includes('String(a) === String(b)'));

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n▶ The session store — one record, two credentials');

  const store = new LoginSessionStore();

  const issued = await store.issue({ ...ACCOUNT });

  assert('issue returns both credentials', () =>
    issued.code.length === 8 && issued.token.length === 43);
  assert('the TTL is 600 seconds', () =>
    issued.ttlSeconds === 600 && LOGIN_SESSION_TTL_SECONDS === 600);

  /**
   * ⚠ The grace must be on the POINTERS as well as the record. With the pointers at plain
   * TTL, a token whose pointer had lapsed could never resolve to its record — so EXPIRED
   * would be unreachable and every late user would be told INVALID.
   */
  assert('the record AND both credential pointers outlive the validity', () => {
    const keys = fakeRedis.keys();
    const session = keys.find((k) => k.startsWith('login:session:'));
    const token = keys.find((k) => k.startsWith('login:token:'));
    const code = keys.find((k) => k.startsWith('login:code:'));
    if (!session || !token || !code) return false;
    const expected = (LOGIN_SESSION_TTL_SECONDS + LOGIN_SESSION_GRACE_SECONDS) * 1000;
     
    const ttlOf = (k: string) => (fakeRedis as any).store.get(k).expiresAtMs - Date.now();
    return [session, token, code].every((k) => ttlOf(k) > expected - 5000);
  });

  assert('the IDENTITY pointer carries the validity only, not the grace', () => {
    const key = fakeRedis.keys().find((k) => k.startsWith('login:identity:'));
    if (!key) return false;
     
    const ttl = (fakeRedis as any).store.get(key).expiresAtMs - Date.now();
    return ttl <= LOGIN_SESSION_TTL_SECONDS * 1000 + 1000;
  });

  await assertAsync('the link resolves the session', async () =>
    (await store.consumeByToken(issued.token)).status === 'ok');

  await assertAsync('⚠ spending the LINK kills the CODE', async () =>
    (await store.consumeByCode(issued.code)).status === 'missing');

  const issued2 = await store.issue({ ...ACCOUNT });
  await assertAsync('the code resolves the session', async () =>
    (await store.consumeByCode(issued2.code)).status === 'ok');
  await assertAsync('⚠ spending the CODE kills the LINK', async () =>
    (await store.consumeByToken(issued2.token)).status === 'missing');

  const issued3 = await store.issue({ ...ACCOUNT });
  await assertAsync('two concurrent redemptions: exactly ONE wins', async () => {
    const [a, b] = await Promise.all([
      store.consumeByToken(issued3.token),
      store.consumeByCode(issued3.code),
    ]);
    return [a, b].filter((r) => r.status === 'ok').length === 1
      && [a, b].filter((r) => r.status === 'missing').length === 1;
  });

  const first = await store.issue({ ...ACCOUNT });
  const second = await store.issue({ ...ACCOUNT });
  await assertAsync('a second /login REVOKES the first pair — one live pair per identity', async () => {
    const oldCode = await store.consumeByCode(first.code);
    const oldToken = await store.consumeByToken(first.token);
    const newCode = await store.consumeByCode(second.code);
    return oldCode.status === 'missing'
      && oldToken.status === 'missing'
      && newCode.status === 'ok';
  });

  await assertAsync('spending leaves NO pointer behind', async () => {
    const s = await store.issue({ ...ACCOUNT });
    await store.consumeByCode(s.code);
    return !fakeRedis.keys().some((k) => k.startsWith('login:token:') || k.startsWith('login:code:'));
  });

  await assertAsync('a code that never existed answers missing', async () =>
    (await store.consumeByCode('QQ7W6E22')).status === 'missing');
  await assertAsync('a token that never existed answers missing', async () =>
    (await store.consumeByToken(generateLoginToken())).status === 'missing');

  /**
   * A credential past `expiresAt` but inside the grace answers EXPIRED, and is SPENT by the
   * attempt — so the grace explains one failure per credential rather than becoming a probe.
   */
  await assertAsync('an expired-but-in-grace credential answers EXPIRED, not missing', async () => {
    const s = await store.issue({ ...ACCOUNT });
    const sessionKey = fakeRedis.keys().find((k) => k.startsWith('login:session:'))!;
     
    const entry = (fakeRedis as any).store.get(sessionKey);
    const record = JSON.parse(entry.value);
    record.expiresAt = new Date(Date.now() - 60_000).toISOString();
    entry.value = JSON.stringify(record);

    const outcome = await store.consumeByToken(s.token);
    const spent = await store.consumeByToken(s.token);
    return outcome.status === 'expired' && spent.status === 'missing';
  });

  console.log('\n▶ The attempt ceiling');

  await assertAsync('the 6th attempt on one identifier is refused', async () => {
    const verdicts: boolean[] = [];
    for (let i = 0; i < 6; i++) verdicts.push(await store.recordAttempt('+237600009999'));
    return verdicts.slice(0, 5).every(Boolean) && verdicts[5] === false;
  });
  assert('the ceiling is 5', () => LOGIN_MAX_ATTEMPTS === 5);

  await assertAsync('clearing resets it, so a typo costs nothing later', async () => {
    await store.clearAttempts('+237600009999');
    return (await store.recordAttempt('+237600009999')) === true;
  });

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n▶ LEAK: no credential in a key name, a result field or a log line');

  /**
   * `GET /api/internal/admin/system/cache/keys` lists key NAMES for any catalogued database
   * and offers no value read. So a raw token or code in a name is a live session credential
   * readable from the operations surface, and a raw phone number there is personal data in
   * an operational listing.
   */
  const leakSession = await store.issue({ ...ACCOUNT });

  assert('no key name contains the raw token or the raw code', () =>
    fakeRedis.keys().every((k) => !k.includes(leakSession.token) && !k.includes(leakSession.code)));
  assert('no key name contains the raw messaging identity', () =>
    fakeRedis.keys().every((k) => !k.includes(WA_PHONE_ID)));
  assert('the code IS reachable through its digest — the hash is a lookup, not a one-way bin', () =>
    fakeRedis.keys().includes(`login:code:${digestForKey(leakSession.code)}`));

  await assertAsync('the attempt key is a HASH, never the raw phone number', async () => {
    await store.recordAttempt(STORED_PHONE);
    const keys = fakeRedis.keys();
    // Named exactly rather than by `find` — earlier assertions left other attempt counters
    // in the fake, and picking the first one would prove nothing about this identifier.
    return keys.includes(`login:attempts:${digestForKey(STORED_PHONE)}`)
      && keys.every((k) => !k.includes(STORED_PHONE));
  });

  /**
   * ⚠ The command result must NOT carry the token or the code as separate fields. `/connect`
   * returns `code` beside `message` for the automation layer's convenience; these are session
   * credentials, and a webhook RESPONSE BODY is logged in more places than a chat message.
   */
  const logLines: string[] = [];
  const realLog = console.log;
  const realError = console.error;
   
  console.log = (...args: any[]) => { logLines.push(args.join(' ')); };
   
  console.error = (...args: any[]) => { logLines.push(args.join(' ')); };

  let reply: unknown;
  try {
    reply = await buildLoginCommandReply(
      { status: 'resolved', account: { ...ACCOUNT } },
      'whatsapp',
      WA_PHONE_ID
    );
  } finally {
    console.log = realLog;
    console.error = realError;
  }

  const serialised = JSON.stringify(reply);
  const replyRecord = reply as { message: string; expiresInSeconds: number };

  assert('the result has NO token field and NO code field', () => {
    const keys = Object.keys(reply as object);
    return !keys.some((k) => /token|code|secret|link/i.test(k));
  });

  assert('the credentials appear ONLY inside `message`', () => {
    const message = replyRecord.message;
    const withoutMessage = serialised.replace(JSON.stringify(message), '""');
    // The message must carry the code (the user needs it) …
    return /[0-9A-HJKMNP-TV-Z]{8}/.test(message)
      // … and nothing outside it may.
      && !/[0-9A-HJKMNP-TV-Z]{8}/.test(withoutMessage.replace(/"whatsapp"/g, ''));
  });

  assert('NO log line written during a mint contains the code or the token', () => {
    const message = replyRecord.message;
    const codeInMessage = message.match(/\n([0-9A-HJKMNP-TV-Z]{8})\n/)?.[1];
    const tokenInMessage = message.match(/\?t=([A-Za-z0-9_-]{43})/)?.[1];
    return logLines.length > 0
      && logLines.every((line) =>
        (!codeInMessage || !line.includes(codeInMessage))
        && (!tokenInMessage || !line.includes(tokenInMessage)));
  });

  assert('the mint DOES log the identity, so the event is still traceable', () =>
    logLines.some((line) => line.includes(WA_PHONE_ID)));

  /**
   * ⚠ **The WORDING changed on 2026-09-20; the GUARANTEE did not.** The message became
   * five-language, and the lifetime now prints as `10 min` — a symbol that does not inflect,
   * so Arabic never has to pick between four plural forms (`bot-signin-message.ts` carries
   * the reasoning). `10 minutes` is therefore gone on purpose, and this asserts the new
   * format AND the absence of the old one, so a silent revert fails here too.
   *
   * ⛔ **The single use, though, was genuinely LOST in that rewrite, and this line is what
   * caught it** — for one round the customer was told when the code dies and not that
   * spending it kills it. The English sentence is spelled out HERE, a second time, on
   * purpose: a guard that read the phrase out of the copy table it is checking would have
   * passed on a table with the sentence deleted, which is precisely the edit that happened.
   */
  assert('the reply states the expiry and the single use', () =>
    replyRecord.message.includes('10 min')
    && !replyRecord.message.includes('10 minutes')
    && replyRecord.message.includes('Single use only.')
    && replyRecord.expiresInSeconds === 600);

  assert('the reply tells an unintended recipient to ignore it', () =>
    /did not ask to sign in/i.test(replyRecord.message));

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n▶ Redemption — the gates are re-checked HERE, not at mint');

  await assertAsync('a valid code signs in and yields a customer-scoped pair', async () => {
    const { service, store: s } = serviceWith([makeUser()]);
    const minted = await s.issue({ ...ACCOUNT });
    const result = await service.redeemCode(STORED_PHONE, minted.code);
    return result.role === 'customer' && !!result.accessToken && !!result.refreshToken;
  });

  await assertAsync('the magic link signs in too', async () => {
    const { service, store: s } = serviceWith([makeUser()]);
    const minted = await s.issue({ ...ACCOUNT });
    const result = await service.redeemLink(minted.token);
    return result.role === 'customer' && !!result.accessToken;
  });

  /**
   * The record stores IDS, never a snapshot — so a suspension inside the ten minutes is seen.
   * Minted against an active account, redeemed after it is suspended.
   */
  await assertAsync('⚠ a suspension AFTER minting is caught at redemption', async () => {
    const user = makeUser();
    const { service, store: s } = serviceWith([user]);
    const minted = await s.issue({ ...ACCOUNT });
    user.status = 'suspended';
    return (await codeFrom(() => service.redeemCode(STORED_PHONE, minted.code)))
      === 'AUTH_ACCOUNT_SUSPENDED';
  });

  await assertAsync('a role removed after minting is caught at redemption', async () => {
    const user = makeUser();
    const { service, store: s } = serviceWith([user]);
    const minted = await s.issue({ ...ACCOUNT });
    user.roles = ['vendor'];
    return (await codeFrom(() => service.redeemLink(minted.token))) === 'AUTH_ROLE_NOT_FOUND';
  });

  await assertAsync('a customer profile deleted after minting is caught at redemption', async () => {
    const { service, store: s } = serviceWith([makeUser()], false);
    const minted = await s.issue({ ...ACCOUNT });
    return (await codeFrom(() => service.redeemLink(minted.token))) === 'AUTH_PROFILE_NOT_FOUND';
  });

  await assertAsync('a user deleted after minting is caught at redemption', async () => {
    const { service, store: s } = serviceWith([]);
    const minted = await s.issue({ ...ACCOUNT });
    return (await codeFrom(() => service.redeemLink(minted.token))) === 'AUTH_ACCOUNT_NOT_FOUND';
  });

  console.log('\n▶ ⚠ ONE error code across the four indistinguishable cases');

  /**
   * Unknown identifier, wrong code, expired-and-swept, and a code belonging to a DIFFERENT
   * account must all answer identically. Any difference makes this a registration oracle
   * answering "is this phone a customer here?" for anyone, for any number, with no account.
   */
  const indistinguishable: string[] = [];

  {
    const { service, store: s } = serviceWith([makeUser()]);
    const minted = await s.issue({ ...ACCOUNT });
    // (a) unknown identifier, real code
    indistinguishable.push(await codeFrom(() => service.redeemCode('+237699999999', minted.code)));
  }
  {
    const { service } = serviceWith([makeUser()]);
    // (b) wrong code
    indistinguishable.push(await codeFrom(() => service.redeemCode(STORED_PHONE, 'ZZZZZZZZ')));
  }
  {
    const { service } = serviceWith([makeUser()]);
    // (c) a well-formed code that was already swept
    indistinguishable.push(await codeFrom(() => service.redeemCode(STORED_PHONE, '4B2K91QN')));
  }
  {
    // (d) mismatch: a real live code, and an identifier naming a DIFFERENT real account
    const other = makeUser({ id: OTHER_USER_ID, _id: OTHER_USER_ID, login_phone: '+237655554444' });
    const { service, store: s } = serviceWith([makeUser(), other]);
    const minted = await s.issue({ ...ACCOUNT });
    indistinguishable.push(await codeFrom(() => service.redeemCode('+237655554444', minted.code)));
  }

  assert('all four answer MAGIC_CODE_INVALID — no oracle', () =>
    indistinguishable.length === 4
    && indistinguishable.every((c) => c === 'MAGIC_CODE_INVALID'));

  /**
   * EXPIRED is only reached AFTER the identifier has been matched to the record's own
   * account, so it confirms nothing to somebody guessing — which is why the store's
   * `expired` result carries its record.
   */
  await assertAsync('an expired code with the RIGHT identifier answers EXPIRED', async () => {
    const { service, store: s } = serviceWith([makeUser()]);
    const minted = await s.issue({ ...ACCOUNT });
    const sessionKey = fakeRedis.keys().find((k) => k.startsWith('login:session:'))!;
     
    const entry = (fakeRedis as any).store.get(sessionKey);
    const record = JSON.parse(entry.value);
    record.expiresAt = new Date(Date.now() - 60_000).toISOString();
    entry.value = JSON.stringify(record);
    return (await codeFrom(() => service.redeemCode(STORED_PHONE, minted.code)))
      === 'MAGIC_CODE_EXPIRED';
  });

  await assertAsync('an expired code with the WRONG identifier answers INVALID, never EXPIRED', async () => {
    const { service, store: s } = serviceWith([makeUser()]);
    const minted = await s.issue({ ...ACCOUNT });
    const sessionKey = fakeRedis.keys().find((k) => k.startsWith('login:session:'))!;
     
    const entry = (fakeRedis as any).store.get(sessionKey);
    const record = JSON.parse(entry.value);
    record.expiresAt = new Date(Date.now() - 60_000).toISOString();
    entry.value = JSON.stringify(record);
    return (await codeFrom(() => service.redeemCode('+237699999999', minted.code)))
      === 'MAGIC_CODE_INVALID';
  });

  await assertAsync('the link has its OWN codes, so a client can tell the two flows apart', async () => {
    const { service } = serviceWith([makeUser()]);
    return (await codeFrom(() => service.redeemLink(generateLoginToken())))
      === 'MAGIC_LINK_INVALID';
  });

  await assertAsync('over the attempt ceiling answers MAGIC_ATTEMPTS_EXCEEDED', async () => {
    const { service } = serviceWith([makeUser()]);
    const target = '+237611112222';
    let last = '';
    for (let i = 0; i < 6; i++) {
      last = await codeFrom(() => service.redeemCode(target, 'ZZZZZZZZ'));
    }
    return last === 'MAGIC_ATTEMPTS_EXCEEDED';
  });

  console.log('\n▶ The identifier — normalisation collapses spellings');

  assert('an email is lowercased', () =>
    normalizeLoginIdentifier('John@Example.COM') === 'john@example.com');
  assert('a phone loses its formatting', () =>
    normalizeLoginIdentifier('+237 600 001 234') === STORED_PHONE);
  assert('⚠ two spellings of ONE number collapse — else the attempt ceiling bounds nothing', () =>
    normalizeLoginIdentifier('+237 600 001 234') === normalizeLoginIdentifier('+237600001234'));
  assert('a national number is not a usable identifier', () =>
    !isUsableLoginIdentifier(normalizeLoginIdentifier('600001234')));
  assert('an email without a TLD is not usable', () =>
    !isUsableLoginIdentifier(normalizeLoginIdentifier('jane@localhost')));

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n▶ SOURCE SCAN: the redeem routes inherit the credential bucket');

  assert('the routes are mounted under /api/auth', () => {
    const api = read('api/index.ts');
    return /router\.use\('\/auth\/magic',\s*messagingLoginRoutes\)/.test(api);
  });

  /**
   * `rate-limit/auth-paths.ts` is an ALLOWLIST — a path is only moved to the looser
   * `auth_session` bucket (300/min) by being named there. These must NOT be, so they inherit
   * the strict 20/min credential bucket.
   */
  assert('neither redeem path is in the loose auth_session bucket', () =>
    !isAuthSessionPathname('/api/auth/magic/link')
    && !isAuthSessionPathname('/api/auth/magic/code'));

  assert('…and no auth-paths entry names them', () =>
    AUTH_SESSION_PATHS.every((entry) => !entry.prefix.includes('magic')));

  assert('the router declares no auth guard — these are how you BECOME authenticated', () => {
    const routes = stripComments(read('modules/messaging-login/messaging-login.routes.ts'));
    return !routes.includes('requireAuth') && !routes.includes('requireRole');
  });

  assert('both redeem endpoints are POST — a GET would be spent by link-preview crawlers', () => {
    const routes = stripComments(read('modules/messaging-login/messaging-login.routes.ts'));
    return /router\.post\('\/link'/.test(routes)
      && /router\.post\('\/code'/.test(routes)
      && !/router\.get\(/.test(routes);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n▶ SOURCE SCAN: the bearer twin, for the customer app');

  /**
   * `/api/auth/mobile/magic/*` exists because the customer app cannot use the cookie pair: a
   * Capacitor WebView's origin makes our cookie third-party, and `Set-Cookie` is a forbidden
   * response header it could not read anyway. Since these two routes are the ONLY way a
   * customer authenticates — the account password is system-generated and disclosed to nobody
   * — the app signs nobody in without them.
   *
   * The invariants below are the same ones `test:mobile-auth` holds over the other bearer
   * namespace. They are structural, and every one of them fails silently in behaviour.
   */
  const mobileMagicRoutes = stripComments(
    read('modules/messaging-login/mobile-messaging-login.routes.ts'));
  const mobileMagicController = stripComments(
    read('modules/messaging-login/mobile-messaging-login.controller.ts'));

  assert('the twin is mounted at /auth/mobile/magic', () => {
    const api = read('api/index.ts');
    return /router\.use\('\/auth\/mobile\/magic',\s*mobileMessagingLoginRoutes\)/.test(api);
  });

  assert('it is mounted BEHIND the auth rate-limit dispatcher', () => {
    const api = read('api/index.ts');
    return api.indexOf("router.use('/auth', authBucketDispatcher)")
      < api.indexOf("router.use('/auth/mobile/magic'");
  });

  /**
   * The anchored match in `auth-paths.ts` is what keeps this true: `/api/auth/mobile/refresh`
   * and `/api/auth/mobile/auth-me` ARE in the loose bucket, and a prefix test written as a
   * bare `startsWith('/api/auth/mobile')` would have swept these in with them — handing the
   * one endpoint that redeems a sign-in credential a 300/min ceiling.
   */
  assert('neither bearer redeem path is in the loose auth_session bucket', () =>
    !isAuthSessionPathname('/api/auth/mobile/magic/link')
    && !isAuthSessionPathname('/api/auth/mobile/magic/code'));

  assert('both bearer endpoints are POST, and there is no GET', () =>
    /router\.post\('\/link'/.test(mobileMagicRoutes)
    && /router\.post\('\/code'/.test(mobileMagicRoutes)
    && !/router\.get\(/.test(mobileMagicRoutes));

  assert('the bearer router declares no auth guard either', () =>
    !mobileMagicRoutes.includes('requireAuth') && !mobileMagicRoutes.includes('requireRole'));

  // The one rule of a bearer controller: setting a cookie the client provably cannot read is
  // dead weight that makes every debugging session harder.
  assert('the bearer controller never calls setAuthCookies', () =>
    !mobileMagicController.includes('setAuthCookies'));
  assert('it never calls res.cookie', () => !/res\.cookie\s*\(/.test(mobileMagicController));
  assert('it does not even import from cookie.config', () =>
    !mobileMagicController.includes('cookie.config'));

  assert('both handlers return the pair through tokenEnvelope', () =>
    (mobileMagicController.match(/tokenEnvelope\(/g) ?? []).length === 2);

  /**
   * The whole point of a parallel namespace rather than a flag on the shared handlers: the
   * rules live in the service, so neither controller can drift from the other on the things
   * that matter — the single-use token, the attempt counter, the collapsed error codes.
   */
  assert('both handlers call the SAME service the cookie twin calls', () =>
    /messagingLoginService\.redeemLink\(/.test(mobileMagicController)
    && /messagingLoginService\.redeemCode\(/.test(mobileMagicController));

  assert('and the SAME validators, so the schemas cannot diverge', () =>
    mobileMagicController.includes('RedeemMagicLinkSchema')
    && mobileMagicController.includes('RedeemMagicCodeSchema'));

  // The browser regression guard, mirroring test:mobile-auth's.
  const cookieMagicController = stripComments(
    read('modules/messaging-login/messaging-login.controller.ts'));
  assert('the cookie twin still sets cookies on both routes', () =>
    (cookieMagicController.match(/setAuthCookies\(/g) ?? []).length === 2);
  assert('⚠ the cookie twin returns NO tokens in its body', () =>
    !cookieMagicController.includes('tokenEnvelope')
    && !/tokens\s*:/.test(cookieMagicController));

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n▶ SOURCE SCAN: the two credential-delivery counters are spent at DIFFERENT points');

  /**
   * BR-021 (2026-09-12). Both counters used to be spent in one `assertWithinLimits`, called
   * AFTER `resolveDestination` — which throws `409 USER_CHANNEL_UNAVAILABLE` for a channel
   * the party does not have. So a caller could enumerate which of email/whatsapp/telegram a
   * party has on file at no cost to any allowance, while `users.md` and the method's own
   * docblock both said the count was on the attempt precisely so that could not happen.
   *
   * The fix is not to move the one call: the two counters bound different things and want
   * opposite orderings.
   *
   *   administrator — bounds a careless or compromised operator. A refused request is still a
   *                   request they made, so it is spent BEFORE the resolve, which is what
   *                   bounds the sweep.
   *   party         — a harassment and SMS-bill bound. A refused channel sends them nothing,
   *                   so it is spent AFTER the resolve; charging it would let an operator's
   *                   mis-click lock the party out of the channel that does work.
   *
   * Asserted on the source because the failure is an ORDERING, and an ordering that is wrong
   * still returns the right status codes on every single-request test.
   */
  const credentialService = stripComments(
    read('modules/messaging-login/services/admin-credential-delivery.service.ts'));

  const atAdminLimit = credentialService.indexOf('this.assertAdminWithinLimits(');
  const atResolve = credentialService.indexOf('this.resolveDestination(');
  const atPartyLimit = credentialService.indexOf('this.assertPartyWithinLimits(');

  assert('all three call sites exist in `send`', () =>
    atAdminLimit > 0 && atResolve > 0 && atPartyLimit > 0);

  assert('⚠ the ADMIN allowance is spent BEFORE the channel resolves — else the probe is free', () =>
    atAdminLimit < atResolve);

  assert('⚠ the PARTY allowance is spent AFTER it resolves — else a mis-click locks them out', () =>
    atResolve < atPartyLimit);

  /**
   * The half of the original claim that was always true: `deliver` runs after both counters,
   * so a delivery that fails downstream still costs the allowance.
   */
  assert('both counters are still spent before anything is minted or delivered', () =>
    atPartyLimit < credentialService.indexOf('this.issueReset(')
    && atPartyLimit < credentialService.indexOf('this.deliver('));

  assert('the merged `assertWithinLimits` is gone — it cannot express two orderings', () =>
    !/assertWithinLimits\s*\(/.test(credentialService.replace(/assert(Admin|Party)WithinLimits/g, '')));

  console.log('\n▶ SOURCE SCAN: identity comes from the CONTEXT, never the payload');

  assert('no command reads an identity out of the payload', () => {
    const files = [
      'modules/messaging-login/commands/login.command.ts',
      'modules/messaging-login/commands/login-contact.command.ts',
      'modules/messaging-login/commands/webhook-context.ts',
    ];
    return files.every((f) =>
      !/payload\.(wa_phone_id|chat_id|externalIdentity|identity|userId|user_id)\b/.test(read(f)));
  });

  assert('the sender is resolved from the context object alone', () => {
    const ctx = stripComments(read('modules/messaging-login/commands/webhook-context.ts'));
    return /context\.wa_phone_id/.test(ctx) && /context\.chat_id/.test(ctx);
  });

  console.log('\n▶ SOURCE SCAN: the magic link points at the STOREFRONT');

  const dto = read('modules/messaging-login/dto/messaging-login.dto.ts');

  assert('the link is built from STOREFRONT_URL', () =>
    stripComments(dto).includes('process.env.STOREFRONT_URL'));

  /**
   * ⚠ API_PUBLIC_URL would produce a well-formed, DEAD link: WhatsApp and Telegram fetch URLs
   * to build preview cards, so a GET on this API that signed you in would be consumed by the
   * crawler before the user ever tapped.
   */
  assert('API_PUBLIC_URL is never used to build it', () =>
    !stripComments(dto).includes('API_PUBLIC_URL'));

  assert('the link path is a storefront PAGE, not an API route', () =>
    dto.includes("MAGIC_LINK_PATH = '/login/magic'") && !/\/api\//.test(
      stripComments(dto).match(/MAGIC_LINK_PATH = '[^']*'/)?.[0] ?? ''));

  assert('the token is URL-encoded into the link', () =>
    stripComments(dto).includes('encodeURIComponent(token)'));

  console.log('\n▶ SOURCE SCAN: the store keeps its atomic primitives');

  const storeSource = read('modules/messaging-login/services/login-session.store.ts');

  assert('a code is CLAIMED with SET NX, never a read-then-write', () =>
    /NX:\s*true/.test(storeSource));
  assert('a session is SPENT by an atomic Lua script', () =>
    storeSource.includes('CONSUME_SCRIPT') && storeSource.includes('redis.eval(CONSUME_SCRIPT'));
  assert('the script does GET then DEL inside ONE evaluation', () =>
    /redis\.call\("get", KEYS\[1\]\)[\s\S]*redis\.call\("del", KEYS\[1\]\)/.test(storeSource));
  assert('GETDEL is not used — unavailable before Redis 6.2, and dev Redis here is 3.0', () =>
    !/getDel/.test(storeSource));
  assert('the RECORD is what is spent — both credentials are pointers at it', () =>
    /keys: \[sessionKey\(sessionId\)\]/.test(storeSource));
  assert('redeemability is decided by expiresAt, not by the key TTL', () =>
    storeSource.includes('Date.parse(record.expiresAt)'));
  assert('every credential key name goes through digestForKey', () =>
    /const tokenKey = .*digestForKey\(token\)/.test(storeSource)
    && /const codeKey = .*digestForKey\(code\)/.test(storeSource)
    && /const attemptKey = [\s\S]{0,80}digestForKey\(identifier\)/.test(storeSource));

  assert('an attempt is counted BEFORE the code is consumed', () => {
    const svc = read('modules/messaging-login/services/messaging-login.service.ts');
    return svc.indexOf('recordAttempt') < svc.indexOf('consumeByCode');
  });

  assert('the role is a LITERAL — never taken from a request or from the record', () => {
    const svc = stripComments(read('modules/messaging-login/services/messaging-login.service.ts'));
    return svc.includes("issueTokenPair(String(user._id), 'customer')")
      && !/issueTokenPair\([^)]*record\.role/.test(svc);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n▶ Registration: the generated customer password');

  assert('a generated password is 43 base64url characters', () => {
    const p = generateSystemPassword();
    return p.length === 43 && /^[A-Za-z0-9_-]+$/.test(p);
  });

  /**
   * ⚠ bcrypt silently TRUNCATES beyond 72 bytes, so a longer generated password would not
   * fail — it would just quietly stop adding entropy, with nothing to say so.
   */
  assert('…comfortably under bcrypt\'s 72-BYTE input limit', () =>
    Buffer.byteLength(generateSystemPassword(), 'utf8') < 72 && SYSTEM_PASSWORD_BYTES === 32);

  assert('1000 generated passwords are all distinct', () =>
    new Set(Array.from({ length: 1000 }, () => generateSystemPassword())).size === 1000);

  assert('RegisterSchema no longer REQUIRES a password outright', () => {
    const schemas = stripComments(read('modules/auth/auth.schemas.ts'));
    return /password: z\.string\(\)\.min\(6[^)]*\)\.optional\(\)/.test(schemas);
  });

  assert('…but every NON-customer role still requires one', () => {
    const schemas = stripComments(read('modules/auth/auth.schemas.ts'));
    return /value\.role !== 'customer' && !value\.password/.test(schemas);
  });

  /**
   * STRIPPED, not merely optional. Accepting a caller-supplied password would create accounts
   * whose password somebody else chose and knows.
   */
  assert('a customer\'s password is STRIPPED, so one that is sent cannot be honoured', () => {
    const schemas = stripComments(read('modules/auth/auth.schemas.ts'));
    return /value\.role === 'customer' \? \{ \.\.\.value, password: undefined \}/.test(schemas);
  });

  assert('the generated password reaches bcrypt and NOTHING else', () => {
    const svc = stripComments(read('modules/auth/auth.service.ts'));
    // Scoped to `register`, which is the only method that ever holds a plaintext password
    // it generated rather than one the caller presented.
    const body = svc.slice(svc.indexOf('async register('), svc.indexOf('async login('));

    // The BARE local, so `input.password` and `passwordHash` are both excluded. It may
    // appear exactly twice: the declaration, and the bcrypt argument.
    const bareUses = body.match(/(?<![.\w])password(?![\w_])/g) ?? [];

    return body.includes('const password = input.password ?? generateSystemPassword()')
      && body.includes('bcrypt.hash(password, 10)')
      && bareUses.length === 2;
  });

  assert('nothing logs or returns it', () => {
    const svc = read('modules/auth/auth.service.ts');
    const helper = read('core/auth/system-password.ts');
    return !/console\.(log|error|warn)\([^)]*\bpassword\b(?!_hash)/.test(svc)
      && !/console\./.test(helper);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n▶ /reset-password — EVERY role, not just customers');

  /**
   * ⚠ THE assertion that distinguishes this command from `/login`. A password belongs to the
   * `users` row, so a vendor, an agency and an agent must all reach it. Gating on the customer
   * role would lock out exactly the people most likely to have a password to forget —
   * customers largely do not have one at all.
   */
  await assertAsync('a VENDOR can reset — /login refuses the same account', async () => {
    const vendor = makeUser({ roles: ['vendor'] });
    const { resolver } = resolverWith({ users: [vendor] });

    const reset = await resolver.resolveForReset('whatsapp', WA_PHONE_ID);
    const login = await resolver.resolveForLogin('whatsapp', WA_PHONE_ID);

    return reset.status === 'resolved' && login.status === 'not_customer';
  });

  await assertAsync('an AGENCY can reset', async () => {
    const { resolver } = resolverWith({ users: [makeUser({ roles: ['agency'] })] });
    return (await resolver.resolveForReset('whatsapp', WA_PHONE_ID)).status === 'resolved';
  });

  await assertAsync('an AGENT can reset', async () => {
    const { resolver } = resolverWith({ users: [makeUser({ roles: ['agent'] })] });
    return (await resolver.resolveForReset('whatsapp', WA_PHONE_ID)).status === 'resolved';
  });

  await assertAsync('a CUSTOMER can reset — this is how they get a real password', async () => {
    const { resolver } = resolverWith({ users: [makeUser({ roles: ['customer'] })] });
    return (await resolver.resolveForReset('whatsapp', WA_PHONE_ID)).status === 'resolved';
  });

  await assertAsync('a multi-role account resolves once, not per role', async () => {
    const { resolver } = resolverWith({ users: [makeUser({ roles: ['vendor', 'customer'] })] });
    const outcome = await resolver.resolveForReset('whatsapp', WA_PHONE_ID);
    return outcome.status === 'resolved' && outcome.account.userId === USER_ID;
  });

  /**
   * A customer profile is NOT required, and asserting it explicitly is the point: the reset
   * account type deliberately carries no `customerId`, so a vendor with no customer row must
   * still resolve.
   */
  await assertAsync('a reset does not require a customer profile', async () => {
    const { resolver } = resolverWith({
      users: [makeUser({ roles: ['vendor'] })],
      customerExists: false,
    });
    return (await resolver.resolveForReset('whatsapp', WA_PHONE_ID)).status === 'resolved';
  });

  await assertAsync('a SUSPENDED account still cannot reset back in', async () => {
    const { resolver } = resolverWith({ users: [makeUser({ status: 'suspended' })] });
    return (await resolver.resolveForReset('whatsapp', WA_PHONE_ID)).status === 'account_inactive';
  });

  await assertAsync('an unknown number is refused', async () => {
    const { resolver } = resolverWith({ users: [] });
    return (await resolver.resolveForReset('whatsapp', WA_PHONE_ID)).status === 'no_account';
  });

  await assertAsync('a refused reset binds NO connection', async () => {
    const { resolver, bound } = resolverWith({ users: [makeUser({ status: 'suspended' })] });
    await resolver.resolveForReset('whatsapp', WA_PHONE_ID);
    return bound.length === 0;
  });

  await assertAsync('the bare-digits repair applies to /reset-password too', async () => {
    const { resolver } = resolverWith({ users: [makeUser({ roles: ['agency'] })] });
    const outcome = await resolver.resolveForReset('whatsapp', WA_PHONE_ID);
    return outcome.status === 'resolved' && outcome.account.userId === USER_ID;
  });

  console.log('\n▶ /reset-password — the reply');

  const resetLogLines: string[] = [];
  const realLog2 = console.log;
  const realError2 = console.error;
   
  console.log = (...args: any[]) => { resetLogLines.push(args.join(' ')); };
   
  console.error = (...args: any[]) => { resetLogLines.push(args.join(' ')); };

  let resetReply: unknown;
  try {
    resetReply = await buildResetCommandReply(
      {
        status: 'resolved',
        account: {
          userId: USER_ID,
          channel: 'whatsapp',
          externalIdentity: WA_PHONE_ID,
          identityHint: '••••1234',
        },
      },
      'whatsapp',
      WA_PHONE_ID
    );
  } finally {
    console.log = realLog2;
    console.error = realError2;
  }

  const resetRecord = resetReply as { message: string; expiresInSeconds: number };
  const resetToken = resetRecord.message.match(/token=([a-f0-9]{64})/)?.[1];

  assert('the reply carries a reset link on the STOREFRONT', () =>
    resetRecord.message.includes(`${process.env.STOREFRONT_URL}/reset-password?token=`));

  assert('the token is 32 random bytes, hex — the existing reset token shape', () =>
    !!resetToken && resetToken.length === 64);

  assert('the reply quotes the real 30-minute TTL', () =>
    resetRecord.message.includes(`${RESET_TOKEN_TTL_MINUTES} minutes`)
    && resetRecord.expiresInSeconds === RESET_TOKEN_TTL_MINUTES * 60);

  assert('the reply says the password has NOT changed yet', () =>
    /has not changed/i.test(resetRecord.message));

  /**
   * ⚠ Same rule as `/login`: a webhook RESPONSE BODY is logged in more places than a chat
   * message, and this token resets somebody's password.
   */
  assert('the result carries NO token field — only the message', () => {
    const keys = Object.keys(resetReply as object);
    return !keys.some((k) => /token|link|secret/i.test(k));
  });

  assert('NO log line contains the reset token', () =>
    resetLogLines.length > 0
    && resetLogLines.every((line) => !resetToken || !line.includes(resetToken)));

  assert('the mint DOES log the identity, so the event stays traceable', () =>
    resetLogLines.some((line) => line.includes(WA_PHONE_ID)));

  /**
   * The token must live in the EXISTING reset key space, redeemable by the existing
   * `POST /auth/reset-password`. A second store is how the two entrances drift on single-use,
   * on expiry, or on the `password_changed_at` stamp that makes a reset revoke live sessions.
   */
  assert('the token lands in the EXISTING password_reset: key space', () =>
    fakeRedis.keys().some((k) => k === `password_reset:${resetToken}`));

  console.log('\n▶ The contact-share serves BOTH commands');

  await assertAsync('a reset prompt records the `reset` intent', async () => {
    await buildResetCommandReply({ status: 'needs_contact' }, 'telegram', TG_CHAT_ID);
    return (await pendingIntentStore.take('telegram', TG_CHAT_ID)) === 'reset';
  });

  await assertAsync('a login prompt records the `login` intent', async () => {
    await buildLoginCommandReply({ status: 'needs_contact' }, 'telegram', TG_CHAT_ID);
    return (await pendingIntentStore.take('telegram', TG_CHAT_ID)) === 'login';
  });

  /**
   * Cleared on read, so one prompt answers one contact-share. A second, unprompted share
   * falls back to the default rather than silently repeating the last request.
   */
  await assertAsync('the intent is cleared by reading it', async () => {
    await pendingIntentStore.remember('telegram', TG_CHAT_ID, 'reset');
    const first = await pendingIntentStore.take('telegram', TG_CHAT_ID);
    const second = await pendingIntentStore.take('telegram', TG_CHAT_ID);
    return first === 'reset' && second === DEFAULT_PENDING_INTENT;
  });

  /**
   * ⚠ The default is `login`, and it is the LESSER outcome — a session the sender could have
   * had by typing `/login`. Defaulting to `reset` would hand a password-reset credential to
   * somebody who never asked for one.
   */
  assert('an unremembered contact-share defaults to login, the lesser outcome', () =>
    DEFAULT_PENDING_INTENT === 'login');

  await assertAsync('intents are per-identity — one chat cannot read another\'s', async () => {
    await pendingIntentStore.remember('telegram', 'chat-A', 'reset');
    const other = await pendingIntentStore.take('telegram', 'chat-B');
    const own = await pendingIntentStore.take('telegram', 'chat-A');
    return other === DEFAULT_PENDING_INTENT && own === 'reset';
  });

  await assertAsync('the intent key name hashes the chat id', async () => {
    await pendingIntentStore.remember('telegram', TG_CHAT_ID, 'reset');
    const keys = fakeRedis.keys().filter((k) => k.startsWith('login:intent:'));
    await pendingIntentStore.take('telegram', TG_CHAT_ID);
    return keys.length === 1 && !keys[0].includes(TG_CHAT_ID)
      && keys[0].endsWith(digestForKey(TG_CHAT_ID));
  });

  console.log('\n▶ SOURCE SCAN: /reset-password reuses the ONE reset mechanism');

  const resetCmd = read('modules/messaging-login/commands/reset-password.command.ts');

  assert('it mints through PasswordResetService, not its own token store', () =>
    resetCmd.includes('passwordResetService.issueResetLinkFor')
    && !/randomBytes|crypto\./.test(stripComments(resetCmd)));

  assert('it never calls requestReset — that path DELIVERS, this one replies', () =>
    !resetCmd.includes('requestReset'));

  assert('the identity comes from the context, never the payload', () =>
    !/payload\.(wa_phone_id|chat_id|externalIdentity|identity|userId|user_id)\b/.test(resetCmd)
    && resetCmd.includes('resolveSender(context)'));

  assert('it resolves with the ROLE-AGNOSTIC entry point', () =>
    resetCmd.includes('resolveForReset') && !resetCmd.includes('resolveForLogin'));

  const resetService = read('modules/auth/services/password-reset.service.ts');

  assert('the bot path and the email path share one token mint', () => {
    const scrubbed = stripComments(resetService);
    return (scrubbed.match(/randomBytes\(32\)/g) ?? []).length === 1
      && scrubbed.includes('private async mintToken');
  });

  assert('the reset link is built in ONE place, used by both paths', () => {
    const scrubbed = stripComments(resetService);
    return (scrubbed.match(/\/reset-password\?token=/g) ?? []).length === 1
      && scrubbed.includes('export function buildResetLink');
  });

  assert('login_contact routes on the recorded intent', () => {
    const contactCmd = stripComments(
      read('modules/messaging-login/commands/login-contact.command.ts')
    );
    return contactCmd.includes("pendingIntentStore.take('telegram', chatId)")
      && /intent === 'reset'[\s\S]{0,120}buildResetCommandReply/.test(contactCmd)
      && contactCmd.includes('buildLoginCommandReply');
  });

  assert('the contact guard still runs BEFORE the intent is read', () => {
    const contactCmd = read('modules/messaging-login/commands/login-contact.command.ts');
    return contactCmd.indexOf('MAGIC_CONTACT_UNVERIFIED')
      < contactCmd.indexOf('pendingIntentStore.take');
  });

  assert('the reset command is registered on the bus', () => {
    const registry = stripComments(read('modules/commands/index.ts'));
    return registry.includes('ResetPasswordCommand.command_name');
  });

  assert('the command name is reset_password', () =>
    resetCmd.includes("export const command_name = 'reset_password'"));

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n▶ Redis catalogue registration');

  const factory = read('infra/redis/redis.factory.ts');
  const flushPolicy = read('modules/system/domain/cache-flush-policy.ts');

  assert('LOGIN_CODE_DB is exported as 14', () =>
    factory.includes('export const LOGIN_CODE_DB = 14'));
  assert('LOGIN_CODE_DB is in REDIS_DB_CATALOG', () =>
    factory.includes("constant: 'LOGIN_CODE_DB'"));
  assert('LOGIN_CODE_DB has a cache-flush policy row', () =>
    flushPolicy.includes("specFor('LOGIN_CODE_DB')"));
  assert('it is a SEPARATE database from the connection codes, not a prefix on 13', () =>
    factory.includes('export const CONNECTION_CODE_DB = 13')
    && factory.includes('export const LOGIN_CODE_DB = 14'));
  assert('the retired databases 4 and 9 are still unassigned', () =>
    !/=\s*4;/.test(factory) && !/=\s*9;/.test(factory));

  // ═══════════════════════════════════════════════════════════════════════════
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log(`${'─'.repeat(60)}\n`);

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('test:messaging-login crashed:', err);
  process.exit(1);
});
