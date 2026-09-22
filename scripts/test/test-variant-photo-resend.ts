/**
 * Variant photo edits re-send the product to the vectoriser (no DB needed).
 *
 * The image search embeds a product's photos, variant photos included
 * (api-doc/n8n/vectoriser/README.md § 15), and nothing reaches the index except
 * by re-sending the product. Until 2026-09-22 the variant routes never re-sent,
 * so a photo added to a variant of an indexed product was unsearchable, and a
 * removed one kept matching, until the vendor next edited the product itself.
 *
 * Owner decision, 2026-09-22: re-send when a variant's PHOTOS change, billed like
 * a product edit; price and stock edits do not re-send.
 *
 * Covered here:
 *  1. photoSetChanged: a set comparison (a reorder costs the vendor nothing)
 *  2. vendor-variant.controller, scanned as TEXT (a suite must not import a
 *     controller): createVariant and updateVariant each re-send exactly once,
 *     after the response, behind the guards below; no other handler re-sends
 *  3. every guard in 2 is proven to BITE: each mutant of the controller source
 *     must fail the scan, or the scan is not checking what it claims to
 *
 * Run: npx ts-node scripts/test/test-variant-photo-resend.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { photoSetChanged } from '../../src/modules/catalog/domain/services/media/photo-set';

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL  ${label}`);
  }
}

// ─── 1. photoSetChanged ─────────────────────────────────────────────────────

console.log('1. photoSetChanged');
assert(photoSetChanged([], ['a']) === true, 'a first photo is a change');
assert(photoSetChanged(['a'], []) === true, 'removing the only photo is a change');
assert(photoSetChanged(['a', 'b'], ['a', 'c']) === true, 'swapping one photo for another is a change');
assert(photoSetChanged(['a', 'b'], ['a', 'b', 'c']) === true, 'adding a photo is a change');
assert(photoSetChanged(['a', 'b'], ['b', 'a']) === false, 'a reorder is NOT a change (it would bill the vendor for nothing)');
assert(photoSetChanged(['a', 'b'], ['a', 'b']) === false, 'the same list is not a change');
assert(photoSetChanged([], []) === false, 'no photos before or after is not a change');
assert(photoSetChanged(['a', 'a'], ['a']) === false, 'duplicates are ignored');

// ─── 2. The controller, as text ─────────────────────────────────────────────

const CONTROLLER = path.resolve(__dirname, '../../src/modules/catalog/controllers/vendor-variant.controller.ts');
// Line endings normalised: the file is CRLF on a Windows checkout and LF elsewhere,
// and a mutant written with \n must match either (else it silently stops mutating).
const source = fs.readFileSync(CONTROLLER, 'utf8').replace(/\r\n/g, '\n');

const RESEND = 'vectorisationService.vectoriseSingle(productId)';

/** The text of one `static <name> = asyncHandler(...)` handler, up to the next one. */
function handlerSpan(src: string, name: string): string {
  const start = src.indexOf(`static ${name} = asyncHandler(`);
  if (start === -1) return '';
  const next = src.indexOf('static ', start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}

/** The `if (...)` condition guarding the re-send inside a span, or '' when there is none. */
function resendGuard(span: string): string {
  const at = span.indexOf(RESEND);
  if (at === -1) return '';
  const ifAt = span.lastIndexOf('if (', at);
  return ifAt === -1 ? '' : span.slice(ifAt, at);
}

/** Every failed check, by label. Empty = the source passes. */
function scan(src: string): string[] {
  const problems: string[] = [];
  const need = (ok: boolean, label: string) => { if (!ok) problems.push(label); };

  const count = src.split(RESEND).length - 1;
  need(count === 2, `the file re-sends exactly twice (found ${count}); no other handler may re-send`);
  need(/import \{ vectorisationService \} from '\.\.\/domain\/services\/VectorisationService';/.test(src),
    'the controller imports the vectorisationService singleton');

  const create = handlerSpan(src, 'createVariant');
  const createGuard = resendGuard(create);
  need(create.includes(RESEND), 'createVariant re-sends');
  need(create.indexOf(RESEND) > create.indexOf('res.status(201).json('), 'createVariant re-sends AFTER the response');
  need(createGuard.includes('product.vectorisationEnabled'), 'createVariant: only an opted-in product');
  need(createGuard.includes("variant.status === 'active'"), 'createVariant: only a live variant (digital ones start archived)');
  need(createGuard.includes('variant.fileIds.length > 0'), 'createVariant: only a variant created with photos');
  need(/void vectorisationService\.vectoriseSingle\(productId\)/.test(create), 'createVariant: fire-and-forget (void)');

  const update = handlerSpan(src, 'updateVariant');
  const updateGuard = resendGuard(update);
  need(update.includes(RESEND), 'updateVariant re-sends');
  need(update.indexOf(RESEND) > update.lastIndexOf('res.json('), 'updateVariant re-sends AFTER the response');
  need(/const demoted = await productStatusValidationService\.revalidateActiveStatus\(/.test(update),
    'updateVariant keeps the demotion verdict');
  need(updateGuard.includes('product.vectorisationEnabled'), 'updateVariant: only an opted-in product');
  need(updateGuard.includes('!demoted'), 'updateVariant: never after a demotion (it would switch the opt-in OFF)');
  need(updateGuard.includes("updatedVariant.status === 'active'"), 'updateVariant: only a live variant');
  need(updateGuard.includes('input.fileIds !== undefined'), 'updateVariant: only when the body carried photos');
  need(updateGuard.includes('photoSetChanged(existingVariant.fileIds'), 'updateVariant: only when the photo SET changed');
  need(/void vectorisationService\.vectoriseSingle\(productId\)/.test(update), 'updateVariant: fire-and-forget (void)');

  return problems;
}

console.log('2. vendor-variant.controller (as text)');
const problems = scan(source);
for (const p of problems) assert(false, p);
if (problems.length === 0) assert(true, 'the controller passes every check');

// ─── 3. The guards bite ─────────────────────────────────────────────────────

console.log('3. every guard bites');
const mutants: Array<[string, (s: string) => string]> = [
  ['create re-send removed', (s) => s.replace(`if (product.vectorisationEnabled && variant.status === 'active' && variant.fileIds.length > 0) {\n            void ${RESEND};`, 'if (false) {')],
  ['create opt-in check dropped', (s) => s.replace("if (product.vectorisationEnabled && variant.status === 'active'", "if (variant.status === 'active'")],
  ['create active check dropped', (s) => s.replace("&& variant.status === 'active' && variant.fileIds", '&& variant.fileIds')],
  ['update demotion check dropped', (s) => s.replace('&& !demoted\n', '\n')],
  ['update photo-set check dropped', (s) => s.replace('&& photoSetChanged(existingVariant.fileIds ?? [], input.fileIds)', '')],
  ['update opt-in check dropped', (s) => s.replace('product.vectorisationEnabled\n            && !demoted', '!demoted')],
  ['demotion verdict discarded', (s) => s.replace('const demoted = await productStatusValidationService', 'await productStatusValidationService')],
  ['a third handler re-sends', (s) => s.replace("res.json({ success: true, message: 'Variant archived successfully' });", `res.json({ success: true, message: 'Variant archived successfully' });\n        void ${RESEND};`)],
  ['create re-sends before the response', (s) => s.replace("res.status(201).json({ success: true, data: detail, message: 'Variant created successfully' });", `void ${RESEND};\n        res.status(201).json({ success: true, data: detail, message: 'Variant created successfully' });`)],
];
for (const [label, mutate] of mutants) {
  const mutated = mutate(source);
  assert(mutated !== source, `mutant "${label}" actually changed the source (else the mutant is stale, not the guard)`);
  assert(scan(mutated).length > 0, `mutant "${label}" is caught`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
