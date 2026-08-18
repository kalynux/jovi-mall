import { getApps, initializeApp, cert } from 'firebase-admin/app';
import { getMessaging, Messaging } from 'firebase-admin/messaging';
import { fcmConfig, isFcmConfigured } from '../../../config/fcm.config';

/**
 * FCM Client
 *
 * Owns a dedicated, NAMED firebase-admin app for Cloud Messaging so it never
 * collides with the default app used by the Firebase storage provider. The
 * messaging project is configured independently via FCM_* env vars.
 *
 * Lazy + idempotent: the named app is created on first use and reused after.
 * When FCM is disabled or misconfigured, getFcmMessaging() returns null and
 * callers skip delivery (graceful no-op).
 *
 * ⚠ MODULAR imports, not the `admin.*` namespace. firebase-admin 14 REMOVED the legacy
 * namespaced API outright — `admin.apps`, `admin.credential`, `admin.messaging()` and
 * `admin.storage()` no longer exist. The mapping is 1:1 (`getApps`, `cert`, `getMessaging`,
 * `getStorage`); do not reintroduce the old shape, it will not compile.
 */
const FCM_APP_NAME = 'fcm';

let messaging: Messaging | null = null;
let initialized = false;

/**
 * Return the FCM messaging instance, initializing the named app on first call.
 * Returns null when push is disabled or credentials are incomplete.
 */
export function getFcmMessaging(): Messaging | null {
    if (initialized) return messaging;
    initialized = true;

    if (!isFcmConfigured()) {
        console.log('[FCM] Push notifications disabled or not configured; skipping initialization');
        return null;
    }

    try {
        const existing = getApps().find(app => app?.name === FCM_APP_NAME);
        const fcmApp =
            existing ??
            initializeApp(
                {
                    credential: cert({
                        projectId: fcmConfig.projectId,
                        clientEmail: fcmConfig.clientEmail,
                        privateKey: fcmConfig.privateKey,
                    }),
                },
                FCM_APP_NAME
            );

        messaging = getMessaging(fcmApp);
        console.log('[FCM] Messaging client initialized');
    } catch (error) {
        console.error('[FCM] Failed to initialize messaging client:', error);
        messaging = null;
    }

    return messaging;
}
