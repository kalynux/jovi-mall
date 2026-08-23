/**
 * Test: reviews & ratings — the two subjects, the moderation pipeline, and the one
 * path a delivery rating reaches an agent's trust score by.
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no
 * framework). DB-free: the domain half of this module is pure by construction, and
 * everything that is not is asserted by SOURCE SCAN.
 *
 * Four groups, and the last two are the ones that matter most:
 *
 *   1. The pure domain — the target matrix, the publish-vs-hold rule, the average.
 *   2. The projections — a review's DTO carries no author identity; a zero-count
 *      aggregate projects to `null` and never to `{ average: 0, count: 0 }`, which
 *      is what keeps `aggregateRating` out of the storefront's JSON-LD.
 *   3. SOURCE SCANS proving the WIRING, because these are structural invariants no
 *      behavioural test can see: exactly one writer of `review_aggregates`, exactly
 *      one reader of it in the trust collector, a compare-and-set on the moderation
 *      verdict, no public route to a delivery review, and a unique index that is
 *      registered as a real migration rather than left to `autoIndex`.
 *   4. The cross-module contract with the trust composite — that `collectSignals`
 *      reports `null` rather than `0` for an unrated agent, which is the difference
 *      between "we do not know" and "everybody rated them one star".
 *
 * Run: npm run test:reviews
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  averageOf,
  initialStatusOf,
  roleMayReview,
  targetsOf,
} from '../../src/modules/reviews/domain/review-targets';
import {
  toAdminReviewDto,
  toAuthorReviewDto,
  toPublicReviewDto,
  toRatingBreakdownDto,
  toRatingSummaryDto,
} from '../../src/modules/reviews/dto/review.dto';
import {
  REVIEW_AUTHOR_ROLES,
  REVIEW_STATUSES,
  REVIEW_SUBJECT_TYPES,
  IReview,
} from '../../src/modules/reviews/models/review.model';
import { ratingFactor } from '../../src/modules/agents/domain/services/agent-trust.service';
import { AGENT_CONFIG } from '../../src/modules/agents/config/agent.config';
import { MIGRATIONS } from '../migrate';

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

const ROOT = join(__dirname, '..', '..');
const SRC = join(ROOT, 'src');
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');

/** Strip comments before a source scan — a scan that forces tombstones out makes the code worse. */
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ─── Fixtures ────────────────────────────────────────────────────────────────

const PRODUCT_ID = '507f1f77bcf86cd799439011';
const AGENT_ID = '507f1f77bcf86cd799439022';
const AGENCY_ID = '507f1f77bcf86cd799439033';
const VENDOR_ID = '507f1f77bcf86cd799439044';
const USER_ID = '507f1f77bcf86cd799439055';
const ORDER_ID = '507f1f77bcf86cd799439066';
const SHIPMENT_ID = '507f1f77bcf86cd799439077';

const asId = (v: string) => ({ toString: () => v });

/**
 * A document-shaped stand-in. The DTO mappers only ever call `toString()` on ids and
 * `toISOString()` on dates, so this is enough to assert the projection without Mongo
 * — the same approach `test:public-catalog` takes with its product fixtures.
 */
const review = (over: Record<string, unknown> = {}): IReview =>
  ({
    _id: asId('507f1f77bcf86cd799439088'),
    subject_type: 'product',
    subject_id: asId(PRODUCT_ID),
    author_user_id: asId(USER_ID),
    author_role: 'customer',
    rating: 4,
    title: null,
    body: null,
    status: 'published',
    published_at: new Date('2026-08-21T10:00:00.000Z'),
    moderation: null,
    order_id: asId(ORDER_ID),
    shipment_id: null,
    target_product_id: asId(PRODUCT_ID),
    target_agent_id: null,
    target_agency_id: null,
    target_vendor_id: asId(VENDOR_ID),
    createdAt: new Date('2026-08-21T09:00:00.000Z'),
    updatedAt: new Date('2026-08-21T10:00:00.000Z'),
    ...over,
  }) as unknown as IReview;

const distribution = (over: Partial<Record<'1' | '2' | '3' | '4' | '5', number>> = {}) => ({
  '1': 0,
  '2': 0,
  '3': 0,
  '4': 0,
  '5': 0,
  ...over,
});

function main(): void {
  console.log('\n── The vocabulary ─────────────────────────────────────────────────────\n');

  assert('two subject types, and only two', () => REVIEW_SUBJECT_TYPES.join(',') === 'product,delivery');

  assert('three author roles', () => REVIEW_AUTHOR_ROLES.join(',') === 'customer,vendor,agency');

  assert('three statuses — pending, published, rejected', () =>
    REVIEW_STATUSES.join(',') === 'pending,published,rejected');

  console.log('\n── Eligibility by role: only a buyer reviews a product ─────────────────\n');

  assert('a customer may review a product', () => roleMayReview('product', 'customer'));

  assert('a vendor may NOT review a product — that one is the buyer\'s', () =>
    !roleMayReview('product', 'vendor'));

  assert('an agency may NOT review a product', () => !roleMayReview('product', 'agency'));

  assert('all three roles may review a delivery — they are its three parties', () =>
    REVIEW_AUTHOR_ROLES.every((role) => roleMayReview('delivery', role)));

  console.log('\n── The target matrix: which aggregates one review moves ───────────────\n');

  assert('a product review moves the product alone', () => {
    const t = targetsOf({ subjectType: 'product', authorRole: 'customer', productId: PRODUCT_ID });
    return t.length === 1 && t[0].type === 'product' && t[0].id === PRODUCT_ID;
  });

  assert("a product review does NOT move a vendor aggregate — recorded, not aggregated", () => {
    const t = targetsOf({ subjectType: 'product', authorRole: 'customer', productId: PRODUCT_ID });
    return !t.some((x) => x.type === 'agency' || x.type === 'agent');
  });

  assert("a customer's delivery review moves the agent AND the agency", () => {
    const t = targetsOf({
      subjectType: 'delivery',
      authorRole: 'customer',
      agentId: AGENT_ID,
      agencyId: AGENCY_ID,
    });
    return t.length === 2 && t.some((x) => x.type === 'agent') && t.some((x) => x.type === 'agency');
  });

  assert("a vendor's delivery review moves the agent AND the agency", () => {
    const t = targetsOf({
      subjectType: 'delivery',
      authorRole: 'vendor',
      agentId: AGENT_ID,
      agencyId: AGENCY_ID,
    });
    return t.length === 2;
  });

  // The load-bearing asymmetry: an agency's public rating must not be self-reported.
  assert('an AGENCY\'s delivery review moves the agent and NEVER the agency itself', () => {
    const t = targetsOf({
      subjectType: 'delivery',
      authorRole: 'agency',
      agentId: AGENT_ID,
      agencyId: AGENCY_ID,
    });
    return t.length === 1 && t[0].type === 'agent' && t[0].id === AGENT_ID;
  });

  assert('a delivery review with no agent moves nothing rather than throwing', () => {
    const t = targetsOf({ subjectType: 'delivery', authorRole: 'customer', agencyId: AGENCY_ID });
    // The agency target still resolves; the point is that the missing agent is not a crash.
    return t.every((x) => x.type !== 'agent');
  });

  console.log('\n── Publish or hold: the rule, and why it is not "everything pends" ─────\n');

  assert('a bare star rating publishes immediately', () => initialStatusOf({}) === 'published');

  assert('a review with a body is held for moderation', () =>
    initialStatusOf({ body: 'The parcel arrived soaked.' }) === 'pending');

  assert('a review with only a title is held too', () => initialStatusOf({ title: 'Terrible' }) === 'pending');

  assert('whitespace is not text — it publishes', () =>
    initialStatusOf({ title: '   ', body: '\n\t' }) === 'published');

  console.log('\n── The average ────────────────────────────────────────────────────────\n');

  assert('no ratings averages to 0, not NaN', () => averageOf(0, 0) === 0);

  assert('the average is rounded to two decimals', () => averageOf(10, 3) === 3.33);

  assert('two decimals rather than one — the composite reads this as a 30-weight input', () =>
    averageOf(14, 3) === 4.67);

  console.log('\n── Projections: a zero-count aggregate is NULL, never a zero rating ────\n');

  assert('an empty aggregate projects to null', () =>
    toRatingSummaryDto({ count: 0, average: 0, distribution: distribution() }) === null);

  assert('a missing aggregate projects to null', () => toRatingSummaryDto(undefined) === null);

  assert('a real aggregate projects to its average and count', () => {
    const dto = toRatingSummaryDto({ count: 12, average: 4.25, distribution: distribution({ '4': 12 }) });
    return dto?.average === 4.25 && dto.count === 12;
  });

  // 10.7's JSON-LD assertion, stated in the terms the backend actually controls: the
  // frontend emits `aggregateRating` iff this field is non-null, so a zero-count
  // product must be indistinguishable from one that has no rating data at all.
  assert('JSON-LD can emit no aggregateRating at count 0 — the breakdown is null too', () =>
    toRatingBreakdownDto({ count: 0, average: 0, distribution: distribution() }) === null);

  assert('the breakdown carries the 1–5 histogram', () => {
    const dto = toRatingBreakdownDto({ count: 3, average: 4, distribution: distribution({ '3': 1, '5': 2 }) });
    return dto?.distribution['5'] === 2 && dto.distribution['3'] === 1 && dto.distribution['1'] === 0;
  });

  assert('the breakdown is COPIED, so a caller cannot mutate the cached row', () => {
    const source = { count: 1, average: 5, distribution: distribution({ '5': 1 }) };
    const dto = toRatingBreakdownDto(source)!;
    dto.distribution['5'] = 99;
    return source.distribution['5'] === 1;
  });

  console.log('\n── LEAK assertions: what a public review may carry ─────────────────────\n');

  assert('the public DTO carries NO author identity', () => {
    const serialised = JSON.stringify(toPublicReviewDto(review()));
    return !serialised.includes(USER_ID) && !serialised.includes('author');
  });

  assert('the public DTO carries no moderation record', () => {
    const serialised = JSON.stringify(
      toPublicReviewDto(
        review({
          status: 'published',
          moderation: { by_user_id: asId(USER_ID), by_source: 'admin', at: new Date(), reason: 'spam suspicion' },
        }),
      ),
    );
    return !serialised.includes('moderation') && !serialised.includes('spam suspicion');
  });

  assert('the public DTO carries no order or shipment reference', () => {
    const serialised = JSON.stringify(toPublicReviewDto(review()));
    return !serialised.includes(ORDER_ID) && !serialised.includes(SHIPMENT_ID);
  });

  assert('the AUTHOR DTO adds status, so a held review is visible to the person who wrote it', () =>
    toAuthorReviewDto(review({ status: 'pending' })).status === 'pending');

  assert('the ADMIN DTO carries the evidence eligibility resolved', () => {
    const dto = toAdminReviewDto(
      review({ subject_type: 'delivery', shipment_id: asId(SHIPMENT_ID), target_agent_id: asId(AGENT_ID) }),
    );
    return dto.evidence.shipmentId === SHIPMENT_ID && dto.targets.agentId === AGENT_ID;
  });

  assert('the ADMIN DTO reports the moderator\'s identity SPACE, not just their id', () => {
    const dto = toAdminReviewDto(
      review({ moderation: { by_user_id: asId(USER_ID), by_source: 'admin', at: new Date(), reason: 'off-topic' } }),
    );
    // `admin` ids resolve nowhere in this database — the source field is what makes
    // the dangling reference legible rather than mysterious (ADR-004 D-1).
    return dto.moderation?.bySource === 'admin';
  });

  console.log('\n── SOURCE SCANS: one writer per field ──────────────────────────────────\n');

  const aggregateRepo = stripComments(read('modules/reviews/repositories/review-aggregate.repository.ts'));
  const reviewService = stripComments(read('modules/reviews/services/review.service.ts'));
  const trustService = stripComments(read('modules/agents/domain/services/agent-trust.service.ts'));
  const reviewRepo = stripComments(read('modules/reviews/repositories/review.repository.ts'));

  // The rule the whole trust design rests on. `modules/reviews` must not be a second
  // writer of an agent's trust fields — it feeds them, through the collector.
  assert('the reviews module never writes delivery_agents', () => {
    const files = [aggregateRepo, reviewService, reviewRepo];
    return files.every(
      (f) => !f.includes('DeliveryAgentModel') && !f.includes('trust_signals') && !f.includes('cod.trust_score'),
    );
  });

  assert('the trust collector reads the aggregate repository, and that is its rating source', () =>
    trustService.includes('reviewAggregateRepository.findAgentRatings('));

  assert('the trust collector does not read the reviews collection directly', () =>
    !trustService.includes('ReviewModel'));

  assert('the aggregate is RECOMPUTED, never incremented', () => {
    // An `$inc` path has to get publish and reject right forever; a single missed
    // transition leaves a permanently drifted average nobody can detect.
    return aggregateRepo.includes('$group') && !aggregateRepo.includes('$inc');
  });

  assert('the recompute counts published rows only — a rejected review counts for nothing', () => {
    const start = aggregateRepo.indexOf('async recompute');
    const end = aggregateRepo.indexOf('async find(');
    const body = aggregateRepo.slice(start, end);
    return start > -1 && end > start && body.includes("status: 'published'");
  });

  assert('exactly ONE function refreshes an aggregate after a review changes', () => {
    const calls = reviewService.match(/this\.aggregates\.recompute\(/g) ?? [];
    return calls.length === 1 && reviewService.includes('private async refreshTargets');
  });

  assert('both moderation verdicts refresh — the rejection branch is the load-bearing one', () => {
    const start = reviewService.indexOf('private async moderate(');
    const end = reviewService.indexOf('private async refreshTargets');
    const body = reviewService.slice(start, end);
    return start > -1 && end > start && body.includes('this.refreshTargets(updated)');
  });

  console.log('\n── SOURCE SCANS: concurrency and the trust nudge ───────────────────────\n');

  assert('the moderation verdict is a compare-and-set on `pending`', () =>
    reviewRepo.includes("status: 'pending'") && reviewRepo.includes('findOneAndUpdate'));

  assert('a compare-and-set miss is a CONFLICT, not a not-found', () =>
    reviewService.includes('REVIEW_NOT_PENDING'));

  assert('a duplicate-key race is translated to the same 409 as the pre-check', () =>
    reviewService.includes('=== 11000') && reviewService.includes('REVIEW_ALREADY_EXISTS'));

  assert('the trust nudge cannot fail the review write that triggered it', () => {
    const line = reviewService.split('\n').find((l) => l.includes('recomputeOne('));
    return line !== undefined && line.trim().startsWith('void ');
  });

  assert('only an AGENT target nudges the trust recompute', () => {
    const start = reviewService.indexOf('private async refreshTargets');
    const body = reviewService.slice(start);
    return body.includes("t.type === 'agent'") && body.includes('recomputeOne(');
  });

  console.log('\n── SOURCE SCANS: the public surface ────────────────────────────────────\n');

  const publicController = stripComments(read('modules/reviews/controllers/public-review.controller.ts'));
  const publicRoutes = stripComments(read('modules/reviews/routes/public-review.routes.ts'));

  /**
   * `api/index.ts` is scanned by STATEMENT LINE rather than through `stripComments`.
   *
   * That helper's block-comment regex starts at any slash-star, and this file is full
   * of path literals like `/api/admin/` + `*` inside prose — so the strip runs from
   * one of those to the next star-slash and swallows real code, including these
   * mounts. Matching a line whose FIRST non-space characters are
   * `router.use(` is immune to that and is strictly stronger than a substring
   * search: a tombstone comment quoting a deleted mount cannot satisfy it, because a
   * comment line begins with `//` or `*`.
   */
  const apiMounts = read('api/index.ts')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('router.use('));

  // A delivery review names an agent server-side and is written by three parties who
  // each see a different slice of one transaction. Only its AGGREGATE leaves the
  // platform; publishing the rows would put a courier's performance record online.
  assert('the public reader is hardwired to product reviews', () =>
    publicController.includes("listPublicForProduct(") && !publicController.includes("'delivery'"));

  assert('no public route accepts a subjectType parameter', () => !publicRoutes.includes('subjectType'));

  assert('the public review router is mounted under /public', () =>
    apiMounts.some((l) => l.startsWith("router.use('/public', publicReviewRoutes)")));

  assert('the three authoring routers are mounted per ROLE, so the role comes from the mount', () =>
    ['/customer/reviews', '/vendor/reviews', '/agency/reviews'].every((prefix) =>
      apiMounts.some((l) => l.startsWith(`router.use('${prefix}'`)),
    ));

  // The three role prefixes already carry routers mounted earlier in that file.
  // Express falls through a `use`-mounted router when nothing inside it matches, so
  // these only work while no earlier router on the same prefix declares `/reviews`.
  assert('no other router on the three role prefixes declares a /reviews path', () => {
    const others = [
      'modules/vendor/routes/index.ts',
      'modules/delivery/agency.routes.ts',
      'modules/orders/customer-order.routes.ts',
    ];
    return others.every((rel) => {
      let source: string;
      try {
        source = stripComments(read(rel));
      } catch {
        return true; // a router that no longer exists cannot shadow anything
      }
      return !/router\.(use|get|post|patch|put|delete)\(\s*['"]\/reviews/.test(source);
    });
  });

  const controller = stripComments(read('modules/reviews/controllers/review.controller.ts'));
  assert('the author role is never read from the request body', () => !controller.includes('req.body.authorRole'));

  assert('the author is the USER id and ownership is the ROLE ENTITY id', () =>
    controller.includes('userId: req.auth!.user._id.toString()') &&
    controller.includes('roleEntityId: req.auth!.role_entity._id.toString()'));

  const adminRoutes = stripComments(read('modules/reviews/routes/admin-review.routes.ts'));
  assert('the moderation surface is a guard-parameterised factory with no public mount', () =>
    adminRoutes.includes('export function buildAdminReviewRouter') &&
    !adminRoutes.includes("requireRole(['admin'])"));

  console.log('\n── The unique index is a REGISTERED migration, not an autoIndex hope ────\n');

  // `autoIndex` is off in production, and this index is the ONLY thing making "one
  // review per author" true — the service pre-check is a race.
  assert('migrate:review-indexes is in the closed migration registry', () =>
    MIGRATIONS.some((m) => m.name === 'migrate:review-indexes'));

  // Not "is it last" — that breaks the moment somebody adds another index build and
  // asserts nothing. The real ordering rule from `migrate.ts`'s header is that index
  // builds run AFTER every data migration, because a unique build fails outright
  // against data a later migration has not yet cleaned up.
  assert('it is registered after every data migration and backfill', () => {
    const names = MIGRATIONS.map((m) => m.name);
    const at = names.indexOf('migrate:review-indexes');
    if (at < 0) return false;
    // Nothing that touches DATA may run after an index build. `backfill:*` writes rows
    // and `drop-*` removes a collection; a unique index built before either is one
    // built against a shape the data has not reached yet.
    return !names.slice(at + 1).some((n) => n.startsWith('backfill:') || n.startsWith('migrate:drop-'));
  });

  assert('it supports --dry-run, like every other migration', () =>
    MIGRATIONS.find((m) => m.name === 'migrate:review-indexes')?.dryRun === true);

  const migrationScript = stripComments(readFileSync(join(ROOT, 'scripts', 'migrate-review-indexes.ts'), 'utf8'));
  assert('the migration builds the one-per-author unique index', () =>
    migrationScript.includes('review_one_per_author_per_subject') && migrationScript.includes('unique: true'));

  assert('the migration builds the aggregate identity index too', () =>
    migrationScript.includes('review_aggregate_identity'));

  assert('the migration never drops anything', () =>
    !migrationScript.includes('dropIndex') && !migrationScript.includes('.drop('));

  console.log('\n── The contract with the trust composite ───────────────────────────────\n');

  assert('an unrated agent reports null, not 0 — the two mean opposite things', () => {
    // `collectSignals` maps count 0 → avg null. Asserted here as the arithmetic
    // consequence: a 0 average would score the agent as universally one-starred.
    const unknown = ratingFactor(null, 0);
    const universallyBad = ratingFactor(0, AGENT_CONFIG.TRUST_MIN_OBSERVATIONS);
    return unknown > universallyBad && unknown === AGENT_CONFIG.TRUST_SCORE_SEED / AGENT_CONFIG.TRUST_SCORE_MAX;
  });

  assert('collectSignals guards every rating average on its count', () => {
    const start = trustService.indexOf('customer_rating_avg:');
    const body = trustService.slice(start, start + 500);
    return (
      body.includes('ratings.customer.count > 0') &&
      body.includes('ratings.agency.count > 0') &&
      body.includes('ratings.vendor.count > 0')
    );
  });

  assert('the three author roles feed the three separate rating factors', () => {
    const start = trustService.indexOf('customer_rating_avg:');
    const body = trustService.slice(start, start + 600);
    return (
      body.includes('ratings.customer.average') &&
      body.includes('ratings.agency.average') &&
      body.includes('ratings.vendor.average')
    );
  });

  // Step 11 has not happened yet. This module must not be what quietly flips it.
  assert('publishing a review still does NOT write the live score (Phase 6 D-2 holds)', () => {
    const worker = stripComments(read('modules/agents/workers/agent-trust-recompute.worker.ts'));
    return worker.includes('setTrustSignalsShadow') && !worker.includes("'cod.trust_score'");
  });

  console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main();
