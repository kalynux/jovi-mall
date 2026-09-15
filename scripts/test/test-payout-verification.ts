/**
 * Test: KYC on the payout path — what a reviewer is shown, and what an unverified owner is
 * capped at (owner decision, 2026-09-15).
 *
 * Follows the scripts/test convention — plain ts-node, hand-rolled asserts, no framework.
 * DB-free: the verdict reader and the ceiling rule are pure, which is why both were pulled
 * out of the service rather than left inline.
 *
 * ── The two failures this exists to catch ────────────────────────────────────
 *
 *   - **A verdict misread as approval.** `verificationOf` must fail CLOSED on anything it
 *     does not recognise — a missing field, a projection that omitted it, a status value
 *     added later by another role. The cost of the opposite mistake is money leaving the
 *     platform to an account nobody vetted, and nothing would log it.
 *
 *   - **A silently disabled cap.** `payoutCeiling` has two exemptions and a zero-means-off
 *     rule, so there are three separate ways for it to return `null` and cap nothing. All
 *     three are correct and none of them is visible in behaviour — an uncapped payout looks
 *     exactly like a capped one that happened to be under the limit.
 *
 * Run: npm run test:payout-verification
 */
import fs from 'fs';
import path from 'path';
import {
  UNKNOWN_VERIFICATION,
  verificationOf,
} from '../../src/core/accounts/verification';
import { allowanceApplies } from '../../src/modules/earnings/services/payout-request.service';
import { computeAllowance, windowStart } from '../../src/modules/earnings/domain/payout-allowance';
import { EARNINGS_CONFIG } from '../../src/modules/earnings/config/earnings.config';

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

function main(): void {
  console.log('\n── Reading a verdict, and failing closed ───────────────────────────────\n');

  assert('verified is the only value that reads as verified', () =>
    verificationOf({ status: 'verified' }).verified === true);

  for (const status of ['pending', 'rejected', 'unverified']) {
    assert(`${status} does not`, () => verificationOf({ status }).verified === false);
  }

  /**
   * ⚠ "Never reviewed" is not approval. A `verdict !== 'rejected'` test would treat every
   * account nobody has looked at as vetted — which is every account, on a young platform.
   */
  assert('an absent KYC block is unverified, not innocent', () =>
    verificationOf(undefined).verified === false
    && verificationOf(null).verified === false
    && verificationOf({}).verified === false);

  assert('a status this file has not been taught is unverified', () =>
    verificationOf({ status: 'provisional' }).verified === false
    && verificationOf({ status: 'provisional' }).verdict === 'unverified');

  assert('a non-string status cannot slip through', () =>
    verificationOf({ status: null }).verified === false);

  assert('the unknown-owner constant is not verified', () =>
    UNKNOWN_VERIFICATION.verified === false && UNKNOWN_VERIFICATION.verdict === 'unverified');

  /**
   * Each role keeps its own word. Flattening `unverified` and `pending` into one value would
   * lose the distinction an agent's record carries — nothing submitted, versus submitted and
   * waiting — which is exactly what a reviewer needs to know whether to chase documents.
   */
  assert('the role’s own verdict is carried through, not normalised', () =>
    verificationOf({ status: 'pending' }).verdict === 'pending'
    && verificationOf({ status: 'unverified' }).verdict === 'unverified'
    && verificationOf({ status: 'rejected' }).verdict === 'rejected');

  console.log('\n── Whether an allowance applies: three ways to say no ─────────────────\n');

  assert('an unverified manual payout is capped', () =>
    allowanceApplies({ verified: false, origin: 'manual', cap: 250_000 }) === true);

  assert('a verified owner is not capped', () =>
    allowanceApplies({ verified: true, origin: 'manual', cap: 250_000 }) === false);

  /**
   * ⚠ The exemption that matters. `AUTO_PAYOUT_THRESHOLD` exists so the platform never owes
   * an unbounded amount; capping the sweep would leave it owing MORE to precisely the
   * least-vetted accounts, and the nightly run would fail against them for ever with nothing
   * opened to track the exposure.
   */
  assert('the auto-threshold sweep is exempt even when unverified', () =>
    allowanceApplies({ verified: false, origin: 'auto_threshold', cap: 250_000 }) === false);

  assert('a cap of 0 means no cap — the feature is inert by default', () =>
    allowanceApplies({ verified: false, origin: 'manual', cap: 0 }) === false);

  assert('a negative cap from a mistyped env is not a cap either', () =>
    allowanceApplies({ verified: false, origin: 'manual', cap: -5 }) === false);

  assert('the shipped default IS inert', () => EARNINGS_CONFIG.UNVERIFIED_PAYOUT_CAP === 0);

  assert('the default window is 30 days', () =>
    EARNINGS_CONFIG.UNVERIFIED_PAYOUT_WINDOW_DAYS === 30);

  console.log('\n── The allowance: a per-request cap would have bounded nothing ────────\n');

  const HOUR = 3_600_000;
  const base = { cap: 20_000, windowDays: 30 };

  assert('nothing spent leaves the whole allowance', () => {
    const a = computeAllowance({ ...base, used: 0, oldestResolvedAt: null });
    return a.capped && a.remaining === 20_000 && a.used === 0 && a.resetsAt === null;
  });

  /**
   * ⚠ The hole this whole window exists to close. Only ONE payout may be pending at a time,
   * but the moment an administrator marks it paid the owner may open another — so a
   * per-request ceiling let an unverified owner take the cap again, and again, until the
   * balance was gone. The allowance has to be the SUM over the window.
   */
  assert('a second request inside the window draws on the same allowance', () => {
    const a = computeAllowance({ ...base, used: 15_000, oldestResolvedAt: new Date() });
    return a.remaining === 5_000;
  });

  assert('a spent allowance leaves nothing', () =>
    computeAllowance({ ...base, used: 20_000, oldestResolvedAt: new Date() }).remaining === 0);

  /**
   * ⚠ Not defensive padding. `used` can legitimately exceed the cap — the cap can be LOWERED
   * while payouts made under the old one are still inside the window. Unclamped, `remaining`
   * goes negative, and a negative ceiling reads downstream as "no cap": lowering the cap
   * would remove it.
   */
  assert('over-spending (after the cap was lowered) clamps at zero, never negative', () => {
    const a = computeAllowance({ cap: 10_000, windowDays: 30, used: 45_000, oldestResolvedAt: new Date() });
    return a.remaining === 0 && a.capped === true;
  });

  assert('a cap of 0 yields the uncapped shape, not an allowance of zero', () => {
    const a = computeAllowance({ cap: 0, windowDays: 30, used: 0, oldestResolvedAt: null });
    return a.capped === false && a.remaining === 0;
  });

  /**
   * `resetsAt` is when the FIRST tranche frees, not when the whole cap returns — the oldest
   * counted payout leaving the window. A client must not promise the full allowance on it.
   */
  assert('resetsAt is the oldest counted payout plus the window', () => {
    const oldest = new Date(Date.UTC(2026, 8, 1, 12));
    const a = computeAllowance({ ...base, used: 5_000, oldestResolvedAt: oldest });
    return a.resetsAt !== null
      && a.resetsAt.getTime() === oldest.getTime() + 30 * 24 * HOUR;
  });

  assert('windowStart is the trailing edge, not the calendar month', () => {
    const now = new Date(Date.UTC(2026, 8, 15, 0));
    return windowStart(30, now).getTime() === now.getTime() - 30 * 24 * HOUR;
  });

  console.log('\n── SOURCE SCAN: the cap can only work if it reaches the ledger ────────\n');

  const accounts = read('modules/earnings/services/earnings-account.service.ts');
  const service = read('modules/earnings/services/payout-request.service.ts');

  /**
   * The whole reason the cap is a partial move rather than a refusal: refusing would mean an
   * unverified owner who earns more than the cap can withdraw nothing at all, so the more
   * they sell the less of their own money they can touch.
   */
  assert('the balance move accepts a maximum', () =>
    /moveAvailableToRequestedInSession\s*\([^)]*maxAmount/s.test(accounts));

  assert('…and takes the smaller of balance and cap', () =>
    /const capped = maxAmount !== null && maxAmount > 0 && available > maxAmount/.test(accounts)
    && /const amount = capped \? maxAmount : available/.test(accounts));

  assert('a cap below the platform floor is reported as a cap, not as "earn more"', () =>
    /capReason: 'unverified'/.test(accounts));

  assert('requestPayout passes the ceiling into the move', () =>
    /moveAvailableToRequestedInSession\(\s*ownerType,\s*ownerId,\s*session,\s*ceiling\s*\)/s.test(service));

  assert('the allowance is summed over PAID requests only', () => {
    const repo = read('modules/earnings/repositories/payout-request.repository.ts');
    const start = repo.indexOf('async sumPaidSince');
    const body = repo.slice(start, start + 900);
    return start !== -1 && body.includes("status: 'paid'") && body.includes('resolved_at: { $gte: since }');
  });

  assert('an exhausted allowance is refused with its own code, not "below minimum"', () =>
    service.includes('EARNINGS_PAYOUT_UNVERIFIED_CAP_REACHED')
    && service.includes("reason: 'allowance_spent'")
    && service.includes("reason: 'remainder_below_minimum'"));

  assert('the owner-facing view carries the allowance', () => {
    const controllers = ['vendor', 'agency', 'agent'].map((r) =>
      read(`modules/earnings/controllers/${r}-earnings.controller.ts`)
    );
    return controllers.every((c) => c.includes('ownerEarningsView'))
      && service.includes('payoutAllowance: allowance.capped ? describeAllowance(allowance) : null');
  });

  /**
   * One read, used for both the cap and the ticket line. Resolving it twice would let the two
   * disagree if an approval landed in between, and the ticket would then explain a cap that
   * was not applied.
   */
  assert('verification is resolved once, before the money moves', () => {
    const resolved = service.indexOf('const verification = await this.resolveVerification(');
    const moved = service.indexOf('runInTransaction');
    return resolved !== -1 && moved !== -1 && resolved < moved;
  });

  console.log('\n── SOURCE SCAN: the reviewer is actually told ─────────────────────────\n');

  assert('the payout ticket states the KYC verdict', () =>
    service.includes('KYC: verified.') && service.includes('KYC: NOT verified'));

  assert('…and says so when the payout was capped', () =>
    /This payout was CAPPED at/.test(service));

  const dto = read('modules/earnings/dto/admin-payout-request.dto.ts');

  assert('the admin DTO carries the verification', () =>
    /verification:\s*\{\s*verified: verification\.verified,\s*verdict: verification\.verdict\s*\}/.test(dto));

  /**
   * ⚠ The default matters. `toAdminPayoutRequestDto` is called from more than one place, and
   * a caller that forgets the argument must produce "unverified", never a crash and never a
   * silently truthy object.
   */
  assert('a caller that omits it gets unverified, not undefined', () =>
    /verification: OwnerVerification = UNKNOWN_VERIFICATION/.test(dto));

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log(`${'─'.repeat(60)}\n`);

  if (failed > 0) process.exit(1);
}

main();
