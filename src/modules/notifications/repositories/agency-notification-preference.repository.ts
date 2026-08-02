import mongoose from 'mongoose';
import {
    AgencyNotificationPreferenceModel,
    IAgencyNotificationPreference
} from '../models/agency-notification-preference.model';

export interface UpdateAgencyPreferencesPayload {
    emailEnabled?: boolean;
    telegramEnabled?: boolean;
    whatsappEnabled?: boolean;
    preferences?: {
        connectionUpdated?: boolean;
        contractUpdated?: boolean;
        shipmentAssigned?: boolean;
        payoutUpdates?: boolean;
        codDepositUpdates?: boolean;
        planUpdates?: boolean;
        storageAlert?: boolean;
    };
}

/**
 * AgencyNotificationPreferenceRepository
 *
 * Mirrors VendorNotificationPreferenceRepository, including the
 * auto-disable-the-others secondary-channel logic.
 */
export class AgencyNotificationPreferenceRepository {
    /**
     * Get preferences for agency (creates defaults if not exists)
     */
    async getByAgency(agencyId: string | mongoose.Types.ObjectId): Promise<IAgencyNotificationPreference> {
        let prefs = await AgencyNotificationPreferenceModel.findOne({
            agencyId: new mongoose.Types.ObjectId(agencyId)
        });

        if (!prefs) {
            prefs = await AgencyNotificationPreferenceModel.create({
                agencyId: new mongoose.Types.ObjectId(agencyId),
                inAppEnabled: true,
                emailEnabled: false,
                telegramEnabled: false,
                whatsappEnabled: false,
                emailVerified: false,
                telegramVerified: false,
                whatsappVerified: false,
                preferences: {
                    connectionUpdated: true,
                    contractUpdated: true,
                    shipmentAssigned: true,
                    payoutUpdates: true,
                    codDepositUpdates: true,
                    planUpdates: true,
                    storageAlert: true
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
        agencyId: string | mongoose.Types.ObjectId,
        updates: UpdateAgencyPreferencesPayload
    ): Promise<IAgencyNotificationPreference> {
        const current = await this.getByAgency(agencyId);

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
            updatePayload['preferences.connectionUpdated'] =
                updates.preferences.connectionUpdated ?? current.preferences.connectionUpdated;
            updatePayload['preferences.contractUpdated'] =
                updates.preferences.contractUpdated ?? current.preferences.contractUpdated ?? true;
            updatePayload['preferences.shipmentAssigned'] =
                updates.preferences.shipmentAssigned ?? current.preferences.shipmentAssigned;
            updatePayload['preferences.payoutUpdates'] =
                updates.preferences.payoutUpdates ?? current.preferences.payoutUpdates;
            updatePayload['preferences.codDepositUpdates'] =
                updates.preferences.codDepositUpdates ?? current.preferences.codDepositUpdates;
            updatePayload['preferences.planUpdates'] =
                updates.preferences.planUpdates ?? current.preferences.planUpdates;
            updatePayload['preferences.storageAlert'] =
                updates.preferences.storageAlert ?? current.preferences.storageAlert;
        }

        const result = await AgencyNotificationPreferenceModel.findOneAndUpdate(
            { agencyId: new mongoose.Types.ObjectId(agencyId) },
            { $set: updatePayload },
            { new: true, upsert: false }
        );

        return result!;
    }
}
