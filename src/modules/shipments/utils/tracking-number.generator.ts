import { randomBytes } from 'crypto';
import { ClientSession } from 'mongoose';
import { ShipmentModel } from '../shipment.model';
import { AgencyMagazinModel } from '../../magazin/models/magazin.model';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';

/**
 * Shipment Tracking Number Generator
 *
 * Every shipment is stamped with a tracking number the moment it is created —
 * it is never typed in and never editable (the PATCH endpoints that used to set
 * it are gone). The number is the shipment's public handle: it is what a
 * customer quotes to support, what an agent reads off a parcel, and the only
 * text field the shipment search matches directly.
 *
 * Format — `ACR-YYMMDD-HHMMSS-XXXXX`, e.g. `FDO-260730-142309-K7Q2M`:
 *
 *   ACR      the delivery agency's acronym, derived from its Magazin business
 *            name (see `agencyAcronym`) — OWNERSHIP, readable at a glance
 *   YYMMDD   the UTC date the shipment was created — WHEN
 *   HHMMSS   the UTC time, to the second — WHEN, and most of the uniqueness
 *   XXXXX    5 random Crockford-base32 characters — UNIQUENESS, and what makes
 *            the number unguessable from a neighbouring one
 *
 * UTC deliberately: the platform spans time zones and a number that means a
 * different instant depending on who reads it is worse than one that always
 * needs a mental offset. Same reason the rest of the model stores UTC dates.
 *
 * **Uniqueness has two layers.** This generator pre-checks each candidate
 * against the collection (inside the caller's transaction session, so shipments
 * created earlier in the same checkout are visible), and the real guarantee is
 * the partial unique index on `tracking_number` in `shipment.model.ts`. The
 * random suffix draws from 32^5 ≈ 33.5M values, so two shipments would have to
 * be created for the same agency in the same second AND draw the same suffix
 * before the pre-check even has work to do.
 *
 * The acronym is a snapshot, not a live join: an agency that later renames
 * itself keeps its old shipments' numbers. That is the point — a tracking
 * number that changes is not a tracking number.
 */

/** Characters in the generated acronym segment. Also its minimum length. */
const ACRONYM_LENGTH = 3;

/**
 * Used when a business name yields no Latin letters or digits at all (a purely
 * non-Latin name, or an agency whose magazin has not been provisioned yet).
 * The random suffix still makes the number unique — only the ownership hint is
 * lost, and there was none to be had.
 */
const ACRONYM_FALLBACK = 'AGY';

/** Pads a short acronym ("A B" → "AB") up to ACRONYM_LENGTH. */
const ACRONYM_PAD = 'X';

const SUFFIX_LENGTH = 5;

/**
 * Crockford-style base32: the full alphabet minus I, L, O and U. Nobody has to
 * decide whether the character on a parcel label is a 1 or an I, and the set
 * cannot accidentally spell an offensive word (U is gone). Exactly 32 symbols,
 * so `byte & 31` samples it without modulo bias.
 */
const SUFFIX_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * How many candidates to try before giving up. A single collision is already
 * astronomically unlikely; five in a row means something is wrong (a clock
 * stuck, a broken RNG) and failing loudly beats looping.
 */
const MAX_GENERATION_ATTEMPTS = 5;

/**
 * Shape of a generated tracking number. Exported for the tests and for any
 * caller that needs to tell a generated number from a legacy hand-typed one
 * (pre-existing shipments carry whatever the agency last typed, or null).
 */
export const TRACKING_NUMBER_PATTERN = /^[A-Z0-9]{3}-\d{6}-\d{6}-[0-9A-HJKMNP-TV-Z]{5}$/;

/**
 * Derive a 3-character acronym from an agency's business name.
 *
 * Pure and deterministic — the same name always yields the same acronym, which
 * is what lets a human recognise the carrier from the number:
 *
 *   "FastShip Douala Express"  → FDE   (3+ words: one initial each)
 *   "FastShip Douala"          → FDO   (2 words: initial + first two letters)
 *   "Jovilog"                  → JOV   (1 word: first three letters)
 *   "Sécurité Livraison"       → SLI   (diacritics folded before initials)
 *   "A1 Express"               → A1E   (digits are kept — they are part of names)
 *   "四海快递"                  → AGY   (nothing Latin to work with)
 *
 * Exported separately from `generate` so it can be tested without a database.
 */
export function agencyAcronym(businessName: string | null | undefined): string {
  const words = (businessName ?? '')
    // Decompose then drop combining marks, so "Sécurité" contributes S, not a
    // character that would be filtered out with the punctuation below.
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);

  let acronym: string;
  if (words.length >= 3) {
    acronym = words.slice(0, 3).map((word) => word[0]).join('');
  } else if (words.length === 2) {
    // Two initials read as an abbreviation of nothing ("FD"); borrowing a second
    // letter from the distinguishing word keeps it pronounceable.
    acronym = words[0][0] + words[1].slice(0, 2);
  } else if (words.length === 1) {
    acronym = words[0].slice(0, ACRONYM_LENGTH);
  } else {
    return ACRONYM_FALLBACK;
  }

  return acronym.padEnd(ACRONYM_LENGTH, ACRONYM_PAD);
}

/** `YYMMDD` / `HHMMSS` in UTC. */
function stamp(at: Date): { date: string; time: string } {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return {
    date: `${pad(at.getUTCFullYear() % 100)}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}`,
    time: `${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}`,
  };
}

/** `SUFFIX_LENGTH` unbiased characters from SUFFIX_ALPHABET (256 % 32 === 0). */
function randomSuffix(): string {
  const bytes = randomBytes(SUFFIX_LENGTH);
  let out = '';
  for (let i = 0; i < SUFFIX_LENGTH; i++) {
    out += SUFFIX_ALPHABET[bytes[i] & 31];
  }
  return out;
}

/**
 * Assemble one candidate number for an acronym and a moment. Exported for the
 * backfill script, which stamps each legacy shipment with its OWN `created_at`
 * rather than "now" — otherwise every backfilled number would claim the
 * shipment was created on the day the script ran. Uniqueness is the caller's
 * job; this is pure formatting.
 */
export function formatTrackingNumber(acronym: string, at: Date): string {
  const { date, time } = stamp(at);
  return `${acronym}-${date}-${time}-${randomSuffix()}`;
}

export class TrackingNumberGenerator {
  /**
   * The acronym for one agency, resolved from its Magazin business name (the
   * source of truth for an agency's business identity — the DeliveryAgency
   * profile holds only the personal display name).
   *
   * Falls back rather than throwing when no magazin exists: a shipment must
   * still be creatable for an agency mid-provisioning, and a number with a
   * generic prefix beats a failed checkout.
   *
   * Deliberately read OUTSIDE any caller transaction — the magazin is not
   * written by the flows that create shipments, so the session would only widen
   * the transaction's footprint for a value that cannot change under it.
   */
  static async acronymForAgency(agencyId: string): Promise<string> {
    const magazin = await AgencyMagazinModel.findOne({ agency_id: agencyId })
      .select('name')
      .lean()
      .exec();
    return agencyAcronym(magazin?.name ?? null);
  }

  /**
   * Generate a unique tracking number for a shipment about to be created for
   * `agencyId`. Pass the creating transaction's `session` so the collision
   * pre-check sees shipments written earlier in the same transaction (a
   * multi-vendor checkout can produce two shipments for the same agency).
   */
  static async generate(agencyId: string, session?: ClientSession): Promise<string> {
    const acronym = await this.acronymForAgency(agencyId);
    const now = new Date();

    for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt++) {
      const candidate = formatTrackingNumber(acronym, now);

      const query = ShipmentModel.exists({ tracking_number: candidate });
      if (session) query.session(session);
      const taken = await query.exec();

      if (!taken) return candidate;
    }

    throw createAppError(
      ERROR_CODES.SHIPMENT_TRACKING_NUMBER_GENERATION_FAILED,
      500,
      `Could not generate a unique tracking number after ${MAX_GENERATION_ATTEMPTS} attempts`,
    );
  }
}
