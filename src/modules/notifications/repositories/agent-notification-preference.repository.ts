import mongoose from 'mongoose';
import {
    AgentNotificationPreferenceModel,
    IAgentNotificationPreference
} from '../models/agent-notification-preference.model';

export interface UpdateAgentPreferencesPayload {
    emailEnabled?: boolean;
    telegramEnabled?: boolean;
    whatsappEnabled?: boolean;
    preferences?: {
        codDepositUpdates?: boolean;
        assignmentOffers?: boolean;
    };
}

/**
 * AgentNotificationPreferenceRepository
 *
 * Mirrors AgencyNotificationPreferenceRepository, including the
 * auto-disable-the-others secondary-channel logic.
 */
export class AgentNotificationPreferenceRepository {
    /**
     * Get preferences for agent (creates defaults if not exists)
     */
    async getByAgent(agentId: string | mongoose.Types.ObjectId): Promise<IAgentNotificationPreference> {
        let prefs = await AgentNotificationPreferenceModel.findOne({
            agentId: new mongoose.Types.ObjectId(agentId)
        });

        if (!prefs) {
            prefs = await AgentNotificationPreferenceModel.create({
                agentId: new mongoose.Types.ObjectId(agentId),
                inAppEnabled: true,
                emailEnabled: false,
                telegramEnabled: false,
                whatsappEnabled: false,
                emailVerified: false,
                telegramVerified: false,
                whatsappVerified: false,
                preferences: {
                    codDepositUpdates: true,
                    assignmentOffers: true
                }
            });
        }

        return prefs;
    }

    /**
     * Update preferences with auto-disable logic for secondary channels.
     *
     * Exactly ONE secondary channel may be active at a time: enabling one
     * auto-disables the others. Priority order: telegram > email > whatsapp.
     */
    async upsertPreferences(
        agentId: string | mongoose.Types.ObjectId,
        updates: UpdateAgentPreferencesPayload
    ): Promise<IAgentNotificationPreference> {
        const current = await this.getByAgent(agentId);

        let secondaryChannelUpdate: any = {};

        if (updates.telegramEnabled === true) {
            secondaryChannelUpdate = {
                telegramEnabled: true,
                emailEnabled: false,
                whatsappEnabled: false
            };
        } else if (updates.emailEnabled === true) {
            secondaryChannelUpdate = {
                telegramEnabled: false,
                emailEnabled: true,
                whatsappEnabled: false
            };
        } else if (updates.whatsappEnabled === true) {
            secondaryChannelUpdate = {
                telegramEnabled: false,
                emailEnabled: false,
                whatsappEnabled: true
            };
        } else if (
            updates.telegramEnabled === false &&
            updates.emailEnabled === false &&
            updates.whatsappEnabled === false
        ) {
            secondaryChannelUpdate = {
                telegramEnabled: false,
                emailEnabled: false,
                whatsappEnabled: false
            };
        }

        const updatePayload: any = {
            ...secondaryChannelUpdate
        };

        if (updates.preferences) {
            updatePayload['preferences.codDepositUpdates'] =
                updates.preferences.codDepositUpdates ?? current.preferences.codDepositUpdates;
            updatePayload['preferences.assignmentOffers'] =
                updates.preferences.assignmentOffers ?? current.preferences.assignmentOffers ?? true;
        }

        const result = await AgentNotificationPreferenceModel.findOneAndUpdate(
            { agentId: new mongoose.Types.ObjectId(agentId) },
            { $set: updatePayload },
            { new: true, upsert: false }
        );

        return result!;
    }
}
