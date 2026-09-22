/**
 * Test: provisioning a role entity from an account that has no email.
 *
 * Follows the scripts/test convention — plain ts-node, hand-rolled asserts, no framework.
 * DB-free: `validateSync()` and `schema.indexes()` run entirely offline, and the migration is
 * read as text.
 *
 * ── The defect this pins ─────────────────────────────────────────────────────
 *
 * `register` and `addRole` both copy the account's email onto the new role entity
 * (`input.email` / `user.login_email`), and the account's email is optional. `Vendor.email`
 * alone was `required: true`, so an email-less agent, agency or customer adding the vendor
 * role threw a Mongoose ValidationError — which the error handler has no branch for, so the
 * client was told `500 INTERNAL_SERVER_ERROR`.
 *
 * Its uniqueness was the second half, and the half no behavioural test at one account can see:
 * a field-level `unique: true` builds a plain unique index, which counts a MISSING email as
 * `null`. Removing `required` alone moves the failure from the first email-less vendor to the
 * second (E11000 → 409). So the index is PARTIAL now, and replacing the live one is a ledgered
 * migration whose literals this suite holds against the model.
 *
 * Run: npm run test:role-provisioning
 */
import fs from 'fs';
import path from 'path';
import { Types } from 'mongoose';
// Imported for their SCHEMAS only — nothing here connects, so this stays a DB-free suite.
import { CustomerModel } from '../../src/modules/customers/customer.model';
import { VendorModel } from '../../src/modules/vendors/vendor.model';
import { DeliveryAgencyModel } from '../../src/modules/delivery/delivery-agency.model';
import { DeliveryAgentModel } from '../../src/modules/agents/models/agent.model';

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

const ROOT = path.resolve(__dirname, '../..');
const read = (relative: string): string => fs.readFileSync(path.join(ROOT, relative), 'utf8');

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

/**
 * Each role entity exactly as `AuthService.addRole` builds it for an account whose
 * `login_email` is absent — `email: undefined` is the literal it passes. A `name` is supplied
 * where the model requires one: this suite is about the email, and the name is a separate rule.
 */
const PHONE = '+237699000101';
const ROLE_ENTITIES = [
  {
    role: 'customer',
    doc: () => new CustomerModel({
      user_id: new Types.ObjectId(), name: 'Ulrich', email: undefined, phone: PHONE,
      email_verified: false, phone_verified: false,
    }),
  },
  {
    role: 'vendor',
    doc: () => new VendorModel({
      user_id: new Types.ObjectId(), display_name: undefined, email: undefined, phone: PHONE,
      email_verified: false, phone_verified: false,
    }),
  },
  {
    role: 'agency',
    doc: () => new DeliveryAgencyModel({
      user_id: new Types.ObjectId(), display_name: undefined, email: undefined, phone: PHONE,
      email_verified: false, phone_verified: false, legit_verified: false,
    }),
  },
  {
    role: 'agent',
    doc: () => new DeliveryAgentModel({
      user_id: new Types.ObjectId(), name: 'Ulrich', email: undefined, phone: PHONE,
      email_verified: false, phone_verified: false,
    }),
  },
];

function main(): void {
  console.log('\n── No role entity may require what the account holds optionally ────────\n');

  for (const { role, doc } of ROLE_ENTITIES) {
    const article = /^[aeiou]/.test(role) ? 'an' : 'a';
    assert(`${article} ${role} built from an email-less account has no email validation error`, () => {
      const error = doc().validateSync();
      return error?.errors?.email === undefined;
    });
  }

  // The vendor is the path the reported 500 took, so it is held to the stronger claim: the
  // add-role shape validates WHOLE, not merely without an email error. `display_name` is
  // undefined too, because `input.name` is optional on the add-role body.
  assert('the vendor add-role shape validates with no errors at all', () =>
    ROLE_ENTITIES.find((r) => r.role === 'vendor')!.doc().validateSync() === undefined);

  assert('a vendor email that IS given is still normalised (trim + lowercase)', () => {
    const vendor = new VendorModel({ user_id: new Types.ObjectId(), phone: PHONE, email: '  Shop@Example.COM ' });
    return vendor.email === 'shop@example.com';
  });

  console.log('\n── Vendor email uniqueness binds only vendors that HAVE one ─────────────\n');

  const emailIndexes = VendorModel.schema.indexes()
    .filter(([key]) => Object.keys(key).length === 1 && 'email' in key);

  // A field-level `unique: true` would re-declare the plain `email_1` beside the partial one —
  // and in development `autoIndex` would build it, reintroducing the second-vendor E11000.
  assert('the email path carries no field-level unique (that builds the plain email_1)', () =>
    !(VendorModel.schema.path('email') as unknown as { options: { unique?: boolean } }).options.unique);

  assert('exactly one index on { email: 1 } is declared', () => emailIndexes.length === 1);

  const [, emailOptions] = emailIndexes[0] ?? [{}, {}];

  assert('...it is unique', () => emailOptions.unique === true);

  assert('...and PARTIAL on a string email, so missing AND null are both outside it', () =>
    JSON.stringify(emailOptions.partialFilterExpression) === JSON.stringify({ email: { $type: 'string' } }));

  assert('...and not merely sparse (sparse still indexes an explicit null)', () =>
    emailOptions.sparse !== true);

  assert('...under the name the migration builds', () =>
    emailOptions.name === 'vendor_email_unique_when_set');

  console.log('\n── The migration mirrors the model ──────────────────────────────────────\n');

  const MIGRATION_FILE = 'scripts/migrate-vendor-email-index.ts';
  const migration = read(MIGRATION_FILE);
  const migrationCode = stripComments(migration);

  /**
   * ⚠ The migration may NOT import the model: `autoIndex` is on in development, so
   * registering the schema and connecting builds every index it declares — which would make
   * `--dry-run` WRITE. So it holds literals, and these assertions are what stop them drifting.
   */
  assert('the migration does not import the vendor model', () =>
    !migrationCode.includes('vendor.model') && migrationCode.includes('COLLECTIONS.VENDOR'));

  assert('its target name matches the declared index', () =>
    migrationCode.includes(`name: '${String(emailOptions.name)}'`));

  assert('its partial filter matches the declared index', () =>
    /partialFilterExpression:\s*\{\s*email:\s*\{\s*\$type:\s*'string'\s*\}\s*\}/.test(migrationCode));

  assert('it drops the legacy index by exact name, and only the plain-unique shape', () =>
    migrationCode.includes("const LEGACY_NAME = 'email_1'")
      && migrationCode.includes('function isLegacyEmailIndex'));

  // Build-then-drop is what keeps vendor email uniqueness enforced at every instant; the
  // reverse order leaves it enforced by nothing if the build then fails.
  assert('it BUILDS before it DROPS', () => {
    const build = migrationCode.indexOf('createIndex(');
    const drop = migrationCode.indexOf('dropIndex(');
    return build > -1 && drop > -1 && build < drop;
  });

  assert('...and never drops while the replacement is not in place', () =>
    /else if \(!targetInPlace\)/.test(migrationCode));

  assert('it is registered in the runner, ahead of the catch-all', () => {
    const runner = read('scripts/migrate.ts');
    const mine = runner.indexOf("name: 'migrate:vendor-email-index'");
    const catchAll = runner.indexOf("name: 'migrate:declared-indexes'");
    return mine > -1 && catchAll > -1 && mine < catchAll && runner.includes(`file: '${MIGRATION_FILE}'`);
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main();
