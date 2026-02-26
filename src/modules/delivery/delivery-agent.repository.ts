import { DeliveryAgentModel, IDeliveryAgent } from './delivery-agent.model';
import { IGeoPoint } from '../../core/types/geo.types';

export class DeliveryAgentRepository {
  async create(data: Partial<IDeliveryAgent>): Promise<IDeliveryAgent> {
    return await DeliveryAgentModel.create(data);
  }

  async findByUserId(userId: string): Promise<IDeliveryAgent | null> {
    return await DeliveryAgentModel.findOne({ user_id: userId });
  }

  async findById(agentId: string): Promise<IDeliveryAgent | null> {
    return await DeliveryAgentModel.findById(agentId);
  }

  async markEmailVerified(userId: string): Promise<IDeliveryAgent | null> {
    return await DeliveryAgentModel.findOneAndUpdate(
      { user_id: userId },
      { email_verified: true },
      { new: true }
    );
  }

  async updateWaVerified(userId: string, waData: { wa_phone_id: string; name?: string }): Promise<IDeliveryAgent | null> {
    return await DeliveryAgentModel.findOneAndUpdate(
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

  async updateStatus(userId: string, status: string): Promise<IDeliveryAgent | null> {
    return await DeliveryAgentModel.findOneAndUpdate({ user_id: userId }, { status }, { new: true });
  }

  async updateProfile(agentId: string, updates: Partial<IDeliveryAgent>): Promise<IDeliveryAgent | null> {
    return await DeliveryAgentModel.findByIdAndUpdate(agentId, updates, { new: true });
  }

  async updateOnboardingStep(agentId: string, step: number): Promise<IDeliveryAgent | null> {
    return await DeliveryAgentModel.findByIdAndUpdate(
      agentId,
      { onboarding_step: step },
      { new: true }
    );
  }

  /** Update agent's real-time location and capacity status. */
  async updateLiveState(
    agentId: string,
    location: IGeoPoint | null,
    status: 'available' | 'busy' | 'offline'
  ): Promise<IDeliveryAgent | null> {
    return await DeliveryAgentModel.findByIdAndUpdate(
      agentId,
      {
        $set: {
          'live_state.last_known_location': location,
          'live_state.current_capacity_status': status,
        },
      },
      { new: true }
    );
  }

  async unlinkWhatsApp(userId: string): Promise<IDeliveryAgent | null> {
    return await DeliveryAgentModel.findOneAndUpdate(
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
