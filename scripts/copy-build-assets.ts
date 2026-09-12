/**
 * Copies the non-TypeScript assets `tsc` does not emit from `src/` into `dist/`.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * `tsc` emits `.js` (and, because `resolveJsonModule` is on, any `.json` that is
 * *imported* as a module). It emits nothing else. Anything read off disk at runtime
 * with a `__dirname`-relative path therefore exists in `src/` and NOT in `dist/`,
 * and the two run paths disagree:
 *
 *     npm run dev    → ts-node src/server.ts  → __dirname is src/modules/mail   ✅
 *     npm start      → node   dist/server.js  → __dirname is dist/modules/mail  ❌
 *
 * That is not hypothetical. `mail.service.ts:87` resolves
 * `path.join(__dirname, 'templates', name + '.hbs')`, and the six Handlebars
 * templates were **never** in `dist/`. Every templated email — welcome,
 * verify-email, reset-password and the three notification digests — threw
 * `MAIL_TEMPLATE_NOT_FOUND` in any deployment that ran the compiled output. It went
 * unnoticed for the ordinary reason: development never runs the build, and CI
 * type-checks without ever building. Containerising the service (plan step 2.B.1)
 * is what surfaced it, because an image has no `src/` to fall back on.
 *
 * ── WHY A MANIFEST RATHER THAN "COPY EVERYTHING NON-.ts" ─────────────────────
 * `src/` also holds READMEs, a stray test PDF under `src/storage-test/`, and the
 * gitignored `src/scripts/` tree. None of those belong in a runtime image. An
 * explicit list is a claim somebody made on purpose; a glob is a claim nobody made.
 *
 * `test:system` scans `src/` for asset extensions and asserts every one is covered
 * here, so adding a `.hbs`/`.sql`/`.yaml` to `src/` without listing it fails the
 * suite instead of failing in production.
 *
 * Run automatically by `npm run build`. Failing loudly is the point: a missing
 * source directory means the manifest is stale, and a silent skip would restore
 * exactly the failure mode this file was written to close.
 */
import { cpSync, existsSync } from 'fs';
import { join, relative } from 'path';

const ROOT = join(__dirname, '..');

/**
 * Directories under `src/` whose contents must reach `dist/`, at the same relative
 * path — the runtime resolves them from `__dirname`, so the layout has to match.
 */
const ASSET_DIRS: readonly string[] = [
    // Handlebars email bodies, read by `MailService.renderTemplate`.
    'modules/mail/templates',
    // The negotiation agent's playbook, read at runtime and served to the bargaining
    // sub-agent as its system prefix. Markdown, and therefore the one asset extension
    // `test:system` used to skip wholesale - see NON_RUNTIME_EXTENSIONS there.
    'modules/negotiation/playbook',
    /**
     * The bot's product-card assets: the stand-in picture for a product with no image, and
     * the Telegram Mini App page.
     *
     * ⚠ **Neither may live under `storage/`, which is where a static file instinctively
     * belongs here.** That tree is in `.dockerignore` — it is 112 MB of real uploads bound to
     * a named volume (D-6) — so a file committed there is present in development and absent
     * from every container image, which is exactly the split that made every Handlebars email
     * template throw under `npm start` and is the reason this script exists.
     */
    'modules/bot-surface/assets',
    'modules/bot-surface/miniapp/public',
];

let copied = 0;
const missing: string[] = [];

for (const dir of ASSET_DIRS) {
    const from = join(ROOT, 'src', dir);
    const to = join(ROOT, 'dist', dir);

    if (!existsSync(from)) {
        missing.push(dir);
        continue;
    }

    cpSync(from, to, { recursive: true });
    copied += 1;
    console.log(`  copied  src/${dir}  →  ${relative(ROOT, to).replace(/\\/g, '/')}`);
}

if (missing.length > 0) {
    console.error(
        `\n✗ copy-build-assets: ${missing.length} manifest entr${missing.length === 1 ? 'y names' : 'ies name'} `
        + `a directory that does not exist under src/:\n`
        + missing.map((d) => `    src/${d}`).join('\n')
        + `\n\n  Either the directory moved and ASSET_DIRS is stale, or it was deleted and the`
        + `\n  entry should go. Do not "fix" this by skipping quietly — the whole point of this`
        + `\n  script is that a missing runtime asset fails the build rather than the deploy.\n`,
    );
    process.exit(1);
}

console.log(`✔ copy-build-assets — ${copied} asset director${copied === 1 ? 'y' : 'ies'} copied into dist/`);
