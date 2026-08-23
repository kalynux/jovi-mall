/**
 * Test: the agency business-verification lifecycle.
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no framework).
 * DB-free — the write itself is one Mongoose compare-and-set, so what is assertable here
 * is the SHAPE of the decision: the schema, the validator, and the structural rules that
 * keep the verdict and its boolean projection from ever disagreeing.
 *
 * ── What this guards ─────────────────────────────────────────────────────────
 * Before Phase 6 Step 4, `kyc_details.legit_verified: false` meant BOTH "never reviewed"
 * and "reviewed and refused". A review queue is unbuildable over a field with that
 * ambiguity, and the agency was never told what to fix. The verdict removes it — and the
 * two must be written together, or the ambiguity comes back in a worse form: a `verified`
 * verdict beside a `false` boolean.
 *
 * The source scans are the spine, for the reason the vendor lifecycle gives: both fields
 * live behind repository methods precisely so no caller can `$set` one alone, and nothing
 * behavioural can see the difference between "written together" and "written in two
 * statements that happen to both run".
 *
 * Run: npm run test:agency-kyc
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { AdminRejectAgencyKycSchema } from '../../src/modules/delivery/validators/admin-agency.validator';

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

const SRC = join(__dirname, '..', '..', 'src');
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const model = read('modules/delivery/delivery-agency.model.ts');
const repo = read('modules/delivery/delivery-agency.repository.ts');
const repoCode = stripComments(repo);
const service = stripComments(read('modules/delivery/services/admin-agency.service.ts'));
const routes = stripComments(read('modules/delivery/admin-agency.routes.ts'));
const dto = stripComments(read('modules/delivery/dto/admin-agency.dto.ts'));

/**
 * The body of one method, for scans that must not see its neighbours.
 *
 * ⚠ The indent width is NOT fixed across this codebase — the repository files use two
 * spaces and the delivery services use four. A helper hardcoding one of them silently
 * runs past the end of the method into the next one, which is how the "rejection is not
 * a transaction" scan first read `deactivate`'s `runInTransaction` and reported a
 * failure that did not exist. Match either.
 */
function methodBody(source: string, name: string): string {
  const start = source.indexOf(`async ${name}(`);
  if (start === -1) return '';
  const after = source.slice(start + 1);
  const nextMethod = after.search(/\n {2,4}(?:async \w+\(|\/\*\*)/);
  return nextMethod === -1 ? after : after.slice(0, nextMethod);
}

function main(): void {
  console.log('\n── The verdict exists, beside its boolean projection ───────────────────\n');

  assert('the KYC block carries a three-value status', () =>
    /enum:\s*\['pending',\s*'verified',\s*'rejected'\]/.test(model));

  assert('it defaults to pending — an unreviewed agency is not a refused one', () => {
    const idx = model.indexOf("enum: ['pending', 'verified', 'rejected']");
    return idx > -1 && /default:\s*'pending'/.test(model.slice(idx, idx + 200));
  });

  assert('a rejection reason is storable and bounded', () =>
    /rejection_reason:\s*\{[^}]*maxlength:\s*500/.test(model));

  assert('the default sub-document names both new fields', () => {
    const idx = model.indexOf('registration_number: null');
    const block = model.slice(idx, idx + 300);
    return block.includes("status: 'pending'") && block.includes('rejection_reason: null');
  });

  assert('the interface exposes the verdict type', () =>
    model.includes("export type AgencyKycStatus = 'pending' | 'verified' | 'rejected'"));

  console.log('\n── The two are written TOGETHER, never apart ───────────────────────────\n');

  // This is the rule the vendor model states and the reason both writes are repository
  // methods. A caller able to $set one alone can produce `verified` beside `false`.
  const verifyBody = methodBody(repoCode, 'markVerifiedIfPending');
  const rejectBody = methodBody(repoCode, 'rejectIfPending');

  assert('approval writes the verdict AND the boolean', () =>
    verifyBody.includes("'kyc_details.status': 'verified'")
    && verifyBody.includes("'kyc_details.legit_verified': true"));

  assert('rejection writes the verdict AND the boolean', () =>
    rejectBody.includes("'kyc_details.status': 'rejected'")
    && rejectBody.includes("'kyc_details.legit_verified': false"));

  assert('approval clears any earlier rejection reason', () =>
    verifyBody.includes("'kyc_details.rejection_reason': null"));

  assert('rejection clears verified_at — an approval that stood is not still standing', () =>
    rejectBody.includes("'kyc_details.verified_at': null"));

  assert('both stamp the reviewer through actorStamp, not by hand', () =>
    verifyBody.includes("actorStamp('kyc_details.verified_by'")
    && rejectBody.includes("actorStamp('kyc_details.verified_by'"));

  console.log('\n── Both verdicts are a compare-and-set on the same status ──────────────\n');

  assert('approval is filtered on pending_verification', () =>
    verifyBody.includes("status: 'pending_verification'"));

  assert('rejection is filtered on pending_verification too', () =>
    rejectBody.includes("status: 'pending_verification'"));

  // Losing a race must be reported, not silently applied over the winner.
  assert('the service answers 409 on a rejection CAS miss', () => {
    const body = methodBody(service, 'reject');
    return body.includes('DELIVERY_AGENCY_STATUS_CONFLICT') && body.includes('409');
  });

  assert('…and distinguishes it from a 404, which is a different remedy', () => {
    const body = methodBody(service, 'reject');
    return body.includes('DELIVERY_AGENCY_NOT_FOUND') && body.includes('404');
  });

  console.log('\n── Rejection changes NO status, which is what makes it safe ────────────\n');

  /**
   * The load-bearing property of this whole step. A rejected agency stays at
   * `pending_verification`, where product activation, pickup resolution, COD eligibility
   * and vendor default-agency selection already refuse it. Writing `status: 'inactive'`
   * instead would silently run the deactivation cascade's territory without its
   * transaction, its product suspensions or its restore path.
   */
  assert('rejectIfPending never writes the top-level status', () => !/\bstatus:\s*'(active|inactive)'/.test(rejectBody));

  assert('approval DOES promote to active — the two are deliberately asymmetric', () =>
    verifyBody.includes("status: 'active'"));

  assert('rejection is not a transaction — it has no cascade to be atomic with', () => {
    const body = methodBody(service, 'reject');
    return !body.includes('runInTransaction');
  });

  console.log('\n── The reason is required, and reaches the agency ──────────────────────\n');

  assert('an empty reason is refused', () => !AdminRejectAgencyKycSchema.safeParse({ reason: '' }).success);

  assert('a whitespace-only reason is refused', () =>
    !AdminRejectAgencyKycSchema.safeParse({ reason: '   ' }).success);

  assert('a one-character reason is refused — it explains nothing', () =>
    !AdminRejectAgencyKycSchema.safeParse({ reason: 'x' }).success);

  assert('a real reason is accepted, and trimmed', () => {
    const parsed = AdminRejectAgencyKycSchema.safeParse({ reason: '  Licence expired  ' });
    return parsed.success && parsed.data.reason === 'Licence expired';
  });

  assert('an over-long reason is refused at 500', () =>
    !AdminRejectAgencyKycSchema.safeParse({ reason: 'x'.repeat(501) }).success);

  assert('the schema is strict — an unknown field is a 400, not a silent strip', () =>
    !AdminRejectAgencyKycSchema.safeParse({ reason: 'Licence expired', status: 'rejected' }).success);

  console.log('\n── The verdict reaches the wire ────────────────────────────────────────\n');

  // A verdict nothing can read is a column, not a lifecycle. wi-admin reads
  // `delivery_agencies` directly AND calls these endpoints; both paths need it.
  assert('the admin DTO carries the verdict', () => dto.includes('status: agency.kyc_details?.status'));

  assert('…and the rejection reason', () => dto.includes('rejectionReason: agency.kyc_details?.rejection_reason'));

  assert('a row written before the field existed reads as pending, not rejected', () =>
    /status: agency\.kyc_details\?\.status \?\? 'pending'/.test(dto));

  assert('the reject route is declared', () => routes.includes("router.post('/:id/reject'"));

  assert('it sits beside verify on the same router — one factory, one mount', () =>
    routes.includes("router.post('/:id/verify'") && routes.includes("router.post('/:id/reject'"));

  console.log('\n── There is deliberately no un-reject ──────────────────────────────────\n');

  /**
   * Re-review is `verify` again: rejection leaves the agency pending, so the approval CAS
   * still accepts it once they fix what the reason named. An `unreject` verb would be a
   * second way to reach a state that already has one.
   */
  assert('no unreject/clear-rejection verb exists on the router', () =>
    !/unreject|clear-rejection|un-reject/i.test(routes));

  assert('no unreject method exists on the repository', () => !/unreject/i.test(repoCode));

  console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main();
