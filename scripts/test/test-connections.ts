/**
 * Test: the unified messaging-connection domain (Phases 2 + 3).
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no framework).
 * DB-free and Redis-free: the code generator, the normalizer, the identity mask and the DTO
 * are pure by construction, which is why they live under `domain/` and `dto/` rather than on
 * the service.
 *
 * Three of its groups are SOURCE SCANS, because the invariants they cover are structural and
 * a regression is invisible in behaviour until somebody exploits it:
 *
 *   - the redeem endpoint must NOT be mounted under `/api/webhooks`, which is exempt from
 *     rate limiting. That exemption is exactly how the two predecessor mechanisms ended up
 *     with unthrottled authenticated endpoints, and 2^30 of code entropy assumes throttling.
 *   - the store must claim with `SET … NX` and spend with `getDel`. A GET-then-DEL pair is
 *     what made the old Telegram token redeemable twice, and the replacement reads fine.
 *   - nothing in `src/` may still reference the deleted `wa` sub-document, `telegram_links`
 *     or `wa_verify:`. That scan is what makes "completely replaced" a fact rather than a
 *     claim.
 *
 * Run: npm run test:connections
 */
import fs from 'fs';
import path from 'path';
import { CONNECTION_CHANNELS, isMessagingChannel } from '../../src/modules/channel-connections/domain/channel';
import {
  CODE_LENGTH,
  CONNECTION_CODE_PATTERN,
  generateConnectionCode,
  normalizeConnectionCode,
  isWellFormedConnectionCode,
} from '../../src/modules/channel-connections/domain/connection-code';
import { maskIdentity } from '../../src/modules/channel-connections/domain/identity-mask';
import { ConnectionMapper } from '../../src/modules/channel-connections/dto/channel-connection.dto';
import { ConnectionService } from '../../src/modules/channel-connections/services/channel-connection.service';
import {
  connectionCodeStore,
  CONNECTION_CODE_MAX_ATTEMPTS,
  ConsumeResult,
} from '../../src/modules/channel-connections/services/connection-code.store';
import {
  handler as connectHandler,
  schema as connectSchema,
} from '../../src/modules/channel-connections/commands/connect.command';
import { CONNECTION_CODE_POLICY, POLICIES } from '../../src/api/rate-limit/policy';

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
 * The async twin of `assert`.
 *
 * Passing an `async` callback to `assert` is a silent always-pass — the helper receives a
 * Promise, which is truthy whatever it settles to. Every assertion that awaits must come
 * through here instead.
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

/** Every .ts file under src/, for the census scans. */
function allSourceFiles(dir: string = SRC, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) allSourceFiles(full, out);
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * Source with comments removed, for the "it is really gone" scans.
 *
 * A scan that cannot tell code from prose fails the moment somebody DOCUMENTS what they
 * deleted — and the tombstone comments left by this change do exactly that, deliberately:
 * `auth.service.ts` explains why `issueWaVerificationCode` is gone, `redis.factory.ts`
 * explains why databases 4 and 9 are unassigned. Those notes are the most useful thing in
 * the diff, and a scan that forces their deletion is a scan that has made the codebase
 * worse. So strip, then look.
 *
 * Handles block comments and whole-line `//` comments, which is what every tombstone here
 * uses. It does NOT parse: a `/*` inside a string literal would over-strip. That is an
 * accepted limit — over-stripping risks a false PASS, so if one of these assertions ever
 * goes green suspiciously, check this function first.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

const SAMPLE = 4000;

async function main(): Promise<void> {
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n▶ The channel vocabulary');

  assert('exactly two channels today', () => CONNECTION_CHANNELS.length === 2);
  assert('whatsapp and telegram, in that order', () =>
    CONNECTION_CHANNELS[0] === 'whatsapp' && CONNECTION_CHANNELS[1] === 'telegram');
  assert('the guard accepts a real channel', () => isMessagingChannel('telegram'));
  assert('the guard rejects a near miss', () => !isMessagingChannel('Telegram'));
  assert('the guard rejects a non-string', () => !isMessagingChannel(7));

  /**
   * The model's enum is spread from CONNECTION_CHANNELS rather than typed out. Asserted by
   * source scan rather than by importing the model, which would register a Mongoose schema
   * and drag a DB connection into a DB-free suite. This is the drift that left eight agent
   * contract notifications in the type union and absent from the schema enum.
   */
  assert('the model enum is DERIVED from the union, not a second literal list', () => {
    const model = read('modules/channel-connections/channel-connection.model.ts');
    return model.includes('enum: [...CONNECTION_CHANNELS]')
      && !/enum:\s*\[\s*'whatsapp'/.test(model);
  });

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n▶ The code — shape and alphabet');

  assert('exactly 6 characters', () => generateConnectionCode().length === CODE_LENGTH);
  assert('CODE_LENGTH is 6', () => CODE_LENGTH === 6);

  const codes = Array.from({ length: SAMPLE }, () => generateConnectionCode());

  assert('every generated code matches the published pattern', () =>
    codes.every((c) => CONNECTION_CODE_PATTERN.test(c)));
  assert('every generated code passes isWellFormedConnectionCode', () =>
    codes.every((c) => isWellFormedConnectionCode(c)));

  /**
   * The ambiguity rule. I, L and O are absent so nobody has to decide whether the glyph on
   * their screen is a one or an i; U is absent so a code cannot spell something unfortunate.
   */
  assert('no I, L, O or U is ever generated', () =>
    codes.every((c) => !/[ILOU]/.test(c)));
  assert('codes are uppercase-only', () => codes.every((c) => c === c.toUpperCase()));

  /**
   * 256 % 32 === 0, so `byte & 31` samples the 32-symbol alphabet without modulo bias. A
   * broken mask (a 31- or 33-symbol alphabet, or a modulo) shows up as a starved character.
   * 4000 codes is 24000 draws, ~750 expected per symbol; a symbol under 300 is a real signal
   * rather than noise.
   */
  assert('all 32 symbols appear — the sampling is unbiased', () => {
    const counts = new Map<string, number>();
    for (const c of codes) for (const ch of c) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    return counts.size === 32 && [...counts.values()].every((n) => n > 300);
  });

  assert('codes are not sequential — 4000 draws are near-all distinct', () =>
    new Set(codes).size > SAMPLE * 0.999);

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n▶ Normalization — rescuing what a user typed');

  assert('lowercase is folded up', () => normalizeConnectionCode('a7k9p2') === 'A7K9P2');
  assert('O becomes zero', () => normalizeConnectionCode('OK9P2X') === '0K9P2X');
  assert('I becomes one', () => normalizeConnectionCode('IK9P2X') === '1K9P2X');
  assert('L becomes one', () => normalizeConnectionCode('LK9P2X') === '1K9P2X');
  assert('lowercase o/i/l are folded too', () => normalizeConnectionCode('oil9p2') === '0119P2');
  assert('hyphens are stripped', () => normalizeConnectionCode('A7K-9P2') === 'A7K9P2');
  assert('spaces are stripped', () => normalizeConnectionCode('A7K 9P2') === 'A7K9P2');
  assert('surrounding whitespace is stripped', () => normalizeConnectionCode('  A7K9P2 ') === 'A7K9P2');

  /**
   * THE load-bearing property. Because the alphabet excludes I, L and O, normalization can
   * only ever rewrite a character a user typed — never one we generated. So it cannot
   * collapse two distinct live codes onto the same key, which is what would make it a
   * collision engine rather than a convenience.
   */
  assert('every generated code is a FIXED POINT of normalize', () =>
    codes.every((c) => normalizeConnectionCode(c) === c));

  assert('a well-formed check rejects a normalized string that is too short', () =>
    !isWellFormedConnectionCode('A7K9P'));
  assert('a well-formed check rejects leftover ambiguous glyphs', () =>
    !isWellFormedConnectionCode('A7K9PO'));

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n▶ The identity mask — what the frontend may see');

  assert('whatsapp shows the last four digits only', () =>
    maskIdentity('whatsapp', '237600001234') === '••••1234');
  assert('whatsapp strips non-digits before masking', () =>
    maskIdentity('whatsapp', '+237 600 001 234') === '••••1234');
  assert('an implausibly short whatsapp id yields null, never a partial id', () =>
    maskIdentity('whatsapp', '12') === null);
  assert('telegram shows the handle', () =>
    maskIdentity('telegram', '123456789', 'janedoe') === '@janedoe');
  assert('telegram does not double the @', () =>
    maskIdentity('telegram', '123456789', '@janedoe') === '@janedoe');
  assert('telegram WITHOUT a handle yields null — the chat id is never a fallback', () =>
    maskIdentity('telegram', '123456789', null) === null);

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n▶ LEAK: external_id must never reach a client');

  const WA_ID = '237600001234';
  const TG_ID = '987654321';

  const waDto = ConnectionMapper.toDto({
    channel: 'whatsapp',
    connection: {
      channel: 'whatsapp',
      external_id: WA_ID,
      display_name: 'Jane D.',
      handle: null,
      connected_at: new Date('2026-08-15T09:00:00.000Z'),
      last_seen_at: null,
    } as any,
  });

  const tgDto = ConnectionMapper.toDto({
    channel: 'telegram',
    connection: {
      channel: 'telegram',
      external_id: TG_ID,
      display_name: 'Jane Doe',
      handle: 'janedoe',
      connected_at: new Date('2026-08-15T09:00:00.000Z'),
      last_seen_at: null,
    } as any,
  });

  assert('the serialised WhatsApp DTO does not contain the wa_phone_id', () =>
    !JSON.stringify(waDto).includes(WA_ID));
  assert('the serialised Telegram DTO does not contain the chat id', () =>
    !JSON.stringify(tgDto).includes(TG_ID));
  assert('no DTO carries an external_id key under any spelling', () => {
    const keys = Object.keys(waDto).concat(Object.keys(tgDto));
    return !keys.some((k) => /external|externalId|chatId|waPhoneId|phone/i.test(k));
  });
  assert('the DTO still says enough to recognise the account', () =>
    waDto.connected && waDto.displayName === 'Jane D.' && waDto.identityHint === '••••1234');
  assert('a connected channel carries no howToConnect block', () =>
    waDto.howToConnect === undefined);
  assert('a disconnected channel DOES carry howToConnect', () => {
    const dto = ConnectionMapper.toDto({ channel: 'telegram', connection: null });
    return dto.connected === false && dto.howToConnect?.command === '/connect';
  });

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n▶ SOURCE SCAN: the redeem endpoint is not rate-limit-exempt');

  assert('connection routes are mounted under /api/me, not /api/webhooks', () => {
    const userRoutes = read('modules/users/user.routes.ts');
    return userRoutes.includes("router.use('/connections', connectionRoutes)");
  });
  assert('the api router does NOT mount connections under /webhooks', () => {
    const api = read('api/index.ts');
    return !/webhooks\/connections|connections['"]\s*,\s*connectionRoutes/.test(api);
  });
  assert('the connections router declares no guard of its own (it inherits requireAuth)', () => {
    const routes = stripComments(read('modules/channel-connections/channel-connection.routes.ts'));
    return !routes.includes('requireAuth') && !routes.includes('requireRole');
  });
  assert('/api/me applies requireAuth at the router level', () => {
    const userRoutes = read('modules/users/user.routes.ts');
    return userRoutes.includes('router.use(requireAuth)');
  });

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n▶ SOURCE SCAN: the store uses atomic primitives');

  const store = read('modules/channel-connections/services/connection-code.store.ts');

  assert('a code is CLAIMED with SET NX, never a read-then-write', () =>
    /NX:\s*true/.test(store));

  /**
   * Spending must be ONE atomic operation. `GETDEL` would say it in a word but needs Redis
   * 6.2, and this platform's development Redis is 3.0 — so it is a Lua script, which is
   * atomic from 2.6 and is already the shape `core/jobs/worker-lock.ts` uses.
   */
  assert('a code is SPENT by an atomic Lua script', () =>
    store.includes('CONSUME_SCRIPT') && store.includes('redis.eval(CONSUME_SCRIPT'));
  assert('the consume script does GET then DEL inside ONE evaluation', () =>
    /redis\.call\("get", KEYS\[1\]\)[\s\S]*redis\.call\("del", KEYS\[1\]\)/.test(store));
  assert('GETDEL is not used — it is unavailable before Redis 6.2', () =>
    !/getDel/.test(store));
  assert('there is no client-side GET-then-DEL pair on the code key', () =>
    !/redis\.get\(codeKey/.test(store));
  assert('the TTL is 600 seconds', () =>
    store.includes('CONNECTION_CODE_TTL_SECONDS = 600'));
  assert('the code key is the documented shape', () =>
    store.includes('`connection:code:${code}`'));
  assert('an attempt is counted BEFORE the code is consumed', () => {
    const service = read('modules/channel-connections/services/channel-connection.service.ts');
    return service.indexOf('recordAttempt') < service.indexOf('codeStore.consume');
  });
  assert('issuing revokes the identity previous live code', () =>
    store.includes('revokeForIdentity'));

  /**
   * The key must OUTLIVE the code so `consume` can tell expired from never-real. If these
   * two ever become the same number the endpoint silently loses `CONNECTION_CODE_EXPIRED`
   * and starts answering `CONNECTION_CODE_INVALID` to every slow user — a UX regression
   * with no failing behaviour anywhere to catch it.
   */
  assert('the key TTL is validity PLUS grace, so expiry stays distinguishable', () =>
    store.includes('EX: CONNECTION_CODE_TTL_SECONDS + CONNECTION_CODE_GRACE_SECONDS'));
  assert('the identity pointer carries the VALIDITY only, not the grace', () =>
    /identityKey\([^)]*\), code, \{\s*\r?\n?\s*EX: CONNECTION_CODE_TTL_SECONDS,/.test(store));
  assert('redeemability is decided by expiresAt, not by the key TTL', () =>
    store.includes('Date.parse(record.expiresAt)'));

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n▶ Phase 6: the linking rule table (fakes — no DB, no Redis)');

  const OTHER_USER = 'aaaaaaaaaaaaaaaaaaaaaaaa';
  const THIS_USER = 'bbbbbbbbbbbbbbbbbbbbbbbb';

  interface FakeState {
    consume: ConsumeResult;
    existingOwner: string | null;
    bound: Array<{ userId: string; channel: string; externalId: string }>;
    attemptsAllowed: boolean;
    attemptsCleared: boolean;
  }

  function serviceWith(overrides: Partial<FakeState>) {
    const state: FakeState = {
      consume: {
        status: 'ok',
        record: {
          channel: 'whatsapp',
          externalIdentity: '237600001234',
          displayName: 'Jane D.',
          handle: null,
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      },
      existingOwner: null,
      bound: [],
      attemptsAllowed: true,
      attemptsCleared: false,
      ...overrides,
    };

    const repo = {
      findByIdentity: async () =>
        state.existingOwner ? ({ user_id: state.existingOwner } as any) : null,
      bind: async (userId: any, data: any) => {
        state.bound.push({
          userId: userId.toString(),
          channel: data.channel,
          externalId: data.externalId,
        });
        return { ...data, user_id: userId, channel: data.channel } as any;
      },
    } as any;

    const codeStore = {
      recordAttempt: async () => state.attemptsAllowed,
      consume: async () => state.consume,
      clearAttempts: async () => { state.attemptsCleared = true; },
    } as any;

    return { service: new ConnectionService(repo, codeStore), state };
  }

  async function codeFrom(fn: () => Promise<unknown>): Promise<string> {
    try {
      await fn();
      return 'NO_THROW';
    } catch (err) {
      return (err as { code?: string }).code ?? 'NO_CODE';
    }
  }

  await (async () => {
    // NEW CONNECTION
    const fresh = serviceWith({});
    await fresh.service.redeemCode(THIS_USER, 'A7K9P2');
    assert('a new identity binds', () =>
      fresh.state.bound.length === 1 && fresh.state.bound[0].userId === THIS_USER);
    assert('a successful redeem clears the attempt counter', () =>
      fresh.state.attemptsCleared);

    // ALREADY CONNECTED TO THE SAME ACCOUNT — idempotent
    const same = serviceWith({ existingOwner: THIS_USER });
    await same.service.redeemCode(THIS_USER, 'A7K9P2');
    assert('re-connecting an identity this account already holds SUCCEEDS', () =>
      same.state.bound.length === 1);
    assert('…and writes through the (user_id, channel) upsert — never a second row', () =>
      same.state.bound[0].userId === THIS_USER
      && same.state.bound[0].channel === 'whatsapp');

    // CONNECTED TO ANOTHER ACCOUNT — refuse, never transfer
    const taken = serviceWith({ existingOwner: OTHER_USER });
    const takenCode = await codeFrom(() => taken.service.redeemCode(THIS_USER, 'A7K9P2'));
    assert('an identity owned by another account is REFUSED', () =>
      takenCode === 'MESSAGING_IDENTITY_ALREADY_LINKED');
    assert('…and ownership is NOT silently transferred', () =>
      taken.state.bound.length === 0);

    // EXPIRED
    const expired = serviceWith({ consume: { status: 'expired' } });
    await assertAsync('an expired code answers CONNECTION_CODE_EXPIRED', async () =>
      (await codeFrom(() => expired.service.redeemCode(THIS_USER, 'A7K9P2')))
        === 'CONNECTION_CODE_EXPIRED');

    // INVALID / MISSING
    const missing = serviceWith({ consume: { status: 'missing' } });
    await assertAsync('an unknown or already-spent code answers CONNECTION_CODE_INVALID', async () =>
      (await codeFrom(() => missing.service.redeemCode(THIS_USER, 'A7K9P2')))
        === 'CONNECTION_CODE_INVALID');

    // MALFORMED — rejected before Redis, same code as a wrong one
    const malformed = serviceWith({});
    await assertAsync('a malformed code answers CONNECTION_CODE_INVALID too', async () =>
      (await codeFrom(() => malformed.service.redeemCode(THIS_USER, 'nope!')))
        === 'CONNECTION_CODE_INVALID');
    assert('…and never reaches the store', () => malformed.state.bound.length === 0);

    // ATTEMPT CEILING
    const throttled = serviceWith({ attemptsAllowed: false });
    await assertAsync('over the attempt ceiling answers CONNECTION_CODE_ATTEMPTS_EXCEEDED', async () =>
      (await codeFrom(() => throttled.service.redeemCode(THIS_USER, 'A7K9P2')))
        === 'CONNECTION_CODE_ATTEMPTS_EXCEEDED');
  })();

  /**
   * The refusal must not describe the other account. The caller already knows the messaging
   * identity — they hold a code minted from it — so the only thing left to leak is WHO on
   * this platform holds it, which would turn a phone number into an account-existence probe.
   */
  assert('the ALREADY_LINKED refusal discloses only the channel', () => {
    const service = read('modules/channel-connections/services/channel-connection.service.ts');
    const site = service.slice(service.indexOf('MESSAGING_IDENTITY_ALREADY_LINKED'));
    const details = site.slice(0, site.indexOf('}'));
    return details.includes('channel: record.channel')
      && !/user|email|owner|account_id/i.test(details);
  });

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n▶ Phase 4: the /connect command');

  assert('it is registered under one name, for BOTH channels', () => {
    // Comments stripped: this file's header names the two commands it replaced, and that
    // note is worth more than the convenience of a substring match.
    const registry = stripComments(read('modules/commands/index.ts'));
    return registry.includes('ConnectCommand.command_name')
      && !registry.includes('link_telegram');
  });

  await (async () => {
    const issued: Array<{ channel: string; externalIdentity: string }> = [];
    const original = connectionCodeStore.issue;
    // Stub the singleton: the handler reaches for it directly, and the point of these
    // assertions is the identity resolution, not Redis.
    (connectionCodeStore as any).issue = async (input: any) => {
      issued.push({ channel: input.channel, externalIdentity: input.externalIdentity });
      return { code: 'A7K9P2', expiresAt: new Date(), ttlSeconds: 600 };
    };

    try {
      const wa = await connectHandler(connectSchema.parse({ name: 'Jane D.' }), {
        source: 'whatsapp',
        wa_phone_id: '237600001234',
      });
      assert('WhatsApp: the identity is the wa_phone_id from the CONTEXT', () =>
        issued[0].channel === 'whatsapp' && issued[0].externalIdentity === '237600001234');
      assert('the reply carries the code', () => wa.message.includes('A7K9P2'));
      assert('the reply says it expires, and in how long', () =>
        /10 minutes/.test(wa.message) && /expires/i.test(wa.message));
      assert('the reply says nothing is connected YET', () =>
        /nothing has been connected yet/i.test(wa.message));
      assert('the result reports the channel and the TTL', () =>
        wa.channel === 'whatsapp' && wa.expiresInSeconds === 600);

      await connectHandler(connectSchema.parse({ username: 'janedoe' }), {
        source: 'telegram',
        chat_id: '987654321',
      });
      assert('Telegram: the identity is the chat_id from the CONTEXT', () =>
        issued[1].channel === 'telegram' && issued[1].externalIdentity === '987654321');

      /**
       * THE security property of this command. The deleted `link` command read
       * `payload.wa_data.wa_phone_id` — caller-supplied — so anyone who could reach the
       * webhook could name somebody else's number. The identity must come from the
       * context the controller built out of the webhook's own sender fields.
       */
      const spoofCode = await codeFrom(() => connectHandler(
        { name: 'attacker' } as any,
        { source: 'whatsapp', wa_phone_id: undefined } as any
      ));
      assert('a context with no sender is REFUSED, not defaulted', () =>
        spoofCode === 'MESSAGING_IDENTITY_UNRESOLVED');

      const badSource = await codeFrom(() => connectHandler(
        {} as any,
        { source: 'sms', wa_phone_id: '237600001234' } as any
      ));
      assert('an unknown channel is refused', () =>
        badSource === 'MESSAGING_IDENTITY_UNRESOLVED');

      assert('exactly two codes were issued — no accidental third', () => issued.length === 2);
    } finally {
      (connectionCodeStore as any).issue = original;
    }
  })();

  assert('SOURCE SCAN: the handler never reads an identity out of the PAYLOAD', () => {
    const cmd = read('modules/channel-connections/commands/connect.command.ts');
    // `payload` may supply cosmetic name/username only.
    return !/payload\.(wa_phone_id|chat_id|externalIdentity|identity|from)/.test(cmd);
  });

  assert('SOURCE SCAN: the minted code is never logged', () => {
    const cmd = read('modules/channel-connections/commands/connect.command.ts');
    const logs = cmd.match(/console\.log\([^)]*\)/g) ?? [];
    return logs.every((line) => !/issued\.code|\$\{code\}/.test(line));
  });

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n▶ Phase 4: the bot webhooks are authenticated');

  const guard = read('api/middlewares/bot-webhook.middleware.ts');

  assert('both bot webhooks carry requireBotWebhookSecret', () => {
    const wa = read('modules/whatsapp/whatsapp.routes.ts');
    const tg = read('modules/telegram/telegram.routes.ts');
    return /router\.post\('\/',\s*requireBotWebhookSecret/.test(wa)
      && /router\.post\('\/webhook',\s*requireBotWebhookSecret/.test(tg);
  });
  assert('the comparison is timing-safe', () =>
    guard.includes('crypto.timingSafeEqual'));
  assert('a length mismatch short-circuits — timingSafeEqual throws on one', () =>
    /a\.length !== b\.length/.test(guard));
  /**
   * ⚠ Rewritten 2026-09-09. These two pinned the guard's PRE-GAP-011 shape and had gone
   * stale in opposite directions — the dangerous one silently.
   *
   * The first required `NODE_ENV === 'production'` between `if (!expected)` and
   * `WEBHOOK_SECRET_INVALID` and had been RED since that branch was removed. The second,
   * "development stays open", was GREEN — but only because its regex `return next();\n}`
   * matches the guard's final success return. It asserted a dev bypass that no longer
   * exists, against a file whose own comment reads "⛔ No environment branch. An unset
   * secret refuses, everywhere… Do not re-add it."
   *
   * A green assertion pinning a REMOVED, WEAKER behaviour is worse than a red one: it reads
   * as coverage for the thing it would now fail to notice. Both are replaced by the
   * property the source actually claims, plus a guard against the branch coming back.
   */
  assert('an unset secret FAILS CLOSED — in every environment, with no branch', () =>
    /if \(!expected\)[\s\S]{0,400}?WEBHOOK_SECRET_INVALID/.test(guard)
      && /reason: 'not_configured'/.test(guard));
  assert('the guard has NO environment branch — an unset secret never opens', () =>
    // The file names `NODE_ENV` once, in the comment explaining why the branch is gone.
    // Any occurrence outside a comment is the removed bypass returning.
    !/NODE_ENV/.test(stripComments(guard)));
  // `lifecycle.ts`, not `server.ts`: plan step 2.A moved the boot sequence out so the drain
  // could be exported and called directly (Windows delivers no SIGTERM to a child process).
  // `server.ts` is now a three-line entrypoint.
  assert('the guard state is reported at boot', () => {
    const boot = read('lifecycle.ts');
    return boot.includes('reportBotWebhookGuard');
  });

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n▶ Phase 6: the redeem endpoint is rate limited on TWO axes');

  assert('POST carries the per-endpoint limiter; GET and DELETE do not', () => {
    const routes = stripComments(read('modules/channel-connections/channel-connection.routes.ts'));
    return /router\.post\('\/',\s*connectionCodeRateLimiter/.test(routes)
      && !/router\.get\([^)]*connectionCodeRateLimiter/.test(routes)
      && !/router\.delete\([^)]*connectionCodeRateLimiter/.test(routes);
  });

  /**
   * The two security counters must key on DIFFERENT axes. The attempt counter is per
   * account and is tighter; accounts are free to mint, so on its own it bounds nothing.
   * Making this limiter identity-scoped too would give an attacker both counters.
   */
  assert('the connection-code policy is IP-scoped, not identity-scoped', () =>
    CONNECTION_CODE_POLICY.scope === 'ip');
  assert('it is stricter than the ordinary identity ceilings', () =>
    Object.values(CONNECTION_CODE_POLICY.limits)
      .every((v) => v !== 'exempt' && (v as number) <= 60));
  assert('internal_service is NOT exempt from it', () =>
    CONNECTION_CODE_POLICY.limits.internal_service !== 'exempt');
  assert('it is registered in POLICIES, so it reaches the ops surface and the metrics', () =>
    POLICIES.some((p) => p.key === CONNECTION_CODE_POLICY.key));
  assert('the per-account attempt ceiling is 5', () =>
    CONNECTION_CODE_MAX_ATTEMPTS === 5);

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n▶ SOURCE SCAN: the predecessors are GONE');

  const files = allSourceFiles();

  /**
   * Files whose CODE — not their comments — still mentions the retired mechanism.
   *
   * Nothing is excluded by path. The new module is scanned like everything else; the only
   * reason its prose does not trip these is that the prose is stripped, which is the same
   * rule applied everywhere and not a carve-out for the code being added.
   */
  const offenders = (pattern: RegExp): string[] =>
    files
      .filter((f) => pattern.test(stripComments(fs.readFileSync(f, 'utf8'))))
      .map((f) => path.relative(SRC, f));

  assert('no `wa.verified` / `wa.wa_phone_id` read survives', () => {
    const bad = offenders(/\bwa\?\.\s*(verified|wa_phone_id)|['"]wa\.(verified|wa_phone_id|bound_at|name|last_seen_at)['"]/);
    if (bad.length) console.error('     ↳', bad.join(', '));
    return bad.length === 0;
  });
  assert('no `telegram_links` collection reference survives', () => {
    const bad = offenders(/telegram_links|TELEGRAM_LINK\b/);
    if (bad.length) console.error('     ↳', bad.join(', '));
    return bad.length === 0;
  });
  assert('no `wa_verify:` Redis key survives', () => {
    const bad = offenders(/wa_verify:|WA_VERIFY_DB/);
    if (bad.length) console.error('     ↳', bad.join(', '));
    return bad.length === 0;
  });
  assert('no `tlgt:` Redis key or TELEGRAM_LINK_TOKEN_DB survives', () => {
    const bad = offenders(/tlgt:|TELEGRAM_LINK_TOKEN_DB/);
    if (bad.length) console.error('     ↳', bad.join(', '));
    return bad.length === 0;
  });
  assert('the `/link:CODE` and `link_telegram` commands are gone', () => {
    const bad = offenders(/link_telegram|'\/link:|issueWaVerificationCode\(/);
    if (bad.length) console.error('     ↳', bad.join(', '));
    return bad.length === 0;
  });
  assert('POST /auth/request-wa-verification is gone', () => {
    const bad = offenders(/request-wa-verification/);
    if (bad.length) console.error('     ↳', bad.join(', '));
    return bad.length === 0;
  });

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n▶ Redis catalogue registration');

  const factory = read('infra/redis/redis.factory.ts');
  const policy = read('modules/system/domain/cache-flush-policy.ts');

  assert('CONNECTION_CODE_DB is exported', () =>
    factory.includes('export const CONNECTION_CODE_DB = 13'));
  assert('CONNECTION_CODE_DB is in REDIS_DB_CATALOG', () =>
    factory.includes("constant: 'CONNECTION_CODE_DB'"));
  assert('CONNECTION_CODE_DB has a cache-flush policy row', () =>
    policy.includes("specFor('CONNECTION_CODE_DB')"));
  assert('the two retired databases are out of the catalogue', () =>
    !factory.includes("constant: 'WA_VERIFY_DB'")
    && !factory.includes("constant: 'TELEGRAM_LINK_TOKEN_DB'"));
  assert('4 and 9 are not silently reassigned to a new feature', () =>
    !/=\s*4;/.test(factory) && !/=\s*9;/.test(factory));

  // ─────────────────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log(`${'─'.repeat(60)}\n`);

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('test:connections crashed:', err);
  process.exit(1);
});
