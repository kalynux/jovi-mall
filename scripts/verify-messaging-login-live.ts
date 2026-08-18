/**
 * Live verification of passwordless `/login` — NEEDS Redis and Mongo.
 *
 * The DB-free `test:messaging-login` covers the pure parts, drives the store against a fake
 * Redis, and scans the structural ones. Four things it structurally cannot cover, and they
 * are the ones that bite:
 *
 *   1. **The resolver against a REAL `users` collection.** The bare-digits repair is asserted
 *      there against a fake repository that was handed the right answer; here the fixture is
 *      genuinely stored as `+237…` and the lookup genuinely runs `findByPhone`. This is the
 *      silent-failure case from D-1 — without the `+` prepend it returns "no account found"
 *      for everybody, and every DB-free test still passes.
 *   2. **The atomic consume against a real Redis.** A fake `eval` is a promise about
 *      semantics; this is the check that caught `GETDEL` being unavailable on Redis 3.0 for
 *      the connection codes, which no source scan could have.
 *   3. **The connection is really PERSISTED**, through the real unique indexes, so a second
 *      `/login` really does take the fast path.
 *   4. **The HTTP surface**: a real `POST /api/auth/magic/*` really sets both auth cookies,
 *      and `GET /api/auth/me` really answers as a customer holding them.
 *
 * Read-mostly: it writes its own `verify-login-*` fixtures and removes them, pass or fail,
 * in the same shape as `verify:connections` and `verify:storefront`.
 *
 * Run: npm run verify:messaging-login
 */
import http from 'http';
import bcrypt from 'bcrypt';
import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

// Signing needs a secret and `getJwtSecret()` fails closed. A developer running this against
// a local stack should not need a fully populated `.env` for the HTTP leg to work.
process.env.JWT_SECRET ||= 'verify-secret-for-messaging-login-suite';
process.env.JWT_REFRESH_SECRET ||= 'verify-refresh-secret-for-messaging-login-suite';

import { app } from '../src/app';
import { UserModel } from '../src/modules/users/user.model';
import { CustomerModel } from '../src/modules/customers/customer.model';
import { ChannelConnectionModel } from '../src/modules/channel-connections/channel-connection.model';
import { loginIdentityResolver } from '../src/modules/messaging-login/services/identity-resolver.service';
import {
  loginSessionStore,
  LOGIN_SESSION_TTL_SECONDS,
  LOGIN_SESSION_GRACE_SECONDS,
} from '../src/modules/messaging-login/services/login-session.store';
import { digestForKey } from '../src/modules/messaging-login/domain/login-token';
import { handler as loginHandler, schema as loginSchema }
  from '../src/modules/messaging-login/commands/login.command';
import { handler as loginContactHandler, schema as loginContactSchema }
  from '../src/modules/messaging-login/commands/login-contact.command';
import { handler as resetHandler, schema as resetSchema }
  from '../src/modules/messaging-login/commands/reset-password.command';
import { pendingIntentStore } from '../src/modules/messaging-login/services/pending-intent.store';
import {
  getRedisClient,
  closeRedisClients,
  LOGIN_CODE_DB,
  EMAIL_VERIFY_DB,
} from '../src/infra/redis/redis.factory';

let passed = 0;
let failed = 0;

async function assert(name: string, fn: () => Promise<boolean> | boolean): Promise<void> {
  try {
    const ok = await fn();
    if (ok) {
      console.log(`  ✅ ${name}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${name}`);
      failed++;
    }
  } catch (err) {
    console.error(`  ❌ THROW: ${name} — ${(err as Error).message}`);
    failed++;
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────
// Stored in strict E.164, exactly as a real registration writes it …
const STORED_PHONE = '+237600000199';
// … and delivered by Meta as bare digits. The gap between these two lines IS the test.
const WA_PHONE_ID = '237600000199';
const TG_CHAT_ID = 'verify-login-tg-70001';
const OTHER_PHONE = '+237600000198';
/** The vendor's number as Meta delivers it — bare. */
const OTHER_WA_PHONE_ID = '237600000198';
/** Belongs to nobody. Used to move a fixture's phone out from under its connection. */
const SCRATCH_PHONE = '+237600000197';

const USER_ID = new mongoose.Types.ObjectId();
const OTHER_USER_ID = new mongoose.Types.ObjectId();

/** What the vendor's password is before the reset, and what it becomes after. */
const ORIGINAL_VENDOR_PASSWORD = 'Verify-Original-1!';
const NEW_VENDOR_PASSWORD = 'Verify-Replaced-2!';

/** Every session this run mints, so cleanup is precise rather than a wildcard delete. */
const mintedSessions: string[] = [];
const touchedIdentifiers = [STORED_PHONE, OTHER_PHONE];
/** Reset tokens live in a different logical database (3), keyed by the token itself. */
const mintedResetTokens: string[] = [];

/** A second fixture with NO customer role — the whole point of `/reset-password`. */
const VENDOR_CHAT_ID = 'verify-login-tg-70002';

async function cleanup(): Promise<void> {
  await UserModel.deleteMany({
    $or: [
      { login_phone: { $in: [STORED_PHONE, OTHER_PHONE, SCRATCH_PHONE] } },
      // Also by id: an assertion that fails mid-way can leave a fixture under SCRATCH_PHONE.
      { _id: { $in: [USER_ID, OTHER_USER_ID] } },
    ],
  });
  await CustomerModel.deleteMany({ user_id: { $in: [USER_ID, OTHER_USER_ID] } });
  await ChannelConnectionModel.deleteMany({
    $or: [
      { user_id: { $in: [USER_ID, OTHER_USER_ID] } },
      { external_id: { $in: [WA_PHONE_ID, TG_CHAT_ID] } },
    ],
  });

  /**
   * Redis keys here are HASHED, so there is no fixture marker to glob on — and that is the
   * point of `digestForKey`. Cleanup is therefore precise: every session this run minted is
   * revoked by id (which drops its own pointers), and the attempt counters are cleared by
   * identifier. A blind `login:*` wildcard would spend somebody's live sign-in.
   */
  for (const sessionId of mintedSessions) await loginSessionStore.revokeSession(sessionId);
  for (const identifier of touchedIdentifiers) await loginSessionStore.clearAttempts(identifier);

  const redis = await getRedisClient(LOGIN_CODE_DB);
  await redis.del([
    `login:identity:whatsapp:${digestForKey(WA_PHONE_ID)}`,
    `login:identity:telegram:${digestForKey(TG_CHAT_ID)}`,
    `login:identity:whatsapp:${digestForKey(OTHER_WA_PHONE_ID)}`,
    `login:intent:telegram:${digestForKey(TG_CHAT_ID)}`,
    `login:intent:telegram:${digestForKey(VENDOR_CHAT_ID)}`,
  ]);

  // Reset tokens live on EMAIL_VERIFY_DB with their own prefix — see PasswordResetService.
  if (mintedResetTokens.length) {
    const resetRedis = await getRedisClient(EMAIL_VERIFY_DB);
    await resetRedis.del(mintedResetTokens.map((t) => `password_reset:${t}`));
  }
}

async function seed(): Promise<void> {
  await UserModel.create({
    _id: USER_ID,
    login_phone: STORED_PHONE,
    password_hash: 'verify-login-not-a-real-hash',
    roles: ['customer'],
    status: 'active',
  });
  await CustomerModel.create({
    user_id: USER_ID,
    name: 'Verify Login Fixture',
    phone: STORED_PHONE,
  });

  /**
   * A VENDOR with no customer role and no customer profile — the account `/login` must refuse
   * and `/reset-password` must serve. Its password is a real bcrypt hash of a known string, so
   * the reset can be proven to have actually changed it.
   */
  await UserModel.create({
    _id: OTHER_USER_ID,
    login_phone: OTHER_PHONE,
    password_hash: await bcrypt.hash(ORIGINAL_VENDOR_PASSWORD, 10),
    roles: ['vendor'],
    status: 'active',
  });
}

/** Mint through the store, remembering the id so cleanup can revoke it. */
async function mintFor(channel: 'whatsapp' | 'telegram', externalIdentity: string) {
  const customer = await CustomerModel.findOne({ user_id: USER_ID });
  const issued = await loginSessionStore.issue({
    userId: USER_ID.toString(),
    customerId: customer!._id.toString(),
    channel,
    externalIdentity,
    identityHint: '••••0199',
  });
  mintedSessions.push(issued.sessionId);
  return issued;
}

async function main(): Promise<void> {
  const uri = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi_mall';
  await mongoose.connect(uri);
  console.log(`\n▶ Connected to ${uri.replace(/\/\/[^@]*@/, '//***@')}`);

  let server: http.Server | null = null;

  try {
    await cleanup();
    await seed();

    // ── 1. The resolver, against real Mongo ────────────────────────────────
    console.log('\n▶ D-1: bare digits against a REAL users collection');

    await assert('the fixture really is stored in strict E.164', async () => {
      const user = await UserModel.findById(USER_ID);
      return user?.login_phone === STORED_PHONE;
    });

    await assert('⚠ a BARE-DIGITS wa_phone_id resolves it — the silent-failure case', async () => {
      const outcome = await loginIdentityResolver.resolveForLogin('whatsapp', WA_PHONE_ID);
      return outcome.status === 'resolved' && outcome.account.userId === USER_ID.toString();
    });

    await assert('…and the connection is PERSISTED, through the real unique indexes', async () => {
      const row = await ChannelConnectionModel.findOne({
        channel: 'whatsapp',
        external_id: WA_PHONE_ID,
      });
      return row?.user_id.toString() === USER_ID.toString();
    });

    await assert('a second /login takes the FAST PATH — resolved by the connection alone', async () => {
      // Prove it is the connection doing the work by moving the phone out from under it.
      // A THIRD number, not the vendor fixture's: `login_phone` is uniquely indexed, so
      // borrowing an occupied one fails the write rather than the assertion.
      await UserModel.updateOne({ _id: USER_ID }, { $set: { login_phone: SCRATCH_PHONE } });
      try {
        const outcome = await loginIdentityResolver.resolveForLogin('whatsapp', WA_PHONE_ID);
        return outcome.status === 'resolved' && outcome.account.userId === USER_ID.toString();
      } finally {
        await UserModel.updateOne({ _id: USER_ID }, { $set: { login_phone: STORED_PHONE } });
      }
    });

    // ── 2. Telegram: prompt, then complete ─────────────────────────────────
    console.log('\n▶ Telegram: contact-share completes the flow');

    await assert('an unknown Telegram chat is asked for a contact', async () => {
      const reply = await loginHandler(loginSchema.parse({}), {
        source: 'telegram',
        chat_id: TG_CHAT_ID,
      });
      return reply.success === true
        && 'requestContact' in reply
        && reply.requestContact === true;
    });

    await assert('a FORWARDED contact is refused against the real stack too', async () => {
      try {
        await loginContactHandler(
          loginContactSchema.parse({
            contact: { phone_number: STORED_PHONE, user_id: '999000999' },
          }),
          { source: 'telegram', chat_id: TG_CHAT_ID }
        );
        return false;
      } catch (err) {
        return (err as { code?: string }).code === 'MAGIC_CONTACT_UNVERIFIED';
      }
    });

    await assert('the sender\'s OWN contact completes it, persists, and mints', async () => {
      const reply = await loginContactHandler(
        loginContactSchema.parse({
          contact: { phone_number: WA_PHONE_ID, user_id: TG_CHAT_ID, first_name: 'Verify' },
          username: 'verifylogin',
        }),
        { source: 'telegram', chat_id: TG_CHAT_ID }
      );

      const row = await ChannelConnectionModel.findOne({
        channel: 'telegram',
        external_id: TG_CHAT_ID,
      });

      return reply.success === true
        && row?.user_id.toString() === USER_ID.toString()
        && row?.handle === '@verifylogin';
    });

    await assert('the reply carries the credentials ONLY inside `message`', async () => {
      const reply = await loginHandler(loginSchema.parse({}), {
        source: 'telegram',
        chat_id: TG_CHAT_ID,
      });
      const keys = Object.keys(reply);
      return !keys.some((k) => /token|code/i.test(k)) && 'message' in reply;
    });

    // ── 3. The store against real Redis ────────────────────────────────────
    console.log('\n▶ The session store, against a real Redis');

    const issued = await mintFor('whatsapp', WA_PHONE_ID);

    await assert('both credentials are minted', () =>
      issued.code.length === 8 && issued.token.length === 43);

    await assert('the record and BOTH credential pointers carry TTL + grace', async () => {
      const redis = await getRedisClient(LOGIN_CODE_DB);
      const expected = LOGIN_SESSION_TTL_SECONDS + LOGIN_SESSION_GRACE_SECONDS;
      const ttls = await Promise.all([
        redis.ttl(`login:session:${issued.sessionId}`),
        redis.ttl(`login:token:${digestForKey(issued.token)}`),
        redis.ttl(`login:code:${digestForKey(issued.code)}`),
      ]);
      return ttls.every((t) => t > expected - 10 && t <= expected);
    });

    await assert('the identity pointer carries the VALIDITY only', async () => {
      const redis = await getRedisClient(LOGIN_CODE_DB);
      const ttl = await redis.ttl(`login:identity:whatsapp:${digestForKey(WA_PHONE_ID)}`);
      return ttl > 0 && ttl <= LOGIN_SESSION_TTL_SECONDS;
    });

    await assert('no key name contains the raw token, code or phone number', async () => {
      const redis = await getRedisClient(LOGIN_CODE_DB);
      const keys = await redis.keys('login:*');
      return keys.every((k) =>
        !k.includes(issued.token) && !k.includes(issued.code) && !k.includes(WA_PHONE_ID));
    });

    await assert('the record still expires after the VALIDITY, not the key TTL', () =>
      issued.expiresAt.getTime() - Date.now() <= LOGIN_SESSION_TTL_SECONDS * 1000);

    await assert('⚠ spending the CODE kills the LINK', async () => {
      const spent = await loginSessionStore.consumeByCode(issued.code);
      const link = await loginSessionStore.consumeByToken(issued.token);
      return spent.status === 'ok' && link.status === 'missing';
    });

    const raced = await mintFor('whatsapp', WA_PHONE_ID);
    await assert('two concurrent redemptions of ONE session: exactly one wins', async () => {
      const [a, b] = await Promise.all([
        loginSessionStore.consumeByToken(raced.token),
        loginSessionStore.consumeByCode(raced.code),
      ]);
      return [a, b].filter((r) => r.status === 'ok').length === 1
        && [a, b].filter((r) => r.status === 'missing').length === 1;
    });

    const reissued1 = await mintFor('whatsapp', WA_PHONE_ID);
    const reissued2 = await mintFor('whatsapp', WA_PHONE_ID);
    await assert('a second /login REVOKES the first pair', async () => {
      const old = await loginSessionStore.consumeByCode(reissued1.code);
      const fresh = await loginSessionStore.consumeByCode(reissued2.code);
      return old.status === 'missing' && fresh.status === 'ok';
    });

    await assert('an expired record answers EXPIRED, an unknown one INVALID', async () => {
      const redis = await getRedisClient(LOGIN_CODE_DB);
      const planted = await mintFor('whatsapp', WA_PHONE_ID);

      // Rewrite the record past its validity but inside the grace — the state a slow user's
      // credential is genuinely in, without waiting ten minutes for one.
      //
      // ⚠ The TTL is read and re-applied rather than preserved with `KEEPTTL`, which needs
      // Redis 6.0 and answers `ERR syntax error` on the 3.0 this platform develops against.
      // Same trap as `GETDEL` in the connection-code store, caught the same way — by running
      // against a real server rather than reasoning about the command set.
      const key = `login:session:${planted.sessionId}`;
      const remaining = await redis.ttl(key);
      const record = JSON.parse((await redis.get(key))!);
      record.expiresAt = new Date(Date.now() - 60_000).toISOString();
      await redis.set(key, JSON.stringify(record), { EX: remaining > 0 ? remaining : 60 });

      const expired = await loginSessionStore.consumeByToken(planted.token);
      const unknown = await loginSessionStore.consumeByCode('QQ7W6E22');
      return expired.status === 'expired' && unknown.status === 'missing';
    });

    // ── 4. The HTTP surface ────────────────────────────────────────────────
    console.log('\n▶ The redemption endpoints, over real HTTP');

    const listening = app.listen(0);
    server = listening;
    await new Promise<void>((resolve) => listening.once('listening', () => resolve()));
    const port = (listening.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;

    const forHttp = await mintFor('whatsapp', WA_PHONE_ID);
    let cookieHeader = '';

    await assert('POST /api/auth/magic/code signs in and sets BOTH auth cookies', async () => {
      const res = await fetch(`${base}/api/auth/magic/code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: STORED_PHONE, code: forHttp.code }),
      });
      const body = await res.json() as { success: boolean; data?: { role?: string } };
      const cookies = res.headers.getSetCookie();
      cookieHeader = cookies.map((c) => c.split(';')[0]).join('; ');

      return res.status === 200
        && body.success === true
        && body.data?.role === 'customer'
        && cookies.some((c) => c.startsWith('access_token='))
        && cookies.some((c) => c.startsWith('refresh_token='));
    });

    await assert('no token appears in the response BODY — cookies only', async () => {
      const fresh = await mintFor('whatsapp', WA_PHONE_ID);
      const res = await fetch(`${base}/api/auth/magic/code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: STORED_PHONE, code: fresh.code }),
      });
      const text = await res.text();
      return !/accessToken|refreshToken|"tokens"/.test(text);
    });

    await assert('GET /api/auth/me with those cookies answers as a CUSTOMER', async () => {
      const res = await fetch(`${base}/api/auth/me`, { headers: { Cookie: cookieHeader } });
      const body = await res.json() as { success: boolean; data?: { role?: string } };
      return res.status === 200 && body.data?.role === 'customer';
    });

    await assert('POST /api/auth/magic/link signs in too', async () => {
      const forLink = await mintFor('whatsapp', WA_PHONE_ID);
      const res = await fetch(`${base}/api/auth/magic/link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: forLink.token }),
      });
      const body = await res.json() as { success: boolean; data?: { role?: string } };
      return res.status === 200
        && body.data?.role === 'customer'
        && res.headers.getSetCookie().some((c) => c.startsWith('access_token='));
    });

    await assert('a spent link answers 401 MAGIC_LINK_INVALID', async () => {
      const res = await fetch(`${base}/api/auth/magic/link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: forHttp.token }),
      });
      const body = await res.json() as { error?: { code?: string } };
      return res.status === 401 && body.error?.code === 'MAGIC_LINK_INVALID';
    });

    await assert('an unknown identifier and a wrong code are INDISTINGUISHABLE', async () => {
      const wrongCode = await fetch(`${base}/api/auth/magic/code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: STORED_PHONE, code: 'ZZZZZZZZ' }),
      });
      const unknownId = await fetch(`${base}/api/auth/magic/code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: '+237699998888', code: 'ZZZZZZZZ' }),
      });
      const a = await wrongCode.json() as { error?: { code?: string } };
      const b = await unknownId.json() as { error?: { code?: string } };

      return wrongCode.status === unknownId.status
        && wrongCode.status === 401
        && a.error?.code === b.error?.code
        && a.error?.code === 'MAGIC_CODE_INVALID';
    });

    // ── 5. /reset-password, end to end, for a NON-customer ─────────────────
    console.log('\n▶ /reset-password — a VENDOR, against the real stack');

    let vendorResetLink = '';

    await assert('⚠ /login REFUSES the vendor — the account has no customer role', async () => {
      const reply = await loginHandler(loginSchema.parse({}), {
        source: 'whatsapp',
        wa_phone_id: OTHER_WA_PHONE_ID,
      });
      return reply.success === false && /business account/i.test(reply.message);
    });

    await assert('…and /reset-password SERVES the same vendor', async () => {
      const reply = await resetHandler(resetSchema.parse({}), {
        source: 'whatsapp',
        wa_phone_id: OTHER_WA_PHONE_ID,
      });
      const match = reply.message.match(/token=([a-f0-9]{64})/);
      if (match) {
        vendorResetLink = reply.message;
        mintedResetTokens.push(match[1]);
      }
      return reply.success === true && !!match;
    });

    await assert('the link points at the storefront reset PAGE', () =>
      /\/reset-password\?token=[a-f0-9]{64}/.test(vendorResetLink));

    await assert('the result carries no token field — only the message', async () => {
      const reply = await resetHandler(resetSchema.parse({}), {
        source: 'whatsapp',
        wa_phone_id: OTHER_WA_PHONE_ID,
      });
      const match = reply.message.match(/token=([a-f0-9]{64})/);
      if (match) mintedResetTokens.push(match[1]);
      return !Object.keys(reply).some((k) => /token|link/i.test(k));
    });

    /**
     * The whole point: the bot-minted token must be redeemable by the EXISTING endpoint, and
     * the password must genuinely change. A second token store would pass every unit test and
     * fail exactly here.
     */
    await assert('POST /auth/reset-password accepts the BOT-minted token', async () => {
      const token = vendorResetLink.match(/token=([a-f0-9]{64})/)![1];
      const res = await fetch(`${base}/api/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, newPassword: NEW_VENDOR_PASSWORD }),
      });
      return res.status === 200;
    });

    await assert('…the vendor can now sign in with the NEW password', async () => {
      const res = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: OTHER_PHONE,
          password: NEW_VENDOR_PASSWORD,
          role: 'vendor',
        }),
      });
      return res.status === 200;
    });

    await assert('…and the OLD password no longer works', async () => {
      const res = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: OTHER_PHONE,
          password: ORIGINAL_VENDOR_PASSWORD,
          role: 'vendor',
        }),
      });
      return res.status === 401;
    });

    await assert('the bot-minted token is SINGLE USE', async () => {
      const token = vendorResetLink.match(/token=([a-f0-9]{64})/)![1];
      const res = await fetch(`${base}/api/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, newPassword: 'Verify-Third-3!' }),
      });
      const body = await res.json() as { error?: { code?: string } };
      return res.status === 400 && body.error?.code === 'AUTH_RESET_TOKEN_INVALID';
    });

    // ── 6. The contact-share routes to the right command ───────────────────
    console.log('\n▶ The contact-share completes whichever command asked for it');

    await assert('an unknown Telegram chat asking to RESET gets the contact prompt', async () => {
      const reply = await resetHandler(resetSchema.parse({}), {
        source: 'telegram',
        chat_id: VENDOR_CHAT_ID,
      });
      return reply.success === true
        && 'requestContact' in reply
        && reply.requestContact === true
        && /reset your password/i.test(reply.message);
    });

    await assert('…and the pending intent really is stored as `reset`', async () => {
      const redis = await getRedisClient(LOGIN_CODE_DB);
      const stored = await redis.get(`login:intent:telegram:${digestForKey(VENDOR_CHAT_ID)}`);
      return stored === 'reset';
    });

    /**
     * ⚠ THE assertion this mechanism exists for. The contact message says nothing about which
     * command was asked, so without the pending intent the vendor would be handed a sign-in
     * attempt — which their account cannot even satisfy — instead of the reset link they asked
     * for.
     */
    await assert('⚠ the contact-share completes the RESET, not a login', async () => {
      const reply = await loginContactHandler(
        loginContactSchema.parse({
          contact: {
            phone_number: OTHER_WA_PHONE_ID,
            user_id: VENDOR_CHAT_ID,
            first_name: 'Vendor',
          },
        }),
        { source: 'telegram', chat_id: VENDOR_CHAT_ID }
      );
      const match = reply.message.match(/token=([a-f0-9]{64})/);
      if (match) mintedResetTokens.push(match[1]);

      return reply.success === true
        && !!match
        && /choose a new password/i.test(reply.message)
        // A login reply would carry an 8-character code and a /login/magic link.
        && !/login\/magic/.test(reply.message);
    });

    await assert('the intent is consumed — a second bare share falls back to login', async () => {
      const intent = await pendingIntentStore.take('telegram', VENDOR_CHAT_ID);
      return intent === 'login';
    });

    await assert('a customer chat asking to LOG IN still gets a sign-in session', async () => {
      await loginHandler(loginSchema.parse({}), { source: 'telegram', chat_id: TG_CHAT_ID });
      const reply = await loginContactHandler(
        loginContactSchema.parse({
          contact: { phone_number: WA_PHONE_ID, user_id: TG_CHAT_ID, first_name: 'Verify' },
        }),
        { source: 'telegram', chat_id: TG_CHAT_ID }
      );
      return reply.success === true && /login\/magic|sign in/i.test(reply.message);
    });

    await assert('a suspended account is refused at REDEMPTION, not at mint', async () => {
      const planted = await mintFor('whatsapp', WA_PHONE_ID);
      await UserModel.updateOne({ _id: USER_ID }, { $set: { status: 'suspended' } });
      try {
        const res = await fetch(`${base}/api/auth/magic/link`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: planted.token }),
        });
        const body = await res.json() as { error?: { code?: string } };
        return res.status === 403 && body.error?.code === 'AUTH_ACCOUNT_SUSPENDED';
      } finally {
        await UserModel.updateOne({ _id: USER_ID }, { $set: { status: 'active' } });
      }
    });
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await cleanup();
    await mongoose.disconnect();
    await closeRedisClients();
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log(`${'─'.repeat(60)}\n`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('verify:messaging-login crashed:', err);
  process.exit(1);
});
