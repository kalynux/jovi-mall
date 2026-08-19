/**
 * Migration: drop the orphaned `agent_invites` collection.
 *
 * The email-invite subsystem was DELETED when agents and agencies moved to the symmetric
 * request → accept/reject/withdraw handshake (`GET /api/agency/agents/browse`,
 * `GET /api/agent/agencies/browse`, mirroring the vendor↔agency connection). The code went;
 * the collection did not. As of 2026-08-19 there is no model, no repository, no route and no
 * script anywhere in this repository that names it — `grep -r agent_invites src/ scripts/`
 * returns nothing, and `COLLECTIONS` has no entry for it.
 *
 * ── Why an orphaned collection is worth a migration ─────────────────────────
 *
 * It is not disk. It is that a collection full of `pending` invitations, with a
 * `email_1_status_1_created_at_-1` index on it, reads to anyone opening the database as a
 * live subsystem — one where somebody's invitation is apparently still waiting to be
 * answered. Nothing will ever answer it: the code that read that `status` no longer exists.
 * A stale collection is a false statement about what the platform does, and it is made to
 * exactly the audience least able to check it against the source.
 *
 * ── Read before dropping ────────────────────────────────────────────────────
 *
 * A drop is irreversible, so this script never drops anything it has not first counted and
 * printed. `--dry-run` does the read and stops. The dev database at the time of writing held
 * two documents, both `status: "pending"`, created 2026-07-12 and 2026-07-28 — both predating
 * the handshake, neither reachable by any code path. If the count where you run this is large
 * or the documents look recent, STOP and find out what wrote them before you drop anything:
 * that would mean something still writes here, which contradicts the premise of this script.
 *
 * ── Idempotent ──────────────────────────────────────────────────────────────
 *
 * A missing collection is not an error, it is the goal — the script exits 0 having done
 * nothing. That matters more here than for the index migrations: this one is registered in
 * the ledger, and `migrate:up -- --only` deliberately re-runs an applied migration.
 *
 * ── Forward-only, and this one really is ────────────────────────────────────
 *
 * There is no down migration in this repository (see `scripts/migrate.ts`), and for a drop
 * that is not a limitation to work around — the correction for dropping the wrong collection
 * is a restore from a backup, never another migration. Which is the second reason for the
 * read-first rule above.
 *
 * Run:  npx ts-node scripts/migrate-drop-agent-invites.ts [--dry-run]
 *       (npm run migrate:drop-agent-invites)
 */
import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi-mall';
const DRY_RUN = process.argv.includes('--dry-run');

/**
 * Not in `COLLECTIONS`, deliberately: that registry names the collections this service USES,
 * and adding a name to it in order to delete the collection would leave a dangling entry
 * behind for the next reader to wonder about.
 */
const COLLECTION = 'agent_invites';

export async function dropAgentInvites(): Promise<void> {
  await mongoose.connect(MONGO_URI);
  console.log(`Connected to ${MONGO_URI}${DRY_RUN ? '  (DRY RUN — nothing will be written)' : ''}`);

  const db = mongoose.connection.db;
  if (!db) throw new Error('No database handle after connect');

  const existing = await db.listCollections({ name: COLLECTION }).toArray();

  if (existing.length === 0) {
    console.log(`\nNothing to do — "${COLLECTION}" does not exist in ${mongoose.connection.name}.`);
    await mongoose.disconnect();
    return;
  }

  // Read before dropping. Both of these are printed on a dry run and on a real one, so the
  // deploy log records what was destroyed rather than only that something was.
  const collection = db.collection(COLLECTION);
  const count = await collection.countDocuments();
  const indexes = await collection.indexes();

  console.log(`\n"${COLLECTION}" in ${mongoose.connection.name}:`);
  console.log(`  documents: ${count}`);
  console.log(`  indexes:   ${indexes.map((i) => i.name).join(', ')}`);

  if (count > 0) {
    const byStatus = await collection
      .aggregate<{ _id: unknown; n: number }>([{ $group: { _id: '$status', n: { $sum: 1 } } }])
      .toArray();
    console.log(`  by status: ${byStatus.map((s) => `${String(s._id)}=${s.n}`).join(', ')}`);
    const newest = await collection.find({}).sort({ created_at: -1 }).limit(1).toArray();
    const createdAt = newest[0]?.created_at;
    console.log(`  newest:    ${createdAt instanceof Date ? createdAt.toISOString() : String(createdAt)}`);
  }

  if (DRY_RUN) {
    console.log(
      `\nDRY RUN — would DROP "${COLLECTION}" and its ${count} document(s). This is irreversible.` +
        '\nRead the counts above first. Re-run without --dry-run to apply.'
    );
    await mongoose.disconnect();
    return;
  }

  await db.dropCollection(COLLECTION);
  console.log(`\nDropped "${COLLECTION}" (${count} document(s)).`);
  console.log('The email-invite subsystem it belonged to was replaced by the agent↔agency handshake;');
  console.log('git history is the archive for both the code and this note.');

  await mongoose.disconnect();
}

/**
 * Run only when INVOKED, never when imported.
 *
 * `scripts/migrate.ts` and its test import each other's registry, and `test-system.ts`
 * imports `MIGRATIONS`. Without this guard, importing anything that transitively reaches this
 * file would DROP A COLLECTION as a side effect of a DB-free unit test. Same guard, same
 * reason, as `scripts/migrate.ts` — and this is the migration where getting it wrong is
 * unrecoverable rather than merely slow.
 */
if (require.main === module) {
  dropAgentInvites().catch((error) => {
    console.error('\nMigration failed:', error);
    process.exit(1);
  });
}
