import { FileDetail } from '../../catalog/read-models/product-detail.read-model';
import { IGeoAddress } from '../../../core/types/geo-address.types';
import { KycDocumentSlot, KYC_MULTI_SLOT_MAX_FILES } from '../../../core/types/kyc-documents.types';
import { KycRole } from '../domain/kyc-subject';

/**
 * ─── What a verification review is built from ────────────────────────────────
 *
 * One shape, for the applicant reading their own submission and for the administrator
 * deciding on it. The administrator's copy carries two blocks the applicant's does not (the
 * addresses already on the account, and the verdict's provenance); everything else is
 * identical, because a dashboard that shows the reviewer something the applicant cannot see
 * about their own documents produces rejections nobody can act on.
 *
 * ── ⚠ THERE IS NO `estimatedVerdict` FIELD, AND THERE MUST NOT BE ────────────
 * The dashboard computes the badge — required vs optional per role, whether an address is
 * geocoded, whether a conditional requirement applies — and pre-populates the rejection
 * reason from it. This service supplies FACTS and no judgement:
 *
 *   · a value, or `null`                       → is it there?
 *   · a `FileDetail`, or `null` / `[]`         → is the document there?
 *   · `geocoded` beside each address           → is it resolvable on a map?
 *   · `status` + `submittedAt`                 → has anybody decided, and is it ready?
 *
 * Adding a `required: true` column here would be the same rule in two repositories, and the
 * one that changes when reviewers change their minds is the dashboard's. See
 * `core/types/kyc-documents.types.ts` for the decision.
 *
 * ── Every document is `access: 'authorized'` with `url: null` ────────────────
 * These files live in the private `kyc/` tree, so `toFileDetail` answers `url: null` by
 * construction. That is not a fault to render as a broken image: the `id` is the handle, and
 * the bytes come from an authorized route — `GET /api/{role}/kyc/documents/:fileId/content`
 * for the applicant, wi-admin's audited `GET /api/v1/files/:fileId/content` for the reviewer.
 */

/** An address already on the account, reduced to what a reviewer needs to judge it. */
export interface KycAddressDto {
    /** `null` on a legacy or hand-typed entry — which is exactly the case worth badging. */
    label: string | null;
    /** The provider's one-line address, or the plain text if it was never geocoded. */
    formattedAddress: string | null;
    /**
     * `[lng, lat]`, or `null`.
     *
     * ⚠ GeoJSON order. A client plotting `[lat, lng]` puts every Douala address in the Gulf
     * of Guinea, and both halves stay plausible numbers — which is why this comment is here
     * and not in a changelog.
     */
    coordinates: [number, number] | null;
    /** Which geocoder resolved it. Informational; nothing branches on it. */
    provider: string | null;
    /**
     * **The badge input.** `true` iff a geocoder resolved this address to a coordinate.
     *
     * Derived here rather than left to the client, because "has a `geo` object" and "has
     * usable coordinates" are not the same test and a client checking the first would pass a
     * half-written legacy row.
     */
    geocoded: boolean;
}

export interface KycDocumentsDto {
    idCardFront: FileDetail | null;
    idCardBack: FileDetail | null;
    selfieWithId: FileDetail | null;
    /** Agent only; `null` for a vendor and an agency. The rider beside the vehicle. */
    vehicleWithAgent: FileDetail | null;
    /** Up to {@link KYC_MULTI_SLOT_MAX_FILES}. Empty array, never null. */
    homeAddressSketches: FileDetail[];
    /** Vendor + agency only; always `[]` for an agent. */
    storeAddressSketches: FileDetail[];
}

export interface KycDto {
    role: KycRole;
    /**
     * `pending | verified | rejected` on a vendor and an agency; the agent's enum adds
     * `unverified`, which is its draft state.
     *
     * ⚠ On a vendor and an agency `pending` means BOTH "never touched" and "waiting for
     * you" — read `submittedAt` to tell them apart. That ambiguity is why the timestamp
     * exists; see `kycDocumentFields`.
     */
    status: string;
    /** `null` until the applicant presses submit. Non-null ⇒ under review ⇒ frozen. */
    submittedAt: string | null;
    /** Whether this record accepts writes right now. Derived from status + submittedAt. */
    locked: boolean;
    /** Present on a rejection, so the applicant can act on it. */
    rejectionReason: string | null;
    verifiedAt: string | null;

    /** The identity number, wherever it lives on this role's document. */
    idNumber: string | null;
    /** Agent only — beside the identity number on `legal_identity`. */
    driversLicenseNumber?: string | null;
    /**
     * Agent only. The vehicle's plate, read from `vehicle_info` rather than duplicated here.
     *
     * Optional on the reviewer's checklist, and the one field in this whole payload the
     * applicant may legitimately leave empty forever: plenty of two-wheelers in this market
     * carry no readable plate.
     */
    plateNumber?: string | null;

    /** The applicant's own home, as submitted for verification. */
    homeAddress: KycAddressDto | null;
    /**
     * The business addresses already on the account — a vendor's `business_addresses`, an
     * agency's magazin `headquarters_addresses`. **Never sent to an agent**, who has none.
     *
     * ⚠ Read-only here. This endpoint does not write them; they are edited where they live
     * (the vendor profile, the magazin), and a second write path would let a frozen KYC
     * record's address change underneath a reviewer looking at it.
     */
    storeAddresses?: KycAddressDto[];

    documents: KycDocumentsDto;

    /** The reviewer's own block. Absent from the applicant's copy. */
    review?: {
        reviewedBy: { id: string | null; source: string; name: string | null } | null;
    };

    /** Echoed so a client need not hardcode it beside the server. */
    limits: { multiSlotMaxFiles: number };
}

/** The slot → DTO-key mapping, so the wire name and the field name cannot drift apart. */
export const KYC_SLOT_DTO_KEYS: Readonly<Record<KycDocumentSlot, keyof KycDocumentsDto>> =
    Object.freeze({
        id_card_front: 'idCardFront',
        id_card_back: 'idCardBack',
        selfie_with_id: 'selfieWithId',
        vehicle_with_agent: 'vehicleWithAgent',
        home_address_sketch: 'homeAddressSketches',
        store_address_sketch: 'storeAddressSketches',
    });

/**
 * A stored `GeoAddress` → the reviewer's address row.
 *
 * ⚠ `coordinates` is read defensively. `GeoPointSchema` stores `{ type, coordinates }` and a
 * legacy row can carry a `geo` object whose coordinate array is absent — which is precisely
 * the row that must report `geocoded: false` rather than throwing on the read that was
 * supposed to reveal it.
 */
export function toKycAddressDto(
    geo: IGeoAddress | null | undefined,
    label: string | null,
    fallbackText: string | null = null,
): KycAddressDto {
    const pair = geo?.coordinates?.coordinates;
    const coordinates =
        Array.isArray(pair) && pair.length === 2 && pair.every((n) => typeof n === 'number')
            ? ([pair[0], pair[1]] as [number, number])
            : null;

    return {
        label,
        formattedAddress: geo?.formatted_address ?? fallbackText,
        coordinates,
        provider: geo?.provider ?? null,
        geocoded: coordinates !== null,
    };
}

export const KYC_LIMITS = Object.freeze({ multiSlotMaxFiles: KYC_MULTI_SLOT_MAX_FILES });
