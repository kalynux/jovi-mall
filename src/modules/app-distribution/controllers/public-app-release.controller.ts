import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { sendSuccess } from '../../../core/responses';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { appReleaseService } from '../services/app-release.service';
import { AppKey, isAppKey } from '../app-distribution.types';

/**
 * How long a client may cache the answer to "what is the current build".
 *
 * Five minutes, matching the blog reader and the plan catalogue. It bounds the window in
 * which a freshly published release is invisible, and it is the reason publishing needs no
 * cache purge: wait it out.
 *
 * ⚠ It applies to the METADATA and to the REDIRECT, never to the artefact. The object itself
 * carries `public, max-age=31536000, immutable` from the storage provider, which is correct
 * because its key contains a uuid and its bytes therefore never change. Caching the redirect
 * for a year instead would pin every downloader to one build forever.
 */
const CACHE_SECONDS = 300;

/**
 * Resolve `:app` to a known key, or refuse with `404 APP_UNKNOWN`.
 *
 * ⚠ **Shared by BOTH handlers, and it is shared because they disagreed.** `latest` validated
 * this segment with Zod and `download` checked it by hand, so one unknown app key produced a
 * `400 VALIDATION_ERROR` on one route and a `404 APP_UNKNOWN` on the other — for the same
 * segment, on the same prefix, in the same module. `api-doc/public/app-downloads.md` described
 * only the second and was therefore half wrong about its own contract.
 *
 * **404 is the correct one.** A 400 says "your request is malformed", and a request naming an
 * app this platform does not distribute is perfectly well formed — the resource simply does
 * not exist. The distinction is not pedantry on a path a marketing page links to: a CDN, a log
 * scraper and a person reading an incident all branch on that difference.
 *
 * ⚠ It returns the SAME status as an unmatched route, so `404` alone cannot tell "this app key
 * is unknown" from "this build has no app-distribution routes at all". The `error.code` in the
 * body is what separates them — `APP_UNKNOWN` versus `NOT_FOUND`. Anything using this endpoint
 * as a deploy probe must read the code, or ask for a REAL key and look for a 200.
 */
function requireAppKey(value: unknown): AppKey {
    if (!isAppKey(value)) {
        throw createAppError(ERROR_CODES.APP_UNKNOWN, 404, `Unknown app "${String(value)}".`);
    }
    return value;
}

/**
 * Unauthenticated reads of the current mobile build.
 *
 * No identity, no session, no side effects, nothing owner-scoped — the same contract as
 * `public-article.controller.ts`, and for the same reason: everything served here is already
 * published on a marketing page.
 *
 * ⚠ **Nothing here counts downloads, and that is a decision rather than an omission.** A
 * counter would be a write on the hot path of a route whose whole purpose is to redirect and
 * get out of the way; it would count redirects rather than installs (a resumed download is
 * several, a CDN-cached one is none); and the number it produced would be wrong in a way
 * nobody could correct later. The honest install count is the one Play will give when the app
 * is listed. Until then it is the agent registrations the app itself produces.
 */
export class PublicAppReleaseController {
    /**
     * GET /api/public/app/{app}/latest
     *
     * The current build's metadata. A landing page reads this to render the version, the
     * size, the checksum and the release notes beside its download button.
     */
    static latest = asyncHandler(async (req: Request, res: Response) => {
        const app = requireAppKey(req.params.app);
        const release = await appReleaseService.getLatest(app);
        res.set('Cache-Control', `public, max-age=${CACHE_SECONDS}`);
        sendSuccess(res, release);
    });

    /**
     * GET /api/public/app/{app}/download
     *
     * **The stable link.** A 302 to wherever the bytes currently live.
     *
     * ⚠ **302 and never 301.** A 301 is cached by browsers indefinitely and by some proxies
     * permanently, so the first agent to install would pin that device to build 0.1.0's CDN
     * object for the life of the browser profile — and the defect would surface months later,
     * on other people's phones, as "the download gives an old version". The entire value of
     * this endpoint is that its target may change.
     *
     * `:app` is resolved by `requireAppKey`, the same way `latest` above resolves it — see that
     * function for why an unknown app is a 404 rather than a 400, and for the period when
     * these two handlers disagreed about it.
     */
    static download = asyncHandler(async (req: Request, res: Response) => {
        const app = requireAppKey(req.params.app);

        const { url, release } = await appReleaseService.resolveDownloadTarget(app);

        /**
         * `Cache-Control` on the redirect itself, so a client that followed it yesterday
         * re-asks today. Without it a browser applies heuristic freshness to a 302 carrying no
         * validator, and the publishing window stops being bounded by anything stated.
         */
        res.set('Cache-Control', `public, max-age=${CACHE_SECONDS}`);
        /**
         * Advisory, and useful to exactly one reader: an operator with `curl -I` who wants to
         * know which build the redirect is about to hand over without following it.
         */
        res.set('X-App-Version', `${release.versionName}+${release.versionCode}`);
        res.redirect(302, url);
    });
}
