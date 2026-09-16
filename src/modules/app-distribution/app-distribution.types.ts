/**
 * App distribution — the vocabulary shared by the model, the public reads and the publish
 * script.
 *
 * ── What this module is, and what it deliberately is not ─────────────────────
 * The agent app is not on Google Play yet. Until it is, an agent installs it by downloading
 * an APK from the marketing site, so the platform needs somewhere to say *which* build is
 * current and *where* its bytes are. That is the whole of this module: one row per published
 * build, two unauthenticated reads, and a script that writes the row.
 *
 * It is **not** an update service. Nothing here pushes, nothing forces a version, and the
 * app does not poll it — `agent-device.service.ts` already receives the app version the agent
 * is running, on device registration, and that is the reporting direction. Should a
 * force-update gate ever be wanted, it belongs beside the reads here (a `minSupported` on the
 * row), but it does not exist and must not be inferred from these fields.
 *
 * ⚠ **It is also not a store.** An APK served from a website is installed with "unknown
 * sources" enabled, which Android makes deliberately awkward and which is the correct amount
 * of friction for the bargain being struck. The properties this module publishes —
 * `sha256`, `signingCertSha256` — exist so that friction can be discharged with evidence
 * rather than with trust in a hostname.
 */

/**
 * The apps this platform distributes directly.
 *
 * A CLOSED set, and the closure is load-bearing: `:app` is a path segment on an
 * unauthenticated route, so an open one would let a caller probe for storage keys by name.
 * Anything not listed here is `APP_UNKNOWN` at 404 before a query is issued.
 *
 * ⚠ **The key names the app AND the platform**, because the same app on two platforms is two
 * artefacts with two versions and two checksums, never one row with two files. When the iOS
 * build exists it is `agent-ios` and it is a second key, not a second column.
 */
export const APP_KEYS = ['agent-android'] as const;
export type AppKey = (typeof APP_KEYS)[number];

export function isAppKey(value: unknown): value is AppKey {
    return typeof value === 'string' && (APP_KEYS as readonly string[]).includes(value);
}

/** Mirrors the suffix of the app key. Stored so a reader never has to parse the key. */
export const APP_PLATFORMS = ['android', 'ios'] as const;
export type AppPlatform = (typeof APP_PLATFORMS)[number];

/**
 * A release is published or it is superseded. There is no `draft`.
 *
 * ⚠ **Deliberate, and the reason is that a draft here would be a lie.** The bytes live in a
 * PUBLIC storage tree (`core/storage/storage-trees.ts`), so the artefact is fetchable by
 * anyone holding its URL the instant the script uploads it. A `draft` status would describe
 * a confidentiality this module does not provide and could not provide without moving the
 * tree private and streaming every download through this service. Publish when you mean it.
 *
 * `superseded` is set on the previous row when a newer one is published — bookkeeping, not a
 * revocation: its bytes stay exactly where they were, and an agent who saved the link keeps
 * using it. Withdrawing a build means deleting the object, which is a deliberate act.
 */
export const APP_RELEASE_STATUSES = ['published', 'superseded'] as const;
export type AppReleaseStatus = (typeof APP_RELEASE_STATUSES)[number];

/**
 * The media type Android expects, and the one thing a browser needs right to offer an install
 * rather than a text preview.
 *
 * ⚠ Set at PUT time on the stored object, not on a response header — the bytes are served by
 * the CDN (or by `express.static`), never by a handler in this service, so this value has to
 * be correct when it is written or it cannot be corrected later without re-uploading.
 */
export const APK_MIME_TYPE = 'application/vnd.android.package-archive';

/** The storage tree these artefacts live in. Classified `public` in `storage-trees.ts`. */
export const APP_RELEASE_STORAGE_FOLDER = 'app-releases';

/** What a public reader is told about the current build. */
export interface AppReleaseDto {
    app: AppKey;
    platform: AppPlatform;
    /** Human-facing, e.g. `0.1.0`. What the app shows in its own settings screen. */
    versionName: string;
    /** Machine-facing and monotonic. Android refuses an install that lowers it. */
    versionCode: number;
    /** e.g. `com.wi_mall.wiagent`. Lets a client detect an already-installed build. */
    packageId: string;
    /** The lowest Android API level that can install this build. `null` for non-Android. */
    minSdk: number | null;
    fileName: string;
    sizeBytes: number;
    /** Lowercase hex. The integrity check a careful downloader actually runs. */
    sha256: string;
    /**
     * The signing certificate's SHA-256, lowercase hex, colon-free.
     *
     * ⚠ **This is the property that matters, and it is not the same claim as `sha256`.** The
     * file hash proves these bytes are the bytes we published; the certificate fingerprint
     * proves the build came from the keystore this platform signs with, which is what Android
     * itself enforces on every subsequent update. A downloader who checks only the file hash
     * has verified the mirror, not the publisher.
     */
    signingCertSha256: string | null;
    releaseNotes: string | null;
    publishedAt: string;
    /**
     * The STABLE link a landing page embeds — this service's own redirect endpoint, never the
     * CDN address behind it. Publishing a new build changes the object and leaves this string
     * untouched, which is the entire reason the endpoint exists.
     */
    downloadUrl: string;
}
