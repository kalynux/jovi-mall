/**
 * Test: changing the email or phone an account signs in with (Phase 6 · 6.D.1).
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no framework).
 * DB-free — `ContactChangeService` takes every collaborator through its constructor, so the
 * whole flow is driven against an in-memory user store rather than source-scanned. That
 * matters here more than usual: the property this feature exists to guarantee is a
 * statement about WHEN a write happens, and "the identifier did not move" is only
 * assertable if something actually ran.
 *
 * ── What this guards ─────────────────────────────────────────────────────────
 * `login_email` and `login_phone` are what `POST /auth/login` resolves an account by. The
 * failure this suite is aimed at is the one that cannot be recovered from: writing the new
 * identifier at REQUEST time and marking it unverified. A typo then becomes the only way
 * in — the account cannot be signed into, and the correction form is behind the sign-in.
 * Every "…is not mutated before confirmation" case below is that one property.
 *
 * The four source scans cover what no fake can see: that the confirm route is public and
 * the request route is not, that the swap and the pending-clear are ONE `$set`, that the
 * WhatsApp identity comparison goes through the shared E.164 repair, and that no code path
 * stamps the password epoch.
 *
 * Run: npm run test:account-contact-change
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { ContactChangeService, buildEmailChangeLink } from '../../src/modules/users/services/contact-change.service';
import { CONTACT_CHANGE_CONFIG } from '../../src/modules/users/config/contact-change.config';
import {
  ConfirmEmailChangeSchema,
  RequestEmailChangeSchema,
  RequestPhoneChangeSchema,
} from '../../src/modules/users/user.validator';
import { AppError } from '../../src/core/errors';
import { ERROR_CODES } from '../../src/core/error-codes';

const originalConsole = { log: console.log.bind(console), error: console.error.bind(console) };

let passed = 0;
let failed = 0;

function assert(name: string, fn: () => boolean | Promise<boolean>): void {
  pending.push({ name, fn });
}

const pending: Array<{ name: string; fn: () => boolean | Promise<boolean> }> = [];

async function run(): Promise<void> {
  for (const { name, fn } of pending) {
    let ok: boolean;
    try {
      ok = await fn();
    } catch (err) {
      originalConsole.error(`  ❌ THROW: ${name} — ${(err as Error).message}`);
      failed++;
      continue;
    }
    if (ok) {
      originalConsole.log(`  ✅ ${name}`);
      passed++;
    } else {
      originalConsole.error(`  ❌ FAIL: ${name}`);
      failed++;
    }
  }
}

function section(title: string): void {
  originalConsole.log(`\n── ${title} ${'─'.repeat(Math.max(0, 70 - title.length))}`);
}

/** The code an AppError carries, or null if it was not one. */
async function codeOf(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return err instanceof AppError ? err.code : `NOT_APP_ERROR:${(err as Error).message}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  The fakes
// ─────────────────────────────────────────────────────────────────────────────

interface FakeUser {
  _id: { toString(): string };
  login_email?: string;
  login_phone?: string;
  roles: string[];
  pending_email: { address: string; token_hash: string; requested_at: Date; expires_at: Date } | null;
  pending_phone: { number: string; requested_at: Date; expires_at: Date } | null;
}

function makeUser(id: string, over: Partial<FakeUser> = {}): FakeUser {
  return {
    _id: { toString: () => id },
    roles: ['customer'],
    pending_email: null,
    pending_phone: null,
    ...over,
  };
}

/**
 * An in-memory `users` collection.
 *
 * The four write methods reproduce the REAL repository's operators rather than assigning
 * fields freely: `applyEmailChange` is a compare-and-set on the token hash and clears the
 * pending block in the same step, because that atomicity is one of the things under test.
 */
class FakeUserRepo {
  constructor(public rows: FakeUser[]) {}

  /** Every write the service made, in order — so a test can assert what did NOT happen. */
  public writes: string[] = [];

  async findById(id: string) {
    return this.rows.find((r) => r._id.toString() === id) ?? null;
  }
  async findByEmail(email: string) {
    return this.rows.find((r) => r.login_email === email.toLowerCase()) ?? null;
  }
  async findByPhone(phone: string) {
    return this.rows.find((r) => r.login_phone === phone) ?? null;
  }
  async findByPendingEmailToken(hash: string) {
    return this.rows.find((r) => r.pending_email?.token_hash === hash) ?? null;
  }
  async setPendingEmail(
    id: string,
    p: { address: string; tokenHash: string; requestedAt: Date; expiresAt: Date },
  ) {
    this.writes.push('setPendingEmail');
    const row = await this.findById(id);
    if (!row) return null;
    row.pending_email = {
      address: p.address.toLowerCase(),
      token_hash: p.tokenHash,
      requested_at: p.requestedAt,
      expires_at: p.expiresAt,
    };
    return row;
  }
  async setPendingPhone(id: string, p: { number: string; requestedAt: Date; expiresAt: Date }) {
    this.writes.push('setPendingPhone');
    const row = await this.findById(id);
    if (!row) return null;
    row.pending_phone = { number: p.number, requested_at: p.requestedAt, expires_at: p.expiresAt };
    return row;
  }
  async applyEmailChange(id: string, tokenHash: string, email: string) {
    this.writes.push('applyEmailChange');
    const row = await this.findById(id);
    if (!row || row.pending_email?.token_hash !== tokenHash) return null; // the compare-and-set
    row.login_email = email.toLowerCase();
    row.pending_email = null;
    return row;
  }
  async applyPhoneChange(id: string, number: string) {
    this.writes.push('applyPhoneChange');
    const row = await this.findById(id);
    if (!row || row.pending_phone?.number !== number) return null;
    row.login_phone = number;
    row.pending_phone = null;
    return row;
  }
  async clearPendingContact(id: string, field: 'pending_email' | 'pending_phone') {
    this.writes.push(`clearPendingContact:${field}`);
    const row = await this.findById(id);
    if (!row) return null;
    row[field] = null;
    return row;
  }
}

/** Captures what was sent, and to whom — the "to whom" is the assertion that matters. */
class FakeMail {
  public sent: Array<{ to: string; template: string; variables: Record<string, unknown> }> = [];
  async send(options: { to: string; template: string; variables: Record<string, unknown> }) {
    this.sent.push({ to: options.to, template: options.template, variables: options.variables });
  }
  /**
   * The token out of the last link sent — the only place a test can get it, as in real life.
   *
   * Parsed with a regex rather than `new URL`, because neither `STOREFRONT_URL` nor
   * `API_PUBLIC_URL` is set in a bare test environment, so the builder's fallback produces a
   * RELATIVE link and `new URL` throws on it. That is the correct behaviour of the builder
   * (a misconfigured deploy should emit a visibly wrong link, not `undefined/...`), so the
   * test accommodates it rather than the other way round.
   */
  lastToken(): string | null {
    const link = this.sent[this.sent.length - 1]?.variables?.link as string | undefined;
    return link ? (/[?&]token=([^&]+)/.exec(link)?.[1] ?? null) : null;
  }
}

/** A messaging-connection lookup. `external_id` is BARE DIGITS, exactly as Meta sends it. */
class FakeConnections {
  constructor(private readonly byUser: Record<string, { channel: string; external_id: string }[]> = {}) {}
  async getConnection(userId: string, channel: string) {
    return (this.byUser[String(userId)] ?? []).find((c) => c.channel === channel) ?? null;
  }
}

class FakeRoleRepo {
  public calls: Array<{ userId: string; contact: Record<string, string> }> = [];
  async setVerifiedContact(userId: string, contact: Record<string, string>) {
    this.calls.push({ userId, contact });
    return null;
  }
}

/**
 * Records that activation was evaluated, and for which user.
 *
 * ⚠ **A fake here is not optional.** The real `AccountActivationService` is the constructor
 * default, so a harness that stops one argument short reaches Mongo with the fixture's `'u1'`
 * and logs a CastError on every run — swallowed, because activation is best-effort, so the
 * suite still passes while printing a stack trace. That is precisely the noise a real failure
 * later hides inside.
 */
class FakeActivation {
  public calls: string[] = [];
  async activateEligibleRoles(user: { _id: { toString(): string } }) {
    this.calls.push(user._id.toString());
    return [];
  }
}

interface Harness {
  service: ContactChangeService;
  users: FakeUserRepo;
  mail: FakeMail;
  customers: FakeRoleRepo;
  vendors: FakeRoleRepo;
  activation: FakeActivation;
}

function harness(rows: FakeUser[], connections: FakeConnections = new FakeConnections()): Harness {
  const users = new FakeUserRepo(rows);
  const mail = new FakeMail();
  const customers = new FakeRoleRepo();
  const vendors = new FakeRoleRepo();
  const activation = new FakeActivation();
  const service = new ContactChangeService(
    users as never,
    mail as never,
    connections as never,
    customers as never,
    vendors as never,
    new FakeRoleRepo() as never,
    new FakeRoleRepo() as never,
    activation as never,
  );
  return { service, users, mail, customers, vendors, activation };
}

const ACTOR = { userId: 'u1', role: 'customer', roleEntityId: 'c1' };

// ─────────────────────────────────────────────────────────────────────────────
//  Sources, for the scans
// ─────────────────────────────────────────────────────────────────────────────

const SRC = join(__dirname, '..', '..', 'src');
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const serviceSrc = stripComments(read('modules/users/services/contact-change.service.ts'));
const repoSrc = stripComments(read('modules/users/user.repository.ts'));
const userRoutes = stripComments(read('modules/users/user.routes.ts'));
const authRoutes = stripComments(read('modules/auth/auth.routes.ts'));
const modelSrc = read('modules/users/user.model.ts');

// ═════════════════════════════════════════════════════════════════════════════

section('Email — pending until verified');

assert('requesting a change writes a pending block and NOTHING else', async () => {
  const h = harness([makeUser('u1', { login_email: 'old@example.com' })]);
  await h.service.requestEmailChange(ACTOR, 'new@example.com');
  return h.users.writes.length === 1 && h.users.writes[0] === 'setPendingEmail';
});

assert('⚠ login_email is NOT mutated by the request — the whole point of the flow', async () => {
  const h = harness([makeUser('u1', { login_email: 'old@example.com' })]);
  await h.service.requestEmailChange(ACTOR, 'new@example.com');
  return h.users.rows[0].login_email === 'old@example.com';
});

assert('the pending block carries the NEW address', async () => {
  const h = harness([makeUser('u1', { login_email: 'old@example.com' })]);
  await h.service.requestEmailChange(ACTOR, 'New@Example.com');
  return h.users.rows[0].pending_email?.address === 'new@example.com';
});

assert('the token is stored HASHED — the collection never holds a spendable credential', async () => {
  const h = harness([makeUser('u1', { login_email: 'old@example.com' })]);
  await h.service.requestEmailChange(ACTOR, 'new@example.com');
  const token = h.mail.lastToken()!;
  const stored = h.users.rows[0].pending_email!.token_hash;
  return token.length === 64 && stored.length === 64 && stored !== token;
});

assert('the verification mail goes to the NEW address, never the old one', async () => {
  const h = harness([makeUser('u1', { login_email: 'old@example.com' })]);
  await h.service.requestEmailChange(ACTOR, 'new@example.com');
  return h.mail.sent.length === 1
    && h.mail.sent[0].to === 'new@example.com'
    && h.mail.sent[0].template === 'verify-email-change';
});

assert('confirming swaps the identifier and clears the pending block', async () => {
  const h = harness([makeUser('u1', { login_email: 'old@example.com' })]);
  await h.service.requestEmailChange(ACTOR, 'new@example.com');
  await h.service.confirmEmailChange(h.mail.lastToken()!);
  return h.users.rows[0].login_email === 'new@example.com' && h.users.rows[0].pending_email === null;
});

assert('the old address stops resolving exactly when the new one starts', async () => {
  const h = harness([makeUser('u1', { login_email: 'old@example.com' })]);
  await h.service.requestEmailChange(ACTOR, 'new@example.com');

  // Mid-flight: the OLD one still resolves and the new one does not.
  const midOld = await h.users.findByEmail('old@example.com');
  const midNew = await h.users.findByEmail('new@example.com');

  await h.service.confirmEmailChange(h.mail.lastToken()!);

  const afterOld = await h.users.findByEmail('old@example.com');
  const afterNew = await h.users.findByEmail('new@example.com');

  return midOld !== null && midNew === null && afterOld === null && afterNew !== null;
});

assert('a confirmed change lands on every role profile the account holds', async () => {
  const h = harness([makeUser('u1', { login_email: 'old@example.com', roles: ['customer', 'vendor'] })]);
  await h.service.requestEmailChange(ACTOR, 'new@example.com');
  await h.service.confirmEmailChange(h.mail.lastToken()!);
  return h.customers.calls.length === 1
    && h.vendors.calls.length === 1
    && h.customers.calls[0].contact.email === 'new@example.com';
});

/**
 * ⚠ **The wiring, not the rule.** Whether a given account *deserves* promotion is
 * `core/accounts/activation.ts`' business and is pinned where that rule lives. What this
 * asserts is the thing that would rot silently: that a proved contact reaches the activation
 * service at all. Delete the call at the bottom of `syncRoleEntities` and nothing else in
 * this suite — or any other — notices; accounts simply stop activating, which looks like a
 * product decision rather than a bug.
 */
assert('a proved contact evaluates activation, once, for the right user', async () => {
  const h = harness([makeUser('u1', { login_email: 'old@example.com', roles: ['customer', 'vendor'] })]);
  await h.service.requestEmailChange(ACTOR, 'new@example.com');
  await h.service.confirmEmailChange(h.mail.lastToken()!);
  return h.activation.calls.length === 1 && h.activation.calls[0] === 'u1';
});

/**
 * Ordering, and it is the half that is easy to get wrong. The rule reads `phone_verified`,
 * which the role-profile writes above are what set. Evaluating activation first would test
 * the previous state and promote nobody on the very call that earned it.
 */
assert('activation is evaluated AFTER the role profiles are written', async () => {
  const order: string[] = [];
  const h = harness([makeUser('u1', { login_email: 'old@example.com', roles: ['vendor'] })]);
  const vendorRepo = h.vendors as unknown as { setVerifiedContact: (...a: never[]) => Promise<unknown> };
  const originalSync = vendorRepo.setVerifiedContact.bind(h.vendors);
  vendorRepo.setVerifiedContact = async (...args: never[]) => {
    order.push('sync');
    return originalSync(...args);
  };
  const activation = h.activation as unknown as { activateEligibleRoles: (...a: never[]) => Promise<unknown> };
  const originalActivate = activation.activateEligibleRoles.bind(h.activation);
  activation.activateEligibleRoles = async (...args: never[]) => {
    order.push('activate');
    return originalActivate(...args);
  };

  await h.service.requestEmailChange(ACTOR, 'new@example.com');
  await h.service.confirmEmailChange(h.mail.lastToken()!);
  return order.join(',') === 'sync,activate';
});

section('Email — the refusals');

assert('moving to the address already on the account is refused, not a silent no-op', async () => {
  const h = harness([makeUser('u1', { login_email: 'old@example.com' })]);
  const code = await codeOf(() => h.service.requestEmailChange(ACTOR, 'OLD@example.com'));
  return code === ERROR_CODES.CONTACT_CHANGE_SAME_IDENTIFIER && h.users.writes.length === 0;
});

assert('an address held by another account is refused AT REQUEST', async () => {
  const h = harness([
    makeUser('u1', { login_email: 'old@example.com' }),
    makeUser('u2', { login_email: 'taken@example.com' }),
  ]);
  const code = await codeOf(() => h.service.requestEmailChange(ACTOR, 'taken@example.com'));
  return code === ERROR_CODES.CONTACT_CHANGE_IDENTIFIER_TAKEN && h.users.writes.length === 0;
});

assert('⚠ …and AGAIN at confirm — it can be claimed in the window between the two', async () => {
  const rows = [makeUser('u1', { login_email: 'old@example.com' })];
  const h = harness(rows);
  await h.service.requestEmailChange(ACTOR, 'new@example.com');

  // Somebody else claims it while the link sits in a mailbox.
  rows.push(makeUser('u2', { login_email: 'new@example.com' }));

  const code = await codeOf(() => h.service.confirmEmailChange(h.mail.lastToken()!));
  return code === ERROR_CODES.CONTACT_CHANGE_IDENTIFIER_TAKEN
    && rows[0].login_email === 'old@example.com';
});

assert('an EXPIRED token cannot swap', async () => {
  const h = harness([makeUser('u1', { login_email: 'old@example.com' })]);
  await h.service.requestEmailChange(ACTOR, 'new@example.com');
  const token = h.mail.lastToken()!;

  h.users.rows[0].pending_email!.expires_at = new Date(Date.now() - 1000);

  const code = await codeOf(() => h.service.confirmEmailChange(token));
  return code === ERROR_CODES.CONTACT_CHANGE_EXPIRED && h.users.rows[0].login_email === 'old@example.com';
});

assert('an unknown token is invalid rather than a crash', async () => {
  const h = harness([makeUser('u1', { login_email: 'old@example.com' })]);
  const code = await codeOf(() => h.service.confirmEmailChange('deadbeef'.repeat(8)));
  return code === ERROR_CODES.CONTACT_CHANGE_TOKEN_INVALID;
});

assert('a token cannot be spent twice — the second confirm misses the compare-and-set', async () => {
  const h = harness([makeUser('u1', { login_email: 'old@example.com' })]);
  await h.service.requestEmailChange(ACTOR, 'new@example.com');
  const token = h.mail.lastToken()!;
  await h.service.confirmEmailChange(token);

  const code = await codeOf(() => h.service.confirmEmailChange(token));
  return code === ERROR_CODES.CONTACT_CHANGE_TOKEN_INVALID;
});

assert('a second request supersedes the first — the earlier token stops working', async () => {
  const h = harness([makeUser('u1', { login_email: 'old@example.com' })]);
  await h.service.requestEmailChange(ACTOR, 'first@example.com');
  const firstToken = h.mail.lastToken()!;
  await h.service.requestEmailChange(ACTOR, 'second@example.com');

  const code = await codeOf(() => h.service.confirmEmailChange(firstToken));
  return code === ERROR_CODES.CONTACT_CHANGE_TOKEN_INVALID
    && h.users.rows[0].login_email === 'old@example.com';
});

assert('cancelling clears the pending block and leaves the identifier alone', async () => {
  const h = harness([makeUser('u1', { login_email: 'old@example.com' })]);
  await h.service.requestEmailChange(ACTOR, 'new@example.com');
  await h.service.cancelPending(ACTOR, 'email');
  return h.users.rows[0].pending_email === null && h.users.rows[0].login_email === 'old@example.com';
});

assert('cancelling with nothing in flight is a conflict, not a silent success', async () => {
  const h = harness([makeUser('u1', { login_email: 'old@example.com' })]);
  const code = await codeOf(() => h.service.cancelPending(ACTOR, 'email'));
  return code === ERROR_CODES.CONTACT_CHANGE_NOT_PENDING;
});

section('Phone — pending until PROVED (O-4)');

const WA = (digits: string) => new FakeConnections({ u1: [{ channel: 'whatsapp', external_id: digits }] });

assert('requesting a change writes a pending block and NOTHING else', async () => {
  const h = harness([makeUser('u1', { login_phone: '+237600000001' })]);
  await h.service.requestPhoneChange(ACTOR, '+237600000002');
  return h.users.writes.length === 1 && h.users.writes[0] === 'setPendingPhone';
});

assert('⚠ login_phone is NOT mutated by the request', async () => {
  const h = harness([makeUser('u1', { login_phone: '+237600000001' })]);
  await h.service.requestPhoneChange(ACTOR, '+237600000002');
  return h.users.rows[0].login_phone === '+237600000001'
    && h.users.rows[0].pending_phone?.number === '+237600000002';
});

assert('confirming with a matching WhatsApp connection swaps the identifier', async () => {
  const h = harness([makeUser('u1', { login_phone: '+237600000001' })], WA('237600000002'));
  await h.service.requestPhoneChange(ACTOR, '+237600000002');
  await h.service.confirmPhoneChange(ACTOR);
  return h.users.rows[0].login_phone === '+237600000002' && h.users.rows[0].pending_phone === null;
});

assert(
  '⚠ the WhatsApp identity is BARE DIGITS and the pending number is E.164 — the repair is what makes this work at all',
  async () => {
    // Without `messagingPhoneToE164` this comparison fails for EVERY user while looking
    // perfectly implemented. Same trap `identity-resolver.service.ts` carries a fixture for.
    const h = harness([makeUser('u1', { login_phone: '+237600000001' })], WA('237600000002'));
    await h.service.requestPhoneChange(ACTOR, '+237600000002');
    const code = await codeOf(() => h.service.confirmPhoneChange(ACTOR));
    return code === null;
  },
);

assert('no connection at all → unproven, and the identifier does not move', async () => {
  const h = harness([makeUser('u1', { login_phone: '+237600000001' })]);
  await h.service.requestPhoneChange(ACTOR, '+237600000002');
  const code = await codeOf(() => h.service.confirmPhoneChange(ACTOR));
  return code === ERROR_CODES.CONTACT_CHANGE_PHONE_UNPROVEN
    && h.users.rows[0].login_phone === '+237600000001';
});

assert('a connection on a DIFFERENT number proves nothing', async () => {
  const h = harness([makeUser('u1', { login_phone: '+237600000001' })], WA('237699999999'));
  await h.service.requestPhoneChange(ACTOR, '+237600000002');
  const code = await codeOf(() => h.service.confirmPhoneChange(ACTOR));
  return code === ERROR_CODES.CONTACT_CHANGE_PHONE_UNPROVEN;
});

assert('a TELEGRAM connection does not count — a chat_id is not a phone number', async () => {
  const telegram = new FakeConnections({ u1: [{ channel: 'telegram', external_id: '237600000002' }] });
  const h = harness([makeUser('u1', { login_phone: '+237600000001' })], telegram);
  await h.service.requestPhoneChange(ACTOR, '+237600000002');
  const code = await codeOf(() => h.service.confirmPhoneChange(ACTOR));
  return code === ERROR_CODES.CONTACT_CHANGE_PHONE_UNPROVEN;
});

assert('an EXPIRED pending phone change cannot swap, even with the proof in hand', async () => {
  const h = harness([makeUser('u1', { login_phone: '+237600000001' })], WA('237600000002'));
  await h.service.requestPhoneChange(ACTOR, '+237600000002');
  h.users.rows[0].pending_phone!.expires_at = new Date(Date.now() - 1000);

  const code = await codeOf(() => h.service.confirmPhoneChange(ACTOR));
  return code === ERROR_CODES.CONTACT_CHANGE_EXPIRED
    && h.users.rows[0].login_phone === '+237600000001';
});

assert('a number held by another account is refused at confirm', async () => {
  const rows = [makeUser('u1', { login_phone: '+237600000001' })];
  const h = harness(rows, WA('237600000002'));
  await h.service.requestPhoneChange(ACTOR, '+237600000002');
  rows.push(makeUser('u2', { login_phone: '+237600000002' }));

  const code = await codeOf(() => h.service.confirmPhoneChange(ACTOR));
  return code === ERROR_CODES.CONTACT_CHANGE_IDENTIFIER_TAKEN
    && rows[0].login_phone === '+237600000001';
});

assert('confirming with nothing in flight is a conflict', async () => {
  const h = harness([makeUser('u1', { login_phone: '+237600000001' })], WA('237600000002'));
  const code = await codeOf(() => h.service.confirmPhoneChange(ACTOR));
  return code === ERROR_CODES.CONTACT_CHANGE_NOT_PENDING;
});

section('The read surface');

assert('the state report never leaks the token or its hash', async () => {
  const h = harness([makeUser('u1', { login_email: 'old@example.com' })]);
  await h.service.requestEmailChange(ACTOR, 'new@example.com');
  const state = await h.service.getState('u1');
  const json = JSON.stringify(state);
  return !json.includes(h.users.rows[0].pending_email!.token_hash)
    && !json.includes(h.mail.lastToken()!);
});

assert('it reports the target, so a client can say WHICH address is waiting', async () => {
  const h = harness([makeUser('u1', { login_email: 'old@example.com' })]);
  await h.service.requestEmailChange(ACTOR, 'new@example.com');
  const state = await h.service.getState('u1');
  return state.pendingEmail?.target === 'new@example.com'
    && state.email === 'old@example.com'
    && state.pendingPhone === null;
});

section('Validation — the shared identifier schemas, not a local regex');

assert('a non-E.164 phone is refused', () =>
  !RequestPhoneChangeSchema.safeParse({ phone: '600000002' }).success);

assert('strict E.164 is accepted', () =>
  RequestPhoneChangeSchema.safeParse({ phone: '+237600000002' }).success);

assert('a malformed email is refused', () =>
  !RequestEmailChangeSchema.safeParse({ email: 'not-an-address' }).success);

assert('both request schemas are .strict() — an unknown key is a 400, not a stripped field', () =>
  !RequestEmailChangeSchema.safeParse({ email: 'a@b.com', verified: true }).success
  && !RequestPhoneChangeSchema.safeParse({ phone: '+237600000002', verified: true }).success);

assert('neither request schema accepts null or an empty string — clearing is not self-service', () =>
  !RequestEmailChangeSchema.safeParse({ email: null }).success
  && !RequestEmailChangeSchema.safeParse({ email: '' }).success
  && !RequestPhoneChangeSchema.safeParse({ phone: null }).success);

assert('the confirm schema bounds the token rather than hashing anything it is handed', () =>
  !ConfirmEmailChangeSchema.safeParse({ token: 'x'.repeat(513) }).success
  && !ConfirmEmailChangeSchema.safeParse({ token: '' }).success
  && ConfirmEmailChangeSchema.safeParse({ token: 'ab'.repeat(32) }).success);

section('Structure — what no fake can see');

assert('the confirmation link points at the STOREFRONT, never the API', () => {
  process.env.STOREFRONT_URL = 'https://shop.example.com';
  const link = buildEmailChangeLink('tok');
  delete process.env.STOREFRONT_URL;
  return link.startsWith('https://shop.example.com/') && !link.includes('/api/');
});

assert('the service reads STOREFRONT_URL first, as buildResetLink does', () =>
  /STOREFRONT_URL\s*\|\|\s*process\.env\.API_PUBLIC_URL/.test(serviceSrc));

assert('the email confirm route is PUBLIC — no requireAuth on it', () => {
  const line = authRoutes.split('\n').find((l) => l.includes("'/email-change/confirm'")) ?? '';
  return line.length > 0 && !line.includes('requireAuth');
});

assert('…and it is a POST, so a mail-client prefetch cannot spend the token', () =>
  /router\.post\('\/email-change\/confirm'/.test(authRoutes));

assert('the request routes ARE authenticated — the /api/me router guards the whole surface', () =>
  /router\.use\(requireAuth\)/.test(userRoutes)
  && /router\.patch\('\/email'/.test(userRoutes)
  && /router\.patch\('\/phone'/.test(userRoutes));

assert('the phone confirm is on /api/me, not /api/auth — its proof needs the account', () =>
  /router\.post\('\/phone\/confirm'/.test(userRoutes)
  && !/phone\/confirm/.test(authRoutes));

assert(
  '⚠ the swap and the pending-clear are ONE $set — a pending block that outlives its confirmation is a token spent twice',
  () => {
    const emailSet = /login_email:[^}]*pending_email:\s*null/.test(repoSrc);
    const phoneSet = /login_phone:[^}]*pending_phone:\s*null/.test(repoSrc);
    return emailSet && phoneSet;
  },
);

assert('both swaps are compare-and-sets, not blind updates', () =>
  /findOneAndUpdate\(\s*\{\s*_id: userId, 'pending_email\.token_hash': tokenHash \}/.test(repoSrc)
  && /findOneAndUpdate\(\s*\{\s*_id: userId, 'pending_phone\.number': number \}/.test(repoSrc));

assert(
  'setPendingEmail / setPendingPhone touch NEITHER login identifier — asserted on the source, because a fake cannot prove a negative about the real one',
  () => {
    const body = repoSrc.slice(repoSrc.indexOf('async setPendingEmail'), repoSrc.indexOf('async findByPendingEmailToken'));
    return body.length > 0 && !body.includes('login_email') && !body.includes('login_phone');
  },
);

assert('the WhatsApp comparison goes through the shared E.164 repair, not a local one', () =>
  serviceSrc.includes('messagingPhoneToE164(connection.external_id)'));

assert('nothing here stamps the password epoch — an identifier is not a credential', () =>
  !serviceSrc.includes('password_changed_at') && !serviceSrc.includes('updatePassword'));

assert('the pending sub-documents default to null, so absent and empty are one state', () =>
  /pending_email:\s*\{[\s\S]{0,600}?default:\s*null/.test(modelSrc)
  && /pending_phone:\s*\{[\s\S]{0,500}?default:\s*null/.test(modelSrc));

assert('the token-hash lookup is indexed, and sparse rather than unique', () =>
  /UserSchema\.index\(\{\s*'pending_email\.token_hash':\s*1\s*\},\s*\{\s*sparse:\s*true\s*\}\)/.test(modelSrc));

assert('the pending phone block carries NO token — its proof is the connection', () =>
  !/pending_phone[\s\S]{0,400}?token_hash/.test(modelSrc));

assert('both windows are configuration, not literals in the rule', () =>
  CONTACT_CHANGE_CONFIG.EMAIL_TOKEN_TTL_SECONDS > 0
  && CONTACT_CHANGE_CONFIG.PHONE_PENDING_TTL_SECONDS > 0
  && serviceSrc.includes('CONTACT_CHANGE_CONFIG.EMAIL_TOKEN_TTL_SECONDS')
  && serviceSrc.includes('CONTACT_CHANGE_CONFIG.PHONE_PENDING_TTL_SECONDS'));

assert('the email window is shorter than the 24h registration verification window', () =>
  CONTACT_CHANGE_CONFIG.EMAIL_TOKEN_TTL_SECONDS < 86400);

// ═════════════════════════════════════════════════════════════════════════════

void (async () => {
  originalConsole.log('\n🔐 Account contact change — Phase 6 · 6.D.1\n');
  await run();
  originalConsole.log(`\n${failed === 0 ? '✔' : '✖'} test:account-contact-change — ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
