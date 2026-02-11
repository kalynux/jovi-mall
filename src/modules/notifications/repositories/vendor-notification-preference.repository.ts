import mongoose from 'mongoose';
import {
    VendorNotificationPreferenceModel,
    IVendorNotificationPreference
} from '../models/vendor-notification-preference.model';

export interface UpdatePreferencesPayload {
    emailEnabled?: boolean;
    telegramEnabled?: boolean;
    whatsappEnabled?: boolean;
    preferences?: {
        orderCreated?: boolean;
        orderCancelled?: boolean;
        bookingCreated?: boolean;
        bookingCancelled?: boolean;
        paymentReceivedPartial?: boolean;
        paymentReceivedFull?: boolean;
    };
}

/**
 * VendorNotificationPreferenceRepository
 * 
 * Manages vendor notification preferences with auto-disable logic for secondary channels.
 */
export class VendorNotificationPreferenceRepository {
    /**
     * Get preferences for vendor (creates defaults if not exists)
     * 
     * @param vendorId - Vendor ID
     * @returns Vendor preferences
     */
    async getByVendor(vendorId: string | mongoose.Types.ObjectId): Promise<IVendorNotificationPreference> {
        let prefs = await VendorNotificationPreferenceModel.findOne({
            vendorId: new mongoose.Types.ObjectId(vendorId)
        });

        if (!prefs) {
            // Create defaults
            prefs = await VendorNotificationPreferenceModel.create({
                vendorId: new mongoose.Types.ObjectId(vendorId),
                inAppEnabled: true,
                emailEnabled: false,
                telegramEnabled: false,
                whatsappEnabled: false,
                emailVerified: false,
                telegramVerified: false,
                whatsappVerified: false,
                preferences: {
                    orderCreated: true,
                    orderCancelled: true,
                    bookingCreated: true,
                    bookingCancelled: true,
                    paymentReceivedPartial: true,
                    paymentReceivedFull: true
                }
            });
        }

        return prefs;
    }

    /**
     * Update preferences with auto-disable logic for secondary channels
     * 
     * When enabling a secondary channel, others are auto-disabled.
     * Priority order: email > telegram > whatsapp
     * 
     * @param vendorId - Vendor ID
     * @param updates - Partial preference updates
     * @returns Updated preferences
     */
    async upsertPreferences(
        vendorId: string | mongoose.Types.ObjectId,
        updates: UpdatePreferencesPayload
    ): Promise<IVendorNotificationPreference> {
        // Get current preferences
        const current = await this.getByVendor(vendorId);

        // Determine which secondary channel to enable (if any)
        // Priority order: email > telegram > whatsapp
        let secondaryChannelUpdate: any = {};

        if (updates.emailEnabled === true) {
            secondaryChannelUpdate = {
                emailEnabled: true,
                telegramEnabled: false,
                whatsappEnabled: false
            };
        } else if (updates.telegramEnabled === true) {
            secondaryChannelUpdate = {
                emailEnabled: false,
                telegramEnabled: true,
                whatsappEnabled: false
            };
        } else if (updates.whatsappEnabled === true) {
            secondaryChannelUpdate = {
                emailEnabled: false,
                telegramEnabled: false,
                whatsappEnabled: true
            };
        } else if (
            updates.emailEnabled === false &&
            updates.telegramEnabled === false &&
            updates.whatsappEnabled === false
        ) {
            // All disabled explicitly
            secondaryChannelUpdate = {
                emailEnabled: false,
                telegramEnabled: false,
                whatsappEnabled: false
            };
        }

        // Build update payload
        const updatePayload: any = {
            ...secondaryChannelUpdate
        };

        // Merge event preferences if provided
        if (updates.preferences) {
            updatePayload['preferences.orderCreated'] = updates.preferences.orderCreated ?? current.preferences.orderCreated;
            updatePayload['preferences.orderCancelled'] = updates.preferences.orderCancelled ?? current.preferences.orderCancelled;
            updatePayload['preferences.bookingCreated'] = updates.preferences.bookingCreated ?? current.preferences.bookingCreated;
            updatePayload['preferences.bookingCancelled'] = updates.preferences.bookingCancelled ?? current.preferences.bookingCancelled;
            updatePayload['preferences.paymentReceivedPartial'] = updates.preferences.paymentReceivedPartial ?? current.preferences.paymentReceivedPartial;
            updatePayload['preferences.paymentReceivedFull'] = updates.preferences.paymentReceivedFull ?? current.preferences.paymentReceivedFull;
        }

        const result = await VendorNotificationPreferenceModel.findOneAndUpdate(
            { vendorId: new mongoose.Types.ObjectId(vendorId) },
            { $set: updatePayload },
            { new: true, upsert: false }
        );

        return result!;
    }

    /**
     * Sync verification status from external sources
     * 
     * Called when vendor verifies email or links Telegram/WhatsApp.
     * 
     * @param vendorId - Vendor ID
     * @param channel - Channel to mark as verified
     */
    async markChannelVerified(
        vendorId: string | mongoose.Types.ObjectId,
        channel: 'email' | 'telegram' | 'whatsapp'
    ): Promise<void> {
        const updateField = `${channel}Verified`;

        await VendorNotificationPreferenceModel.updateOne(
            { vendorId: new mongoose.Types.ObjectId(vendorId) },
            { $set: { [updateField]: true } },
            { upsert: true }
        );
    }
}
