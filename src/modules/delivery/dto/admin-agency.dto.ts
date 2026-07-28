import { IDeliveryAgency } from '../delivery-agency.model';
import { FileDetail } from '../../catalog/read-models/product-detail.read-model';

export interface AdminAgencyListItemDto {
    id: string;
    userId: string;
    agencyName: string;
    logo: FileDetail | null;
    status: 'active' | 'pending_verification' | 'inactive';
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
            onboardingStep: agency.onboarding_step,
            createdAt: agency.created_at,
            updatedAt: agency.updated_at,
        };
    }
}
