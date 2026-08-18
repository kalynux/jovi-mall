/**
 * Test: Vendor Onboarding Validator
 *
 * Run: npx ts-node scripts/test/test-vendor-onboarding.ts
 */
import { ZodError } from 'zod';
import {
    VendorOnboardingStep1Schema,
    VendorOnboardingStep2Schema,
    VendorOnboardingStep3Schema,
    UpdateVendorProfileSchema,
} from '../../src/modules/vendor/validators/vendor-onboarding.validator';
import { isPayoutMethodEnabled } from '../../src/core/types/payout.types';

let passed = 0;
let failed = 0;

function assert(name: string, fn: () => boolean): void {
    try {
        const result = fn();
        if (result) { console.log(`  ✅ ${name}`); passed++; }
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

console.log('\n── Vendor Onboarding Step 1 ──────────────────────────────────────────────');

assert('Step 1 passes valid mobile_money payout', () => {
    const result = VendorOnboardingStep1Schema.parse({
        country: 'CM',
        timezone: 'Africa/Douala',
        // An ORDERED ARRAY since the payout refactor — 1 to 3 entries, index 0 preferred.
        payout_details: [{
            method: 'mobile_money',
            mobile_money: { provider: 'MTN', phone_number: '+237670000000', account_name: 'John Doe' },
        }],
    });
    return result.country === 'CM' && result.payout_details[0].method === 'mobile_money';
});

assert('Step 1 normalizes country to uppercase', () => {
    const result = VendorOnboardingStep1Schema.parse({
        country: 'cm',
        timezone: 'Africa/Douala',
        payout_details: [{
            method: 'mobile_money',
            mobile_money: { provider: 'MTN', phone_number: '+237670000000', account_name: 'John' },
        }],
    });
    return result.country === 'CM';
});

assertZodFails('Step 1 rejects missing country', VendorOnboardingStep1Schema, {
    timezone: 'Africa/Douala',
    payout_details: [{ method: 'mobile_money', mobile_money: { provider: 'MTN', phone_number: '+237670000000', account_name: 'John' } }],
});

assertZodFails('Step 1 rejects missing payout_details', VendorOnboardingStep1Schema, {
    country: 'CM',
    timezone: 'Africa/Douala',
});

assertZodFails('Step 1 rejects wrong country length', VendorOnboardingStep1Schema, {
    country: 'CMR',
    timezone: 'Africa/Douala',
    payout_details: [{ method: 'mobile_money', mobile_money: { provider: 'MTN', phone_number: '+237670000000', account_name: 'John' } }],
});

console.log('\n── Vendor Onboarding Step 2 ──────────────────────────────────────────────');

// Step 2 no longer carries `default_delivery_agency_id`, and that is deliberate: agency
// selection happens exclusively through the agency-connections endpoints, and the vendor's
// default agency is set automatically the first time a connection is approved. The step
// survives as a pure step-advance with a deprecated `skip`, kept so existing frontend calls
// do not break. These two assertions used to test the removed field.
assert('Step 2 is a pure step-advance — skip defaults to false', () => {
    const result = VendorOnboardingStep2Schema.parse({});
    return result.skip === false;
});

assert('Step 2 accepts the deprecated skip flag', () => {
    const result = VendorOnboardingStep2Schema.parse({ skip: true });
    return result.skip === true;
});

console.log('\n── Vendor Onboarding Step 3 ──────────────────────────────────────────────');

assert('Step 3 passes with skip=true and no data', () => {
    const result = VendorOnboardingStep3Schema.parse({ skip: true });
    return result.skip === true;
});

assert('Step 3 passes with branding data', () => {
    const result = VendorOnboardingStep3Schema.parse({
        skip: false,
        branding: { logo_file_id: '507f1f77bcf86cd799439011', cover_image_file_id: null },
    });
    return result.branding?.logo_file_id === '507f1f77bcf86cd799439011';
});

assertZodFails('Step 3 rejects invalid logo file id', VendorOnboardingStep3Schema, {
    branding: { logo_file_id: 'not-an-id' },
});

console.log('\n── General Profile Update ────────────────────────────────────────────────');

assert('Profile update passes valid minimal input (version required)', () => {
    const result = UpdateVendorProfileSchema.parse({ version: 3 });
    return result.version === 3;
});

assertZodFails('Profile update rejects missing version', UpdateVendorProfileSchema, {
    displayName: 'Test Vendor',
});

assertZodFails('Profile update rejects bad email', UpdateVendorProfileSchema, {
    email: 'not-an-email',
    version: 0,
});

console.log('\n── Payout: Bank branch ──────────────────────────────────────────────────');

// ⚠ A bank payout is REFUSED on every write path today, and that is a switch rather than a
// bug: ENABLED_PAYOUT_METHODS is ['mobile_money'], and PayoutMethodZodSchema pipes that
// switch in front of the shape check so a client posting a half-filled bank form hears "not
// available right now" instead of "bank_name is required". Reads, the payout pipeline and
// the Mongoose enum all ignore the switch on purpose, so a disabled kind never strands
// money already addressed to one.
//
// This assertion therefore follows the SETTING rather than hardcoding an outcome — the same
// thing test:payout-methods does. It used to assert that a bank payout parsed, which is the
// shape of the failure carried as T-2 in the production-readiness register.
assert('Step 1 refuses a bank payout while the switch is mobile_money-only', () => {
    if (isPayoutMethodEnabled('bank')) return true; // re-enabled: nothing to assert here
    const parsed = VendorOnboardingStep1Schema.safeParse({
        country: 'CM',
        timezone: 'Africa/Douala',
        payout_details: [{
            method: 'bank',
            bank: { bank_name: 'Afriland First Bank', account_number: '123456789', account_name: 'John Doe', country: 'CM' },
        }],
    });
    return parsed.success === false;
});

assertZodFails('Step 1 rejects bank method without bank data', VendorOnboardingStep1Schema, {
    country: 'CM',
    timezone: 'Africa/Douala',
    payout_details: [{ method: 'bank', bank: null }],
});

console.log(`\n─────────────────────────────────────────────────────────────────────────`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
