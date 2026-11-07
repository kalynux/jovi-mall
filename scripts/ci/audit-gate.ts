/**
 * The production-dependency audit gate, run by CI in place of a bare
 * `npm audit --omit=dev --audit-level=high`.
 *
 * npm has no way to accept ONE advisory, so a single unfixable high fails the build
 * forever — and a permanently red step is one people stop reading. This gate fails on
 * every high/critical advisory EXCEPT the ones named in ACCEPTED, each with its reason.
 *
 * It fails IN EITHER DIRECTION, like the suite baselines in ci.yml: a new high still
 * breaks the build, and an accepted advisory that no longer appears breaks it too, so
 * the fix is noticed and the entry deleted rather than left to excuse a future one.
 *
 * It fails CLOSED: if `npm audit` produces no report (registry down, npm error), that is
 * a failure, not an empty list.
 */
import { spawnSync } from 'node:child_process';

interface Advisory {
    id: string;
    pkg: string;
    severity: string;
    title: string;
    range: string;
}

const ACCEPTED: Record<string, string> = {
    // zod 3.x — memory exhaustion validating an oversized array with no length cap.
    // Patched only in 4.6.6; the 3.x line ends at 3.25.76. Upgrading is a zod 4
    // migration (123 files here, and wi-admin too). Bounded meanwhile by the 1 MB
    // JSON_BODY_LIMIT (12 MB on the two internal routes). Accepted by the owner
    // 2026-10-25; delete this entry in the zod 4 upgrade.
    'GHSA-mrhx-c7xc-m3w5': 'zod <4.6.6 — accepted 2026-10-25 until the zod 4 upgrade',
};

const GATED = new Set(['high', 'critical']);

const run = spawnSync('npm', ['audit', '--omit=dev', '--json'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    maxBuffer: 64 * 1024 * 1024,
});

let report: { error?: unknown; vulnerabilities?: Record<string, { via: unknown[] }> };
try {
    report = JSON.parse(run.stdout);
} catch {
    console.error('audit-gate: `npm audit` produced no JSON report — failing closed.');
    console.error(run.stderr || run.stdout);
    process.exit(1);
}
if (report.error || !report.vulnerabilities) {
    console.error('audit-gate: `npm audit` reported an error — failing closed.');
    console.error(JSON.stringify(report.error ?? report, null, 2));
    process.exit(1);
}

// Each advisory appears in `via` as an object on the package it was filed against;
// packages that merely depend on it list its name as a string. Dedupe by advisory id.
const advisories = new Map<string, Advisory>();
for (const vuln of Object.values(report.vulnerabilities)) {
    for (const entry of vuln.via) {
        if (typeof entry !== 'object' || entry === null) continue;
        const via = entry as { url?: string; source?: number; name: string; severity: string; title: string; range: string };
        const id = String(via.url ?? '').split('/').pop() || String(via.source);
        advisories.set(id, { id, pkg: via.name, severity: via.severity, title: via.title, range: via.range });
    }
}

const blocking = [...advisories.values()].filter((a) => GATED.has(a.severity) && !(a.id in ACCEPTED));
const accepted = [...advisories.values()].filter((a) => a.id in ACCEPTED);
const stale = Object.keys(ACCEPTED).filter((id) => !advisories.has(id));
const below = [...advisories.values()].filter((a) => !GATED.has(a.severity) && !(a.id in ACCEPTED));

for (const a of accepted) console.log(`  accepted  ${a.severity.padEnd(8)} ${a.pkg} ${a.range} — ${a.id}: ${ACCEPTED[a.id]}`);
for (const a of below) console.log(`  below     ${a.severity.padEnd(8)} ${a.pkg} ${a.range} — ${a.id}: ${a.title}`);
for (const a of blocking) console.log(`  BLOCKING  ${a.severity.padEnd(8)} ${a.pkg} ${a.range} — ${a.id}: ${a.title}`);
for (const id of stale) console.log(`  STALE     ${id} is accepted but no longer reported — delete it from ACCEPTED in scripts/ci/audit-gate.ts`);

if (blocking.length || stale.length) {
    console.error(`audit-gate: ${blocking.length} blocking advisory(ies), ${stale.length} stale acceptance(s).`);
    process.exit(1);
}
console.log(`audit-gate: pass — ${accepted.length} accepted, ${below.length} below the high threshold.`);
