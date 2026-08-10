import mongoose from 'mongoose';
import { IAgentVehicleInfo } from '../models/agent.model';

/**
 * Vehicle colour vocabulary + the `vehicle_info` merge rule.
 *
 * Pure and DB-free on purpose — covered by `npm run test:vehicle-profile`.
 *
 * ── Why `color` is a convention, not an enum ────────────────────────────────
 *
 * The app writes one of {@link VEHICLE_COLORS}, but the field stays
 * `z.string().min(1).max(50)`. Two populations would otherwise fail validation
 * on their next profile save: every agent onboarded before the palette existed,
 * and the "another colour" escape hatch the app keeps for a two-tone or unusual
 * vehicle. So we normalize on write and store anything unrecognised verbatim —
 * the vocabulary is what consumers can *rely on*, not what they can *assume*.
 *
 * Same convention `vehicle_type` already uses: lowercase, singular, English,
 * never localized on the wire. Each consumer renders its own label and swatch.
 */

export const VEHICLE_COLORS = [
  'white',
  'silver',
  'grey',
  'black',
  'red',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'brown',
  'beige',
  'gold',
] as const;

export type VehicleColorToken = (typeof VEHICLE_COLORS)[number];

/**
 * Spellings that mean a token but are not one. Deliberately tiny: capitalisation
 * (`Red`) is handled by the lowercasing below, so only genuine *different words*
 * belong here. Grow it from the migration's unmapped report, not from guesses —
 * inventing an alias silently rewrites what an agent typed.
 */
const VEHICLE_COLOR_ALIASES: Readonly<Record<string, VehicleColorToken>> = {
  gray: 'grey',
};

/**
 * Lowercase, trim, collapse inner whitespace, then map a known alias to its
 * token. Anything that does not match is returned as-is — that is the escape
 * hatch, and it must survive intact.
 */
export function normalizeVehicleColor(raw: string): string {
  const cleaned = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  return VEHICLE_COLOR_ALIASES[cleaned] ?? cleaned;
}

export function isVehicleColorToken(value: string): value is VehicleColorToken {
  return (VEHICLE_COLORS as readonly string[]).includes(value);
}

/**
 * The validated `vehicle_info` sub-object as it arrives from Zod: the two
 * required facts, plus the two `clearable()` slots where **absent means
 * unchanged** and `null` means clear.
 */
export interface VehicleInfoPatch {
  vehicle_type: IAgentVehicleInfo['vehicle_type'];
  color: string;
  plate_number?: string | null;
  photo_file_id?: string | null;
}

/**
 * Merge a `vehicle_info` patch onto what is stored, rather than replacing the
 * sub-document wholesale.
 *
 * This is what makes `clearable()` mean what it says on `plate_number` and
 * `photo_file_id`. Under a wholesale replace, a client PATCHing `vehicle_info`
 * to fix a plate number silently drops the photo — the request returns 200 and
 * the file is gone on the next load. `vehicle_type` and `color` are required by
 * the schema, so they always come from the patch.
 */
export function mergeVehicleInfo(
  current: IAgentVehicleInfo | null | undefined,
  patch: VehicleInfoPatch,
): IAgentVehicleInfo {
  return {
    vehicle_type: patch.vehicle_type,
    color: normalizeVehicleColor(patch.color),
    plate_number: patch.plate_number !== undefined ? patch.plate_number : (current?.plate_number ?? null),
    photo_file_id:
      patch.photo_file_id !== undefined
        ? patch.photo_file_id
          ? new mongoose.Types.ObjectId(patch.photo_file_id)
          : null
        : (current?.photo_file_id ?? null),
  };
}
