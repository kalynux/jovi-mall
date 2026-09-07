/**
 * Dev helper: fill `product_vectors` from the dev catalogue, through the real path.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * The vectoriser and the search tool are both built, and neither can be judged
 * against an empty index. `POST /api/internal/admin/.../bulk-vectorise` cannot
 * seed it either: it selects products with `vectorisationEnabled: true`, and that
 * flag is a VENDOR opt-in defaulting to false, so on a fresh dev database it
 * matches nothing and reports a cheerful zero.
 *
 * So this flips the flag on dev products and then calls the production
 * `vectoriseBulk` — not a copy of it, not a hand-rolled POST. Everything it
 * exercises is the real thing: the 202, the accepted/rejected split, the claim
 * tickets, and the callback that lands on the running server minutes later.
 *
 * ── ⚠ IT WRITES, AND ONLY TO DEV ─────────────────────────────────────────────
 *
 * `vectorisationEnabled` is a vendor's decision. Setting it for them is fine on a
 * disposable dev database and is NOT fine anywhere else, so this refuses to run
 * when NODE_ENV is production. It is deliberately not registered in
 * `scripts/migrate.ts`: it is a fixture, not a migration.
 *
 * ── The callback does not land in THIS process ───────────────────────────────
 *
 * `vectoriseBulk` returns as soon as the vectoriser answers 202. The per-product
 * outcome arrives later, over `POST /api/internal/vectoriser/callback`, on the
 * server that is already running — so `npm run dev` has to be up, or the products
 * stay `pending` and nothing writes `completed`. This script waits for that and
 * reports what actually landed, rather than reporting the 202 as success.
 *
 * Run:
 *   npx ts-node scripts/dev-seed-vectoriser-index.ts
 *   npx ts-node scripts/dev-seed-vectoriser-index.ts --limit 30 --wait 180
 *   npx ts-node scripts/dev-seed-vectoriser-index.ts --dry-run
 */
import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const isDryRun = process.argv.includes('--dry-run');
const LIMIT = parseInt(arg('limit', '30'), 10);
const WAIT_SECONDS = parseInt(arg('wait', '150'), 10);

function log(level: string, message: string, ctx: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, message, ...ctx }));
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    log('ERROR', 'Refusing to run in production — this sets a vendor opt-in flag on their behalf');
    process.exit(2);
  }

  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    log('ERROR', 'MONGO_URI is not set');
    process.exit(2);
  }
  if (!process.env.VECTORISER_BASE_URL) {
    log('ERROR', 'VECTORISER_BASE_URL is not set — nothing would be dispatched');
    process.exit(2);
  }

  await mongoose.connect(mongoUri);
  log('INFO', 'MongoDB connected');

  const { ProductModel } = await import('../src/modules/catalog/models/product.model');
  const { vectorisationService } = await import(
    '../src/modules/catalog/domain/services/VectorisationService'
  );

  const candidates = await ProductModel.find({ status: 'active', deletedAt: null })
    .select('_id title vectorisationEnabled vectorisationStatus')
    .limit(LIMIT)
    .lean();

  if (candidates.length === 0) {
    log('WARN', 'No active products in this database — nothing to index');
    await mongoose.disconnect();
    process.exit(0);
  }

  const ids = candidates.map((p) => p._id.toString());
  log('INFO', 'Found active products', {
    count: ids.length,
    alreadyEnabled: candidates.filter((p) => p.vectorisationEnabled).length,
  });

  if (isDryRun) {
    candidates.forEach((p) =>
      console.log(
        JSON.stringify({
          id: p._id.toString(),
          title: p.title,
          enabled: p.vectorisationEnabled,
          status: p.vectorisationStatus,
        }),
      ),
    );
    log('INFO', 'Dry run — nothing written');
    await mongoose.disconnect();
    process.exit(0);
  }

  // The vendor opt-in. Dev only; see the header.
  const flip = await ProductModel.updateMany(
    { _id: { $in: ids }, vectorisationEnabled: { $ne: true } },
    { $set: { vectorisationEnabled: true } },
  );
  log('INFO', 'Enabled vectorisation', { modified: flip.modifiedCount });

  // The real dispatch path. Not billed — see the BILLING note on vectoriseBulk.
  const result = await vectorisationService.vectoriseBulk(ids);
  log('INFO', 'Submitted to the vectoriser', {
    accepted: result.accepted,
    failed: result.failed,
    total: result.total,
  });
  if (result.errors.length > 0) {
    result.errors.slice(0, 10).forEach((e) => log('WARN', 'Not accepted', e));
  }

  if (result.accepted === 0) {
    log('ERROR', 'Nothing was accepted — the callback will never fire, stopping here');
    await mongoose.disconnect();
    process.exit(1);
  }

  // ── Wait for the callback, and report what it actually wrote ───────────────
  //
  // Polling the STATUS, not a timer: `completed` is written only by
  // /api/internal/vectoriser/callback, so a product that reaches it proves the
  // whole round trip — 202, embed, pgvector write, callback, Mongo update.
  log('INFO', 'Waiting for the callback to land', {
    seconds: WAIT_SECONDS,
    reminder: 'the jovi-mall server must be running to receive it',
  });

  const deadline = Date.now() + WAIT_SECONDS * 1000;
  let settled = 0;
  while (Date.now() < deadline) {
    const counts = await ProductModel.aggregate([
      { $match: { _id: { $in: ids.map((i) => new mongoose.Types.ObjectId(i)) } } },
      { $group: { _id: '$vectorisationStatus', n: { $sum: 1 } } },
    ]);
    const byStatus: Record<string, number> = {};
    counts.forEach((c: { _id: string; n: number }) => {
      byStatus[c._id] = c.n;
    });
    settled = (byStatus.completed ?? 0) + (byStatus.failed ?? 0);

    log('INFO', 'Poll', byStatus);
    if (settled >= result.accepted) break;

    await new Promise((r) => setTimeout(r, 10000));
  }

  const completed = await ProductModel.countDocuments({
    _id: { $in: ids },
    vectorisationStatus: 'completed',
  });
  const stuck = await ProductModel.countDocuments({
    _id: { $in: ids },
    vectorisationStatus: 'pending',
  });

  log('INFO', '═══ Seeding finished ═══', { completed, stillPending: stuck });
  if (stuck > 0) {
    log('WARN', 'Products still pending — the callback did not arrive for them', {
      check: 'is the jovi-mall server running, and can n8n reach it over Tailscale?',
    });
  }

  await mongoose.disconnect();
  process.exit(completed > 0 ? 0 : 1);
}

main().catch((err) => {
  log('ERROR', 'Unhandled failure', { error: err?.message, stack: err?.stack });
  process.exit(1);
});
