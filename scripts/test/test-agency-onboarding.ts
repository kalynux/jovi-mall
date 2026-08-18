/**
 * Test: Agency Onboarding Validator
 *
 * Run: npx ts-node scripts/test/test-agency-onboarding.ts
 */
import { ZodError } from 'zod';
import {
    AgencyOnboardingStep1Schema,
    AgencyOnboardingStep2Schema,
    AgencyOnboardingStep3Schema,
} from '../../src/modules/delivery/validators/agency-onboarding.validator';
import { isPayoutMethodEnabled } from '../../src/core/types/payout.types';

let passed = 0;
let failed = 0;

function assert(name: string, fn: () => boolean): void {
    try {
        const ok = fn();
        if (ok) { console.log(`  ✅ ${name}`); passed++; }
        else { console.error(`  ❌ FAIL: ${name}`); failed++; }
    } catch (err) {
        console.error(`  ❌ THROW: ${name}`, (err as Error).message);
        failed++;
    }
}

function assertZodFails(name: string, schema: any, data: unknown): void {
    try {
        schema.parse(data);
        console.error(`  ❌ SHOULD HAVE FAILED: ${name}`);
        failed++;
    } catch (err) {
        if (err instanceof ZodError) { console.log(`  ✅ (correctly rejected) ${name}`); passed++; }
        else { console.error(`  ❌ UNEXPECTED THROW: ${name}`, (err as Error).message); failed++; }
    }
}

/**
 * A coverage area is a REGION KEY now, not a polygon.
 *
 * Step 1 used to take GeoJSON polygons; coverage is written as picked region keys from
 * the agency's country catalogue (`locations.json`), which is what makes a contract's
 * `coverage.regions` comparable against an order's `delivery_address.components.region`.
 * The polygon fixture below it survived because nothing ran this file.
 */
const validRegion = 'littoral';

/**
 * An HQ entry as the shared array schema accepts it today.
 *
 * `label` and `address_description` are required and neither existed when this fixture was
 * written; `address_line1` and a per-entry `country` are gone (Step 1's own `country` is
 * the one that counts, and headquarters must geocode inside it). `location` is the legacy
 * bare coordinate, kept optional and derived from `geo` on write.
 */
const validHq = {
    label: 'Main depot',
    address_description: '12 Rue de la Liberté',
    city: 'Douala',
    location: { type: 'Point' as const, coordinates: [9.7, 4.0] },
    support_contact: { phone: '+237670000000', email: null },
};

console.log('\n── Agency Onboarding Step 1 ──────────────────────────────────────────────');

assert('Step 1 passes with 1 region and 1 HQ address', () => {
    const result = AgencyOnboardingStep1Schema.parse({
        country: 'CM',
        coverage_areas: [validRegion],
        headquarters_addresses: [validHq],
    });
    return result.coverage_areas.length === 1 && result.headquarters_addresses.length === 1;
});

// `country` is set ONCE here and is immutable after onboarding completes — headquarters
// addresses must geocode inside it. It was not in this schema when these fixtures were
// written, which is why every case below carries it now.
assertZodFails('Step 1 rejects a missing country', AgencyOnboardingStep1Schema, {
    coverage_areas: [validRegion],
    headquarters_addresses: [validHq],
});

assertZodFails('Step 1 rejects empty coverage_areas', AgencyOnboardingStep1Schema, {
    country: 'CM',
    coverage_areas: [],
    headquarters_addresses: [validHq],
});

assertZodFails('Step 1 rejects empty headquarters_addresses (min 1)', AgencyOnboardingStep1Schema, {
    country: 'CM',
    coverage_areas: [validRegion],
    headquarters_addresses: [],
});

console.log('\n── Agency Onboarding Step 2 ──────────────────────────────────────────────');

// payout_details is an ORDERED ARRAY since the payout refactor (1–3 entries, index 0
// preferred), and a bank entry is refused while ENABLED_PAYOUT_METHODS is mobile_money-only
// — the switch is piped in front of the shape check on every write path. This asserts
// against the SETTING rather than a hardcoded outcome, as test:payout-methods does.
assert('Step 2 passes a mobile_money payout', () => {
    const result = AgencyOnboardingStep2Schema.parse({
        payout_details: [{
            method: 'mobile_money',
            mobile_money: { provider: 'MTN', phone_number: '+237670000000', account_name: 'Agency SARL' },
        }],
    });
    return result.payout_details[0].method === 'mobile_money';
});

assert('Step 2 refuses a bank payout while the switch is mobile_money-only', () => {
    if (isPayoutMethodEnabled('bank')) return true; // re-enabled: nothing to assert here
    const parsed = AgencyOnboardingStep2Schema.safeParse({
        payout_details: [{
            method: 'bank',
            bank: { bank_name: 'SGBC', account_number: '002345678', account_name: 'Agency SARL', country: 'CM' },
        }],
    });
    return parsed.success === false;
});

assertZodFails('Step 2 rejects missing payout_details', AgencyOnboardingStep2Schema, {});

console.log('\n── Agency Onboarding Step 3 ──────────────────────────────────────────────');

assert('Step 3 passes with skip=true', () => {
    const result = AgencyOnboardingStep3Schema.parse({ skip: true });
    return result.skip === true;
});

assert('Step 3 passes with logo_file_id', () => {
    const result = AgencyOnboardingStep3Schema.parse({
        skip: false,
        logo_file_id: '507f1f77bcf86cd799439011',
        timezone: 'Africa/Douala',
    });
    return result.logo_file_id === '507f1f77bcf86cd799439011';
});

assertZodFails('Step 3 rejects invalid logo_file_id', AgencyOnboardingStep3Schema, {
    logo_file_id: 'not-an-id',
});

console.log(`\n─────────────────────────────────────────────────────────────────────────`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
