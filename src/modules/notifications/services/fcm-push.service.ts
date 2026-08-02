import mongoose from 'mongoose';
import type { messaging } from 'firebase-admin';
import { getFcmMessaging } from '../providers/fcm.client';
import { DeviceTokenRepository } from '../repositories/device-token.repository';

/**
 * Android notification channels this backend addresses.
 *
 * These ids are a **client contract**: a native client (the Flutter agent app)
 * must create a channel with the matching id, or Android silently falls back to
 * the manifest default channel and the importance we ask for here is lost. Adding
 * an id here without shipping the matching client channel is a no-op, not an
 * error — so they are documented in `api-doc/agent/notifications.md`.
 *
 * Web push ignores channels entirely (the vendor dashboard is unaffected).
 */
export const ANDROID_CHANNELS = {
    /** Everything that is not time-critical. */
    DEFAULT: 'jovi_default',
    /**
     * Delivery offers. Separate channel so an agent can keep offers loud while
     * muting the rest — muting the one channel that costs them work should be an
     * explicit choice, not collateral damage from silencing the app.
     */
    AGENT_OFFERS: 'jovi_agent_offers'
} as const;

/**
 * How hard the OS should work to wake the device for this message.
 *
 * `high` maps to FCM high priority + APNs priority 10, which bypasses Android
 * Doze batching. It is the default because every situation in all three
 * notification stacks is a user-visible alert about the recipient's money or
 * work — none of them are background syncs. Use `normal` only for something a
 * user would not mind seeing an hour late.
 */
export type PushUrgency = 'high' | 'normal';

/**
 * Push payload rendered from the in-app notification.
 *
 * `data` values must be strings (FCM constraint). The client reads `url` to
 * deep-link and `type`/`aggregateType`/`aggregateId` to route.
 */
export interface PushPayload {
    title: string;
    body: string;
    /** Android channel id; defaults to `ANDROID_CHANNELS.DEFAULT`. */
    channelId?: string;
    /** Wake-the-device urgency; defaults to `'high'`. */
    urgency?: PushUrgency;
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
            data,
            android: this.androidConfig(payload),
            apns: this.apnsConfig(payload)
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

    /**
     * Android delivery options.
     *
     * `priority: 'high'` is the load-bearing part: without it FCM sends at normal
     * priority and Doze may hold the message until the next maintenance window —
     * minutes on an idle phone, which is fatal for a delivery offer that is being
     * broadcast to other agents in parallel.
     *
     * Note there is deliberately **no `ttl`**. An auto-assignment offer stays
     * acceptable until the shipment binds to someone (only manual offers expire),
     * so expiring the push would cost an agent work their offer was still open for.
     */
    private androidConfig(payload: PushPayload): messaging.AndroidConfig {
        const high = (payload.urgency ?? 'high') === 'high';

        return {
            priority: high ? 'high' : 'normal',
            notification: {
                channelId: payload.channelId ?? ANDROID_CHANNELS.DEFAULT,
                priority: high ? 'max' : 'default',
                defaultSound: true
            }
        };
    }

    /**
     * APNs delivery options. Priority 10 = deliver immediately (legal here because
     * we always send an alert payload); 5 = power-considerate batching.
     */
    private apnsConfig(payload: PushPayload): messaging.ApnsConfig {
        const high = (payload.urgency ?? 'high') === 'high';

        return {
            headers: {
                'apns-priority': high ? '10' : '5'
            },
            payload: {
                aps: {
                    sound: 'default'
                }
            }
        };
    }
}
