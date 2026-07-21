import mongoose from 'mongoose';
import { AgentNotificationRepository, PaginationOptions } from '../repositories/agent-notification.repository';
import {
    AgentNotificationPreferenceRepository,
    UpdateAgentPreferencesPayload
} from '../repositories/agent-notification-preference.repository';
import { IAgentNotificationPreference } from '../models/agent-notification-preference.model';
import { AgentRepository } from '../../agents';
import { TelegramRepository } from '../../telegram/telegram.repository';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';

/**
 * Live verification status for an agent's secondary channels. Source of truth is
 * the underlying entities (agent + telegram link), not the stored preference
 * flags — mirrors AgencyNotificationService's ChannelVerification.
 */
interface AgentChannelVerification {
    emailVerified: boolean;
    telegramVerified: boolean;
    whatsappVerified: boolean;
}

/**
 * AgentNotificationService - list/read/preferences. Third counterpart to
 * VendorNotificationService and AgencyNotificationService — see
 * AgentNotificationEventHandler for the dispatch side.
 */
export class AgentNotificationService {
    private agentRepo: AgentRepository;
    private telegramRepo: TelegramRepository;

    constructor(
        private readonly repo: AgentNotificationRepository = new AgentNotificationRepository(),
        private readonly preferenceRepo: AgentNotificationPreferenceRepository = new AgentNotificationPreferenceRepository()
    ) {
        this.agentRepo = new AgentRepository();
        this.telegramRepo = new TelegramRepository();
    }

    async listNotifications(agentId: string | mongoose.Types.ObjectId, pagination: PaginationOptions) {
        const { data, total } = await this.repo.findByAgent(agentId, pagination);
        const unreadCount = await this.repo.countUnread(agentId);
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

    async markAsRead(notificationId: string, agentId: string | mongoose.Types.ObjectId) {
        const notification = await this.repo.markAsRead(notificationId, agentId);
        if (!notification) {
            throw createAppError(ERROR_CODES.DELIVERY_AGENT_NOTIFICATION_NOT_FOUND, 404, 'Notification not found');
        }
        return notification;
    }

    async markAllAsRead(agentId: string | mongoose.Types.ObjectId): Promise<number> {
        return this.repo.markAllAsRead(agentId);
    }

    /**
     * Get notification preferences for agent (creates defaults if not exists).
     * Verification status is computed live and overlaid onto the returned
     * document — the stored *Verified flags are not authoritative.
     */
    async getPreferences(
        agentId: string | mongoose.Types.ObjectId
    ): Promise<IAgentNotificationPreference> {
        const [prefs, verification] = await Promise.all([
            this.preferenceRepo.getByAgent(agentId),
            this.computeVerification(agentId)
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
        agentId: string | mongoose.Types.ObjectId,
        updates: UpdateAgentPreferencesPayload
    ): Promise<IAgentNotificationPreference> {
        const verification = await this.computeVerification(agentId);

        if (updates.emailEnabled === true && !verification.emailVerified) {
            throw this.channelNotVerifiedError('email');
        }
        if (updates.telegramEnabled === true && !verification.telegramVerified) {
            throw this.channelNotVerifiedError('telegram');
        }
        if (updates.whatsappEnabled === true && !verification.whatsappVerified) {
            throw this.channelNotVerifiedError('whatsapp');
        }

        const prefs = await this.preferenceRepo.upsertPreferences(agentId, updates);

        prefs.emailVerified = verification.emailVerified;
        prefs.telegramVerified = verification.telegramVerified;
        prefs.whatsappVerified = verification.whatsappVerified;

        return prefs;
    }

    /**
     * Resolve live verification status for an agent's secondary channels.
     * - email    → agent.email_verified
     * - telegram → an active telegram link for the agent's user
     * - whatsapp → agent.wa.verified
     */
    private async computeVerification(
        agentId: string | mongoose.Types.ObjectId
    ): Promise<AgentChannelVerification> {
        const agent = await this.agentRepo.findById(agentId.toString());
        if (!agent) {
            return { emailVerified: false, telegramVerified: false, whatsappVerified: false };
        }

        const telegramLink = await this.telegramRepo.findByUserId(agent.user_id.toString());

        return {
            emailVerified: !!agent.email_verified,
            telegramVerified: !!(telegramLink && telegramLink.isActive),
            whatsappVerified: !!agent.wa?.verified
        };
    }

    private channelNotVerifiedError(channel: 'email' | 'telegram' | 'whatsapp') {
        return createAppError(
            ERROR_CODES.DELIVERY_AGENT_NOTIFICATION_CHANNEL_NOT_VERIFIED,
            400,
            `Cannot enable ${channel} notifications: channel is not verified`,
            { channel }
        );
    }
}

export const agentNotificationService = new AgentNotificationService();
