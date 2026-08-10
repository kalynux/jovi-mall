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
        storageAlert?: boolean;
        connectionUpdated?: boolean;
        payoutUpdates?: boolean;
        shipmentRejected?: boolean;
        agencyStorageUpdates?: boolean;
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
                    paymentReceivedFull: true,
                    storageAlert: true,
                    connectionUpdated: true,
                    payoutUpdates: true,
                    shipmentRejected: true,
                    agencyStorageUpdates: true
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

        // Only one secondary channel can be enabled; enabling one disables the rest.
        // Priority order when multiple are requested: telegram > email > whatsapp.
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
            // All disabled explicitly
            secondaryChannelUpdate = {
                telegramEnabled: false,
                emailEnabled: false,
                whatsappEnabled: false
            };
        }

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
            updatePayload['preferences.storageAlert'] = updates.preferences.storageAlert ?? current.preferences.storageAlert;
            updatePayload['preferences.connectionUpdated'] = updates.preferences.connectionUpdated ?? current.preferences.connectionUpdated;
            updatePayload['preferences.payoutUpdates'] = updates.preferences.payoutUpdates ?? current.preferences.payoutUpdates;
            updatePayload['preferences.shipmentRejected'] = updates.preferences.shipmentRejected ?? current.preferences.shipmentRejected;
            // `?? true` on the tail: rows written before this flag existed carry no
            // value for it, and coalescing to `undefined` would blank the key.
            updatePayload['preferences.agencyStorageUpdates'] =
                updates.preferences.agencyStorageUpdates ?? current.preferences.agencyStorageUpdates ?? true;
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
