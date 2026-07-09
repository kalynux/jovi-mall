import { IDeliveryAgency } from '../delivery-agency.model';

export interface AdminAgencyListItemDto {
    id: string;
    userId: string;
    agencyName: string;
    logoUrl: string | null;
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
    static toListItemDto(agency: IDeliveryAgency): AdminAgencyListItemDto {
        return {
            id: agency._id.toString(),
            userId: agency.user_id.toString(),
            agencyName: agency.agency_name,
            logoUrl: agency.logo_url,
            status: agency.status,
            onboardingStep: agency.onboarding_step,
            createdAt: agency.created_at,
            updatedAt: agency.updated_at,
        };
    }
}
