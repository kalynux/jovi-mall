import { Schema, model } from 'mongoose';
import { IBaseDocument, BaseSchemaFields, BaseSchemaOptions } from '../../../core/base.schema';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';
import {
    APP_KEYS,
    APP_PLATFORMS,
    APP_RELEASE_STATUSES,
    AppKey,
    AppPlatform,
    AppReleaseStatus,
} from '../app-distribution.types';

/**
 * One published build of a first-party mobile app.
 *
 * ⚠ **Written by `scripts/publish-app-release.ts` and by nothing else.** There is no service
 * method that creates one and no HTTP route that can. That is not an accident of scope: the
 * write uploads ~79 MB through the storage provider and then claims "this is what an agent
 * should install", and neither half belongs behind a request timeout or a dashboard button
 * that can be clicked twice. When wi-admin grows a publishing screen it should call the same
 * script's logic, not reimplement the write here.
 *
 * ⚠ **The bytes outlive the row and the row outlives nothing.** Deleting a row does NOT
 * delete the object — `file-cleanup` never sees this tree, because a release artefact has no
 * `file_references` row by design (see `core/database/collections.ts`). Withdrawing a build
 * therefore means deleting the storage object deliberately; dropping the row alone leaves it
 * fetchable at a URL somebody may have saved.
 */
export interface IAppRelease extends IBaseDocument {
    app: AppKey;
    platform: AppPlatform;
    versionName: string;
    versionCode: number;
    packageId: string;
    minSdk: number | null;
    /**
     * The provider key, e.g. `app-releases/2026/09/<uuid>_wi-agent-0.1.0.apk`.
     *
     * ⚠ **Not a URL, and storing the URL instead would be the bug.** A key is provider-neutral
     * and permanent; a URL bakes in `STORAGE_R2_PUBLIC_URL`, so moving the CDN or switching
     * provider would silently strand every row. `AppReleaseService` resolves key → URL per
     * request through `getPublicUrl`, which is also where a provider mismatch is caught.
     */
    storageKey: string;
    fileName: string;
    sizeBytes: number;
    sha256: string;
    signingCertSha256: string | null;
    releaseNotes: string | null;
    status: AppReleaseStatus;
    publishedAt: Date;
}

const AppReleaseSchema = new Schema<IAppRelease>(
    {
        app: { type: String, enum: APP_KEYS as unknown as string[], required: true },
        platform: { type: String, enum: APP_PLATFORMS as unknown as string[], required: true },
        versionName: { type: String, required: true, trim: true },
        /**
         * Monotonic per app. The sort key for "latest", and deliberately NOT `publishedAt`:
         * republishing an older build to roll back a bad release would otherwise make the
         * rollback the newest row and hand every downloader a version their phone refuses to
         * install over what they already have. Android compares this number, so this module
         * compares this number.
         */
        versionCode: { type: Number, required: true, min: 1 },
        packageId: { type: String, required: true, trim: true },
        minSdk: { type: Number, default: null },
        storageKey: { type: String, required: true },
        fileName: { type: String, required: true },
        sizeBytes: { type: Number, required: true, min: 1 },
        /** Lowercase hex, 64 chars. The publish script computes it over the exact bytes it PUTs. */
        sha256: { type: String, required: true, lowercase: true, trim: true },
        signingCertSha256: { type: String, default: null, lowercase: true, trim: true },
        releaseNotes: { type: String, default: null },
        status: { type: String, enum: APP_RELEASE_STATUSES as unknown as string[], required: true },
        publishedAt: { type: Date, required: true },
        ...BaseSchemaFields,
    },
    BaseSchemaOptions,
);

/**
 * One row per (app, versionCode). UNIQUE, and it is the guard that matters here.
 *
 * Publishing is a manual command run from a laptop, so the realistic mistake is running it
 * twice — the second run uploads a second 79 MB object and writes a second row claiming the
 * same version. Without this index the two differ only by `_id`, and "which build is 0.1.0"
 * stops having an answer. With it the second write fails and the script says so.
 *
 * ⚠ Production runs `autoIndex: false`, so declaring it here does NOT create it there. Run
 * `npm run migrate:up -- --only migrate:declared-indexes` after deploying (idempotent — it
 * builds only what is missing).
 */
AppReleaseSchema.index({ app: 1, versionCode: -1 }, { unique: true, name: 'app_release_version' });

/**
 * The read path: newest published build for one app.
 *
 * Partial on `status`, because the collection is append-only and every superseded row is dead
 * weight for the only query this module issues.
 */
AppReleaseSchema.index(
    { app: 1, status: 1, versionCode: -1 },
    { name: 'app_release_latest_published', partialFilterExpression: { status: 'published' } },
);

export const AppReleaseModel = model<IAppRelease>(
    MODELS.APP_RELEASE,
    AppReleaseSchema,
    COLLECTIONS.APP_RELEASE,
);
