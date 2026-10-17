/**
 * Verify: the vendor- and agency-dashboard paths the website guide links to are real routes.
 *
 * The twin of `verify:landing-routes`, for `website-guide-vendor.ts` and `website-guide-agency.ts`
 * (2026-10-09). Same reasoning, same shape: a `verify:` and not a `test:`, because CI does not check
 * out the dashboards, and it REFUSES (exit 2) when a dashboard is not beside this repository
 * rather than passing having checked nothing.
 *
 * ── HOW A ROUTE IS FOUND ─────────────────────────────────────────────────────
 * Both dashboards are React Router apps with no locale segment. Their routes are `<Route path="…">`
 * literals: absolute ones (`/login`, `/onboarding/*`) in `App.tsx`, and relative ones (`orders`,
 * `account/:tab`) inside the shell mounted at `/dashboard/*`. So every literal is read; a relative
 * one is taken to live under `/dashboard`. A guide path matches when each segment equals the
 * pattern's, a `:param` takes any one segment, and a trailing `*` takes the rest.
 *
 * ⚠ **What this does NOT prove**: a `:tab` route matches ANY tab name, so `/dashboard/settings/nope`
 * would pass. Every tab a guide topic names is therefore also looked for as a quoted literal in
 * the dashboard's source — a weaker check, said out loud here rather than reported as a pass.
 *
 * Run: npm run verify:dashboard-routes [-- --vendor <path>] [-- --agency <path>]
 */
import fs from 'fs';
import path from 'path';
import { WEBSITE_GUIDE } from '../src/modules/bot-surface/domain/website-guide';

const ROOT = path.resolve(__dirname, '../../../frontend');
/** A literal route segment counts as present when it appears between any two of these. */
const QUOTES = ["'", '"', '`', '/'];

function flag(name: string, fallback: string): string {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : fallback;
}

function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...sourceFiles(full));
        else if (/\.(tsx?|jsx?)$/.test(entry.name)) out.push(full);
    }
    return out;
}

function routePatterns(src: string): string[] {
    const patterns = new Set<string>();
    for (const file of sourceFiles(src)) {
        const text = fs.readFileSync(file, 'utf8');
        for (const m of text.matchAll(/<Route\b[^>]*?\bpath=["']([^"']+)["']/gs)) {
            const p = m[1];
            if (p === '*') continue;
            patterns.add(p.startsWith('/') ? p : `/dashboard/${p}`);
        }
    }
    return [...patterns];
}

/**
 * ⚠ A trailing `*` is a MOUNT (`/dashboard/*`, `/onboarding/*`), not a page: it matches its own
 * root and nothing below it. The first version let `*` take the rest of the path, and then
 * `/dashboard/*` vouched for every made-up dashboard path — found by feeding it
 * `/dashboard/nowhere`, which passed. The pages below a mount are its own relative routes.
 */
function matches(guidePath: string, pattern: string): boolean {
    const g = guidePath.split('/').filter(Boolean);
    const p = pattern.split('/').filter(Boolean);
    if (p[p.length - 1] === '*') return g.length === p.length - 1 && g.every((seg, i) => seg === p[i]);
    for (let i = 0; i < p.length; i++) {
        if (i >= g.length) return false;
        if (!p[i].startsWith(':') && p[i] !== g[i]) return false;
    }
    return g.length === p.length;
}

function main(): void {
    const apps = [
        { app: 'vendor' as const, src: path.join(flag('vendor', path.join(ROOT, 'vendor-dash')), 'src') },
        { app: 'agency' as const, src: path.join(flag('agency', path.join(ROOT, 'agency-dash')), 'src') },
    ];

    const absent = apps.filter((a) => !fs.existsSync(a.src));
    if (absent.length > 0) {
        console.error('⛔ CANNOT VERIFY — a dashboard is not here.');
        for (const a of absent) console.error(`   Looked for the ${a.app} dashboard in: ${a.src}`);
        console.error('   Point it at a checkout:  npm run verify:dashboard-routes -- --vendor <path> --agency <path>');
        process.exit(2);
    }

    const missing: string[] = [];
    let checked = 0;

    for (const { app, src } of apps) {
        const patterns = routePatterns(src);
        if (patterns.length === 0) {
            console.error(`⛔ no <Route path> found under ${src} — this check is reading the wrong thing`);
            process.exit(1);
        }
        const allSource = sourceFiles(src).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
        const topics = WEBSITE_GUIDE.filter((t) => t.app === app && t.path !== null);

        console.log(`\n══ ${app} dashboard — ${topics.length} guide paths against ${patterns.length} routes ══\n`);

        for (const t of topics) {
            checked++;
            const routePath = t.path as string;
            const hit = patterns.find((p) => matches(routePath, p));
            // A `:param` matched a literal segment: that literal must at least exist in the source.
            const loose = hit
                ? hit.split('/').filter(Boolean)
                    .map((seg, i) => (seg.startsWith(':') ? routePath.split('/').filter(Boolean)[i] : null))
                    .filter((seg): seg is string => seg !== null)
                    .filter((seg) => !QUOTES.some((a) => QUOTES.some((b) => allSource.includes(`${a}${seg}${b}`))))
                : [];
            const ok = Boolean(hit) && loose.length === 0;
            console.log(`  ${ok ? '✅' : '❌'} ${t.key.padEnd(22)} ${routePath}${hit && hit !== routePath ? `   (${hit})` : ''}`);
            if (!hit) missing.push(`${t.key} → ${routePath} (no route)`);
            else if (loose.length) missing.push(`${t.key} → ${routePath} ("${loose.join('", "')}" appears nowhere in the source)`);
        }
    }

    if (missing.length > 0) {
        console.error(`\n❌ ${missing.length} of ${checked} dashboard paths do not resolve:`);
        for (const row of missing) console.error(`     ${row}`);
        console.error('\n   Either the page moved in the dashboard, or the guide is stale.');
        process.exit(1);
    }
    console.log(`\n✅ all ${checked} dashboard paths resolve to a route`);
}

main();
