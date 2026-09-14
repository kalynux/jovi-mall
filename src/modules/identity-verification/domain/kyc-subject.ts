import { Model } from 'mongoose';
import { KycDocumentSlot } from '../../../core/types/kyc-documents.types';
import { FileOwnerType } from '../../catalog/models/file.model';
import { FileReferenceEntityType } from '../../catalog/models/file-reference.model';
import { VendorModel } from '../../vendors/vendor.model';
import { DeliveryAgencyModel } from '../../delivery/delivery-agency.model';
import { DeliveryAgentModel } from '../../agents/models/agent.model';

/**
 * ─── The three roles, as ONE shape ───────────────────────────────────────────
 *
 * A vendor, an agency and an agent submit near-identical evidence to near-identical
 * screens, and the only real differences are three: which collection the block lives in,
 * what the block is called on that document, and which two or three slots apply.
 *
 * ── Why a table rather than three modules ────────────────────────────────────
 * The alternative is a `vendor-kyc.service.ts`, an `agency-kyc.service.ts` and an
 * `agent-kyc.service.ts`, each ~300 lines, differing in a path prefix. That is how the
 * upload-config `provider: 'mock'` defect happened — four copies of one policy, three of
 * them wrong, and nothing to compare them against. It is also how `agency-storage` and
 * `delivery-agency` suspension nearly collapsed into one reason set.
 *
 * The single service reads this table and is otherwise role-blind, so a rule written once
 * is enforced three times by construction. The cost is one indirection at every model
 * access — `subject.model` rather than `VendorModel` — which is the whole of it.
 *
 * ⚠ **The ROLE, not the collection, decides `ownerType`.** An uploaded document is charged
 * against the uploader's own plan storage cap, and `FileReferenceService.assertAttachable`
 * authorises an attach by comparing `File.ownerType`/`ownerId` to the actor. Stamping an
 * agent's selfie as vendor-owned would both bill the wrong party and make the attach fail —
 * loudly, which is the one mercy in it.
 */
export type KycRole = 'vendor' | 'agency' | 'agent';

export interface KycSubject {
    role: KycRole;
    /** The collection holding the block. `Model<any>` deliberately — see the header. */
    model: Model<any>;
    /** The path to the KYC block on that document: `kyc_details` or `kyc`. */
    path: string;
    /**
     * The path to the identity NUMBER, which is deliberately not inside the document block.
     *
     * All three roles already had somewhere to put it and all three keep it: a vendor and an
     * agency on their own `kyc_details`, an agent on `legal_identity` beside their driving
     * licence. Relocating them into one uniform slot would have renamed a field that three
     * DTOs and wi-admin's vendor read already carry — a live contract broken for symmetry.
     */
    idNumberPath: string;
    /** Which slots this role may fill. Anything else is a 400 naming these. */
    slots: readonly KycDocumentSlot[];
    /** Stamped on every uploaded File, and the party whose storage cap is charged. */
    ownerType: FileOwnerType;
    /** The `file_references.entityType` the documents attach to. */
    entityType: FileReferenceEntityType;
    /**
     * Where this role's "store address" actually lives, for the admin read.
     *
     * ⚠ Names a DIFFERENT collection for an agency: a vendor's business addresses are on the
     * vendor document, while an agency's headquarters live on its **Magazin**. That is the
     * Store/Magazin split — business identity is not on the profile — and it is why the admin
     * checklist cannot just project one field name for both.
     */
    storeAddressSource: 'vendor.business_addresses' | 'magazin.headquarters_addresses' | null;
}

const IDENTITY_SLOTS = ['id_card_front', 'id_card_back', 'selfie_with_id'] as const;

export const KYC_SUBJECTS: Readonly<Record<KycRole, KycSubject>> = Object.freeze({
    vendor: {
        role: 'vendor',
        model: VendorModel,
        path: 'kyc_details',
        idNumberPath: 'kyc_details.national_id_number',
        slots: [...IDENTITY_SLOTS, 'home_address_sketch', 'store_address_sketch'],
        ownerType: 'vendor',
        entityType: 'vendor',
        storeAddressSource: 'vendor.business_addresses',
    },
    agency: {
        role: 'agency',
        model: DeliveryAgencyModel,
        path: 'kyc_details',
        idNumberPath: 'kyc_details.national_id_number',
        slots: [...IDENTITY_SLOTS, 'home_address_sketch', 'store_address_sketch'],
        ownerType: 'agency',
        entityType: 'agency',
        storeAddressSource: 'magazin.headquarters_addresses',
    },
    agent: {
        role: 'agent',
        model: DeliveryAgentModel,
        path: 'kyc',
        idNumberPath: 'legal_identity.national_id_number',
        slots: [...IDENTITY_SLOTS, 'home_address_sketch', 'vehicle_with_agent'],
        ownerType: 'agent',
        entityType: 'agent',
        storeAddressSource: null,
    },
});

export function kycSubjectFor(role: KycRole): KycSubject {
    return KYC_SUBJECTS[role];
}
