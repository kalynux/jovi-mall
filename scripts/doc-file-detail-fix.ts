/*
 * doc-file-detail-fix.ts — add the missing `access` to every `FileDetail` api-doc SHOWS.
 *
 * F-17's third class, applied. `DOC-PROGRAM/tools/doc-file-detail.js` finds them; this fixes them.
 * It lives here rather than in `DOC-PROGRAM/tools/` for the same reason `doc-envelope-fix.ts`
 * does: it must not RE-DERIVE the public/private rule.
 *
 *   import { isPrivateStorageKey, treeOfKey, STORAGE_TREE_VISIBILITY } from '…/storage-trees';
 *
 * That table is the platform's answer — an ALLOWLIST census of every tree. A JavaScript
 * reimplementation next door would be a second opinion about a rule with one owner, and it would
 * be wrong the first time a tree is added or reclassified.
 *
 * ── Why `access` can be computed rather than guessed ──────────────────────────
 * `toFileDetail` sets it from the key and nothing else:
 *
 *     url:    isPrivate ? null : storage.getPublicUrl(file.key)
 *     access: isPrivate ? 'authorized' : 'public'
 *
 * ⚠ **But it can only be computed from a key that names a REAL tree**, and most doc example keys
 * do not. That refusal is the finding, not a footnote — see bug 1.
 *
 * ── Three bugs this went through, and each one is a rule now ──────────────────
 * 1. **It inherited the runtime's fail-closed default.** `isPrivateStorageKey` answers *private*
 *    for an unrecognised tree, which is right when it guards bytes and WRONG here: a doc key like
 *    `vendors/avatar-xyz789.png` names no tree in the census, and defaulting it to private would
 *    stamp `access: "authorized"` onto a **public avatar** — a worse claim than the missing field,
 *    because it tells every client the url is null when it is not. It now REFUSES an unclassified
 *    tree. *A fail-closed default and a fail-to-refuse default are not the same policy.*
 * 2. **It inserted after an anchor and produced a TRAILING COMMA** when that anchor was the
 *    object's last property — valid-looking markdown, invalid JSON, 8 blocks.
 * 3. **Its line-axis brace search found the PARENT's braces** for an inline object nested in a
 *    multi-line one (`"avatar": { … }` on one line inside a multi-line `customer`), so the
 *    single-line guard passed and `access` landed OUTSIDE the object — 25 blocks. That is
 *    `doc-envelope-fix.ts`'s own lesson arriving in a shape its guard did not cover.
 *
 * Bugs 2 and 3 are closed by one decision: **work in CHARACTERS, not lines, and insert
 * immediately BEFORE `"mimeType"`.** `mimeType` is never the first property (`id`/`key`/`url`
 * precede it) and never the last (`size` follows), so there is a comma on both sides already and
 * the trailing-comma case cannot arise at all. It also lands `access` exactly where
 * `toFileDetail` puts it.
 *
 * ⚠ Both were caught ONLY by `DOC-PROGRAM/tools/json-blocks.js` (827 → 819). Run it before and
 * after, and compare per file.
 *
 * ── What it will NOT do ───────────────────────────────────────────────────────
 * It refuses rather than guesses, and prints every refusal:
 *
 *   - no `"key"` in the object                → nothing to derive from
 *   - the key names no CLASSIFIED tree        → the common case; see bug 1
 *   - the object already carries `access`     → skipped silently
 *
 * Run:  npx ts-node scripts/doc-file-detail-fix.ts [--apply]
 * Without `--apply` it is a dry run and writes nothing.
 */
import * as fs from 'fs';
import * as path from 'path';

import { isPrivateStorageKey, treeOfKey, STORAGE_TREE_VISIBILITY } from '../src/core/storage/storage-trees';

const APPLY = process.argv.includes('--apply');
const BE = path.resolve(__dirname, '../..');

const TREES = [
    path.join(BE, 'jovi-mall', 'api-doc'),
    path.join(BE, 'admin', 'docs'),
    path.join(BE, 'geo-tracker', 'api-doc'),
];

const EXEMPT = [/BACKEND-(GAPS|REQUIREMENTS|BLOG-REQUIREMENTS|SHOP-REQUIREMENTS)/, /backend-requests\//];

/** Fields that only ever appear on the stored `File` record, never on a `FileDetail`. */
const RAW_RECORD_MARKERS = ['provider', 'checksum', 'usageCount', 'ownerType', 'ownerId'];

function walk(dir: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (e.name.endsWith('.md')) out.push(p);
    }
    return out;
}

const hasKey = (s: string, k: string) => new RegExp(`"${k}"\\s*:`).test(s);

/** The innermost `{…}` enclosing `i`, as [start, end]. Null when unbalanced. */
function enclosingObject(text: string, i: number): [number, number] | null {
    let depth = 0;
    let open = -1;
    for (let p = i; p >= 0; p--) {
        const c = text[p];
        if (c === '}') depth++;
        else if (c === '{') {
            if (depth === 0) { open = p; break; }
            depth--;
        }
    }
    if (open === -1) return null;
    depth = 0;
    for (let p = open; p < text.length; p++) {
        const c = text[p];
        if (c === '{') depth++;
        else if (c === '}') {
            depth--;
            if (depth === 0) return [open, p];
        }
    }
    return null;
}

let fixed = 0;
let skipped = 0;
const touched = new Set<string>();

for (const root of TREES) {
    if (!fs.existsSync(root)) continue;

    for (const file of walk(root)) {
        const rel = path.relative(BE, file).replace(/\\/g, '/');
        if (EXEMPT.some((r) => r.test(rel))) continue;

        const text = fs.readFileSync(file, 'utf8');
        const edits: Array<{ at: number; insert: string }> = [];

        const re = /"mimeType"\s*:/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
            const range = enclosingObject(text, m.index);
            if (!range) continue;
            const obj = text.slice(range[0], range[1] + 1);

            if (RAW_RECORD_MARKERS.some((k) => hasKey(obj, k))) continue;
            // ⚠ `key` is REQUIRED. `AssetDetail` (`product-detail.read-model.ts:48`) is a
            // narrower type — `{id, originalName, mimeType, size}` — that deliberately carries
            // no url and no key. The looser signature reported both digital-product pages as
            // needing a hand fix when they were already RIGHT.
            if (!hasKey(obj, 'id') || !hasKey(obj, 'key')) continue;
            if (hasKey(obj, 'access')) continue;

            const line = text.slice(0, m.index).split('\n').length;

            const keyMatch = obj.match(/"key"\s*:\s*"([^"]+)"/);
            if (!keyMatch) {
                console.log(`  SKIP  ${rel}:${line}  no "key" to derive access from (fix by hand)`);
                skipped++;
                continue;
            }

            // ⚠ REFUSE an unclassified tree rather than inheriting the runtime's private default.
            const tree = treeOfKey(keyMatch[1]);
            if (!tree || !(tree in STORAGE_TREE_VISIBILITY)) {
                console.log(`  SKIP  ${rel}:${line}  key "${keyMatch[1]}" names no classified tree (fix by hand)`);
                skipped++;
                continue;
            }

            const access = isPrivateStorageKey(keyMatch[1]) ? 'authorized' : 'public';

            // Insert immediately BEFORE `"mimeType"`. When it is alone on its line, repeat that
            // line's indentation so the new key lines up with its siblings.
            const lineStart = text.lastIndexOf('\n', m.index - 1) + 1;
            const before = text.slice(lineStart, m.index);
            const inline = before.trim() !== '';
            const insert = inline ? `"access": "${access}", ` : `"access": "${access}",\n${before}`;

            console.log(`  FIX   ${rel}:${line}  tree "${tree}" -> "${access}"${inline ? '  (inline)' : ''}`);
            edits.push({ at: m.index, insert });
            fixed++;
        }

        if (edits.length) {
            touched.add(rel);
            if (APPLY) {
                // Apply LAST to FIRST so earlier offsets stay valid.
                let out = text;
                for (const e of edits.sort((a, b) => b.at - a.at)) {
                    out = out.slice(0, e.at) + e.insert + out.slice(e.at);
                }
                fs.writeFileSync(file, out);
            }
        }
    }
}

console.log(`\n${APPLY ? 'APPLIED' : 'DRY RUN'} — inserted "access" on ${fixed} objects across ${touched.size} files`);
console.log(`  skipped (reported above): ${skipped}`);
if (!APPLY) console.log('  re-run with --apply to write');
