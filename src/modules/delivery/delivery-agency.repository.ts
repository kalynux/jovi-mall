import { DeliveryAgencyModel, IDeliveryAgency } from './delivery-agency.model';

export class DeliveryAgencyRepository {
  async create(data: Partial<IDeliveryAgency>): Promise<IDeliveryAgency> {
    return await DeliveryAgencyModel.create(data);
  }

  async findByUserId(userId: string): Promise<IDeliveryAgency | null> {
    return await DeliveryAgencyModel.findOne({ user_id: userId });
  }

  async findById(agencyId: string): Promise<IDeliveryAgency | null> {
    return await DeliveryAgencyModel.findById(agencyId);
  }

  async markEmailVerified(userId: string): Promise<IDeliveryAgency | null> {
    return await DeliveryAgencyModel.findOneAndUpdate(
      { user_id: userId },
      { email_verified: true },
      { new: true }
    );
  }

  async updateWaVerified(userId: string, waData: { wa_phone_id: string; name?: string }): Promise<IDeliveryAgency | null> {
    return await DeliveryAgencyModel.findOneAndUpdate(
      { user_id: userId },
      {
        $set: {
          'wa.verified': true,
          'wa.wa_phone_id': waData.wa_phone_id,
          'wa.bound_at': new Date(),
          'wa.last_seen_at': new Date(),
          ...(waData.name ? { 'wa.name': waData.name } : {})
        }
      },
      { new: true }
    );
  }

  async updateStatus(userId: string, status: string): Promise<IDeliveryAgency | null> {
    return await DeliveryAgencyModel.findOneAndUpdate({ user_id: userId }, { status }, { new: true });
  }

  async updateProfile(agencyId: string, updates: Partial<IDeliveryAgency>): Promise<IDeliveryAgency | null> {
    return await DeliveryAgencyModel.findByIdAndUpdate(agencyId, updates, { new: true });
  }

  async updateOnboardingStep(agencyId: string, step: number): Promise<IDeliveryAgency | null> {
    return await DeliveryAgencyModel.findByIdAndUpdate(
      agencyId,
      { onboarding_step: step },
      { new: true }
    );
  }

  /** Admin-only: flip legit_verified in both locations for backward compatibility. */
  async setLegitVerified(agencyId: string, verified: boolean): Promise<IDeliveryAgency | null> {
    return await DeliveryAgencyModel.findByIdAndUpdate(
      agencyId,
      {
        $set: {
          legit_verified: verified,
          'kyc_details.legit_verified': verified,
        },
      },
      { new: true }
    );
  }

  async unlinkWhatsApp(userId: string): Promise<IDeliveryAgency | null> {
    return await DeliveryAgencyModel.findOneAndUpdate(
      { user_id: userId },
      {
        $set: {
          'wa.verified': false,
          'wa.wa_phone_id': null,
          'wa.name': null,
          'wa.bound_at': null,
          'wa.last_seen_at': null
        }
      },
      { new: true }
    );
  }
}
