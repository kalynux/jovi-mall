/**
 * Clearable-field validator tests (no DB needed).
 *
 * Verifies the `clearable()` Zod helper semantics across the validators that
 * adopted it: absent = leave unchanged, ''/null = clear (normalised to null),
 * anything else must satisfy the wrapped constraint. Also proves that required
 * fields did NOT become clearable, and that the store mapper propagates null.
 *
 * Run: npx ts-node scripts/test/test-clearable-validators.ts
 */

import { UpdateStoreProfileSchema } from '../../src/modules/store/validators/store.validator';
import { StoreProfileMapper } from '../../src/modules/store/dto/store-profile.dto';
import { UpdateAdminProfileSchema } from '../../src/modules/admins/validators/admin-profile.validator';
import {
  SetAvailabilitySchema,
  SetTrackingAllowedSchema,
  UpdateAgentProfileSchema,
} from '../../src/modules/agents/validators/agent.validator';
import { UpdateProductSchema } from '../../src/modules/catalog/validators/product.validator';
import { UpdateCustomerProfileSchema } from '../../src/modules/customers/validators/customer-onboarding.validator';
import { UpdateVendorProfileSchema } from '../../src/modules/vendor/validators/vendor-onboarding.validator';
import { AddPaymentMethodSchema } from '../../src/modules/payment-methods/validators/payment-method.validators';

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL  ${label}`);
  }
}

// ─── Store profile ────────────────────────────────────────────────────────────

{
  const validId = '507f1f77bcf86cd799439011';

  // The reported bug: '' and null must both clear, not 400.
  const emptyStr = UpdateStoreProfileSchema.safeParse({ version: 1, logoFileId: '' });
  assert(emptyStr.success && emptyStr.data.logoFileId === null, "store: logoFileId '' → null");

  const nullVal = UpdateStoreProfileSchema.safeParse({ version: 1, logoFileId: null });
  assert(nullVal.success && nullVal.data.logoFileId === null, 'store: logoFileId null → null');

  const whitespace = UpdateStoreProfileSchema.safeParse({ version: 1, description: '   ' });
  assert(whitespace.success && whitespace.data.description === null, "store: description '   ' → null");

  const kept = UpdateStoreProfileSchema.safeParse({ version: 1, logoFileId: validId });
  assert(kept.success && kept.data.logoFileId === validId, 'store: valid logoFileId kept');

  const invalid = UpdateStoreProfileSchema.safeParse({ version: 1, logoFileId: 'not-an-id' });
  assert(!invalid.success, 'store: invalid logoFileId still rejected');

  const absent = UpdateStoreProfileSchema.safeParse({ version: 1 });
  assert(absent.success && !('logoFileId' in (absent.data as Record<string, unknown>)), 'store: absent logoFileId stays absent');

  const phoneCleared = UpdateStoreProfileSchema.safeParse({ version: 1, supportPhone: '' });
  assert(phoneCleared.success && phoneCleared.data.supportPhone === null, "store: supportPhone '' → null");

  const phoneShort = UpdateStoreProfileSchema.safeParse({ version: 1, supportPhone: '123' });
  assert(!phoneShort.success, 'store: supportPhone shorter than 8 still rejected');

  // `name` is required in the model — it must NOT be clearable.
  assert(!UpdateStoreProfileSchema.safeParse({ version: 1, name: '' }).success, "store: name '' rejected");
  assert(!UpdateStoreProfileSchema.safeParse({ version: 1, name: null }).success, 'store: name null rejected');

  // The mapper must propagate null (= clear) into the persistence payload.
  const clearedPayload = StoreProfileMapper.toUpdatePayload({ version: 1, logoFileId: null, description: 'Shop' });
  assert(clearedPayload.logo_file_id === null, 'store mapper: null flows into payload as logo_file_id: null');
  assert(clearedPayload.description === 'Shop', 'store mapper: values still map');
  assert(!('banner_file_id' in clearedPayload), 'store mapper: absent fields stay out of payload');

  // A valid file id maps to an ObjectId on the persistence payload.
  const setPayload = StoreProfileMapper.toUpdatePayload({ version: 1, logoFileId: validId });
  assert(setPayload.logo_file_id?.toString() === validId, 'store mapper: valid id maps to ObjectId');
}

// ─── Admin profile ────────────────────────────────────────────────────────────

{
  const cleared = UpdateAdminProfileSchema.safeParse({ job_title: '', avatar_url: null });
  assert(cleared.success && cleared.data.job_title === null && cleared.data.avatar_url === null,
    "admin: job_title ''/avatar_url null → null");

  assert(!UpdateAdminProfileSchema.safeParse({ avatar_url: 'nope' }).success, 'admin: invalid avatar_url still rejected');
}

// ─── Agent ────────────────────────────────────────────────────────────────────

{
  const availability = SetAvailabilitySchema.safeParse({ state: 'online', reason: '' });
  assert(availability.success && availability.data.reason === null, "agent: availability reason '' → null");

  const availabilityDefault = SetAvailabilitySchema.safeParse({ state: 'offline' });
  assert(availabilityDefault.success && availabilityDefault.data.reason === null, 'agent: absent reason defaults to null');

  // Disabling tracking REQUIRES a reason — '' must not satisfy it.
  assert(!SetTrackingAllowedSchema.safeParse({ allowed: false, reason: '' }).success,
    "agent: tracking-disable with '' reason still rejected");
  assert(SetTrackingAllowedSchema.safeParse({ allowed: false, reason: 'policy violation' }).success,
    'agent: tracking-disable with real reason accepted');

  const profile = UpdateAgentProfileSchema.safeParse({ avatar_url: '' });
  assert(profile.success && profile.data.avatar_url === null, "agent: avatar_url '' → null");
}

// ─── Catalog product update ───────────────────────────────────────────────────

{
  const clearedAgency = UpdateProductSchema.safeParse({ delivery: { agencyId: '' } });
  assert(clearedAgency.success && clearedAgency.data.delivery?.agencyId === null,
    "product: delivery.agencyId '' → null (clears per-product agency)");

  // pickupLocation refine: vendor_address source still requires a real id.
  assert(!UpdateProductSchema.safeParse({ delivery: { pickupLocation: { source: 'vendor_address', vendorAddressId: '' } } }).success,
    "product: pickup source vendor_address with '' id still rejected");
}

// ─── Customer profile ─────────────────────────────────────────────────────────

{
  const cleared = UpdateCustomerProfileSchema.safeParse({ avatarUrl: '', bio: '' });
  assert(cleared.success && cleared.data.avatarUrl === null && cleared.data.bio === null,
    "customer: avatarUrl/bio '' → null");

  assert(!UpdateCustomerProfileSchema.safeParse({ name: null }).success, 'customer: name null rejected');
}

// ─── Vendor profile (PATCH /api/vendor/profile) ───────────────────────────────

{
  const cleared = UpdateVendorProfileSchema.safeParse({ version: 1, businessDescription: '' });
  assert(cleared.success && cleared.data.businessDescription === null,
    "vendor profile: businessDescription '' → null");

  const socials = UpdateVendorProfileSchema.safeParse({
    version: 1,
    social_links: { instagram: '', facebook: null, twitter: 'https://x.com/shop' },
  });
  assert(socials.success
    && socials.data.social_links?.instagram === null
    && socials.data.social_links?.facebook === null
    && socials.data.social_links?.twitter === 'https://x.com/shop',
    'vendor profile: social links clear via \'\'/null, valid URL kept');

  // Identity fields did NOT become clearable.
  assert(!UpdateVendorProfileSchema.safeParse({ version: 1, email: '' }).success, "vendor profile: email '' rejected");
  assert(!UpdateVendorProfileSchema.safeParse({ version: 1, phone: null }).success, 'vendor profile: phone null rejected');
}

// ─── Payment methods (add) ────────────────────────────────────────────────────

{
  const base = {
    provider: 'stripe',
    gateway_customer_id: 'cus_1',
    gateway_instrument_id: 'pm_1',
    method_type: 'card',
    display_label: 'VISA •••• 4242',
  };

  const cleared = AddPaymentMethodSchema.safeParse({ ...base, brand: '', last4: '', holder_name: '' });
  assert(cleared.success
    && cleared.data.brand === null && cleared.data.last4 === null && cleared.data.holder_name === null,
    "payment method: ''-valued display fields → null");

  assert(!AddPaymentMethodSchema.safeParse({ ...base, last4: '123' }).success,
    'payment method: 3-digit last4 still rejected');
}

// ─── Result ───────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
