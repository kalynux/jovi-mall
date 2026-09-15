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

/**
 * The FILTER argument of a `findOneAndUpdate`, and nothing else.
 *
 * Both writers legitimately `$set` the verdict as an equality, so any scan looking for an
 * equality *predicate* must see the filter alone. Matched on the `_id:` term, which appears
 * once per method and only in the filter.
 */
function filterOf(methodSource: string): string {
  return methodSource.split('\n').find((line) => line.includes('_id: agencyId')) ?? '';
}

/** An equality on the verdict axis, in whichever of the three values it names. */
function equalityOnVerdict(filter: string): boolean {
  return ['pending', 'verified', 'rejected'].some((verdict) =>
    filter.includes(`'kyc_details.status': '${verdict}'`));
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
  const verifyBody = methodBody(repoCode, 'markVerifiedIfNotVerified');
  const rejectBody = methodBody(repoCode, 'rejectIfNotRejected');

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

  console.log('\n── Both verdicts are a compare-and-set on the REVIEW axis ──────────────\n');

  /**
   * ⚠ **This group has been wrong once, in a way a passing suite CONCEALED, and the
   * history is the reason it is written the way it is now.**
   *
   * It first required the CAS to filter on the top-level `status: 'pending_verification'`,
   * correct only while that field doubled as the review queue — administrative approval
   * was the only thing that ever set an agency `active`.
   *
   * On 2026-09-15 agencies began activating themselves on a proved phone
   * (`core/accounts/activation.ts`), so an agency awaiting review is routinely `active` and
   * the old filter would have matched none of them. The axis move to `kyc_details.status`
   * was right. **Writing it as an equality on `'pending'` was not**, and these assertions
   * were updated to require that equality — so the suite went green over a defect that made
   * the first verdict of either kind FINAL: a refused agency read `'rejected'`, approval's
   * filter missed, and the re-review loop this very file asserts at the bottom ("There is
   * deliberately no un-reject") could not run. admin-dash found it by reading the two
   * predicates side by side (BR-026 § 2); nothing here could have, because the assertion
   * had been rewritten to match the code rather than the intent.
   *
   * ⚠ **So these now pin the PROPERTY, not the literal.** Each predicate must refuse a
   * REPEAT of the verdict its own method writes and admit every other state — which is what
   * makes re-review work, and what `$ne` also buys on a document carrying no `kyc_details`
   * at all. An equality on any single value is the shape of the bug, and is refused by name
   * below so that restoring it cannot go green.
   */
  assert('approval refuses a repeat of ITS OWN verdict, not everything but pending', () =>
    filterOf(verifyBody).includes("'kyc_details.status': { $ne: 'verified' }"));

  assert('rejection refuses a repeat of its own verdict, mirrored', () =>
    filterOf(rejectBody).includes("'kyc_details.status': { $ne: 'rejected' }"));

  /**
   * The regression that shipped on 2026-09-15, named so it cannot return quietly: an
   * equality on the verdict axis is one-verdict-ever, whichever value it names.
   *
   * ⚠ Scanned over `filterOf` rather than the method body, and that is not a detail. The
   * `$set` legitimately writes `'kyc_details.status': 'verified'` — a body-wide scan for an
   * equality therefore fails on correct code, which is how the first draft of this
   * assertion reported the bug it was written to catch as still present after the fix.
   */
  assert('neither verdict is gated on an EQUALITY — that is the one-verdict-ever bug', () =>
    !equalityOnVerdict(filterOf(verifyBody)) && !equalityOnVerdict(filterOf(rejectBody)));

  /**
   * The loop stated at the bottom of this file, asserted where it is actually decided:
   * approval must ADMIT a rejected agency, or re-review is unreachable.
   */
  assert('a REFUSED agency is approvable — the documented re-review loop', () =>
    !filterOf(verifyBody).includes("$ne: 'rejected'"));

  assert('neither verdict is filtered on the account status any more', () =>
    !verifyBody.includes("status: 'pending_verification'")
    && !rejectBody.includes("status: 'pending_verification'"));

  // Losing a race must be reported, not silently applied over the winner.
  assert('the service answers 409 on a rejection CAS miss', () => {
    const body = methodBody(service, 'reject');
    return body.includes('DELIVERY_AGENCY_VERIFICATION_CONFLICT') && body.includes('409');
  });

  /**
   * ⚠ Renamed from `DELIVERY_AGENCY_STATUS_CONFLICT` on 2026-09-15 (BR-026 § 3) because the
   * predicate had stopped touching `status` while the code's name went on pointing there.
   * Pinned in the negative as well: the old name reappearing means somebody reverted the
   * rename without reverting the reason for it.
   */
  assert('…under a code that names the VERDICT, not the account status', () =>
    !service.includes('DELIVERY_AGENCY_STATUS_CONFLICT'));

  assert('…and distinguishes it from a 404, which is a different remedy', () => {
    const body = methodBody(service, 'reject');
    return body.includes('DELIVERY_AGENCY_NOT_FOUND') && body.includes('404');
  });

  console.log('\n── NEITHER verdict touches the account status any more ─────────────────\n');

  /**
   * ⚠ **The asymmetry this group used to assert is GONE, deliberately (2026-09-15).**
   * Approval wrote `status: 'active'` and rejection wrote nothing; now neither writes the
   * top-level status at all, because whether an account may operate is the account holder's
   * question (prove a phone) and whether a business is vetted is an administrator's. One
   * endpoint answering both is what made an agency that had proved everything about itself
   * wait on a review queue to trade.
   *
   * Writing `status: 'inactive'` on a refusal remains wrong for the original reason: it
   * would run the deactivation cascade's territory without its transaction, its product
   * suspensions or its restore path.
   *
   * ⚠ **What a refusal now costs an agency is NARROWER than it was, and this is the thing to
   * re-read before changing either side.** A rejected agency that has proved a phone is
   * `active`, so pickup resolution, product activation and vendor default-agency selection
   * accept it — where previously it was refused by all three for sitting at
   * `pending_verification`. What it cannot do is take cash: `CodEligibilityService` tests
   * `kyc_details.legit_verified` explicitly, which is why that check had to be added in the
   * same change rather than left to `status`.
   */
  assert('rejectIfNotRejected never writes the top-level status', () => !/\bstatus:\s*'(active|inactive)'/.test(rejectBody));

  assert('markVerifiedIfNotVerified no longer writes the top-level status either', () =>
    !/\bstatus:\s*'(active|inactive)'/.test(verifyBody));

  assert('activation is a separate, self-service write', () => {
    const repoSource = read('modules/delivery/delivery-agency.repository.ts');
    return /async activateIfFundamentalsMet\b/.test(repoSource)
      && methodBody(repoSource, 'activateIfFundamentalsMet').includes('activationFilter(');
  });

  /**
   * Matched on the CODE form (`!agency.kyc_details?.legit_verified`) rather than the bare
   * field name, which also appears in that file's prose explaining why the check is there.
   * A scan that a comment can satisfy is a scan that passes after somebody deletes the line.
   */
  assert('COD refuses an agency the administrator has not verified', () =>
    /!agency\.kyc_details\?\.legit_verified/.test(read('modules/cod/services/cod-eligibility.service.ts')));

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
   * Re-review is `verify` again: the approval predicate ADMITS a rejected agency, so it
   * accepts them once they fix what the reason named. An `unreject` verb would be a second
   * way to reach a state that already has one.
   *
   * ⚠ **This paragraph read "rejection leaves the agency pending" until 2026-09-15, and by
   * then it was doubly false** — rejection writes `'rejected'` on the verdict axis, and the
   * agency's `status` is whatever its own phone verification made it. The loop it describes
   * was unreachable for as long as that predicate stood while this sentence went on
   * asserting it, and these two
   * assertions passed throughout: absence of an `unreject` verb is not evidence that the
   * path it would have replaced works. That is now asserted above, where it is decided.
   */
  assert('no unreject/clear-rejection verb exists on the router', () =>
    !/unreject|clear-rejection|un-reject/i.test(routes));

  assert('no unreject method exists on the repository', () => !/unreject/i.test(repoCode));

  console.log('\n── The vendor twin: one rule, two roles ───────────────────────────────\n');

  /**
   * ⚠ **This group is about VENDORS and lives in the agency file on purpose.**
   *
   * Since 2026-09-15 the two roles answer the same question the same way — refuse a REPEAT
   * of a verdict, admit everything else — and the failure this guards is one drifting from
   * the other, which no single-role suite can see. The two arrived from opposite directions
   * and each was missing the other's half: the agency had an atomic predicate enforcing the
   * wrong rule, and the vendor had the right rule enforced non-atomically, as a read and a
   * comparison in the service followed by an unpredicated write.
   *
   * The vendor's own history is the argument for pinning the mechanism rather than the
   * behaviour. A read-then-write refuses a second administrator only when the two are far
   * enough apart in time; two opposite verdicts in the same instant both read the old value,
   * both passed the check and both wrote. Nothing observable distinguished that from the
   * guarded version until it happened, and then the evidence was an audit row in wi-admin
   * claiming a transition that had already been overwritten.
   */
  const vendorRepoCode = stripComments(read('modules/vendors/vendor.repository.ts'));
  const vendorService = stripComments(read('modules/vendors/admin-vendor.service.ts'));
  const vendorVerdictBody = methodBody(vendorRepoCode, 'setKycVerdict');

  assert('the vendor verdict is a compare-and-set, not findByIdAndUpdate', () =>
    vendorVerdictBody.includes('findOneAndUpdate')
    && !vendorVerdictBody.includes('findByIdAndUpdate'));

  assert('…predicated on the verdict being written, so a repeat misses', () =>
    vendorVerdictBody.includes("'kyc_details.status': { $ne: verdict }"));

  assert('…and a rejected vendor is re-verifiable, as a rejected agency is', () =>
    !vendorVerdictBody.includes("$ne: 'rejected'"));

  /**
   * The guard must not ALSO remain in the service. Two copies of one rule is how they drift,
   * and the read-then-compare form would keep answering first — hiding whether the predicate
   * underneath it works at all.
   */
  assert('the service no longer pre-reads to compare the verdict', () =>
    !/const current = vendor\.kyc_details\?\.status/.test(vendorService));

  assert('it answers 409 on the CAS miss, distinguished from a 404', () => {
    const body = methodBody(vendorService, 'setKycVerdict');
    return body.includes('VENDOR_KYC_STATUS_CONFLICT') && body.includes('409');
  });

  console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main();
