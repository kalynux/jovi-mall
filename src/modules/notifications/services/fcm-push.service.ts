import mongoose from 'mongoose';
import { getFcmMessaging } from '../providers/fcm.client';
import { DeviceTokenRepository } from '../repositories/device-token.repository';

/**
 * Push payload rendered from the in-app notification.
 *
 * `data` values must be strings (FCM constraint). The client reads `url` to
 * deep-link and `type`/`aggregateType`/`aggregateId` to route.
 */
export interface PushPayload {
    title: string;
    body: string;
    data: {
        type: string;
        aggregateType: string;
        aggregateId: string;
        /** Relative deep-link path the SPA can route to, e.g. "orders/665f…" */
        path?: string;
        /** Absolute deep-link (present only when VENDOR_APP_URL is configured) */
        url?: string;
    };
}

/** FCM error codes that mean a token is permanently dead and should be pruned. */
const INVALID_TOKEN_CODES = new Set([
    'messaging/registration-token-not-registered',
    'messaging/invalid-registration-token',
    'messaging/invalid-argument'
]);

/**
 * FcmPushService
 *
 * Delivers a notification to all of a user's registered devices via FCM.
 * Self-healing: tokens FCM reports as invalid are removed from the registry.
 *
 * Never throws — push is a best-effort companion to the in-app notification.
 * Returns the number of tokens targeted (0 when push is off, no devices, or
 * delivery could not be attempted) so callers can decide whether to record
 * 'push' as a delivery channel.
 */
export class FcmPushService {
    private deviceTokenRepo: DeviceTokenRepository;

    constructor() {
        this.deviceTokenRepo = new DeviceTokenRepository();
    }

    /**
     * Send a push to every device registered to the given user.
     *
     * @returns count of tokens the push was attempted against (0 if skipped)
     */
    async sendToUser(
        userId: string | mongoose.Types.ObjectId,
        payload: PushPayload
    ): Promise<number> {
        const messaging = getFcmMessaging();
        if (!messaging) return 0; // Push disabled / not configured

        const devices = await this.deviceTokenRepo.findActiveByUser(userId);
        if (devices.length === 0) return 0;

        const tokens = devices.map(d => d.token);

        // FCM data values must be strings; drop undefined keys.
        const data: Record<string, string> = {
            type: payload.data.type,
            aggregateType: payload.data.aggregateType,
            aggregateId: payload.data.aggregateId
        };
        if (payload.data.path) data.path = payload.data.path;
        if (payload.data.url) data.url = payload.data.url;

        const response = await messaging.sendEachForMulticast({
            tokens,
            notification: {
                title: payload.title,
                body: payload.body
            },
            data
        });

        // Prune tokens FCM rejected as permanently invalid (self-healing).
        const invalidTokens: string[] = [];
        response.responses.forEach((res, idx) => {
            if (!res.success) {
                const code = res.error?.code;
                if (code && INVALID_TOKEN_CODES.has(code)) {
                    invalidTokens.push(tokens[idx]);
                }
            }
        });

        if (invalidTokens.length > 0) {
            await this.deviceTokenRepo.deleteManyTokens(invalidTokens);
        }

        return tokens.length;
    }
}
