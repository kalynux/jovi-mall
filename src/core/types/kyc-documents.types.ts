import mongoose, { Schema } from 'mongoose';
import { z } from 'zod';
import { GeoAddressSchema, IGeoAddress } from './geo-address.types';
import { MODELS } from '../database/collections';

/**
 * ─── The identity-verification document set ──────────────────────────────────
 *
 * What an administrator actually looks at when deciding whether a vendor, an agency or an
 * agent is a real person who can be held responsible for a sale or a delivery.
 *
 * ── The defect this closes ────────────────────────────────────────────────────
 * Before this, the whole of a verification decision rested on a NUMBER the applicant typed
 * in — `kyc_details.national_id_number` on a vendor, `registration_number` on an agency,
 * and on an agent a free-text `kyc.reference` that the *administrator* wrote themselves.
 * None of the three can be checked against anything. An administrator opening the approve
 * dialog was being asked to certify an identity from a string, which means every verdict on
 * the platform was either a rubber stamp or a refusal, and neither was evidence.
 *
 * ── ⚠ THE BACKEND EVALUATES NOTHING, AND THAT IS THE DESIGN ───────────────────
 * Nothing here is `required`. Not one field, on any role, at any point — submission
 * included. A vendor may submit an entirely empty document set and the write succeeds.
 *
 * That looks like an omission and is a decision (owner, 2026-09-14). The required/optional
 * split lives in the ADMIN DASHBOARD, which uses it to compute the estimated-verdict badge
 * and to pre-populate a rejection reason. Encoding it here as well would put one rule in two
 * places that cannot both be edited by the person who owns it: it is a REVIEW POLICY that
 * changes when the reviewers change their minds, not a data invariant. And a backend that
 * refused an incomplete submission would also refuse the applicant the one thing they
 * actually need — to be told, by a human, what is missing and why.
 *
 * So the contract of this module is narrow and total: **collect whatever is offered, return
 * all of it, store the verdict somebody else reached.** Anything that reads like a check
 * belongs on the other side of the wire.
 *
 * ── PRIVATE by the tree, not by a flag ───────────────────────────────────────
 * Every file here lands in the `kyc/` storage tree, classified `private` in
 * `core/storage/storage-trees.ts` (and in wi-admin's verbatim copy of it). That is the whole
 * of the privacy mechanism: `toFileDetail` reads the tree off the key and answers
 * `url: null, access: 'authorized'`, `express.static` does not serve it, and the R2 provider
 * routes the bytes to the private bucket. There is deliberately no `sensitive: true` column
 * anywhere — a second mechanism is a second thing to get wrong, and the tree already decides
 * this for `digital/` and `shipments/`.
 *
 * ⚠ A photograph of somebody's identity card, and a photograph of their FACE beside it, is
 * the most disclosing thing this platform stores about anyone. A future slot added here is
 * added to the `kyc/` tree or it is not added.
 */

// ─── Slots ────────────────────────────────────────────────────────────────────

/**
 * The document slots, as the wire names them.
 *
 * ⚠ **These strings are a PUBLIC CONTRACT** — they are the `:slot` path segment on the upload
 * and delete routes, the keys of the `documents` object on every read, and (in the dashboard)
 * the keys the estimation rules are written against. Renaming one breaks three clients.
 *
 * Two cardinalities, and the difference is not cosmetic:
 *
 *   **single** — REPLACED on re-upload. There is one front of one identity card, so a second
 *   upload means "the first was bad", and keeping both would ask the reviewer which is
 *   current. The previous file is detached and soft-deleted, exactly as a delivery proof is.
 *
 *   **multi** — APPENDED, up to {@link KYC_MULTI_SLOT_MAX_FILES}. A sketch describes ONE
 *   address and an applicant may hold several (a vendor with two shops, an agency with four
 *   depots), so the count is theirs to decide and not ours to derive. ⚠ The backend
 *   deliberately does NOT pair a sketch with the address it depicts: that pairing is a
 *   judgement ("is this a drawing of that place?") which only a reviewer looking at both can
 *   make, and a stored foreign key would assert it had already been made.
 */
export const KYC_DOCUMENT_SLOTS = {
    id_card_front: 'single',
    id_card_back: 'single',
    selfie_with_id: 'single',
    home_address_sketch: 'multi',
    store_address_sketch: 'multi',
    vehicle_with_agent: 'single',
} as const;

export type KycDocumentSlot = keyof typeof KYC_DOCUMENT_SLOTS;
export type KycSlotCardinality = (typeof KYC_DOCUMENT_SLOTS)[KycDocumentSlot];

export const KYC_DOCUMENT_SLOT_NAMES = Object.keys(KYC_DOCUMENT_SLOTS) as KycDocumentSlot[];

/**
 * The ceiling on a multi-value slot, per slot.
 *
 * Ten because the owner set it at ten, and because the real constraint is the reviewer's
 * patience rather than storage: a submission with forty sketches is not more verifiable than
 * one with three. The bytes are separately capped by the upload policy and by the applicant's
 * plan storage quota, so this number is about the REVIEW, not about disk.
 */
export const KYC_MULTI_SLOT_MAX_FILES = 10;

/** The Mongoose field name backing a slot. */
export function kycSlotField(slot: KycDocumentSlot): string {
    return KYC_DOCUMENT_SLOTS[slot] === 'multi' ? `${slot}_file_ids` : `${slot}_file_id`;
}

/**
 * The `file_references.field` value for a slot.
 *
 * Prefixed `kyc_` because that collection is keyed on
 * `(fileId, entityType, entityId, field)`, and an agent's `vehicle_with_agent` must not
 * collide with the ordinary `vehicle_photo` already attached to the same agent. The prefix
 * also makes a reference row self-describing in a database shell, which is where anyone
 * chasing "why is this file still alive" will be reading it.
 */
export function kycReferenceField(slot: KycDocumentSlot): string {
    return `kyc_${slot}`;
}

// ─── Mongoose ─────────────────────────────────────────────────────────────────

/**
 * Which slots a role's block carries.
 *
 * A factory rather than one schema holding every slot, following `actorStampFields`. The
 * alternative — a single shared sub-schema — would hang `vehicle_with_agent_file_id` off
 * every vendor and `store_address_sketch_file_ids` off every agent, where they can only ever
 * be null. A field that cannot be set is a field every reader has to ask about.
 */
export interface KycSlotSelection {
    /** Vendor + agency. Sketches of the business / HQ addresses already on the account. */
    storeSketches?: boolean;
    /** Agent only. The vehicle photographed WITH its rider — not the plain vehicle photo. */
    vehicle?: boolean;
}

export function kycDocumentFields(selection: KycSlotSelection = {}): Record<string, unknown> {
    const fileId = () => ({ type: Schema.Types.ObjectId, ref: MODELS.FILE, default: null });
    const fileIds = () => ({ type: [Schema.Types.ObjectId], ref: MODELS.FILE, default: [] });

    return {
        id_card_front_file_id: fileId(),
        id_card_back_file_id: fileId(),
        selfie_with_id_file_id: fileId(),
        home_address_sketch_file_ids: fileIds(),
        ...(selection.storeSketches ? { store_address_sketch_file_ids: fileIds() } : {}),
        ...(selection.vehicle ? { vehicle_with_agent_file_id: fileId() } : {}),

        /**
         * The applicant's own home, geocoded.
         *
         * A full {@link IGeoAddress} rather than a string, so "is this address valid" is a
         * question the reviewer answers by looking at `coordinates` and `provider` instead of
         * by trusting prose. The dashboard's estimation rule for every role is literally
         * `homeAddress !== null`.
         *
         * ⚠ **On an agent this is NOT `home_base`, and merging them would be wrong.**
         * `home_base` is the OPERATIONAL anchor auto-dispatch ranks against — an agent may
         * legitimately work from a depot, a relative's house, or a city they do not live in,
         * and changing it is a routing decision they make freely. This is an IDENTITY claim
         * an administrator has approved and that the applicant must not be able to revise
         * afterwards. Two fields whose values usually agree and whose meanings never do.
         */
        home_address: { type: GeoAddressSchema, default: null },

        /**
         * When the applicant pressed submit — and the field that makes a review queue
         * possible at all.
         *
         * ⚠ It exists because `status: 'pending'` means TWO things on a vendor and an agency:
         * "has never touched this" (it is the schema default) and "is waiting for you". An
         * administrator cannot tell a blank draft from a finished application, and a queue
         * built over that field lists every account that ever existed. The agent's enum has an
         * `unverified` value and does not carry the ambiguity, but takes the stamp anyway so
         * that one rule — `submittedAt !== null` means under review — holds for all three.
         *
         * Adding `'draft'` to the vendor/agency enums was the alternative. Rejected: those
         * values are persisted, mirrored in wi-admin's validators as `VENDOR_KYC_STATUSES`,
         * and read by the dashboard's filters, so the change would have been three
         * repositories wide to express what a nullable timestamp expresses additively.
         */
        submitted_at: { type: Date, default: null },
    };
}

// ─── TypeScript ───────────────────────────────────────────────────────────────

export interface IKycDocumentFields {
    id_card_front_file_id: mongoose.Types.ObjectId | null;
    id_card_back_file_id: mongoose.Types.ObjectId | null;
    selfie_with_id_file_id: mongoose.Types.ObjectId | null;
    home_address_sketch_file_ids: mongoose.Types.ObjectId[];
    /** Vendor + agency only. Absent from an agent's block. */
    store_address_sketch_file_ids?: mongoose.Types.ObjectId[];
    /** Agent only. Absent from a vendor's or an agency's block. */
    vehicle_with_agent_file_id?: mongoose.Types.ObjectId | null;
    home_address: IGeoAddress | null;
    submitted_at: Date | null;
}

// ─── Zod ──────────────────────────────────────────────────────────────────────

/**
 * The `:slot` path parameter, narrowed to the slots the role actually has.
 *
 * ⚠ Narrowed **per role** rather than accepting the whole vocabulary and ignoring the extras:
 * `POST /api/agent/kyc/documents/store_address_sketch` must answer 400 and name the slots
 * that exist, not 200 having stored nothing. A write that silently does nothing is the
 * hardest thing there is for a frontend author to diagnose, because every observable signal
 * says it worked.
 */
export function kycSlotParamSchema(allowed: readonly KycDocumentSlot[]) {
    return z.object({
        slot: z.enum(allowed as unknown as [KycDocumentSlot, ...KycDocumentSlot[]]),
    });
}
