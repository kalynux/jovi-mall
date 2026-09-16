import { Router } from 'express';
import { PublicAppReleaseController } from '../controllers/public-app-release.controller';

/**
 * Public app-distribution routes — the agent APK's download link.
 * Mounted at `/api/public` → `/public/app/{app}/latest`, `/public/app/{app}/download`.
 *
 * ⚠️ There is **no `requireAuth`** on this router, the same as `public-blog.routes.ts` and
 * `public-catalog.routes.ts`. That is the design rather than an oversight: the link is
 * embedded in a marketing page that has no session and never will (the landing site is a
 * separate Next.js app), and an APK's authenticity is established by the signature Android
 * verifies at install — which is why the metadata read publishes `signingCertSha256`.
 *
 * ⚠ **Do not add a write here, and do not add an upload here.** Releases are published by
 * `scripts/publish-app-release.ts`; the reasoning is on `models/app-release.model.ts`. If a
 * publishing screen is ever wanted it belongs in wi-admin behind a permission, like every
 * other administrative write on this platform (ADR-004 D-4).
 *
 * The IP rate limiter covering this mount is `publicRateLimiter`, applied once in
 * `api/index.ts` in front of every `/public` router — this one included, which is why it is
 * mounted after that line and not before it.
 */
const router = Router();

/** Metadata for the current build: version, size, checksums, notes. */
router.get('/app/:app/latest', PublicAppReleaseController.latest);

/** The stable link. 302 to the artefact. */
router.get('/app/:app/download', PublicAppReleaseController.download);

export default router;
