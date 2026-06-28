import * as admin from 'firebase-admin';
import { fcmConfig, isFcmConfigured } from '../../../config/fcm.config';

/**
 * FCM Client
 *
 * Owns a dedicated, NAMED firebase-admin app for Cloud Messaging so it never
 * collides with the default app used by the Firebase storage provider. The
 * messaging project is configured independently via FCM_* env vars.
 *
 * Lazy + idempotent: the named app is created on first use and reused after.
 * When FCM is disabled or misconfigured, getMessaging() returns null and
 * callers skip delivery (graceful no-op).
 */
const FCM_APP_NAME = 'fcm';

let messaging: admin.messaging.Messaging | null = null;
let initialized = false;

/**
 * Return the FCM messaging instance, initializing the named app on first call.
 * Returns null when push is disabled or credentials are incomplete.
 */
export function getFcmMessaging(): admin.messaging.Messaging | null {
    if (initialized) return messaging;
    initialized = true;

    if (!isFcmConfigured()) {
        console.log('[FCM] Push notifications disabled or not configured; skipping initialization');
        return null;
    }

    try {
        const existing = admin.apps.find(app => app?.name === FCM_APP_NAME);
        const fcmApp =
            existing ??
            admin.initializeApp(
                {
                    credential: admin.credential.cert({
                        projectId: fcmConfig.projectId,
                        clientEmail: fcmConfig.clientEmail,
                        privateKey: fcmConfig.privateKey,
                    }),
                },
                FCM_APP_NAME
            );

        messaging = admin.messaging(fcmApp);
        console.log('[FCM] Messaging client initialized');
    } catch (error) {
        console.error('[FCM] Failed to initialize messaging client:', error);
        messaging = null;
    }

    return messaging;
}
