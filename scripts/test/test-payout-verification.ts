/**
 * Test: KYC on the payout path — what a reviewer is shown, and that it LIMITS NOTHING.
 *
 * Follows the scripts/test convention — plain ts-node, hand-rolled asserts, no framework.
 * DB-free: the verdict reader is pure, and the rest is source scan.
 *
 * ── The two failures this exists to catch ────────────────────────────────────
 *
 *   - **A verdict misread as approval.** `verificationOf` must fail CLOSED on anything it
 *     does not recognise — a missing field, a projection that omitted it, a status value
 *     added later by another role. The reviewing administrator is shown it, and "verified"
 *     on an account nobody vetted is a lie on the one screen money leaves through.
 *
 *   - **The unverified-payout cap coming back.** From 2026-09-15 an unverified owner could be
 *     limited to an allowance per rolling window (`EARNINGS_UNVERIFIED_PAYOUT_CAP`). The owner
 *     reversed that on 2026-09-27: nobody's earned money is held back for being unverified.
 *     It was DELETED — code, env variable and error code — rather than left at its inert
 *     default of 0, and § "the cap is gone" fails if any part of it reappears.
 *
 * Run: npm run test:payout-verification
 */
import fs from 'fs';
import path from 'path';
import {
  UNKNOWN_VERIFICATION,
  verificationOf,
} from '../../src/core/accounts/verification';
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

  console.log('\n── The cap is gone (owner decision, 2026-09-27) ───────────────────────\n');

  const accounts = read('modules/earnings/services/earnings-account.service.ts');
  const service = read('modules/earnings/services/payout-request.service.ts');
  const repo = read('modules/earnings/repositories/payout-request.repository.ts');

  assert('no config key for an unverified-payout cap or its window', () =>
    !Object.keys(EARNINGS_CONFIG).some((k) => /UNVERIFIED/i.test(k)));

  assert('no source file reads EARNINGS_UNVERIFIED_PAYOUT_*', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts')) {
          const code = fs.readFileSync(full, 'utf8');
          if (/intEnv\(\s*'EARNINGS_UNVERIFIED_PAYOUT|process\.env\.EARNINGS_UNVERIFIED_PAYOUT/.test(code)) offenders.push(full);
        }
      }
    };
    walk(SRC);
    return offenders.length === 0;
  });

  assert('the allowance module is deleted', () =>
    !fs.existsSync(path.join(SRC, 'modules/earnings/domain/payout-allowance.ts')));

  assert('the cap error code is not in the registry', () =>
    !read('core/error-codes.ts').includes('EARNINGS_PAYOUT_UNVERIFIED_CAP_REACHED'));

  /**
   * ⚠ The partial move was the cap's lever into the ledger. With no `maxAmount` a payout can
   * only ever take the WHOLE available balance, so no future cap can hide in a caller.
   */
  assert('the balance move takes no maximum — the whole balance, always', () =>
    !/moveAvailableToRequestedInSession\s*\([^)]*maxAmount/s.test(accounts)
    && /const amount = available;/.test(accounts));

  assert('requestPayout passes no ceiling into the move', () =>
    /moveAvailableToRequestedInSession\(\s*ownerType,\s*ownerId,\s*session\s*\)/s.test(service)
    && !/\bceiling\b/.test(service));

  assert('no windowed paid-sum survives in the repository', () => !repo.includes('sumPaidSince'));

  /**
   * `payoutAllowance` stays on the wire, ALWAYS null, so dashboards that read it keep
   * working. `null` has always meant "no limit".
   */
  assert('the owner-facing view reports payoutAllowance: null for everyone', () => {
    const controllers = ['vendor', 'agency', 'agent'].map((r) =>
      read(`modules/earnings/controllers/${r}-earnings.controller.ts`)
    );
    return controllers.every((c) => c.includes('ownerEarningsView'))
      && service.includes('payoutAllowance: null,');
  });

  /**
   * One read, before the money moves. Resolving it again afterwards could disagree with an
   * approval that landed in between, and the ticket would misreport the owner's standing.
   */
  assert('verification is resolved once, before the money moves', () => {
    const resolved = service.indexOf('const verification = await this.resolveVerification(');
    const moved = service.indexOf('runInTransaction');
    return resolved !== -1 && moved !== -1 && resolved < moved;
  });

  console.log('\n── SOURCE SCAN: the reviewer is actually told ─────────────────────────\n');

  assert('the payout ticket states the KYC verdict', () =>
    service.includes('KYC: verified.') && service.includes('KYC: NOT verified'));

  assert('…and never claims the payout was capped', () =>
    !/CAPPED/.test(service));

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
