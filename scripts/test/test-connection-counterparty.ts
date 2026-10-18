/**
 * Test: the counterparty on a vendor↔agency connection (2026-10-18).
 *
 * Follows the scripts/test convention — plain ts-node, hand-rolled asserts, no framework.
 * DB-free: `ConnectionService`'s repositories are swapped for fakes after construction.
 *
 * ── What this suite is really protecting ─────────────────────────────────────
 *
 * Since 2026-10-18 the directories (`/browse`) list `active` accounts only. The agency
 * dashboard had been naming its connection rows by scanning `/browse` for the vendor id, so
 * the rows that most needed a name — a `pending_verification` vendor — lost it.
 * `counterpartyProfile` names the row from the counterparty's OWN records. The failure it
 * guards against is silent: a row resolved through the directory still renders, just as
 * "Vendor …abc123".
 *
 *   - **A pending counterparty is named.** The whole point; asserted for both directions.
 *   - **A missing counterparty is `null`, never a half-filled profile.**
 *   - **One lookup per page, not per row** — the fakes count their calls.
 *   - **The DTO carries both fields, derived from one value**, so status and profile can
 *     never describe two different reads.
 *
 * Run: npm run test:connection-counterparty
 */
import { Types } from 'mongoose';
import { ConnectionService } from '../../src/modules/agency-connections/connection.service';
import { ConnectionMapper } from '../../src/modules/agency-connections/dto/connection.dto';
import { IVendorAgencyConnection } from '../../src/modules/agency-connections/connection.model';

let passed = 0;
let failed = 0;

function assert(name: string, ok: boolean): void {
  if (ok) {
    console.log(`  ✅ ${name}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${name}`);
    failed++;
  }
}

const VENDOR_A = new Types.ObjectId();
const VENDOR_GONE = new Types.ObjectId();
const AGENCY_A = new Types.ObjectId();
const AGENCY_B = new Types.ObjectId();
const LOGO = new Types.ObjectId().toString();

function connection(vendorId: Types.ObjectId, agencyId: Types.ObjectId): IVendorAgencyConnection {
  const now = new Date();
  return {
    _id: new Types.ObjectId(),
    vendor_id: vendorId,
    agency_id: agencyId,
    status: 'pending',
    requester_role: 'vendor',
    requested_by_user_id: new Types.ObjectId(),
    requested_at: now,
    responded_by_user_id: null,
    responded_at: null,
    reapproval_required_from: null,
    paused_at: null,
    paused_reason: null,
    rejection: null,
    withdrawal: null,
    termination: null,
    created_at: now,
    updated_at: now,
  } as unknown as IVendorAgencyConnection;
}

async function main(): Promise<void> {
  const calls = { vendorRows: 0, agencyRows: 0, stores: 0, magazins: 0, files: 0 };
  const svc = new ConnectionService();
  const s = svc as any;

  s.vendorRepo = {
    findConnectionCounterparts: async (ids: string[]) => {
      calls.vendorRows++;
      const out = new Map();
      if (ids.includes(VENDOR_A.toString())) {
        out.set(VENDOR_A.toString(), { status: 'pending_verification', displayName: 'Amina', kycVerified: false });
      }
      return out;
    },
  };
  s.storeRepo = {
    findNamesByVendorIds: async () => {
      calls.stores++;
      return new Map([[VENDOR_A.toString(), { name: 'Chez Amina', logoFileId: LOGO }]]);
    },
  };
  s.agencyRepo = {
    findConnectionCounterparts: async () => {
      calls.agencyRows++;
      return new Map([
        [AGENCY_A.toString(), { status: 'pending_verification', displayName: 'Akwa', kycVerified: true }],
        [AGENCY_B.toString(), { status: 'active', displayName: null, kycVerified: false }],
      ]);
    },
  };
  s.magazinRepo = {
    findNamesByAgencyIds: async () => {
      calls.magazins++;
      // AGENCY_B has no Magazin yet.
      return new Map([[AGENCY_A.toString(), { name: 'Akwa Express', logoFileId: null }]]);
    },
  };
  s.fileRepository = {
    findManyByIds: async (ids: string[]) => {
      calls.files++;
      return ids.map((id) => ({ id, key: `images/${id}.png`, mimeType: 'image/png', size: 1, originalName: 'logo.png' }));
    },
  };
  s.storageProvider = { getPublicUrl: (key: string) => `https://cdn.test/${key}` };

  // ── Agency caller: the counterparty is the VENDOR ──────────────────────────
  console.log('\n── Agency caller sees the vendor ──');
  const pendingVendorRow = connection(VENDOR_A, AGENCY_A);
  const goneVendorRow = connection(VENDOR_GONE, AGENCY_A);
  const forAgency = await svc.counterpartiesFor('agency', [pendingVendorRow, goneVendorRow]);
  const pendingVendor = forAgency.get(pendingVendorRow._id.toString());

  assert('a pending_verification vendor is NAMED (the reason this exists)',
    pendingVendor?.status === 'pending_verification' && pendingVendor.profile.businessName === 'Chez Amina');
  assert('displayName and kycVerified come from the vendor row',
    pendingVendor?.profile.displayName === 'Amina' && pendingVendor.profile.kycVerified === false);
  assert('the Store logo is resolved to a FileDetail',
    pendingVendor?.profile.logo?.id === LOGO && pendingVendor.profile.logo.url === `https://cdn.test/images/${LOGO}.png`);
  assert('a vendor that no longer exists is null, not a half-filled profile',
    forAgency.get(goneVendorRow._id.toString()) === null);
  assert('one lookup per page: one row query, one Store query, one logo resolve',
    calls.vendorRows === 1 && calls.stores === 1 && calls.files === 1 && calls.agencyRows === 0);

  // ── Vendor caller: the counterparty is the AGENCY ──────────────────────────
  console.log('\n── Vendor caller sees the agency ──');
  const rowA = connection(VENDOR_A, AGENCY_A);
  const rowB = connection(VENDOR_A, AGENCY_B);
  const forVendor = await svc.counterpartiesFor('vendor', [rowA, rowB]);
  const agencyA = forVendor.get(rowA._id.toString());
  const agencyB = forVendor.get(rowB._id.toString());

  assert('a pending_verification agency is named from its Magazin',
    agencyA?.status === 'pending_verification' && agencyA.profile.businessName === 'Akwa Express' && agencyA.profile.logo === null);
  assert('an agency with no Magazin yet gets businessName "" (the browse DTOs\' fallback)',
    agencyB?.status === 'active' && agencyB.profile.businessName === '' && agencyB.profile.displayName === null);
  assert('the vendor side reads agencies and Magazins, never vendors or Stores',
    calls.agencyRows === 1 && calls.magazins === 1 && calls.vendorRows === 1 && calls.stores === 1);

  // ── Empty page ──────────────────────────────────────────────────────────────
  const empty = await svc.counterpartiesFor('agency', []);
  assert('an empty page queries nothing', empty.size === 0 && calls.vendorRows === 1);

  // ── The DTO ─────────────────────────────────────────────────────────────────
  console.log('\n── ConnectionDto ──');
  const dto = ConnectionMapper.toDto(pendingVendorRow, pendingVendor ?? null);
  assert('the DTO carries counterpartyStatus and counterpartyProfile from ONE value',
    dto.counterpartyStatus === 'pending_verification' && dto.counterpartyProfile?.businessName === 'Chez Amina');
  const goneDto = ConnectionMapper.toDto(goneVendorRow, null);
  assert('a missing counterparty yields null for BOTH fields',
    goneDto.counterpartyStatus === null && goneDto.counterpartyProfile === null);

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log(`${'─'.repeat(60)}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

void main();
