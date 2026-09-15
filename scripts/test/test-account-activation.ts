/**
 * Test: self-service account activation (owner decision, 2026-09-15).
 *
 * Follows the scripts/test convention — plain ts-node, hand-rolled asserts, no framework.
 * DB-free: the rule is a pure predicate plus a Mongo filter fragment, which is exactly why
 * it was put in `core/accounts/activation.ts` rather than inlined in three repositories.
 *
 * ── What this suite is really protecting ─────────────────────────────────────
 *
 * Two of its groups are SOURCE SCANS, and they cover the failures that behaviour cannot:
 *
 *   - **Three repositories, one rule.** Vendor, agency and agent each promote themselves,
 *     and before this change they had three different answers to "when is an account
 *     active?" — the vendor on email, the other two never. A copy of the filter in each
 *     repository would drift back into that within a release, and the drift is invisible:
 *     each collection keeps working, they just disagree.
 *
 *   - **Promotion only, and only out of `pending_verification`.** If the filter ever loses
 *     that clause, a suspended account lifts its own suspension by re-proving a number it
 *     already holds. Nothing throws, no request fails, and the administrator who suspended
 *     them is not told. This is the same trap `VendorRepository.markEmailVerified` was
 *     rewritten to close once before.
 *
 * Run: npm run test:account-activation
 */
import fs from 'fs';
import path from 'path';
import {
  ACTIVATION_ELIGIBLE_FROM,
  ACTIVATION_TARGET,
  activationFilter,
  meetsActivationFundamentals,
} from '../../src/core/accounts/activation';
import { SELF_ACTIVATING_ROLES } from '../../src/modules/users/services/account-activation.service';

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

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

/** The three repositories that must promote, and the name column each one keys on. */
const ROLE_REPOS: Array<{ role: string; file: string; nameField: string }> = [
  { role: 'vendor', file: 'modules/vendors/vendor.repository.ts', nameField: 'display_name' },
  { role: 'agency', file: 'modules/delivery/delivery-agency.repository.ts', nameField: 'display_name' },
  { role: 'agent', file: 'modules/agents/repositories/agent.repository.ts', nameField: 'name' },
];

function main(): void {
  console.log('\n── The rule: a proved phone and a name ─────────────────────────────────\n');

  assert('both proofs together activate', () =>
    meetsActivationFundamentals({ phoneVerified: true, name: 'Ulrich' }));

  assert('a name without a proved phone does NOT', () =>
    !meetsActivationFundamentals({ phoneVerified: false, name: 'Ulrich' }));

  assert('a proved phone without a name does NOT', () =>
    !meetsActivationFundamentals({ phoneVerified: true, name: null }));

  /**
   * ⚠ `phone_verified` is `false` by default but `undefined` on a projection that omits it.
   * A truthiness test treats both as "not verified", which is right; an `!== false` test
   * would activate on a missing field, which is very wrong.
   */
  assert('a MISSING phone_verified is not a proved one', () =>
    !meetsActivationFundamentals({ phoneVerified: undefined, name: 'Ulrich' })
    && !meetsActivationFundamentals({ phoneVerified: null, name: 'Ulrich' }));

  assert('whitespace is not a name', () =>
    !meetsActivationFundamentals({ phoneVerified: true, name: '   ' }));

  assert('an empty name is not a name', () =>
    !meetsActivationFundamentals({ phoneVerified: true, name: '' }));

  console.log('\n── The filter carries the WHOLE rule, so the write is atomic ───────────\n');

  const filter = activationFilter('display_name') as Record<string, unknown>;

  assert('it pins the source status — promotion, never a blanket write', () =>
    filter.status === ACTIVATION_ELIGIBLE_FROM && ACTIVATION_ELIGIBLE_FROM === 'pending_verification');

  assert('it requires the proved phone', () => filter.phone_verified === true);

  /**
   * `$nin: [null, '']` rather than `$exists`. A name never set is `null`; a name cleared
   * through a PATCH is `''`. `$exists` is true for both, so it would activate an account
   * with no name at all — the one condition the owner named alongside the phone.
   */
  assert('it rejects both spellings of "no name"', () => {
    const clause = filter.display_name as { $nin?: unknown[] };
    return Array.isArray(clause?.$nin) && clause.$nin.includes(null) && clause.$nin.includes('');
  });

  assert('the name column is the caller’s, never guessed', () =>
    'name' in (activationFilter('name') as Record<string, unknown>)
    && !('display_name' in (activationFilter('name') as Record<string, unknown>)));

  assert('the target is active', () => ACTIVATION_TARGET === 'active');

  console.log('\n── SOURCE SCAN: three repositories, ONE rule ──────────────────────────\n');

  for (const { role, file, nameField } of ROLE_REPOS) {
    const source = read(file);
    const code = stripComments(source);

    assert(`${role} exposes activateIfFundamentalsMet`, () =>
      /async activateIfFundamentalsMet\s*\(/.test(code));

    // A literal `includes` rather than a built RegExp: `nameField` is a constant from the
    // table above, but the ESLint ban on bare `new RegExp()` is blanket for a good reason
    // and a test file is not the place to argue for an exception.
    assert(`${role} builds its filter from the shared rule`, () =>
      code.includes(`activationFilter('${nameField}')`));

    /**
     * The filter is shared; the literal would not be. A repository that writes
     * `status: 'active'` by hand is one edit away from disagreeing with the other two about
     * what "active" is even called.
     */
    assert(`${role} writes the shared target constant, not a literal`, () => {
      const body = code.slice(code.indexOf('async activateIfFundamentalsMet'));
      const method = body.slice(0, body.indexOf('\n  }') + 4);
      return method.includes('ACTIVATION_TARGET') && !/status:\s*'active'/.test(method);
    });
  }

  console.log('\n── SOURCE SCAN: nothing else promotes, and nothing demotes ────────────\n');

  /**
   * ⚠ The vendor's email path is GONE and must stay gone. It was the only self-service
   * activation that existed, and leaving it in place alongside the new rule would mean
   * vendors activate on either proof while agencies and agents need the phone — the exact
   * three-different-answers state this change was made to end.
   */
  assert('markEmailVerified no longer promotes a vendor', () => {
    const code = stripComments(read('modules/vendors/vendor.repository.ts'));
    const start = code.indexOf('async markEmailVerified');
    const body = code.slice(start, start + 400);
    return start !== -1 && !body.includes('status');
  });

  assert('no role repository writes status: inactive on a verification path', () => {
    for (const { file } of ROLE_REPOS) {
      const code = stripComments(read(file));
      const start = code.indexOf('async activateIfFundamentalsMet');
      if (start === -1) return false;
      if (/status:\s*'(inactive|suspended)'/.test(code.slice(start, start + 600))) return false;
    }
    return true;
  });

  /**
   * ⚠ The agency's administrative approval must NOT write the account status. That fusion —
   * one endpoint answering both "is this business real" and "may this account operate" — is
   * what this change separated, and re-adding the status write would quietly restore it.
   */
  assert('agency approval writes the verdict, never the account status', () => {
    const code = stripComments(read('modules/delivery/delivery-agency.repository.ts'));
    // ⚠ Renamed from markVerifiedIfPending / rejectIfPending on 2026-09-15: the predicate
    // stopped being "is it pending" and became "is it not already this verdict", so the old
    // names described a filter that no longer exists (BR-026 § 2). The property asserted
    // here is unchanged — approval writes the verdict and never the account status.
    const start = code.indexOf('async markVerifiedIfNotVerified');
    const end = code.indexOf('async rejectIfNotRejected');
    if (start === -1 || end === -1) return false;
    const body = code.slice(start, end);
    return body.includes("'kyc_details.status': 'verified'") && !/status:\s*'active'/.test(body);
  });

  console.log('\n── The service: which roles, and how it fails ─────────────────────────\n');

  assert('exactly vendor, agency and agent self-activate', () =>
    [...SELF_ACTIVATING_ROLES].sort().join(',') === 'agency,agent,vendor');

  /**
   * A customer's `status` gates nothing today. Including them would be a behaviour change
   * dressed as consistency — and their phone arrives observed by the bot rather than proved
   * by an OTP, which is a different quality of evidence.
   */
  assert('customer is deliberately excluded', () =>
    !(SELF_ACTIVATING_ROLES as readonly string[]).includes('customer'));

  /**
   * Activation follows a proof; it is not the proof. A throw here would cost the person the
   * OTP they just spent, because the code is consumed before this runs.
   */
  assert('a failing role is caught, so a spent proof is never lost', () => {
    const code = stripComments(read('modules/users/services/account-activation.service.ts'));
    return /try\s*\{/.test(code) && /catch\s*\(/.test(code);
  });

  assert('the proof funnel evaluates activation', () => {
    const code = stripComments(read('modules/users/services/contact-change.service.ts'));
    return /this\.activation\.activateEligibleRoles\(user\)/.test(code);
  });

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log(`${'─'.repeat(60)}\n`);

  if (failed > 0) process.exit(1);
}

main();
