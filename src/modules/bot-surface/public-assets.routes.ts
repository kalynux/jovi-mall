import path from 'path';
import { Request, Response, Router } from 'express';

/**
 * `/api/public/assets` — the platform's own images, as opposed to anybody's uploads.
 *
 * ── ONE FILE, DECLARED, RATHER THAN A DIRECTORY MOUNT ───────────────────────
 * There is exactly one asset here and it is written out by name. Two reasons, and the second
 * is the one that decided it:
 *
 *   - **A directory mount is a promise about every file somebody drops in later.** This tree
 *     lives inside `src/`, beside source; an `express.static` on it would publish whatever a
 *     future author puts there, and nobody would notice.
 *   - ⚠ **`test:uploads` pins the exact text of the `express.static(path.join(...))` call in
 *     `api/index.ts`**, because that assertion is what proves the storage mount list is
 *     DERIVED from `storage-trees.ts` rather than hand-kept. A second `express.static` in the
 *     same file weakens the one guard standing between a private storage tree and the public
 *     internet, and it would do so for a formatting reason.
 *
 * ── WHY THE FILE IS IN `src/` AND NOT IN `storage/` ─────────────────────────
 * `storage/system/` is already classified public and already mounted, so it looks like the
 * obvious home. It is the wrong one: `storage/` is in `.dockerignore` — it is a named volume
 * holding real uploads (ADR D-6) — so a file committed there is present in development and
 * absent from every container image. That is the split that left six Handlebars email
 * templates missing under `npm start` for months.
 */
const router = Router();

/** A year. The bytes never change; a new stand-in would be a new file name. */
const IMMUTABLE = 'public, max-age=31536000, immutable';

/**
 * The stand-in for a product with no usable photograph.
 *
 * ⚠ **Fetched by TELEGRAM'S and META'S servers, not by a browser**, which is why it needs a
 * public route at all and why `Cross-Origin-Resource-Policy` matters here as much as it does
 * on the uploads mount: `app.use(helmet())` stamps `same-origin` globally, and a card image
 * is loaded by a no-cors request that consults CORP and throws the bytes away. The same
 * paragraph in `api/index.ts` explains it at length for the storage trees.
 *
 * The URL is built by `botPlaceholderImageUrl`, which is the only caller — and which returns
 * null rather than this path when there is no publicly reachable origin to serve it from.
 */
router.get('/assets/no-product-image.png', (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', IMMUTABLE);
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.type('png');
    // `__dirname`-relative, so `modules/bot-surface/assets` is on the build-assets manifest.
    res.sendFile(path.join(__dirname, 'assets', 'no-product-image.png'));
});

export default router;
