import { IDeliveryAgency } from '../delivery-agency.model';
import { FileDetail } from '../../catalog/read-models/product-detail.read-model';

export interface AdminAgencyListItemDto {
    id: string;
    userId: string;
    agencyName: string;
    logo: FileDetail | null;
    status: 'active' | 'pending_verification' | 'inactive';
    /**
     * The business-verification verdict, added in Phase 6 Step 4.
     *
     * Distinct from `status` above and not derivable from it: `pending_verification`
     * is where an agency sits both **before** a review and **after a refused one**,
     * which is exactly the ambiguity the verdict exists to remove. A review queue
     * reads this; a dispatch decision reads `status`.
     *
     * `reviewedByName` is a snapshot rather than a joinable id — the reviewer is
     * usually a wi-admin administrator whose id resolves in that database and nowhere
     * here, which is what `actorStampFields` exists to make legible.
     */
    kyc: {
        status: 'pending' | 'verified' | 'rejected';
        rejectionReason: string | null;
        verifiedAt: Date | null;
        reviewedByName: string | null;
        reviewedBySource: string | null;
    };
    onboardingStep: number;
    createdAt: Date;
    updatedAt: Date;
}

export interface AdminAgencyListMeta {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
}

export class AdminAgencyMapper {
    /**
     * @param logo Pre-resolved FileDetail for the agency's logo file (the caller
     * resolves logo_file_id → FileDetail in batch). Null when unset.
     */
    static toListItemDto(
        agency: IDeliveryAgency,
        agencyName: string,
        logo: FileDetail | null = null,
    ): AdminAgencyListItemDto {
        return {
            id: agency._id.toString(),
            userId: agency.user_id.toString(),
            agencyName,
            logo,
            status: agency.status,
            kyc: {
                // `?? 'pending'` covers rows written before the field existed — under a
                // Mongoose default they read as `pending`, which is the truth about them:
                // nobody has reached a verdict.
                status: agency.kyc_details?.status ?? 'pending',
                rejectionReason: agency.kyc_details?.rejection_reason ?? null,
                verifiedAt: agency.kyc_details?.verified_at ?? null,
                reviewedByName: agency.kyc_details?.verified_by_name ?? null,
                reviewedBySource: agency.kyc_details?.verified_by_source ?? null,
            },
            onboardingStep: agency.onboarding_step,
            createdAt: agency.created_at,
            updatedAt: agency.updated_at,
        };
    }
}
