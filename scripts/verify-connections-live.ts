/**
 * Live verification of the messaging-connection mechanism — NEEDS Redis and Mongo.
 *
 * The DB-free `test:connections` covers the pure parts and scans the structural ones. Three
 * things it structurally cannot cover, and all three are the ones that bite:
 *
 *   1. the two UNIQUE INDEXES actually BUILD. `autoIndex` is on and a failed build fails
 *      SILENTLY at boot, which would leave the "one account per messaging identity" rule
 *      enforced by nothing — the exact hole the predecessor had.
 *   2. the consume script is atomic against a real Redis. A code redeemed twice concurrently
 *      must bind once and fail once. This is also the check that caught `GETDEL` being
 *      unavailable on Redis 3.0 — a source scan could never have.
 *   3. `SET NX` really refuses an occupied key, and the identity pointer really revokes.
 *
 * Read-mostly: it writes its own `verify-conn-*` fixtures and deletes them, pass or fail,
 * in the same shape as `verify:storefront`.
 *
 * Run: npm run verify:connections
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { ChannelConnectionModel } from '../src/modules/channel-connections/channel-connection.model';
import { connectionRepository } from '../src/modules/channel-connections/channel-connection.repository';
import {
  connectionCodeStore,
  CONNECTION_CODE_TTL_SECONDS,
  CONNECTION_CODE_GRACE_SECONDS,
} from '../src/modules/channel-connections/services/connection-code.store';
import { connectionService } from '../src/modules/channel-connections/services/channel-connection.service';
import { handler as connectHandler } from '../src/modules/channel-connections/commands/connect.command';
import { getRedisClient, closeRedisClients, CONNECTION_CODE_DB } from '../src/infra/redis/redis.factory';


dotenv.config();

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

const USER_A = new mongoose.Types.ObjectId();
const USER_B = new mongoose.Types.ObjectId();
const WA_ID = 'verify-conn-237600009999';
const TG_ID = 'verify-conn-tg-55512345';

async function cleanup(): Promise<void> {
  await ChannelConnectionModel.deleteMany({
    $or: [
      { user_id: { $in: [USER_A, USER_B] } },
      { external_id: { $regex: '^verify-conn-' } },
    ],
  });
  const redis = await getRedisClient(CONNECTION_CODE_DB);

  // Identity pointers and attempt counters name their subject in the KEY.
  for (const pattern of [
    'connection:identity:*verify-conn-*',
    `connection:attempts:${USER_A.toString()}`,
    `connection:attempts:${USER_B.toString()}`,
  ]) {
    const keys = await redis.keys(pattern);
    if (keys.length) await redis.del(keys);
  }

  // Code keys are random, so the fixture marker is in the VALUE. Read before
  // deleting — this database may hold a real in-flight code and a blind
  // wildcard delete would spend somebody's live connection.
  const codeKeys = await redis.keys('connection:code:*');
  for (const key of codeKeys) {
    const value = await redis.get(key);
    if (value?.includes('verify-conn-')) await redis.del(key);
  }
}

async function main(): Promise<void> {
  const uri = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi_mall';
  await mongoose.connect(uri);
  console.log(`\n▶ Connected to ${uri.replace(/\/\/[^@]*@/, '//***@')}`);

  try {
    await cleanup();

    // ── 1. The indexes actually build ──────────────────────────────────────
    console.log('\n▶ Indexes (autoIndex fails SILENTLY — this is the only place it is proven)');

    await ChannelConnectionModel.init();
    const indexes = await ChannelConnectionModel.collection.indexes();

    await assert('unique index on (user_id, channel) exists', () =>
      indexes.some((i) => i.unique === true
        && JSON.stringify(i.key) === JSON.stringify({ user_id: 1, channel: 1 })));

    await assert('unique index on (channel, external_id) exists', () =>
      indexes.some((i) => i.unique === true
        && JSON.stringify(i.key) === JSON.stringify({ channel: 1, external_id: 1 })));

    // ── 2. Binding rules against the real indexes ──────────────────────────
    console.log('\n▶ Binding');

    await connectionRepository.bind(USER_A, { channel: 'whatsapp', externalId: WA_ID, displayName: 'A' });

    await assert('the connection reads back', async () => {
      const c = await connectionService.getConnection(USER_A, 'whatsapp');
      return c?.external_id === WA_ID;
    });

    await assert('re-binding a NEW number on the same channel replaces, not duplicates', async () => {
      await connectionRepository.bind(USER_A, { channel: 'whatsapp', externalId: WA_ID + '-new' });
      const rows = await ChannelConnectionModel.countDocuments({ user_id: USER_A, channel: 'whatsapp' });
      const c = await connectionService.getConnection(USER_A, 'whatsapp');
      return rows === 1 && c?.external_id === WA_ID + '-new';
    });

    await assert('a SECOND account cannot claim the same identity (index enforces it)', async () => {
      try {
        await connectionRepository.bind(USER_B, { channel: 'whatsapp', externalId: WA_ID + '-new' });
        return false; // the index did not fire — the whole rule is unenforced
      } catch (err) {
        return (err as { code?: number }).code === 11000;
      }
    });

    await assert('the two channels are independent', async () => {
      await connectionRepository.bind(USER_A, { channel: 'telegram', externalId: TG_ID, handle: 'jane' });
      const map = await connectionService.getConnectionMap(USER_A);
      return !!map.whatsapp && !!map.telegram;
    });

    // ── 3. The code store against real Redis ───────────────────────────────
    console.log('\n▶ The code store');

    const issued = await connectionCodeStore.issue({
      channel: 'whatsapp',
      externalIdentity: 'verify-conn-237611110000',
      displayName: 'Fixture',
    });

    await assert('issue returns a 6-character code', () => issued.code.length === 6);

    await assert('the key outlives the code: TTL + grace, so expiry stays explicable', async () => {
      const redis = await getRedisClient(CONNECTION_CODE_DB);
      const ttl = await redis.ttl(`connection:code:${issued.code}`);
      const expected = CONNECTION_CODE_TTL_SECONDS + CONNECTION_CODE_GRACE_SECONDS;
      return ttl > expected - 10 && ttl <= expected;
    });

    await assert('the record still expires after the VALIDITY, not the key TTL', () =>
      issued.expiresAt.getTime() - Date.now() <= CONNECTION_CODE_TTL_SECONDS * 1000);

    await assert('a second /connect REVOKES the first code', async () => {
      const second = await connectionCodeStore.issue({
        channel: 'whatsapp',
        externalIdentity: 'verify-conn-237611110000',
      });
      const redis = await getRedisClient(CONNECTION_CODE_DB);
      const firstStillLive = await redis.exists(`connection:code:${issued.code}`);
      const secondLive = await redis.exists(`connection:code:${second.code}`);
      return firstStillLive === 0 && secondLive === 1;
    });

    // ── 4. Single-use, under concurrency ───────────────────────────────────
    console.log('\n▶ Single-use (the atomic-consume guarantee)');

    const raced = await connectionCodeStore.issue({
      channel: 'telegram',
      externalIdentity: 'verify-conn-tg-99999',
      handle: 'racer',
    });

    await assert('two concurrent consumes: exactly ONE wins', async () => {
      const [a, b] = await Promise.all([
        connectionCodeStore.consume(raced.code),
        connectionCodeStore.consume(raced.code),
      ]);
      return [a, b].filter((r) => r.status === 'ok').length === 1
        && [a, b].filter((r) => r.status === 'missing').length === 1;
    });

    await assert('a spent code reads as missing, never as expired', async () =>
      (await connectionCodeStore.consume(raced.code)).status === 'missing');

    // ── 5. The redeem path end to end ──────────────────────────────────────
    console.log('\n▶ Redeem, end to end');

    const forRedeem = await connectionCodeStore.issue({
      channel: 'telegram',
      externalIdentity: 'verify-conn-tg-77777',
      displayName: 'Redeemer',
      handle: 'redeemer',
    });

    await assert('a LOWERCASE code redeems (normalization runs on the read side)', async () => {
      const c = await connectionService.redeemCode(USER_B, forRedeem.code.toLowerCase());
      return c.external_id === 'verify-conn-tg-77777' && c.handle === 'redeemer';
    });

    await assert('replaying the same code is refused', async () => {
      try {
        await connectionService.redeemCode(USER_B, forRedeem.code);
        return false;
      } catch (err) {
        return (err as { code?: string }).code === 'CONNECTION_CODE_INVALID';
      }
    });

    await assert('redeeming an identity owned by someone else is refused', async () => {
      const taken = await connectionCodeStore.issue({
        channel: 'telegram',
        externalIdentity: 'verify-conn-tg-77777',
      });
      try {
        await connectionService.redeemCode(USER_A, taken.code);
        return false;
      } catch (err) {
        return (err as { code?: string }).code === 'MESSAGING_IDENTITY_ALREADY_LINKED';
      }
    });

    await assert('disconnect removes it, and a second disconnect 404s', async () => {
      await connectionService.disconnect(USER_B, 'telegram');
      try {
        await connectionService.disconnect(USER_B, 'telegram');
        return false;
      } catch (err) {
        return (err as { code?: string }).code === 'MESSAGING_CONNECTION_NOT_FOUND';
      }
    });

    // ── 6. Expired vs invalid, against real key TTLs ───────────────────────
    console.log('\n▶ Expired is distinguishable from invalid');

    await assert('a code past expiresAt answers EXPIRED, not INVALID', async () => {
      // Plant a record that is already past its validity but still inside the grace
      // window — exactly the state a slow user's code is in. Hand-written rather than
      // waiting 10 minutes for a real one.
      const redis = await getRedisClient(CONNECTION_CODE_DB);
      const code = 'ZZ9Y8X';
      const past = new Date(Date.now() - 60_000).toISOString();
      await redis.set(
        `connection:code:${code}`,
        JSON.stringify({
          channel: 'whatsapp',
          externalIdentity: 'verify-conn-expired-1',
          createdAt: past,
          expiresAt: past,
        }),
        { EX: 120 }
      );

      try {
        await connectionService.redeemCode(USER_A, code);
        return false;
      } catch (err) {
        return (err as { code?: string }).code === 'CONNECTION_CODE_EXPIRED';
      }
    });

    await assert('an expired code is SPENT by the attempt — the grace explains once', async () => {
      const redis = await getRedisClient(CONNECTION_CODE_DB);
      return (await redis.exists('connection:code:ZZ9Y8X')) === 0;
    });

    await assert('a code that never existed answers INVALID', async () => {
      try {
        await connectionService.redeemCode(USER_A, 'QQ7W6E');
        return false;
      } catch (err) {
        return (err as { code?: string }).code === 'CONNECTION_CODE_INVALID';
      }
    });

    // ── 7. The /connect command, end to end ────────────────────────────────
    console.log('\n▶ /connect (Phase 4)');

    await assert('WhatsApp /connect mints a code against the context sender', async () => {
      const result = await connectHandler(
        { name: 'Fixture' },
        { source: 'whatsapp', wa_phone_id: 'verify-conn-237655550000' }
      );
      return result.success
        && result.channel === 'whatsapp'
        && /^[0-9A-HJKMNP-TV-Z]{6}$/.test(result.code)
        && result.message.includes(result.code);
    });

    await assert('Telegram /connect mints against the chat id, and it redeems', async () => {
      const result = await connectHandler(
        { name: 'Fixture', username: 'fixture' },
        { source: 'telegram', chat_id: 'verify-conn-tg-31415' }
      );
      const connection = await connectionService.redeemCode(USER_A, result.code);
      return connection.external_id === 'verify-conn-tg-31415'
        && connection.handle === '@fixture';
    });

    await assert('a second /connect invalidates the first code (Phase 4 rule)', async () => {
      const first = await connectHandler(
        {},
        { source: 'whatsapp', wa_phone_id: 'verify-conn-237655551111' }
      );
      const second = await connectHandler(
        {},
        { source: 'whatsapp', wa_phone_id: 'verify-conn-237655551111' }
      );

      const redis = await getRedisClient(CONNECTION_CODE_DB);
      const firstGone = (await redis.exists(`connection:code:${first.code}`)) === 0;
      const secondLive = (await redis.exists(`connection:code:${second.code}`)) === 1;
      return firstGone && secondLive && first.code !== second.code;
    });

    // ── 8. The attempt limiter ─────────────────────────────────────────────
    console.log('\n▶ The attempt limiter');

    await assert('the 6th attempt in a window is refused', async () => {
      const probe = new mongoose.Types.ObjectId().toString();
      const verdicts: boolean[] = [];
      for (let i = 0; i < 6; i++) verdicts.push(await connectionCodeStore.recordAttempt(probe));
      const redis = await getRedisClient(CONNECTION_CODE_DB);
      await redis.del(`connection:attempts:${probe}`);
      return verdicts.slice(0, 5).every(Boolean) && verdicts[5] === false;
    });
  } finally {
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
  console.error('verify:connections crashed:', err);
  process.exit(1);
});
