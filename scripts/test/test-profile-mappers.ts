/**
 * Test: Profile Mapper Security (DTO field redaction)
 *
 * Run: npx ts-node scripts/test/test-profile-mappers.ts
 *
 * DB-free. Every mock below carries a null avatar/logo reference, so the file
 * resolver short-circuits and the stub repo/storage are never actually called —
 * which is what keeps this runnable without Mongo or a storage provider.
 */
import { VendorProfileMapper } from '../../src/modules/vendor/dto/vendor-profile.dto';
import { CustomerProfileMapper } from '../../src/modules/customers/dto/customer-profile.dto';
import { AgencyProfileMapper } from '../../src/modules/delivery/dto/agency-profile.dto';
import { AgentProfileMapper } from '../../src/modules/agents';
import { AdminProfileMapper } from '../../src/modules/admins/dto/admin-profile.dto';
import { FileRepositoryMongo } from '../../src/modules/catalog/repositories/mongo/file.repository.mongo';
import { IStorageProvider } from '../../src/core/storage';

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

// Minimal mock helpers
function makeDoc(overrides: Record<string, unknown> = {}): any {
    return {
        _id: { toString: () => 'mock-id' },
        created_at: new Date(),
        updated_at: new Date(),
        ...overrides,
    };
}

/**
 * The mappers take a file repository and a storage provider to resolve avatar
 * references. Every mock here has none, so these stubs exist only to satisfy the
 * signatures — a call to either means a mock grew a file id and the test needs
 * a real fixture, so they throw rather than return a silent null.
 */
const stubFileRepo = {
    findById: () => { throw new Error('stub file repo called — a mock grew a file reference'); },
} as unknown as FileRepositoryMongo;
const stubStorage = {
    getPublicUrl: () => { throw new Error('stub storage called — a mock grew a file reference'); },
} as unknown as IStorageProvider;

async function main(): Promise<void> {
    // ─── Vendor Mapper ────────────────────────────────────────────────────────
    console.log('\n── Vendor Profile Mapper ─────────────────────────────────────────────────');

    const vendorMock = makeDoc({
        email: 'vendor@test.com', email_verified: true,
        phone: '+237670000001', phone_verified: false,
        business_name: 'Test Shop', display_name: 'Test',
        business_description: null, country: 'CM',
        branding: { logo_file_id: null, cover_image_file_id: null },
        business_addresses: [], operating_hours: [],
        // An ordered array of methods — the FIRST is the one payouts use.
        payout_details: [{
            method: 'mobile_money',
            mobile_money: { provider: 'MTN', phone_number: '670123456', account_name: 'John' },
            bank: null,
        }],
        kyc_details: { national_id_number: 'SECRET-ID-12345', legit_verified: false },
        social_links: { instagram: null, facebook: null, twitter: null },
        notification_preferences: { email: true, whatsapp: false, phone: false },
        two_factor_enabled: false,
        status: 'active', version: 0, timezone: 'Africa/Douala',
        onboarding_step: 0,
    });

    const vendorDto = await VendorProfileMapper.toResponseDto(vendorMock, stubFileRepo, stubStorage);

    assert('Vendor DTO never contains national_id_number', () => {
        return !JSON.stringify(vendorDto).includes('SECRET-ID-12345');
    });

    assert('Vendor DTO masks payout phone number', () => {
        const mm = vendorDto.payoutDetails?.mobile_money;
        return !!mm && !mm.phone_number_masked.includes('670123456');
    });

    assert('Vendor DTO has kycVerified (not kyc_details object)', () => {
        return typeof (vendorDto as any).kycVerified === 'boolean'
            && (vendorDto as any).kyc_details === undefined;
    });

    // ─── Agency Mapper ────────────────────────────────────────────────────────
    console.log('\n── Agency Profile Mapper ─────────────────────────────────────────────────');

    const agencyPayload = AgencyProfileMapper.toUpdatePayload({
        kyc_details: { national_id_number: 'ID-999' },
    } as any);

    assert('Agency update payload forces legit_verified false on KYC edit', () => {
        return (agencyPayload as any).kyc_details?.legit_verified === false;
    });

    // ─── Customer Mapper ──────────────────────────────────────────────────────
    console.log('\n── Customer Profile Mapper ───────────────────────────────────────────────');

    const customerMock = makeDoc({
        email: 'customer@test.com', email_verified: true,
        phone: '+2348012345678', phone_verified: true,
        first_name: 'Ada', last_name: 'Eze', avatar_url: null,
        saved_addresses: [], preferences: {},
        wa: null, timezone: 'Africa/Lagos', status: 'active', onboarding_step: 0,
    });

    const savedPaymentMethods = [{
        id: 'pm-1',
        provider: 'paystack',
        display_label: 'Visa •••• 4242',
        method_type: 'card',
        is_default: true,
    }] as any;

    const customerDto = await CustomerProfileMapper.toResponseDto(
        customerMock,
        savedPaymentMethods,
        stubFileRepo,
        stubStorage,
    );

    assert('Customer DTO never contains gateway_customer_id', () => {
        return !JSON.stringify(customerDto).includes('cus_SECRET_GATEWAY_ID');
    });

    assert('Customer DTO never contains gateway_instrument_id', () => {
        return !JSON.stringify(customerDto).includes('inst_SECRET_INSTRUMENT_ID');
    });

    assert('Customer DTO includes display_label for payment method', () => {
        return customerDto.savedPaymentMethods[0].display_label === 'Visa •••• 4242';
    });

    assert('Customer DTO onboarding_step is always 0', () => {
        return customerDto.onboardingStep === 0;
    });

    // ─── Agent Mapper ─────────────────────────────────────────────────────────
    console.log('\n── Agent Profile Mapper ──────────────────────────────────────────────────');

    // No agency_id: an agent may serve several agencies, so the link lives on
    // AgentAgencyMembership and is never embedded in the profile DTO.
    const agentMock = makeDoc({
        name: 'Bob Driver',
        email: null, email_verified: false, phone: null, phone_verified: false,
        avatar_url: null,
        vehicle_info: { vehicle_type: 'bike', plate_number: 'CE-1234', color: 'Red' },
        legal_identity: { drivers_license_number: 'SECRET-LICENSE', national_id_number: 'SECRET-NATIONAL-ID' },
        emergency_contact: null,
        cod: { trust_score: 100 },
        availability: { state: 'offline', changed_at: new Date(), reason: null },
        // Deliberately DIFFERENT from capacity.active_shipment_count below: the
        // two counters can drift, and the DTO must report the authoritative one.
        working_state: { state: 'working', active_shipment_count: 7, computed_at: new Date() },
        tracking: { allowed: true, reason: null, changed_at: new Date(), changed_by_user_id: null, changed_by_role: null },
        device: { platform: 'unknown', location_permission: 'unknown', location_services_enabled: null, reported_at: null },
        last_known_tracking_state: { status: 'unknown', last_position: null, last_reported_at: null, source: null },
        preferences: { navigation_app: 'google_maps' },
        settings: { auto_accept_assignments: false },
        capacity: { max_active_shipments: 20, active_shipment_count: 3, reconciled_at: null },
        wa: null, timezone: 'Africa/Douala', status: 'active', status_reason: null, onboarding_step: 0,
    });

    const agentDto = AgentProfileMapper.toResponseDto(agentMock);

    assert('Agent DTO never contains legal_identity', () => {
        return !JSON.stringify(agentDto).includes('SECRET-LICENSE')
            && !JSON.stringify(agentDto).includes('SECRET-NATIONAL-ID');
    });

    assert('Agent DTO contains vehicle_info', () => {
        return agentDto.vehicleInfo?.vehicle_type === 'bike';
    });

    assert('Agent DTO carries no agencyId (agents may serve several agencies)', () => {
        return !('agencyId' in agentDto);
    });

    assert('Agent DTO exposes capacity so the app can show "3 of 20"', () => {
        return agentDto.capacity.maxActiveShipments === 20
            && agentDto.capacity.activeShipmentCount === 3
            && agentDto.capacity.remaining === 17;
    });

    assert('Agent capacity reads capacity.*, not the working_state counter', () => {
        // working_state says 7; capacity says 3. Only capacity is compare-and-set
        // on accept, so it is the one admission control and the app must agree on.
        return agentDto.capacity.activeShipmentCount === 3;
    });

    assert('Agent capacity remaining never goes negative', () => {
        const overCommitted = AgentProfileMapper.toCapacityDto(
            makeDoc({ capacity: { max_active_shipments: 2, active_shipment_count: 5, reconciled_at: null } }),
        );
        return overCommitted.remaining === 0;
    });

    assert('Agent preferences carry no dead notify_* flags', () => {
        return !('notify_on_assignment' in agentDto.preferences)
            && !('notify_on_shipment_update' in agentDto.preferences);
    });

    assert('Agent roster entry reports the authoritative in-flight count', () => {
        return AgentProfileMapper.toRosterEntryDto(agentMock).activeShipmentCount === 3;
    });

    // ─── Admin Mapper ─────────────────────────────────────────────────────────
    console.log('\n── Admin Profile Mapper ──────────────────────────────────────────────────');

    const adminMock = makeDoc({
        name: 'Super Admin', email: 'admin@test.com',
        avatar_url: null, job_title: 'CTO', department: 'Engineering',
        two_factor_enabled: true, last_login_ip: '192.168.1.100',
        timezone: 'UTC', onboarding_step: 0,
    });

    const adminPublicDto = await AdminProfileMapper.toResponseDto(adminMock, stubFileRepo, stubStorage);
    const adminSelfDto = await AdminProfileMapper.toSelfResponseDto(adminMock, stubFileRepo, stubStorage);

    assert('Admin public DTO never contains last_login_ip', () => {
        return !('lastLoginIp' in adminPublicDto);
    });

    assert('Admin self DTO contains last_login_ip', () => {
        return adminSelfDto.lastLoginIp === '192.168.1.100';
    });

    assert('Admin onboarding_step is always 0', () => {
        return adminPublicDto.onboardingStep === 0;
    });

    // ─── Summary ──────────────────────────────────────────────────────────────
    console.log(`\n─────────────────────────────────────────────────────────────────────────`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

main().catch((err) => {
    console.error('Test run threw:', err);
    process.exit(1);
});
