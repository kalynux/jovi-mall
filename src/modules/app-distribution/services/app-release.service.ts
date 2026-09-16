import { getStorageProvider } from '../../../core/storage';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { isPrivateStorageKey } from '../../../core/storage/storage-trees';
import { appReleaseRepository } from '../repositories/app-release.repository';
import { IAppRelease } from '../models/app-release.model';
import { AppKey, AppReleaseDto } from '../app-distribution.types';

/**
 * Trailing slashes stripped for the same reason `storage.instance.ts` strips them off
 * `STORAGE_R2_PUBLIC_URL`: this value is concatenated, and `//api/...` is a different path to
 * anything that routes on the literal string.
 */
function apiPublicUrl(): string {
    const configured = process.env.API_PUBLIC_URL || `http://localhost:${process.env.PORT || 8022}`;
    return configured.replace(/\/+$/, '');
}

/**
 * Reads of the current build, for the marketing site's download button.
 *
 * ── The one decision in this file: this service NEVER serves bytes ───────────
 * `resolveDownloadTarget` returns a URL and the controller answers `302`. It would be four
 * lines shorter to pipe `getDownloadStream` into the response, and it would be wrong on this
 * deployment for reasons that have nothing to do with elegance:
 *
 *   - the artefact is ~79 MB and the production container is memory-capped
 *     (`docker-compose.prod.yml`), on a host `docs/DEPLOY-VPS.md` sizes at 2 vCPU / 8 GB for
 *     the WHOLE platform. Ten concurrent installs is 790 MB of egress moving through the same
 *     event loop that is taking checkout traffic;
 *   - R2 egress through the Cloudflare CDN is free and cached at the edge, and the bytes are
 *     already there — the tree is public, so the object is directly addressable;
 *   - a redirect keeps the resume/range behaviour that a 79 MB download over a mobile
 *     connection genuinely needs, and that a naive pipe silently drops.
 *
 * What the redirect costs is the pretty filename: the saved file carries the storage key's
 * basename, uuid prefix and all. That is a deliberate trade and it is the reason the publish
 * script passes a readable `filename` — so the uuid is a prefix on a recognisable name rather
 * than the whole of it.
 */
export class AppReleaseService {
    /** The current build as a public DTO, or a 404 when nothing is published yet. */
    async getLatest(app: AppKey): Promise<AppReleaseDto> {
        const release = await appReleaseRepository.findLatestPublished(app);
        if (!release) {
            throw createAppError(
                ERROR_CODES.APP_RELEASE_NOT_FOUND,
                404,
                `No published release for "${app}".`,
            );
        }
        return this.toDto(release);
    }

    /**
     * Where the bytes actually are.
     *
     * Resolved per request rather than stored, so switching provider or moving the CDN needs
     * no data change — and so a provider that cannot address the key fails HERE, loudly, at
     * the one place that knows it is answering a download.
     */
    async resolveDownloadTarget(app: AppKey): Promise<{ url: string; release: IAppRelease }> {
        const release = await appReleaseRepository.findLatestPublished(app);
        if (!release) {
            throw createAppError(
                ERROR_CODES.APP_RELEASE_NOT_FOUND,
                404,
                `No published release for "${app}".`,
            );
        }

        /**
         * ⚠ A belt-and-braces re-check of something `storage-trees.ts` already guarantees.
         * `getPublicUrl` THROWS on a private key (that is the R2 provider's ADR-A01 D-2
         * guard), so a future reclassification of `app-releases` to `private` would turn every
         * download into an unhandled 500 with a storage-internal message. Catching it here
         * means it becomes a named 503 instead, and the message says which decision caused it.
         */
        if (isPrivateStorageKey(release.storageKey)) {
            throw createAppError(
                ERROR_CODES.APP_RELEASE_UNAVAILABLE,
                503,
                `"${release.storageKey}" is in a private storage tree, so it has no public URL. `
                + 'A release artefact must live in a tree classified `public` in '
                + 'core/storage/storage-trees.ts.',
            );
        }

        let url: string;
        try {
            url = getStorageProvider().getPublicUrl(release.storageKey);
        } catch (error: any) {
            throw createAppError(
                ERROR_CODES.APP_RELEASE_UNAVAILABLE,
                503,
                `The active storage provider cannot address "${release.storageKey}": `
                + `${error?.message ?? error}`,
            );
        }

        return { url, release };
    }

    /**
     * ⚠ `_id` is absent by design. A release is addressed by `(app, versionCode)` — there is
     * no route that takes an id, and publishing an opaque database key into a marketing page's
     * markup buys a reader nothing they can use.
     */
    toDto(release: IAppRelease): AppReleaseDto {
        return {
            app: release.app,
            platform: release.platform,
            versionName: release.versionName,
            versionCode: release.versionCode,
            packageId: release.packageId,
            minSdk: release.minSdk ?? null,
            fileName: release.fileName,
            sizeBytes: release.sizeBytes,
            sha256: release.sha256,
            signingCertSha256: release.signingCertSha256 ?? null,
            releaseNotes: release.releaseNotes ?? null,
            publishedAt: release.publishedAt.toISOString(),
            downloadUrl: `${apiPublicUrl()}/api/public/app/${release.app}/download`,
        };
    }
}

export const appReleaseService = new AppReleaseService();
