/**
 * Verify: the storefront paths this service links customers to are real routes in the landing app.
 *
 * ── WHY THIS IS A `verify:` AND NOT A `test:` ───────────────────────────────
 * `SURFACE_PATHS` in `domain/bot-list-window.ts` is a HAND-KEPT COPY of `frontend/landing`'s
 * routes. There is no shared package, nothing checks it at build time, and a page renamed over
 * there turns ten links here into 404s **silently** — discovered by a customer who tapped "see
 * the rest" and landed on nothing.
 *
 * The obvious move is a `test:` that skips when the other repository is absent. That was
 * considered and refused: CI does not check out the landing app, so such a test would report
 * **passed** having verified nothing, on every run, for ever — the exact shape this round has
 * spent its time removing. A check that finds nothing and says "passed" is worse than no check,
 * because it also retires the worry.
 *
 * So this is a `verify:` — the family this repository already keeps for things CI cannot do —
 * and it **REFUSES** when the landing app is not present (exit 2, a stated "cannot check from
 * here") rather than passing. It belongs on the deploy-day list, where somebody runs it before
 * the links go out.
 *
 * ⚠ **Read-only, one direction, every path in the table.** It derives the list from
 * `SURFACE_PATHS` rather than holding one, precisely so no comment here has to say how many
 * there are — a count in prose is wrong the week after it is written. It never writes, never
 * installs, and must not grow
 * into a build dependency on a repository this one does not control.
 *
 * Run: npm run verify:landing-routes [-- --landing <path>]
 */
import fs from 'fs';
import path from 'path';
import { BOT_LIST_SURFACES, surfacePath } from '../src/modules/bot-surface/domain/bot-list-window';

/** Where the landing app lives when the two repositories sit side by side, as they do locally. */
const DEFAULT_LANDING = path.resolve(__dirname, '../../../frontend/landing');

function landingRoot(): string {
    const flag = process.argv.indexOf('--landing');
    return flag >= 0 && process.argv[flag + 1]
        ? path.resolve(process.argv[flag + 1])
        : DEFAULT_LANDING;
}

/**
 * Does this Next.js app serve `/shop/account/orders`?
 *
 * ⚠ **A route is a DIRECTORY holding a page file**, and the locale segment is a dynamic one
 * (`[locale]`), so the path is looked up beneath it. A directory with no page file is a
 * grouping, not a route, and must not count — that distinction is the whole reason this walks
 * the tree rather than testing `existsSync` on the directory alone.
 */
function servesRoute(appDir: string, routePath: string): boolean {
    const segments = routePath.split('/').filter(Boolean);
    const candidates = [path.join(appDir, '[locale]'), appDir];

    return candidates.some((base) => {
        const dir = path.join(base, ...segments);
        if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return false;
        return ['page.tsx', 'page.ts', 'page.jsx', 'page.js', 'route.ts', 'route.js']
            .some((file) => fs.existsSync(path.join(dir, file)));
    });
}

function main(): void {
    const root = landingRoot();
    const appDir = path.join(root, 'src', 'app');

    /**
     * ⛔ The refusal that makes this honest. Exit 2 rather than 0: "not verified" is a different
     * outcome from "verified", and a runner that treats them alike has learned nothing.
     */
    if (!fs.existsSync(appDir)) {
        console.error('⛔ CANNOT VERIFY — the landing app is not here.');
        console.error(`   Looked in: ${appDir}`);
        console.error('   This check compares the storefront paths this bot links to against the');
        console.error('   landing app\'s real routes. Without that repository it can prove nothing,');
        console.error('   so it refuses rather than reporting a pass it did not earn.');
        console.error('   Point it at a checkout:  npm run verify:landing-routes -- --landing <path>');
        process.exit(2);
    }

    const surfaces = [...BOT_LIST_SURFACES];
    if (surfaces.length === 0) {
        console.error('⛔ the surface list is empty — this check is reading the wrong thing');
        process.exit(1);
    }

    console.log(`\n══ Storefront paths, against ${appDir} ══\n`);

    const missing: string[] = [];
    for (const surface of surfaces) {
        const routePath = surfacePath(surface);
        const ok = servesRoute(appDir, routePath);
        console.log(`  ${ok ? '✅' : '❌'} ${surface.padEnd(16)} ${routePath}`);
        if (!ok) missing.push(`${surface} → ${routePath}`);
    }

    if (missing.length > 0) {
        console.error(`\n❌ ${missing.length} of ${surfaces.length} paths do not resolve to a route:`);
        for (const row of missing) console.error(`     ${row}`);
        console.error('\n   Either the page moved in the landing app, or this table is stale.');
        console.error('   Every one of these is a link a customer can tap in a chat.');
        process.exit(1);
    }

    console.log(`\n✅ all ${surfaces.length} storefront paths resolve to a route\n`);
}

main();
