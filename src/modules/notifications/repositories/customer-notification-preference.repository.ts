import mongoose from 'mongoose';
import {
    CustomerNotificationPreferenceModel,
    ICustomerNotificationPreference
} from '../models/customer-notification-preference.model';

export interface UpdateCustomerPreferencesPayload {
    emailEnabled?: boolean;
    telegramEnabled?: boolean;
    whatsappEnabled?: boolean;
    preferences?: {
        bookingUpdates?: boolean;
        bookingReminders?: boolean;
        orderUpdates?: boolean;
        marketing?: boolean;
    };
}

/**
 * CustomerNotificationPreferenceRepository
 *
 * Mirrors AgentNotificationPreferenceRepository, including the
 * auto-disable-the-others secondary-channel logic.
 */
export class CustomerNotificationPreferenceRepository {
    /** Get preferences for a customer, creating defaults on first read. */
    async getByCustomer(
        customerId: string | mongoose.Types.ObjectId
    ): Promise<ICustomerNotificationPreference> {
        const id = new mongoose.Types.ObjectId(customerId);

        // Upsert rather than find-then-create: two concurrent first reads (a page
        // load racing an inbound event) would otherwise both miss and both insert,
        // and the unique index on customerId turns the loser into a 500.
        return CustomerNotificationPreferenceModel.findOneAndUpdate(
            { customerId: id },
            { $setOnInsert: { customerId: id, inAppEnabled: true } },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        ) as unknown as ICustomerNotificationPreference;
    }

    /**
     * Update preferences with auto-disable logic for secondary channels.
     *
     * Exactly ONE secondary channel may be active at a time: enabling one
     * auto-disables the others. Priority order: telegram > email > whatsapp.
     */
    async upsertPreferences(
        customerId: string | mongoose.Types.ObjectId,
        updates: UpdateCustomerPreferencesPayload
    ): Promise<ICustomerNotificationPreference> {
        const current = await this.getByCustomer(customerId);

        let secondaryChannelUpdate: Record<string, boolean> = {};

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

        const updatePayload: Record<string, boolean> = { ...secondaryChannelUpdate };

        if (updates.preferences) {
            updatePayload['preferences.bookingUpdates'] =
                updates.preferences.bookingUpdates ?? current.preferences.bookingUpdates ?? true;
            updatePayload['preferences.bookingReminders'] =
                updates.preferences.bookingReminders ?? current.preferences.bookingReminders ?? true;
            updatePayload['preferences.orderUpdates'] =
                updates.preferences.orderUpdates ?? current.preferences.orderUpdates ?? true;
            updatePayload['preferences.marketing'] =
                updates.preferences.marketing ?? current.preferences.marketing ?? false;
        }

        const result = await CustomerNotificationPreferenceModel.findOneAndUpdate(
            { customerId: new mongoose.Types.ObjectId(customerId) },
            { $set: updatePayload },
            { new: true, upsert: false }
        );

        return result!;
    }
}
