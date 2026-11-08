/**
 * Backfill: give every SERVICE PROVIDER without a country the one registration now gives them
 * (2026-11-08, vendor-dashboard request).
 *
 * A seller chooses their country in onboarding Step 1. A provider starts with onboarding complete
 * (`onboarding_step: 0`) and never sees that step, so every provider registered before 2026-11-08
 * has `country: null`, and the vendor dashboard was setting it on first visit as a workaround.
 * Registration now writes it (`providerCountryOf`, `vendors/domain/vendor-kind.ts`): the sign-up
 * phone's country by the platform's dial-code table, Cameroon when nothing matches. This applies
 * the SAME rule to the rows that predate it, so old and new providers cannot differ.
 *
 * The phone read is the vendor row's own `phone`, else the account's `login_phone` — the number
 * registration and add-role pass, respectively.
 *
 * Country is set-once (`assertCountryUnchangedOrFirstSet`), so the write is conditional on the
 * field still being empty: a provider who set it meanwhile, through the dashboard's workaround,
 * keeps their own value. Sellers are never touched — Step 1 is theirs.
 *
 * Idempotent: a second run finds no provider without a country. `--dry-run` prints every provider
 * it would set and the country, and writes nothing.
 *
 * Run:  npx ts-node scripts/backfill-provider-country.ts [--dry-run]
 *       (npm run backfill:provider-country)
 */
import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';
import { COLLECTIONS } from '../src/core/database/collections';
import { providerCountryOf } from '../src/modules/vendors/domain/vendor-kind';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi-mall';
const DRY_RUN = process.argv.includes('--dry-run');

const WITHOUT_COUNTRY = { kind: 'provider', $or: [{ country: null }, { country: '' }] };

async function main(): Promise<void> {
  await mongoose.connect(MONGO_URI);
  console.log(`Connected to ${MONGO_URI}${DRY_RUN ? '  (DRY RUN — nothing will be written)' : ''}`);

  const vendors = mongoose.connection.collection(COLLECTIONS.VENDOR);
  const users = mongoose.connection.collection(COLLECTIONS.USER);

  const rows = await vendors
    .find(WITHOUT_COUNTRY, { projection: { _id: 1, user_id: 1, phone: 1, display_name: 1 } })
    .toArray();
  console.log(`\nProviders without a country: ${rows.length}`);

  let written = 0;
  for (const row of rows) {
    let phone: string | null = typeof row.phone === 'string' && row.phone ? row.phone : null;
    if (!phone && row.user_id) {
      const user = await users.findOne({ _id: row.user_id }, { projection: { login_phone: 1 } });
      phone = typeof user?.login_phone === 'string' ? user.login_phone : null;
    }
    const country = providerCountryOf(phone);
    console.log(`  ${String(row._id)}  ${country}${phone ? '' : '  (no phone on record: default)'}`);
    if (DRY_RUN) continue;
    const result = await vendors.updateOne(
      { _id: row._id, ...WITHOUT_COUNTRY },
      { $set: { country, updated_at: new Date() } },
    );
    written += result.modifiedCount;
  }

  console.log(DRY_RUN ? '\nDRY RUN — nothing was written.' : `\nSet the country on ${written} provider(s).`);
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error('\nBackfill failed:', error);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
