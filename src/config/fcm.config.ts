/**
 * Firebase Cloud Messaging (FCM) Configuration
 *
 * Drives the push-notification channel. FCM runs in its OWN Firebase project,
 * separate from the storage Firebase project (STORAGE_FIREBASE_*), so it has a
 * dedicated set of credentials and a dedicated firebase-admin app instance.
 *
 * Env vars:
 *   FCM_ENABLED       — 'true' to enable push delivery (default: disabled, no-op)
 *   FCM_PROJECT_ID    — Firebase project id of the messaging project
 *   FCM_CLIENT_EMAIL  — service-account client email
 *   FCM_PRIVATE_KEY   — service-account private key (escaped \n are unescaped)
 *
 * When disabled or missing credentials, the FCM client degrades to a no-op so
 * notification dispatch is never broken.
 */
export const fcmConfig = {
  /** Master switch. Push delivery is skipped entirely when false. */
  enabled: process.env.FCM_ENABLED === 'true',

  /** Firebase project id of the dedicated messaging project. */
  projectId: process.env.FCM_PROJECT_ID ?? '',

  /** Service-account client email. */
  clientEmail: process.env.FCM_CLIENT_EMAIL ?? '',

  /** Service-account private key. Handles escaped newlines from .env. */
  privateKey: (process.env.FCM_PRIVATE_KEY ?? '').replace(/\\n/g, '\n'),
} as const;

export type FcmConfig = typeof fcmConfig;

/** True only when push is enabled AND all credentials are present. */
export function isFcmConfigured(): boolean {
  return Boolean(
    fcmConfig.enabled &&
      fcmConfig.projectId &&
      fcmConfig.clientEmail &&
      fcmConfig.privateKey
  );
}
