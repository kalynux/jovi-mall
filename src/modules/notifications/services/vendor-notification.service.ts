import mongoose from 'mongoose';
import {
    VendorNotificationRepository,
    NotificationFilters,
    PaginationOptions,
    LeanVendorNotification
} from '../repositories/vendor-notification.repository';
import {
    VendorNotificationPreferenceRepository,
    UpdatePreferencesPayload
} from '../repositories/vendor-notification-preference.repository';
import { IVendorNotification } from '../models/vendor-notification.model';
import { IVendorNotificationPreference } from '../models/vendor-notification-preference.model';
import { VendorRepository } from '../../vendors/vendor.repository';
import { connectionService } from '../../channel-connections';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';

/**
 * Live verification status for a vendor's secondary channels.
 *
 * Source of truth is the underlying entities (vendor + telegram link),
 * not the stored preference flags — those are no longer authoritative.
 */
interface ChannelVerification {
    emailVerified: boolean;
    telegramVerified: boolean;
    whatsappVerified: boolean;
}

export interface ListNotificationsResult {
    notifications: LeanVendorNotification[];
    unreadCount: number;
    meta: {
        total: number;
        page: number;
        limit: number;
        pages: number;
    };
}

/**
 * VendorNotificationService
 * 
 * API-facing service for vendor notification management.
 * Handles listing, reading, and preference updates.
 */
export class VendorNotificationService {
    private notificationRepo: VendorNotificationRepository;
    private preferenceRepo: VendorNotificationPreferenceRepository;
    private vendorRepo: VendorRepository;

    constructor() {
        this.notificationRepo = new VendorNotificationRepository();
        this.preferenceRepo = new VendorNotificationPreferenceRepository();
        this.vendorRepo = new VendorRepository();
    }

    /**
     * List notifications for vendor with filters and pagination
     * 
     * @param vendorId - Vendor ID from auth context
     * @param filters - Optional filters
     * @param pagination - Pagination options
     * @returns Notifications with unread count
     */
    async listNotifications(
        vendorId: string | mongoose.Types.ObjectId,
        filters: NotificationFilters = {},
        pagination: PaginationOptions = { page: 1, limit: 20 }
    ): Promise<ListNotificationsResult> {
        const [result, unreadCount] = await Promise.all([
            this.notificationRepo.findByVendor(vendorId, filters, pagination),
            this.notificationRepo.countUnread(vendorId)
        ]);

        return {
            notifications: result.data,
            unreadCount,
            meta: result.meta
        };
    }

    /**
     * Mark notification as read
     * 
     * Ownership validated. Idempotent.
     * 
     * @param notificationId - Notification ID
     * @param vendorId - Vendor ID from auth context
     * @throws NotFoundError if notification not found or not owned
     */
    async markAsRead(
        notificationId: string | mongoose.Types.ObjectId,
        vendorId: string | mongoose.Types.ObjectId
    ): Promise<IVendorNotification> {
        const notification = await this.notificationRepo.markAsRead(notificationId, vendorId);

        if (!notification) {
            throw createAppError(ERROR_CODES.VENDOR_NOTIFICATION_NOT_FOUND, 404, 'Notification not found');
        }

        return notification;
    }

    /**
     * Mark all notifications as read (bulk operation)
     * 
     * @param vendorId - Vendor ID from auth context
     * @returns Count of notifications marked as read
     */
    async markAllAsRead(vendorId: string | mongoose.Types.ObjectId): Promise<number> {
        return await this.notificationRepo.markAllAsRead(vendorId);
    }

    /**
     * Get unread notification count
     * 
     * @param vendorId - Vendor ID from auth context
     * @returns Unread count
     */
    async getUnreadCount(vendorId: string | mongoose.Types.ObjectId): Promise<number> {
        return await this.notificationRepo.countUnread(vendorId);
    }

    /**
     * Get notification preferences for vendor
     *
     * Creates defaults if not exists. Verification status is computed live
     * from the underlying entities (vendor + telegram link) and overlaid onto
     * the returned document — the stored *Verified flags are not authoritative.
     *
     * @param vendorId - Vendor ID from auth context
     * @returns Preferences with live verification status
     */
    async getPreferences(
        vendorId: string | mongoose.Types.ObjectId
    ): Promise<IVendorNotificationPreference> {
        const [prefs, verification] = await Promise.all([
            this.preferenceRepo.getByVendor(vendorId),
            this.computeVerification(vendorId)
        ]);

        prefs.emailVerified = verification.emailVerified;
        prefs.telegramVerified = verification.telegramVerified;
        prefs.whatsappVerified = verification.whatsappVerified;

        return prefs;
    }

    /**
     * Update notification preferences
     *
     * A secondary channel can only be enabled if it is currently verified
     * (checked live). Auto-disables other secondary channels when one is enabled.
     * Priority: telegram > email > whatsapp
     *
     * ⚠ Corrected 2026-09-09 (DOC-PROGRAM close-out § 6, item 4). This line read
     * "email > telegram > whatsapp" and was the only place on the platform that
     * said so. The order is applied one layer down, in
     * `vendor-notification-preference.repository.ts:90-111`, which tests
     * `telegramEnabled` first; the agency, agent and customer stacks and both
     * event handlers all document telegram first too. The api-doc pages were right
     * and this docstring was the outlier.
     *
     * @param vendorId - Vendor ID from auth context
     * @param updates - Preference updates
     * @returns Updated preferences with live verification status
     * @throws AppError(400) if enabling an unverified channel
     */
    async updatePreferences(
        vendorId: string | mongoose.Types.ObjectId,
        updates: UpdatePreferencesPayload
    ): Promise<IVendorNotificationPreference> {
        const verification = await this.computeVerification(vendorId);

        if (updates.emailEnabled === true && !verification.emailVerified) {
            throw this.channelNotVerifiedError('email');
        }
        if (updates.telegramEnabled === true && !verification.telegramVerified) {
            throw this.channelNotVerifiedError('telegram');
        }
        if (updates.whatsappEnabled === true && !verification.whatsappVerified) {
            throw this.channelNotVerifiedError('whatsapp');
        }

        const prefs = await this.preferenceRepo.upsertPreferences(vendorId, updates);

        prefs.emailVerified = verification.emailVerified;
        prefs.telegramVerified = verification.telegramVerified;
        prefs.whatsappVerified = verification.whatsappVerified;

        return prefs;
    }

    /**
     * Resolve live verification status for a vendor's secondary channels.
     *
     * - email    → vendor.email_verified
     * - telegram → an active telegram link for the vendor's user
     * - whatsapp → vendor.wa.verified
     */
    private async computeVerification(
        vendorId: string | mongoose.Types.ObjectId
    ): Promise<ChannelVerification> {
        const vendor = await this.vendorRepo.findById(vendorId.toString());
        if (!vendor) {
            return { emailVerified: false, telegramVerified: false, whatsappVerified: false };
        }

        /**
         * Both channels from one query, against the single connections store.
         *
         * ⚠ `telegramVerified` now means "a Telegram connection exists" and
         * nothing else. It used to be `link.isActive`, a second mute switch
         * beside `telegramEnabled` below — so muting made a connected account
         * read as unconnected and the UI offered "Connect" to somebody who
         * already had. WhatsApp never had that flag; the two channels now agree.
         */
        const connections = await connectionService.getConnectionMap(vendor.user_id);

        return {
            emailVerified: !!vendor.email_verified,
            telegramVerified: !!connections.telegram,
            whatsappVerified: !!connections.whatsapp
        };
    }

    private channelNotVerifiedError(channel: 'email' | 'telegram' | 'whatsapp') {
        return createAppError(
            ERROR_CODES.VENDOR_NOTIFICATION_CHANNEL_NOT_VERIFIED,
            400,
            `Cannot enable ${channel} notifications: channel is not verified`,
            { channel }
        );
    }
}
