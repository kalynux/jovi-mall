/**
 * Test: the agent's vehicle profile — colour vocabulary + `vehicle_info` merge.
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no
 * framework). DB-free, and that is what it is for: the merge is the thing that
 * makes `clearable()` mean *omit = unchanged* on `plate_number` and
 * `photo_file_id`, and getting it wrong is silent — a client PATCHing a plate
 * number drops the photo, the request returns 200, and nothing errors anywhere.
 *
 * The schema half matters for the same reason: `z.object` strips unknown keys
 * without complaint, which is exactly how `photo_file_id` used to vanish.
 *
 * Run: npm run test:vehicle-profile
 */
import mongoose from 'mongoose';
import {
  VEHICLE_COLORS,
  normalizeVehicleColor,
  isVehicleColorToken,
  mergeVehicleInfo,
} from '../../src/modules/agents/domain/vehicle-info';
import {
  UpdateAgentProfileSchema,
  AgentOnboardingStep1Schema,
} from '../../src/modules/agents/validators/agent.validator';
import { AgentProfileMapper } from '../../src/modules/agents/dto/agent-profile.dto';
import { IAgentVehicleInfo } from '../../src/modules/agents/models/agent.model';

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

// ─── Fixtures ────────────────────────────────────────────────────────────────

const PHOTO_A = '665f1c2a9b1e4a0012a3b4ee';
const PHOTO_B = '665f1c2a9b1e4a0012a3b4ff';

const stored = (over: Partial<IAgentVehicleInfo> = {}): IAgentVehicleInfo => ({
  vehicle_type: 'van',
  plate_number: 'LT-123-AB',
  color: 'white',
  photo_file_id: new mongoose.Types.ObjectId(PHOTO_A),
  ...over,
});

function main(): void {
  console.log('\n=== Vehicle profile: colour vocabulary + vehicle_info merge ===\n');

  // ── The vocabulary ─────────────────────────────────────────────────────────
  console.log('Colour normalization');

  assert('every token normalizes to itself (the palette is already canonical)', () =>
    VEHICLE_COLORS.every((c) => normalizeVehicleColor(c) === c));

  assert('capitalisation is folded: "Red" → "red"', () => normalizeVehicleColor('Red') === 'red');
  assert('surrounding whitespace is trimmed', () => normalizeVehicleColor('  blue  ') === 'blue');
  assert('inner whitespace is collapsed', () => normalizeVehicleColor('dark   blue') === 'dark blue');
  assert('gray → grey (the one real alias)', () => normalizeVehicleColor('GRAY') === 'grey');

  assert('an unrecognised colour survives VERBATIM (the escape hatch)', () =>
    normalizeVehicleColor('Rouge Bordeaux') === 'rouge bordeaux');

  assert('normalization is idempotent', () =>
    ['Red', ' GRAY ', 'Rouge Bordeaux', 'silver'].every(
      (c) => normalizeVehicleColor(normalizeVehicleColor(c)) === normalizeVehicleColor(c),
    ));

  assert('isVehicleColorToken recognises the palette', () => VEHICLE_COLORS.every(isVehicleColorToken));
  assert('isVehicleColorToken rejects free text', () => !isVehicleColorToken('rouge bordeaux'));
  assert('isVehicleColorToken rejects an un-normalized token', () => !isVehicleColorToken('Red'));

  // ── The merge ──────────────────────────────────────────────────────────────
  console.log('\nvehicle_info merge (clearable = omit means unchanged)');

  assert('omitting photo_file_id KEEPS the stored photo', () => {
    const merged = mergeVehicleInfo(stored(), { vehicle_type: 'van', color: 'white', plate_number: 'NEW-1' });
    return merged.photo_file_id?.toString() === PHOTO_A;
  });

  assert('omitting plate_number KEEPS the stored plate', () => {
    const merged = mergeVehicleInfo(stored(), { vehicle_type: 'van', color: 'white', photo_file_id: PHOTO_B });
    return merged.plate_number === 'LT-123-AB';
  });

  assert('null photo_file_id CLEARS the photo', () => {
    const merged = mergeVehicleInfo(stored(), { vehicle_type: 'van', color: 'white', photo_file_id: null });
    return merged.photo_file_id === null;
  });

  assert('null plate_number CLEARS the plate', () => {
    const merged = mergeVehicleInfo(stored(), { vehicle_type: 'van', color: 'white', plate_number: null });
    return merged.plate_number === null;
  });

  assert('a new photo_file_id REPLACES the stored one, as an ObjectId', () => {
    const merged = mergeVehicleInfo(stored(), { vehicle_type: 'van', color: 'white', photo_file_id: PHOTO_B });
    return merged.photo_file_id instanceof mongoose.Types.ObjectId && merged.photo_file_id.toString() === PHOTO_B;
  });

  assert('vehicle_type and color always come from the patch (both are required)', () => {
    const merged = mergeVehicleInfo(stored(), { vehicle_type: 'bike', color: 'Black' });
    return merged.vehicle_type === 'bike' && merged.color === 'black';
  });

  assert('colour is normalized on the way in', () => {
    const merged = mergeVehicleInfo(stored(), { vehicle_type: 'van', color: ' Gray ' });
    return merged.color === 'grey';
  });

  assert('merging onto nothing yields nulls, not undefined', () => {
    const merged = mergeVehicleInfo(null, { vehicle_type: 'car', color: 'red' });
    return merged.plate_number === null && merged.photo_file_id === null;
  });

  assert('a legacy sub-document with no photo_file_id key merges to null', () => {
    const legacy = { vehicle_type: 'car', plate_number: null, color: 'red' } as IAgentVehicleInfo;
    return mergeVehicleInfo(legacy, { vehicle_type: 'car', color: 'red' }).photo_file_id === null;
  });

  // ── The schema ─────────────────────────────────────────────────────────────
  console.log('\nValidation (z.object strips unknown keys — the original bug)');

  assert('PATCH /profile accepts photo_file_id', () => {
    const parsed = UpdateAgentProfileSchema.parse({
      vehicle_info: { vehicle_type: 'van', color: 'white', photo_file_id: PHOTO_A },
    });
    return parsed.vehicle_info?.photo_file_id === PHOTO_A;
  });

  assert('onboarding step 1 accepts photo_file_id too (same sub-schema)', () => {
    const parsed = AgentOnboardingStep1Schema.parse({
      vehicle_info: { vehicle_type: 'bike', color: 'red', photo_file_id: PHOTO_A },
    });
    return parsed.vehicle_info.photo_file_id === PHOTO_A;
  });

  assert('an omitted photo_file_id parses to undefined, not null', () => {
    const parsed = AgentOnboardingStep1Schema.parse({ vehicle_info: { vehicle_type: 'bike', color: 'red' } });
    return parsed.vehicle_info.photo_file_id === undefined;
  });

  assert('"" clears (clearable normalises it to null)', () => {
    const parsed = AgentOnboardingStep1Schema.parse({
      vehicle_info: { vehicle_type: 'bike', color: 'red', photo_file_id: '' },
    });
    return parsed.vehicle_info.photo_file_id === null;
  });

  assert('a non-hex photo_file_id is rejected', () => {
    const r = AgentOnboardingStep1Schema.safeParse({
      vehicle_info: { vehicle_type: 'bike', color: 'red', photo_file_id: 'not-an-id' },
    });
    return !r.success;
  });

  assert('color stays free text — an off-palette value still validates', () => {
    const r = AgentOnboardingStep1Schema.safeParse({
      vehicle_info: { vehicle_type: 'bike', color: 'Rouge Bordeaux' },
    });
    return r.success;
  });

  assert('color is still bounded at 50 chars', () => {
    const r = AgentOnboardingStep1Schema.safeParse({
      vehicle_info: { vehicle_type: 'bike', color: 'x'.repeat(51) },
    });
    return !r.success;
  });

  // ── The wire shape ─────────────────────────────────────────────────────────
  console.log('\nWire shape (a raw file id must never reach a client)');

  const photoDetail = {
    id: PHOTO_A,
    key: 'agents/van.jpg',
    url: 'https://cdn.example/agents/van.jpg',
    mimeType: 'image/jpeg',
    size: 284119,
    originalName: 'van.jpg',
  };

  assert('toVehicleInfoDto emits `photo`, never `photo_file_id`', () => {
    const dto = AgentProfileMapper.toVehicleInfoDto(stored(), photoDetail)!;
    return dto.photo?.id === PHOTO_A && !('photo_file_id' in dto);
  });

  assert('an unresolvable photo becomes null, not a dangling id', () =>
    AgentProfileMapper.toVehicleInfoDto(stored(), null)!.photo === null);

  assert('the roster summary carries no photo key at all', () => {
    const dto = AgentProfileMapper.toVehicleSummaryDto(stored())!;
    return !('photo' in dto) && !('photo_file_id' in dto) && dto.color === 'white';
  });

  assert('both mappers pass a null vehicle straight through', () =>
    AgentProfileMapper.toVehicleInfoDto(null, photoDetail) === null &&
    AgentProfileMapper.toVehicleSummaryDto(null) === null);

  assert('toUpdatePayload MERGES rather than replaces', () => {
    const input = UpdateAgentProfileSchema.parse({
      vehicle_info: { vehicle_type: 'van', color: 'white', plate_number: 'NEW-1' },
    });
    const payload = AgentProfileMapper.toUpdatePayload(input, stored());
    return payload.vehicle_info?.photo_file_id?.toString() === PHOTO_A;
  });

  console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main();
