/**
 * App distribution — direct download of first-party mobile builds.
 *
 * The agent app is not on Google Play yet, so an agent installs it from the marketing site.
 * This module is the backend half of that: one row per published build (`app_releases`), two
 * unauthenticated reads under `/api/public/app`, and one storage tree (`app-releases`).
 *
 * ── The three things to know before changing anything here ───────────────────
 *  1. **The write path is a script, not a route** — `scripts/publish-app-release.ts`. See
 *     `models/app-release.model.ts` for why.
 *  2. **This service never serves the bytes.** `/download` is a 302 to the storage provider's
 *     public URL. See `services/app-release.service.ts` for why, and for what it costs.
 *  3. **`app-releases` is a PUBLIC storage tree**, so an uploaded artefact is fetchable the
 *     instant the script finishes. There is no unpublished state, and `AppReleaseStatus` has
 *     no `draft` for exactly that reason.
 *
 * Contract: `api-doc/public/app-downloads.md`. Suite: `npm run test:app-releases`.
 */
export * from './app-distribution.types';
export { AppReleaseModel, IAppRelease } from './models/app-release.model';
export { appReleaseRepository, AppReleaseRepository } from './repositories/app-release.repository';
export { appReleaseService, AppReleaseService } from './services/app-release.service';
export { default as publicAppReleaseRoutes } from './routes/public-app-release.routes';
