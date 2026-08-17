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

const validPolygon = {
    type: 'Polygon' as const,
    coordinates: [[[9.7, 4.0], [9.8, 4.0], [9.8, 4.1], [9.7, 4.1], [9.7, 4.0]]],
};

const validHq = {
    address_line1: '12 Rue de la Liberté',
    city: 'Douala',
    country: 'CM',
    location: { type: 'Point' as const, coordinates: [9.7, 4.0] },
    support_contact: { phone: '+237670000000', email: null },
};

console.log('\n── Agency Onboarding Step 1 ──────────────────────────────────────────────');

assert('Step 1 passes with 1 polygon and 1 HQ address', () => {
    const result = AgencyOnboardingStep1Schema.parse({
        coverage_areas: [validPolygon],
        headquarters_addresses: [validHq],
    });
    return result.coverage_areas.length === 1 && result.headquarters_addresses.length === 1;
});

assertZodFails('Step 1 rejects empty coverage_areas', AgencyOnboardingStep1Schema, {
    coverage_areas: [],
    headquarters_addresses: [validHq],
});

assertZodFails('Step 1 rejects empty headquarters_addresses (min 1)', AgencyOnboardingStep1Schema, {
    coverage_areas: [validPolygon],
    headquarters_addresses: [],
});

assertZodFails('Step 1 rejects missing support_contact', AgencyOnboardingStep1Schema, {
    coverage_areas: [validPolygon],
    headquarters_addresses: [{ address_line1: '12 Rue', city: 'Douala', country: 'CM' }],
});

console.log('\n── Agency Onboarding Step 2 ──────────────────────────────────────────────');

assert('Step 2 passes valid bank payout', () => {
    const result = AgencyOnboardingStep2Schema.parse({
        payout_details: {
            method: 'bank',
            bank: { bank_name: 'SGBC', account_number: '002345678', account_name: 'Agency SARL', country: 'CM' },
        },
    });
    return result.payout_details.method === 'bank';
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
