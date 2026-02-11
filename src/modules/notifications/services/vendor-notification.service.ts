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
import { NotFoundError } from '../../../core/errors';

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

    constructor() {
        this.notificationRepo = new VendorNotificationRepository();
        this.preferenceRepo = new VendorNotificationPreferenceRepository();
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
            throw new NotFoundError('Notification not found');
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
     * Creates defaults if not exists.
     * 
     * @param vendorId - Vendor ID from auth context
     * @returns Preferences
     */
    async getPreferences(
        vendorId: string | mongoose.Types.ObjectId
    ): Promise<IVendorNotificationPreference> {
        return await this.preferenceRepo.getByVendor(vendorId);
    }

    /**
     * Update notification preferences
     * 
     * Auto-disables other secondary channels when one is enabled.
     * Priority: email > telegram > whatsapp
     * 
     * @param vendorId - Vendor ID from auth context
     * @param updates - Preference updates
     * @returns Updated preferences
     */
    async updatePreferences(
        vendorId: string | mongoose.Types.ObjectId,
        updates: UpdatePreferencesPayload
    ): Promise<IVendorNotificationPreference> {
        return await this.preferenceRepo.upsertPreferences(vendorId, updates);
    }
}
