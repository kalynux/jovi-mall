import mongoose from 'mongoose';
import { AgencyNotificationRepository, PaginationOptions } from '../repositories/agency-notification.repository';
import {
    AgencyNotificationPreferenceRepository,
    UpdateAgencyPreferencesPayload
} from '../repositories/agency-notification-preference.repository';
import { IAgencyNotificationPreference } from '../models/agency-notification-preference.model';
import { DeliveryAgencyRepository } from '../../delivery/delivery-agency.repository';
import { connectionService } from '../../channel-connections';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';

/**
 * Live verification status for an agency's secondary channels. Source of
 * truth is the underlying entities (agency + telegram link), not the stored
 * preference flags — mirrors VendorNotificationService's ChannelVerification.
 */
interface AgencyChannelVerification {
    emailVerified: boolean;
    telegramVerified: boolean;
    whatsappVerified: boolean;
}

/**
 * AgencyNotificationService - list/read/preferences. Multi-channel counterpart
 * to VendorNotificationService — see AgencyNotificationEventHandler for the
 * dispatch side.
 */
export class AgencyNotificationService {
    private agencyRepo: DeliveryAgencyRepository;

    constructor(
        private readonly repo: AgencyNotificationRepository = new AgencyNotificationRepository(),
        private readonly preferenceRepo: AgencyNotificationPreferenceRepository = new AgencyNotificationPreferenceRepository()
    ) {
        this.agencyRepo = new DeliveryAgencyRepository();
    }

    async listNotifications(agencyId: string | mongoose.Types.ObjectId, pagination: PaginationOptions) {
        const { data, total } = await this.repo.findByAgency(agencyId, pagination);
        const unreadCount = await this.repo.countUnread(agencyId);
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

    async markAsRead(notificationId: string, agencyId: string | mongoose.Types.ObjectId) {
        const notification = await this.repo.markAsRead(notificationId, agencyId);
        if (!notification) {
            throw createAppError(ERROR_CODES.DELIVERY_AGENCY_NOTIFICATION_NOT_FOUND, 404, 'Notification not found');
        }
        return notification;
    }

    async markAllAsRead(agencyId: string | mongoose.Types.ObjectId): Promise<number> {
        return this.repo.markAllAsRead(agencyId);
    }

    /**
     * Get notification preferences for agency (creates defaults if not exists).
     * Verification status is computed live and overlaid onto the returned
     * document — the stored *Verified flags are not authoritative.
     */
    async getPreferences(
        agencyId: string | mongoose.Types.ObjectId
    ): Promise<IAgencyNotificationPreference> {
        const [prefs, verification] = await Promise.all([
            this.preferenceRepo.getByAgency(agencyId),
            this.computeVerification(agencyId)
        ]);

        prefs.emailVerified = verification.emailVerified;
        prefs.telegramVerified = verification.telegramVerified;
        prefs.whatsappVerified = verification.whatsappVerified;

        return prefs;
    }

    /**
     * Update notification preferences. A secondary channel can only be enabled
     * if it is currently verified (checked live). Auto-disables other
     * secondary channels when one is enabled. Priority: telegram > email > whatsapp.
     */
    async updatePreferences(
        agencyId: string | mongoose.Types.ObjectId,
        updates: UpdateAgencyPreferencesPayload
    ): Promise<IAgencyNotificationPreference> {
        const verification = await this.computeVerification(agencyId);

        if (updates.emailEnabled === true && !verification.emailVerified) {
            throw this.channelNotVerifiedError('email');
        }
        if (updates.telegramEnabled === true && !verification.telegramVerified) {
            throw this.channelNotVerifiedError('telegram');
        }
        if (updates.whatsappEnabled === true && !verification.whatsappVerified) {
            throw this.channelNotVerifiedError('whatsapp');
        }

        const prefs = await this.preferenceRepo.upsertPreferences(agencyId, updates);

        prefs.emailVerified = verification.emailVerified;
        prefs.telegramVerified = verification.telegramVerified;
        prefs.whatsappVerified = verification.whatsappVerified;

        return prefs;
    }

    /**
     * Resolve live verification status for an agency's secondary channels.
     * - email    → agency.email_verified
     * - telegram → an active telegram link for the agency's user
     * - whatsapp → agency.wa.verified
     */
    private async computeVerification(
        agencyId: string | mongoose.Types.ObjectId
    ): Promise<AgencyChannelVerification> {
        const agency = await this.agencyRepo.findById(agencyId.toString());
        if (!agency) {
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
        const connections = await connectionService.getConnectionMap(agency.user_id);

        return {
            emailVerified: !!agency.email_verified,
            telegramVerified: !!connections.telegram,
            whatsappVerified: !!connections.whatsapp
        };
    }

    private channelNotVerifiedError(channel: 'email' | 'telegram' | 'whatsapp') {
        return createAppError(
            ERROR_CODES.DELIVERY_AGENCY_NOTIFICATION_CHANNEL_NOT_VERIFIED,
            400,
            `Cannot enable ${channel} notifications: channel is not verified`,
            { channel }
        );
    }
}
