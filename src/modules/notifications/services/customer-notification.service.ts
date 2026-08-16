import mongoose from 'mongoose';
import {
    CustomerNotificationRepository,
    PaginationOptions,
    ListFilters
} from '../repositories/customer-notification.repository';
import {
    CustomerNotificationPreferenceRepository,
    UpdateCustomerPreferencesPayload
} from '../repositories/customer-notification-preference.repository';
import { ICustomerNotificationPreference } from '../models/customer-notification-preference.model';
import { CustomerModel } from '../../customers/customer.model';
import { connectionService } from '../../channel-connections';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';

/**
 * Live verification status for a customer's secondary channels. The source of
 * truth is the customer document and the telegram link, not the stored
 * preference flags — mirrors AgentNotificationService's ChannelVerification.
 */
interface CustomerChannelVerification {
    emailVerified: boolean;
    telegramVerified: boolean;
    whatsappVerified: boolean;
}

/**
 * CustomerNotificationService — list / read / preferences.
 *
 * Fourth counterpart to the vendor, agency and agent notification services. See
 * CustomerNotificationEventHandler for the dispatch side.
 */
export class CustomerNotificationService {
    constructor(
        private readonly repo: CustomerNotificationRepository = new CustomerNotificationRepository(),
        private readonly preferenceRepo: CustomerNotificationPreferenceRepository = new CustomerNotificationPreferenceRepository()
    ) {}

    async listNotifications(
        customerId: string | mongoose.Types.ObjectId,
        pagination: PaginationOptions,
        filters: ListFilters = {}
    ) {
        const { data, total } = await this.repo.findByCustomer(customerId, pagination, filters);
        const unreadCount = await this.repo.countUnread(customerId);
        return {
            notifications: data,
            unreadCount,
            meta: {
                total,
                page: pagination.page,
                limit: pagination.limit,
                pages: Math.max(1, Math.ceil(total / pagination.limit))
            }
        };
    }

    /** Unread count alone — for a badge, without paying for a page of rows. */
    async countUnread(customerId: string | mongoose.Types.ObjectId): Promise<number> {
        return this.repo.countUnread(customerId);
    }

    async markAsRead(notificationId: string, customerId: string | mongoose.Types.ObjectId) {
        const notification = await this.repo.markAsRead(notificationId, customerId);
        if (!notification) {
            throw createAppError(
                ERROR_CODES.CUSTOMER_NOTIFICATION_NOT_FOUND,
                404,
                'Notification not found'
            );
        }
        return notification;
    }

    async markAllAsRead(customerId: string | mongoose.Types.ObjectId): Promise<number> {
        return this.repo.markAllAsRead(customerId);
    }

    /**
     * Preferences, creating defaults on first read. Verification status is
     * computed live and overlaid — the stored `*Verified` flags are a cache and
     * are not authoritative.
     */
    async getPreferences(
        customerId: string | mongoose.Types.ObjectId
    ): Promise<ICustomerNotificationPreference> {
        const [prefs, verification] = await Promise.all([
            this.preferenceRepo.getByCustomer(customerId),
            this.computeVerification(customerId)
        ]);

        prefs.emailVerified = verification.emailVerified;
        prefs.telegramVerified = verification.telegramVerified;
        prefs.whatsappVerified = verification.whatsappVerified;
        return prefs;
    }

    /**
     * Update preferences.
     *
     * A secondary channel may only be enabled once it is verified — otherwise the
     * customer switches on a channel that silently delivers nothing, which reads
     * as the platform being broken rather than as a setup step they missed.
     */
    async updatePreferences(
        customerId: string | mongoose.Types.ObjectId,
        updates: UpdateCustomerPreferencesPayload
    ): Promise<ICustomerNotificationPreference> {
        const verification = await this.computeVerification(customerId);

        if (updates.emailEnabled === true && !verification.emailVerified) {
            throw createAppError(
                ERROR_CODES.CUSTOMER_NOTIFICATION_CHANNEL_NOT_VERIFIED,
                400,
                'Verify your email address before enabling email notifications'
            );
        }
        if (updates.telegramEnabled === true && !verification.telegramVerified) {
            throw createAppError(
                ERROR_CODES.CUSTOMER_NOTIFICATION_CHANNEL_NOT_VERIFIED,
                400,
                'Link your Telegram account before enabling Telegram notifications'
            );
        }
        if (updates.whatsappEnabled === true && !verification.whatsappVerified) {
            throw createAppError(
                ERROR_CODES.CUSTOMER_NOTIFICATION_CHANNEL_NOT_VERIFIED,
                400,
                'Verify your WhatsApp number before enabling WhatsApp notifications'
            );
        }

        const prefs = await this.preferenceRepo.upsertPreferences(customerId, updates);

        prefs.emailVerified = verification.emailVerified;
        prefs.telegramVerified = verification.telegramVerified;
        prefs.whatsappVerified = verification.whatsappVerified;
        return prefs;
    }

    private async computeVerification(
        customerId: string | mongoose.Types.ObjectId
    ): Promise<CustomerChannelVerification> {
        const customer = await CustomerModel.findById(customerId).select(
            'user_id email email_verified'
        );
        if (!customer) {
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
        const connections = await connectionService.getConnectionMap(customer.user_id);

        return {
            emailVerified: !!customer.email_verified && !!customer.email,
            telegramVerified: !!connections.telegram,
            whatsappVerified: !!connections.whatsapp
        };
    }
}
