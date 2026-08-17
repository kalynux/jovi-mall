/**
 * Test: the password epoch — the mechanism that makes a password change a revocation.
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no framework).
 * DB-free: the predicate is pure, and the parts that are NOT pure — that the epoch is
 * written with the hash, and that both credential paths read it — are covered by a source
 * scan, for the same reason `test:system` scans for safe execution and `test:vendors` scans
 * for the narrow `=== 'inactive'` form. A predicate nobody calls protects nothing, and that
 * is exactly the state this feature was in before: the invalidation was a `console.log`.
 *
 * Run: npm run test:password-epoch
 */
import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';
import { isTokenPredatingPasswordChange } from '../../src/core/auth/password-epoch';

let passed = 0;
let failed = 0;

function assert(name: string, fn: () => boolean): void {
  let ok = false;
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

/** Seconds, as a JWT's `iat` claim is: whole seconds since the epoch. */
const seconds = (ms: number): number => Math.floor(ms / 1000);

function main(): void {
  console.log('\n▶ No epoch — an account that never changed its password');

  assert('null epoch accepts every token (no backfill needed)', () =>
    isTokenPredatingPasswordChange(seconds(Date.now()) - 999_999, null) === false);
  assert('undefined epoch accepts every token', () =>
    isTokenPredatingPasswordChange(0, undefined) === false);
  assert('a corrupt epoch does not lock anybody out', () =>
    isTokenPredatingPasswordChange(0, new Date('not a date')) === false);

  console.log('\n▶ The eviction — tokens minted under the old password');

  const changedAt = new Date('2026-08-13T10:00:00.500Z');
  const changedAtMs = changedAt.getTime();

  assert('a token from an hour before the change is refused', () =>
    isTokenPredatingPasswordChange(seconds(changedAtMs) - 3600, changedAt) === true);
  assert('a token from one second before the change is refused', () =>
    isTokenPredatingPasswordChange(seconds(changedAtMs) - 1, changedAt) === true);
  assert('a 30-day-old refresh token is refused', () =>
    isTokenPredatingPasswordChange(seconds(changedAtMs) - 2_592_000, changedAt) === true);
  assert('a token from after the change is accepted', () =>
    isTokenPredatingPasswordChange(seconds(changedAtMs) + 1, changedAt) === false);

  console.log('\n▶ The whole-second boundary — the replacement pair must survive');

  // The regression this guards: `password_changed_at` is a millisecond instant while `iat`
  // is a floored second, so a millisecond comparison rejects the caller's own replacement
  // token whenever the change lands part-way through a second — i.e. about always.
  assert('a token minted in the SAME second as the change survives it', () =>
    isTokenPredatingPasswordChange(seconds(changedAtMs), changedAt) === false);
  assert('…even when the change was at .999 of that second', () =>
    isTokenPredatingPasswordChange(
      seconds(changedAtMs),
      new Date(Math.floor(changedAtMs / 1000) * 1000 + 999),
    ) === false);
  assert('…and when the change was exactly on the second', () =>
    isTokenPredatingPasswordChange(
      seconds(changedAtMs),
      new Date(Math.floor(changedAtMs / 1000) * 1000),
    ) === false);
  assert('the second BEFORE is still refused at a .999 change', () =>
    isTokenPredatingPasswordChange(
      seconds(changedAtMs) - 1,
      new Date(Math.floor(changedAtMs / 1000) * 1000 + 999),
    ) === true);

  console.log('\n▶ Undateable tokens fail CLOSED (but only for a changed account)');

  assert('a token with no iat is refused once an epoch exists', () =>
    isTokenPredatingPasswordChange(undefined, changedAt) === true);
  assert('a NaN iat is refused', () =>
    isTokenPredatingPasswordChange(Number.NaN, changedAt) === true);
  assert('a non-numeric iat is refused', () =>
    isTokenPredatingPasswordChange('1755079200' as unknown as number, changedAt) === true);
  assert('…but an account with no epoch is still unaffected by a missing iat', () =>
    isTokenPredatingPasswordChange(undefined, null) === false);

  console.log('\n▶ Against real jsonwebtoken output, in the real order');

  // The exact sequence the change performs: stamp the epoch, then mint the caller's
  // replacement pair. The old pair was minted before it.
  const oldPair = jwt.sign({ userId: 'u1', role: 'vendor' }, 'test-secret', { expiresIn: 900 });
  const oldIat = (jwt.decode(oldPair) as { iat: number }).iat;
  const stampedAt = new Date();
  const newPair = jwt.sign({ userId: 'u1', role: 'vendor' }, 'test-secret', { expiresIn: 900 });
  const newIat = (jwt.decode(newPair) as { iat: number }).iat;

  assert('jsonwebtoken stamps an iat without being asked', () => typeof oldIat === 'number');
  assert("the caller's replacement token survives its own password change", () =>
    isTokenPredatingPasswordChange(newIat, stampedAt) === false);
  // Same-second minting means the old token can legitimately survive here; what must never
  // happen is the reverse — a token minted a second earlier than the stamp being accepted.
  assert('a token minted a second before the stamp is refused', () =>
    isTokenPredatingPasswordChange(oldIat - 1, stampedAt) === true);

  console.log('\n▶ The wiring — a predicate nobody calls protects nothing');

  const repository = read('modules/users/user.repository.ts');
  const middleware = read('api/middlewares/auth.middleware.ts');
  const authService = read('modules/auth/auth.service.ts');
  const userService = read('modules/users/user.service.ts');

  // One $set, never two: a hash that lands without its stamp leaves the new password live
  // and every old token working, which is the defect the stamp exists to close.
  assert('updatePassword writes hash and epoch in ONE $set', () =>
    /\$set:\s*\{[^}]*password_hash[^}]*password_changed_at[^}]*\}/s.test(repository));

  assert('requireAuth gates the ACCESS token on the epoch', () =>
    middleware.includes('isTokenPredatingPasswordChange('));
  assert('rotateRefreshToken gates the REFRESH token on the epoch', () =>
    authService.includes('isTokenPredatingPasswordChange('));
  assert('both raise AUTH_PASSWORD_CHANGED', () =>
    middleware.includes('AUTH_PASSWORD_CHANGED') && authService.includes('AUTH_PASSWORD_CHANGED'));

  // The check has to sit AFTER the user row is loaded — the epoch lives on it.
  assert('the middleware check follows the user load', () =>
    middleware.indexOf('userRepo.findById') < middleware.indexOf('isTokenPredatingPasswordChange('));
  assert('the refresh check follows the user load', () =>
    authService.indexOf('this.userRepo.findById(payload.userId)')
      < authService.indexOf('isTokenPredatingPasswordChange('));

  assert('changePassword no longer stubs session invalidation', () =>
    !/TODO:\s*Invalidate/i.test(userService));

  console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main();
