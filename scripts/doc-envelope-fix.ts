/*
 * doc-envelope-fix.ts — rewrite the error bodies api-doc SHOWS into the shape the server sends.
 *
 * F-17's highest-value class, applied. `DOC-PROGRAM/tools/doc-error-envelope.js` finds them; this
 * fixes them. It lives here rather than in `DOC-PROGRAM/tools/` for one reason: it must not
 * RE-DERIVE the category rule.
 *
 *   import { categoryFor } from '../src/core/error-category';
 *
 * That function is the platform's answer, overrides and integration prefixes included. A
 * JavaScript reimplementation next door would be a second opinion about a rule with one owner,
 * and it would be wrong the first time `CATEGORY_OVERRIDES` gains an entry — which is exactly the
 * decay class this whole program exists to remove.
 *
 * ── What it will NOT do ───────────────────────────────────────────────────────
 * It refuses rather than guesses, and prints every refusal:
 *
 *   - no status code recoverable from the surrounding prose  → skipped
 *   - the `code` is not in ERROR_CODES                       → skipped and REPORTED, because a
 *     phantom code is a different defect (F-17's second class) and silently wrapping it in a
 *     correct-looking envelope would make it harder to find, not easier
 *
 * Run:  npx ts-node scripts/doc-envelope-fix.ts [--apply]
 * Without `--apply` it is a dry run and writes nothing.
 */
import * as fs from 'fs';
import * as path from 'path';

import { ERROR_CODES } from '../src/core/error-codes';
import { categoryFor } from '../src/core/error-category';

const APPLY = process.argv.includes('--apply');
const BE = path.resolve(__dirname, '../..');

const TREES = [
    path.join(BE, 'jovi-mall', 'api-doc'),
    path.join(BE, 'admin', 'docs'),
    path.join(BE, 'geo-tracker', 'api-doc'),
];

const EXEMPT = [/[\\/]payments[\\/]/, /[\\/]n8n[\\/]/, /BACKEND-(GAPS|REQUIREMENTS|BLOG-REQUIREMENTS)/, /backend-requests[\\/]/];

const KNOWN = new Set<string>(Object.values(ERROR_CODES as Record<string, string>));

function walk(dir: string, acc: string[]): string[] {
    let ents: fs.Dirent[];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
    for (const e of ents) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, acc);
        else if (/\.md$/i.test(e.name)) acc.push(full);
    }
    return acc;
}

/*
 * The status code is stated in the prose above the block, in one of the shapes these pages use:
 *   **Not Found (404)**   ### 409 Conflict   `HTTP/1.1 422`   | `404` |
 * Only the nearest 12 lines are searched — further away and it is another endpoint's status.
 */
function statusAbove(lines: string[], fenceLine: number): number | null {
    for (let i = fenceLine - 2; i >= Math.max(0, fenceLine - 13); i--) {
        const m = lines[i].match(/\b(4\d\d|5\d\d)\b/);
        if (m) return Number(m[1]);
    }
    return null;
}

const skipped: string[] = [];
const phantom: string[] = [];
let filesChanged = 0, blocksFixed = 0;

for (const tree of TREES) {
    for (const file of walk(tree, [])) {
        const rel = path.relative(BE, file).split(path.sep).join('/');
        if (EXEMPT.some((re) => re.test(file))) continue;

        const original = fs.readFileSync(file, 'utf8');
        const eol = original.includes('\r\n') ? '\r\n' : '\n';
        const lines = original.split(/\r?\n/);
        let changed = false;

        // locate fenced blocks
        const fences: number[] = [];
        lines.forEach((l, i) => { if (/^\s*```/.test(l)) fences.push(i); });

        for (let f = 0; f + 1 < fences.length; f += 2) {
            const start = fences[f], end = fences[f + 1];
            const body = lines.slice(start + 1, end).join('\n');

            if (!/"error"\s*:/.test(body) || !/"code"\s*:/.test(body)) continue;
            if (/"data"\s*:/.test(body) && !/"success"\s*:\s*false/.test(body)) continue;

            const needsReq = !/"requestId"\s*:/.test(body);
            const needsStatus = !/"statusCode"\s*:/.test(body);
            const needsCat = !/"category"\s*:/.test(body);
            // ⚠ The Zod `details` shape ([{field,message}] → {fields:[{path,message,code}]}) is
            // deliberately NOT rewritten here. The first attempt did, and produced malformed JSON:
            // re-nesting an array one level deeper means re-indenting every line inside it and
            // inventing a Zod issue `code` the page never carried. Those blocks are fixed by hand.
            if (!needsReq && !needsStatus && !needsCat) continue;

            /*
             * ── `requestId` is INDEPENDENT of the other two, and separating them matters ──
             *
             * `statusCode` and `category` need a status this tool can only recover from prose, and
             * `category` additionally needs a real code to derive from. `requestId` needs neither —
             * it is on every response the server sends, whatever went wrong. Gating all three
             * together (the first version) left 35 examples missing it purely because a nearby
             * heading did not spell out a number, or because the block used a placeholder code.
             */
            const codeM = body.match(/"code"\s*:\s*"([A-Z0-9_]+)"/);
            const code = codeM ? codeM[1] : null;
            const status = statusAbove(lines, start + 1);

            const knownCode = code !== null && KNOWN.has(code);
            if (code !== null && !knownCode) phantom.push(rel + ':' + (start + 1) + '  `' + code + '` is in no registry');
            if (status === null) skipped.push(rel + ':' + (start + 1) + '  no status code in the 12 lines above');

            // the pair is only safe to write when BOTH inputs are trustworthy
            const canPair = knownCode && status !== null;
            const doStatus = needsStatus && canPair;
            const doCat = needsCat && canPair;
            if (!needsReq && !doStatus && !doCat) continue;

            const category = canPair ? categoryFor(code as never, status as number) : '';

            /*
             * ── rewrite by INDEX, not by per-line regex ────────────────────────
             *
             * The first version matched `"message"` on every line and injected into the FIRST one,
             * which inside a validation body is the message of a `details.fields[]` entry — so it
             * put `statusCode` and `category` inside the field object. Locating the error object's
             * own message by position is the fix: it is the first `"message"` AFTER the first
             * `"code"` and BEFORE any `"details"`.
             */
            const seg = lines.slice(start + 1, end);
            const codeIdx = seg.findIndex((l) => /"code"\s*:/.test(l));
            const detailsIdx = seg.findIndex((l) => /"details"\s*:/.test(l));
            const limit = detailsIdx === -1 ? seg.length : detailsIdx;
            let msgIdx = -1;
            for (let i = codeIdx + 1; i < limit; i++) {
                if (/"message"\s*:/.test(seg[i])) { msgIdx = i; break; }
            }
            const anchor = msgIdx === -1 ? codeIdx : msgIdx;
            if (anchor === -1) { skipped.push(rel + ':' + (start + 1) + '  no anchor line'); continue; }

            /*
             * ⚠ SINGLE-LINE blocks are refused, and this cost a real defect on the first apply.
             *
             * The whole insertion strategy is "append a line after the line holding the anchor
             * key", which assumes one key per line. `customer/profile.md` writes an entire error
             * envelope on ONE line, so the anchor line was the whole object and `"category"` was
             * appended OUTSIDE it — valid-looking markdown, invalid JSON. Caught only by parsing
             * every block before and after; a diff read by eye looks fine.
             */
            if (seg.filter((l) => l.trim() !== '').length === 1) {
                skipped.push(rel + ':' + (start + 1) + '  single-line JSON — inject by hand');
                continue;
            }

            const out: string[] = [];
            for (let i = 0; i < seg.length; i++) {
                const line = seg[i];

                if (needsReq && /"success"\s*:\s*false/.test(line)) {
                    const ind = (line.match(/^\s*/) || [''])[0];
                    out.push(line.replace(/,?\s*$/, ','));
                    out.push(ind + '"requestId": "3f8a1c74-9b2e-4d10-8c55-6a0f2b7e19dd",');
                    continue;
                }

                if (i === anchor && (doStatus || doCat)) {
                    const ind = (line.match(/^\s*/) || [''])[0];
                    // does anything follow inside the error object? if so the last line we add
                    // keeps its comma; if not, it must not have one.
                    const rest = seg.slice(i + 1).find((l) => l.trim() !== '');
                    const more = !!rest && !/^\s*[}\]]/.test(rest);
                    out.push(line.replace(/,?\s*$/, ','));
                    const added: string[] = [];
                    if (doStatus) added.push(ind + '"statusCode": ' + status);
                    if (doCat) added.push(ind + '"category": "' + category + '"');
                    added.forEach((l, k) => out.push(l + (k < added.length - 1 || more ? ',' : '')));
                    continue;
                }

                out.push(line);
            }

            const newSeg = out;
            lines.splice(start + 1, end - start - 1, ...newSeg);
            // fence indices after this block shift
            const delta = newSeg.length - (end - start - 1);
            for (let k = f + 1; k < fences.length; k++) fences[k] += delta;
            changed = true;
            blocksFixed++;
        }

        if (changed) {
            filesChanged++;
            if (APPLY) fs.writeFileSync(file, lines.join(eol), 'utf8');
        }
    }
}

console.log((APPLY ? 'APPLIED' : 'DRY RUN') + ' — envelope repair');
console.log('  blocks rewritten: ' + blocksFixed + '   files: ' + filesChanged);
console.log('');
console.log('  SKIPPED (no confident status code): ' + skipped.length);
for (const s of skipped) console.log('      ' + s);
console.log('');
console.log('  🔴 PHANTOM CODE — left alone, needs a human (F-17 class 2): ' + phantom.length);
for (const p of phantom) console.log('      ' + p);
