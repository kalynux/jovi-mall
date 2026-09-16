/**
 * Test: the upload virus scanner — the factory, the refusals, and the rule that keeps it the
 * only door (plan step 4.A.4a, S-2 / F-25, ADR-A01 D-1).
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no framework).
 * DB-free. It needs no ClamAV either: the wire-protocol group talks to a FAKE clamd on an
 * ephemeral loopback socket, so it runs in CI beside every other suite.
 *
 * ── Why the SOURCE SCAN is the spine of this suite ────────────────────────────
 * The finding it guards is not a bug in a function; it is a bug in *wiring*, and it survived
 * for one reason worth restating at every layer: **a scanner which does nothing is
 * indistinguishable from a scanner which works.** Same result shape, same latency order, same
 * log line, same observer callback. Every happy-path test passes. `UPLOAD_VIRUS_SCAN_PROVIDER`
 * was parsed and read by nothing while three separate no-op classes — two `NoOpVirusScanner`
 * definitions and a `MockScanner` on the digital-products path — were hand-constructed at the
 * injection sites.
 *
 * So the load-bearing assertion is structural: **no file under `src/` may construct a scanner
 * directly.** `resolveVirusScanner` is the only door, and a regression is a new `new
 * SomethingScanner()` that no behavioural test anywhere would notice.
 *
 * The behavioural half covers the factory's refusals, `VirusScanValidator`'s two failure modes
 * (a scanner that reports dirty, and a scanner that throws — because "could not scan" must
 * never be spelled "clean"), and the clamd wire protocol against a fake daemon.
 *
 * ⚠ **The protocol group exists because the live EICAR check found a bug none of the scans
 * could.** clamd's `z`-prefixed reply is NUL-terminated with no trailing newline, so an
 * anchored `/…FOUND$/m` matched neither verdict and every scan fell through to the
 * unavailable throw. Safe direction, but a scanner that never returns a verdict behind a
 * configuration that says it does — this step's own finding in a new costume. A fixture I
 * invented would have carried the same wrong assumption; only real bytes settled it.
 *
 * Run: npm run test:uploads
 */
import fs from 'fs';
import net from 'net';
import path from 'path';
import { resolveVirusScanner, assertUploadScannerSafe } from '../../src/core/uploads/scanners';
import { ClamAVScanner } from '../../src/core/uploads/scanners/clamav-scanner';
import { MockScanner } from '../../src/core/uploads/scanners/mock-scanner';
import { VirusScanValidator } from '../../src/core/uploads/validators/virus-scan.validator';
import { UploadPipelineContextImpl } from '../../src/core/uploads/upload-pipeline-context';
import {
    getDefaultUploadConfig,
    getDeliveryProofUploadConfig,
    getDigitalAssetUploadConfig,
    getPolicyDocumentUploadConfig,
    getVideoUploadConfig,
    UploadPolicyConfig,
} from '../../src/core/uploads/upload-config';
import { PermissionValidator } from '../../src/core/uploads/validators/permission.validator';
import { IVirusScanner, UploadRequest } from '../../src/core/uploads/upload-policy.types';
import {
    isPrivateStorageKey,
    PRIVATE_STORAGE_TREES,
    STORAGE_TREE_VISIBILITY,
} from '../../src/core/storage/storage-trees';
import { toFileDetail, withUrlAndAccess } from '../../src/modules/catalog/read-models/file-detail.resolver';
import { MEDIA_CATEGORY_FOLDERS } from '../../src/core/uploads/media-folder';
import { ERROR_CODES } from '../../src/core/error-codes';
import { AppError } from '../../src/core/errors';

let passed = 0;
let failed = 0;

function assert(name: string, fn: () => boolean): void {
    let ok: boolean;
    try {
        ok = fn();
    } catch (err) {
        console.error(`  ❌ THROW: ${name} — ${(err as Error).message}`);
        failed++;
        return;
    }
    if (ok) {
        console.log(`  ✅ ${name}`);
        passed++;
    } else {
        console.error(`  ❌ FAIL: ${name}`);
        failed++;
    }
}

async function assertAsync(name: string, fn: () => Promise<boolean>): Promise<void> {
    let ok: boolean;
    try {
        ok = await fn();
    } catch (err) {
        console.error(`  ❌ THROW: ${name} — ${(err as Error).message}`);
        failed++;
        return;
    }
    if (ok) {
        console.log(`  ✅ ${name}`);
        passed++;
    } else {
        console.error(`  ❌ FAIL: ${name}`);
        failed++;
    }
}

const ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(ROOT, 'src');

/** Strip comments, so a scan cannot be satisfied — or defeated — by prose about the code. */
function code(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function walkTs(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walkTs(full, out);
        else if (entry.name.endsWith('.ts')) out.push(full);
    }
    return out;
}

function configWith(provider: string, extra: Partial<UploadPolicyConfig['virusScan']> = {}): UploadPolicyConfig {
    const config = getDefaultUploadConfig();
    return {
        ...config,
        virusScan: { ...config.virusScan, provider: provider as any, ...extra },
    };
}

/** The pipeline context the validators consume, with one file in it. */
function contextWithOneFile(): UploadPipelineContextImpl {
    const request: UploadRequest = {
        folder: 'by-type',
        context: { userId: 'user-1', role: 'user' },
        files: [{ buffer: Buffer.from('anything at all'), originalName: 'invoice.pdf', mimeType: 'application/pdf' }],
    };
    return new UploadPipelineContextImpl(request);
}

/**
 * A fake `clamd` on an ephemeral loopback port.
 *
 * @param reply the exact bytes to answer with once the stream terminator arrives — including
 *   its terminator, because the terminator IS what these cases are about. `null` means never
 *   answer, for the timeout case.
 */
function fakeClamd(reply: string | null): Promise<{ port: number; close: () => Promise<void>; received: () => Buffer[] }> {
    const received: Buffer[] = [];
    return new Promise((resolve) => {
        const server = net.createServer((socket) => {
            socket.on('data', (data) => {
                received.push(data);
                // The zero-length chunk terminates INSTREAM. Answer only then, exactly as
                // clamd does — answering early would let a scanner that never finished
                // streaming pass these tests.
                if (reply !== null && Buffer.concat(received).subarray(-4).equals(Buffer.alloc(4))) {
                    socket.end(Buffer.from(reply, 'binary'));
                }
            });
            socket.on('error', () => undefined);
        });
        server.listen(0, '127.0.0.1', () => {
            resolve({
                port: (server.address() as net.AddressInfo).port,
                received: () => received,
                close: () => new Promise((done) => server.close(() => done())),
            });
        });
    });
}

/** A scanner with a scripted verdict, for the two validator cases. */
class ScriptedScanner implements IVirusScanner {
    constructor(private readonly behaviour: 'dirty' | 'throws') {}
    async scan(): Promise<{ clean: boolean; reason?: string; virus?: string }> {
        if (this.behaviour === 'throws') throw new Error('clamd unreachable at clamav:3310');
        return { clean: false, virus: 'Eicar-Signature' };
    }
}

async function main(): Promise<void> {
    const originalEnv = process.env.NODE_ENV;

    // ─────────────────────────────────────────────────────────────────────────
    // THE ONE THAT MATTERS. Everything else here could pass with the finding intact.
    console.log('\n▶ The factory is the ONLY door (the assertion that catches a regression)');

    const srcFiles = walkTs(SRC);
    const FACTORY = path.join(SRC, 'core', 'uploads', 'scanners', 'index.ts');

    assert('no file under src/ constructs a scanner directly — the factory is the only path', () => {
        const offenders = srcFiles.filter((file) => {
            if (file === FACTORY) return false;                       // the factory itself
            if (file.includes(path.join('scanners', 'clamav-scanner'))) return false;
            if (file.includes(path.join('scanners', 'mock-scanner'))) return false;
            return /new\s+\w*(Virus)?Scanner\s*\(/.test(code(fs.readFileSync(file, 'utf8')));
        });
        if (offenders.length) {
            console.error(`     offenders: ${offenders.map((f) => path.relative(ROOT, f)).join(', ')}`);
        }
        return offenders.length === 0;
    });

    assert('no NoOpVirusScanner class survives anywhere in src/', () =>
        !srcFiles.some((file) => /class\s+NoOpVirusScanner/.test(fs.readFileSync(file, 'utf8'))));

    // `MockScanner` is a test double and this file imports it — from its own module, which is
    // the only way anything may. It must not be reachable from the production barrel, because
    // that is how it reached the digital-products upload path.
    assert('MockScanner is NOT re-exported from the core/uploads barrel', () => {
        const barrel = fs.readFileSync(path.join(SRC, 'core', 'uploads', 'index.ts'), 'utf8');
        return !/export \* from '\.\/scanners\/mock-scanner'/.test(barrel);
    });
    assert('…and nothing under src/ imports it', () =>
        !srcFiles.some((file) =>
            file !== path.join(SRC, 'core', 'uploads', 'scanners', 'mock-scanner.ts')
            && /from\s+'[^']*scanners\/mock-scanner'/.test(code(fs.readFileSync(file, 'utf8')))));

    // The three sites ADR-A01 D-1 names — two of them, plus the third it does NOT name, which
    // is the digital-products path and the one that mattered most.
    for (const [label, relative] of [
        ['the general upload controller', 'api/controllers/file-upload.controller.ts'],
        ['the delivery-proof service', 'modules/shipments/delivery-proof.service.ts'],
        ['the DIGITAL-PRODUCTS service (the one the ADR does not name)',
            'modules/digital-delivery/services/digital-asset.service.ts'],
    ] as const) {
        assert(`${label} resolves through the factory`, () =>
            /resolveVirusScanner\(/.test(code(fs.readFileSync(path.join(SRC, relative), 'utf8'))));
    }

    assert('the boot asserts the scanner, beside the other config guards', () => {
        // Imports stripped first: the `import { assertUploadScannerSafe }` line precedes every
        // call in the file, so an ordering check against the raw text compares the wrong thing
        // and passes (or fails) for no reason connected to the boot sequence.
        const lifecycle = code(fs.readFileSync(path.join(SRC, 'lifecycle.ts'), 'utf8'))
            .replace(/^import .*$/gm, '');
        return /assertUploadScannerSafe\(/.test(lifecycle)
            && lifecycle.indexOf('assertUploadScannerSafe(') > lifecycle.indexOf('assertSigningSecrets()');
    });

    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n▶ The factory REFUSES rather than degrades');

    process.env.NODE_ENV = 'development';
    assert('clamav resolves to the real scanner', () =>
        resolveVirusScanner(configWith('clamav')) instanceof ClamAVScanner);
    assert('mock resolves in development — there is no clamd on a laptop', () =>
        resolveVirusScanner(configWith('mock')) instanceof MockScanner);

    process.env.NODE_ENV = 'production';
    for (const [label, provider] of [
        ['mock is REFUSED in production — it is a test double', 'mock'],
        ['cloud is refused — declared in the config type, never implemented', 'cloud'],
        ['an unrecognised provider is refused — a typo must not open the door', 'clamAV'],
    ] as const) {
        assert(label, () => {
            try {
                resolveVirusScanner(configWith(provider));
                return false;
            } catch (err) {
                return err instanceof AppError
                    && err.code === ERROR_CODES.CONFIG_INVALID_UPLOAD_SCANNER;
            }
        });
    }
    assert('…and clamav still resolves in production', () =>
        resolveVirusScanner(configWith('clamav')) instanceof ClamAVScanner);

    assert('the boot guard refuses a production deploy that forgot the variable', () => {
        // `mock` is the built-in default, so this IS the forgot-the-variable case.
        try {
            assertUploadScannerSafe(configWith('mock'), () => undefined);
            return false;
        } catch (err) {
            return err instanceof AppError && err.code === ERROR_CODES.CONFIG_INVALID_UPLOAD_SCANNER;
        }
    });
    assert('…but scanning switched off DELIBERATELY is logged, not refused', () => {
        // The distinction is the finding's own: S-2 was a config that CLAIMED to scan and did
        // not. `enabled=false` claims nothing — it is an operator's explicit choice.
        const lines: string[] = [];
        assertUploadScannerSafe(configWith('mock', { enabled: false }), (m) => lines.push(m));
        return lines.length === 1 && /DISABLED/.test(lines[0]);
    });
    process.env.NODE_ENV = originalEnv;

    // ─────────────────────────────────────────────────────────────────────────
    /*
     * Step 25.1, and this group is here because step 8 shipped without it.
     *
     * `resolveVirusScanner(config)` reads `config.virusScan.provider`. Four of the five upload
     * configs hardcoded `provider: 'mock'` — only `loadUploadConfig()` read the environment —
     * so three of the four sites step 8 wired up were handed a TEST DOUBLE: in development
     * they scanned nothing (leaving the digital-products path exactly as it was), and in
     * production `resolveVirusScanner` would have refused, failing every video, digital-asset
     * and delivery-proof upload.
     *
     * The boot assertion could not see it either — it checks `loadUploadConfig()`, the one
     * config that was already right. So the assertion that matters is STRUCTURAL: no factory
     * may write its own provider.
     */
    console.log('\n▶ EVERY upload config resolves its scanner from the environment (25.1)');

    const uploadConfigSource = code(fs.readFileSync(
        path.join(SRC, 'core', 'uploads', 'upload-config.ts'), 'utf8'));

    assert('no upload config hardcodes a scanner provider', () => {
        // The trailing `[,}]` is what separates an ASSIGNMENT from the interface's type union
        // (`provider: 'mock' | 'clamav' | 'cloud';`), which is legitimate and must not match.
        // `resolveVirusScanConfig`'s own read is `provider: (process.env… ) || 'mock'` and so
        // does not match either — the fallback belongs in the resolver; it is the factories
        // that must not have opinions.
        const literals = uploadConfigSource.match(/provider:\s*'[^']*'\s*[,}]/g) ?? [];
        if (literals.length) console.error(`     literals: ${literals.join(' | ')}`);
        return literals.length === 0;
    });
    /**
     * ⚠ **DERIVED, not a hardcoded count, and the change is what makes this assertion
     * useful.**
     *
     * It used to read `factories === 6`. That number is a fact about the file restated in a
     * second place, so every new upload config broke the suite and was "fixed" by bumping it —
     * which is a step whose entire content is agreeing with whatever the file now says. Worse,
     * bumping it is exactly what somebody does after adding a config that FORGOT the resolver:
     * the count would then be wrong twice and pass.
     *
     * Counting the config factories and requiring one `resolveVirusScanConfig()` each says the
     * real thing: **every config that exists resolves its scanner from the environment.** A
     * factory that grows its own answer fails (the original defect), and so does a new factory
     * that never called the resolver at all — which the hardcoded number could not see.
     */
    assert('…they all go through the one resolver', () => {
        const calls = (uploadConfigSource.match(/virusScan:\s*resolveVirusScanConfig\(\)/g) ?? []).length;
        const factories = (uploadConfigSource.match(
            /export function (?:get\w*UploadConfig|loadUploadConfig)\s*\(/g) ?? []).length;
        if (calls !== factories) {
            console.error(`     ${factories} config factories, ${calls} resolver calls`);
        }
        // A floor as well: a regex that stopped matching would otherwise report 0 === 0.
        return factories >= 6 && calls === factories;
    });

    process.env.NODE_ENV = 'production';
    process.env.UPLOAD_VIRUS_SCAN_PROVIDER = 'clamav';
    for (const [label, factory] of [
        ['the general config', getDefaultUploadConfig],
        ['the DIGITAL-ASSET config', getDigitalAssetUploadConfig],
        ['the video config', getVideoUploadConfig],
        ['the delivery-proof config', getDeliveryProofUploadConfig],
        ['the policy-document config', getPolicyDocumentUploadConfig],
    ] as const) {
        assert(`${label} resolves a REAL scanner in production`, () =>
            resolveVirusScanner(factory()) instanceof ClamAVScanner);
    }
    delete process.env.UPLOAD_VIRUS_SCAN_PROVIDER;
    assert('…and with the variable UNSET, every one of them refuses to boot', () =>
        // `mock` is the fallback, so this is the forgot-the-variable case for ALL five, not
        // just the one the boot guard is handed.
        [getDefaultUploadConfig, getDigitalAssetUploadConfig, getVideoUploadConfig,
            getDeliveryProofUploadConfig, getPolicyDocumentUploadConfig].every((factory) => {
            try {
                resolveVirusScanner(factory());
                return false;
            } catch (err) {
                return err instanceof AppError
                    && err.code === ERROR_CODES.CONFIG_INVALID_UPLOAD_SCANNER;
            }
        }));
    process.env.NODE_ENV = originalEnv;

    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n▶ Policy documents reach the pipeline (25.2)');

    for (const [label, relative] of [
        ['the vendor endpoint', 'modules/vendor/controller/vendor-profile.controller.ts'],
        ['the agency endpoint', 'modules/delivery/controllers/agency-profile.controller.ts'],
    ] as const) {
        const controller = code(fs.readFileSync(path.join(SRC, relative), 'utf8'));
        assert(`${label} no longer calls storageProvider.put directly`, () =>
            !/storageProvider\.put\(/.test(controller));
        assert(`…and goes through the shared upload service`, () =>
            /policyDocumentUploadService\.upload\(/.test(controller));
    }

    assert('the policy config is PDF-only and scanned', () => {
        const config = getPolicyDocumentUploadConfig();
        return Object.keys(config.perMimeType).join(',') === 'application/pdf'
            && config.virusScan.enabled
            && config.virusScan.blockOnFailure;
    });

    // ⚠ The trap this step exists around: a File with no reference is DELETED by
    // `LonelyFileDeletionService` ("falls back to createdAt for files that were uploaded but
    // never attached"). Creating the record without referencing it would have traded an
    // unscanned upload for the loss of every vendor's policy PDFs.
    assert('the upload writes a file_reference — without it the cleanup sweep reclaims them', () => {
        const service = code(fs.readFileSync(
            path.join(SRC, 'modules', 'catalog', 'domain', 'services', 'media',
                'PolicyDocumentUploadService.ts'), 'utf8'));
        return /fileReferenceService\.reconcile\(/.test(service)
            && /field:\s*'policy_documents'/.test(service)
            && /entityType:\s*ownerType/.test(service);
    });

    assert('both policy trees are classified, and both are public', () =>
        STORAGE_TREE_VISIBILITY['vendor-policy-documents'] === 'public'
        && STORAGE_TREE_VISIBILITY['agency-policy-documents'] === 'public');

    // Keyed on ownerType, not role: the pipeline's `UserRole` cannot tell an agency from a
    // customer, so without this rule the two new purpose folders would inherit the permission
    // validator's "not named here, therefore allowed" default — a purpose folder with no
    // purpose rule.
    await assertAsync('a policy folder refuses an owner it is not for', async () => {
        const context = new UploadPipelineContextImpl({
            folder: 'agency-policy-documents',
            context: { userId: 'u1', role: 'user', ownerType: 'vendor', ownerId: 'v1' },
            files: [{ buffer: Buffer.from('%PDF-1.4'), mimeType: 'application/pdf' }],
        });
        try {
            await new PermissionValidator(getPolicyDocumentUploadConfig()).validate(context);
            return false;
        } catch {
            return context.violations.some((v) => v.code === 'PERMISSION_DENIED');
        }
    });

    await assertAsync('…and admits the owner it IS for', async () => {
        const context = new UploadPipelineContextImpl({
            folder: 'agency-policy-documents',
            context: { userId: 'u1', role: 'user', ownerType: 'agency', ownerId: 'a1' },
            files: [{ buffer: Buffer.from('%PDF-1.4'), mimeType: 'application/pdf' }],
        });
        await new PermissionValidator(getPolicyDocumentUploadConfig()).validate(context);
        return context.violations.length === 0;
    });

    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n▶ VirusScanValidator: dirty is refused, and so is "could not scan"');

    await assertAsync('a scanner reporting DIRTY produces a VIRUS_DETECTED violation', async () => {
        const context = contextWithOneFile();
        await new VirusScanValidator(configWith('clamav'), new ScriptedScanner('dirty')).validate(context);
        return context.violations.length === 1
            && context.violations[0].code === 'VIRUS_DETECTED'
            && String(context.violations[0].message).includes('Eicar-Signature');
    });

    await assertAsync('a scanner that THROWS is refused too, when blockOnFailure is set', async () => {
        const context = contextWithOneFile();
        const config = configWith('clamav', { blockOnFailure: true });
        await new VirusScanValidator(config, new ScriptedScanner('throws')).validate(context);
        return context.violations.length === 1 && context.violations[0].code === 'VIRUS_DETECTED';
    });

    await assertAsync('…and is NOT refused when blockOnFailure is off (the documented cost)', async () => {
        const context = contextWithOneFile();
        const config = configWith('clamav', { blockOnFailure: false });
        await new VirusScanValidator(config, new ScriptedScanner('throws')).validate(context);
        return context.violations.length === 0;
    });

    await assertAsync('a disabled scan adds no violation and calls no scanner', async () => {
        const context = contextWithOneFile();
        let called = false;
        const spy: IVirusScanner = { scan: async () => { called = true; return { clean: true }; } };
        await new VirusScanValidator(configWith('clamav', { enabled: false }), spy).validate(context);
        return !called && context.violations.length === 0;
    });

    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n▶ The ClamAV scanner never reports "clean" for an answer it did not get');

    assert('it bounds the whole operation with ONE deadline, not a socket idle timeout', () => {
        const source = fs.readFileSync(
            path.join(SRC, 'core', 'uploads', 'scanners', 'clamav-scanner.ts'), 'utf8',
        );
        // An idle timeout is restarted by every byte, so a daemon dribbling data holds an
        // upload request open forever while never being idle — and blockOnFailure can never
        // fire, because it never gets a verdict.
        return /setTimeout\(/.test(source) && !/setTimeout\s*\(\s*\d+\s*\)/.test(code(source))
            && !code(source).includes('socket.setTimeout');
    });
    assert('an unrecognised clamd reply THROWS rather than returning clean', () => {
        const source = code(fs.readFileSync(
            path.join(SRC, 'core', 'uploads', 'scanners', 'clamav-scanner.ts'), 'utf8',
        ));
        // Exactly one `clean: true` in the file, and it is behind the `stream: OK` test.
        return (source.match(/clean:\s*true/g) ?? []).length === 1
            && source.indexOf('stream:\\s*OK') < source.indexOf('clean: true')
            && /throw this\.unavailable\('ClamAV returned an unrecognised reply'/.test(source);
    });
    assert('its failures carry NO host, port or socket detail in the MESSAGE', () => {
        // `VirusScanValidator` copies a thrown message verbatim into a violation the uploading
        // vendor reads, so internal topology in the message is published to whoever uploaded a
        // file. It belongs in `details`, which is journaled and dropped at the boundary for
        // the `external_service` category this code derives to.
        const source = code(fs.readFileSync(
            path.join(SRC, 'core', 'uploads', 'scanners', 'clamav-scanner.ts'), 'utf8',
        ));
        return !/new Error\(/.test(source)
            && /createAppError\(\s*\n?\s*ERROR_CODES\.UPLOAD_VIRUS_SCAN_UNAVAILABLE,\s*\n?\s*502,\s*\n?\s*undefined,/.test(source);
    });

    // ─────────────────────────────────────────────────────────────────────────
    /*
     * These four talk to a FAKE clamd on a real loopback socket — no daemon, no Docker, so
     * they run in CI like everything else here.
     *
     * ⚠ **They exist because the live check found a bug the source scans could not.** A
     * `z`-prefixed clamd command gets a **NUL-terminated** reply with no trailing newline, so
     * the wire carries `stream: Eicar-Test-Signature FOUND\0`. An anchored `/…FOUND$/m`
     * matches neither verdict — `$` wants a newline or end-of-string and finds `\0` — and
     * every scan fell through to the unavailable throw. The failure direction was safe
     * (`blockOnFailure` refuses), but the effect was a scanner that never returns a verdict
     * behind a configuration that says it does, which is this step's own finding in a new
     * costume. A unit test written against a fixture the same author invented would have
     * carried the same wrong assumption; only real bytes settled it. These pin the real ones.
     */
    console.log('\n▶ The clamd wire protocol, against a fake daemon on a real socket');

    for (const [label, reply, expected] of [
        ['a NUL-terminated FOUND is a detection', 'stream: Eicar-Test-Signature FOUND\0', 'dirty'],
        ['a NUL-terminated OK is clean', 'stream: OK\0', 'clean'],
        ['a newline-terminated FOUND is a detection too', 'stream: Eicar-Test-Signature FOUND\n', 'dirty'],
        ['an ERROR reply is UNAVAILABLE, never clean', 'INSTREAM size limit exceeded. ERROR\0', 'throws'],
    ] as const) {
        await assertAsync(label, async () => {
            const { port, close } = await fakeClamd(reply);
            try {
                const scanner = new ClamAVScanner({ host: '127.0.0.1', port, timeoutMs: 5000 });
                const result = await scanner.scan(Buffer.from('bytes'), 'f.bin').catch((err) => err);
                if (expected === 'throws') {
                    return result instanceof AppError
                        && result.code === ERROR_CODES.UPLOAD_VIRUS_SCAN_UNAVAILABLE;
                }
                if (expected === 'clean') return result.clean === true;
                return result.clean === false && result.virus === 'Eicar-Test-Signature';
            } finally {
                await close();
            }
        });
    }

    await assertAsync('it streams the WHOLE file, in length-prefixed chunks, terminated by a zero', async () => {
        // 150 KB forces more than the 64 KB chunk size, so the framing is exercised rather
        // than assumed. The fake reassembles what the scanner sent and compares it byte for
        // byte — a framing bug here means clamd scans the wrong bytes and answers OK.
        const payload = Buffer.alloc(150 * 1024);
        for (let i = 0; i < payload.length; i++) payload[i] = i % 251;

        const { port, close, received } = await fakeClamd('stream: OK\0');
        try {
            await new ClamAVScanner({ host: '127.0.0.1', port, timeoutMs: 5000 })
                .scan(payload, 'big.bin');
            const wire = Buffer.concat(received());
            if (!wire.subarray(0, 10).equals(Buffer.from('zINSTREAM\0'))) return false;

            const body: Buffer[] = [];
            let at = 10;
            for (;;) {
                const length = wire.readUInt32BE(at);
                at += 4;
                if (length === 0) break;
                body.push(wire.subarray(at, at + length));
                at += length;
            }
            return Buffer.concat(body).equals(payload) && at === wire.length;
        } finally {
            await close();
        }
    });

    await assertAsync('a daemon that never answers is UNAVAILABLE, bounded by our own deadline', async () => {
        // `null` = accept the connection, read everything, reply nothing, ever. Without the
        // whole-operation deadline this hangs the upload request forever and `blockOnFailure`
        // never gets a verdict to act on.
        const { port, close } = await fakeClamd(null);
        try {
            const started = Date.now();
            const err = await new ClamAVScanner({ host: '127.0.0.1', port, timeoutMs: 400 })
                .scan(Buffer.from('bytes'), 'f.bin').catch((e) => e);
            return err instanceof AppError
                && err.code === ERROR_CODES.UPLOAD_VIRUS_SCAN_UNAVAILABLE
                && Date.now() - started < 3000;
        } finally {
            await close();
        }
    });

    // ─────────────────────────────────────────────────────────────────────────
    // ADR-A01 D-2 / plan step 4.A.4b. Structural again, and for the same reason: a tree that
    // slips back onto the static mount, or a `FileDetail` built by hand somewhere, is
    // invisible to every behavioural test — the platform keeps working and the files are
    // simply public.
    console.log('\n▶ The private trees are off the public mount (ADR-A01 D-2)');

    const apiIndex = code(fs.readFileSync(path.join(SRC, 'api', 'index.ts'), 'utf8'));

    assert('nothing serves the whole storage root any more', () =>
        !/express\.static\(path\.join\(__dirname, '\.\.\/\.\.', 'storage'\)\)/.test(apiIndex));
    assert('the mounts are DERIVED from the classification, not a second list', () =>
        /for \(const tree of PUBLIC_STORAGE_TREES\)/.test(apiIndex)
        && /express\.static\(path\.join\(__dirname, '\.\.\/\.\.', 'storage', tree\)\)/.test(apiIndex));
    assert('no express.static call anywhere in src/ names a private tree', () => {
        const statics = srcFiles.flatMap((file) =>
            code(fs.readFileSync(file, 'utf8')).match(/express\.static\([^)]*\)/g) ?? []);
        return statics.every((call) => !PRIVATE_STORAGE_TREES.some((tree) => call.includes(tree)));
    });

    /**
     * ⚠ A LITERAL, not a count, and deliberately so: the failure this guards is a tree being
     * RECLASSIFIED rather than added, and a count cannot see a swap.
     *
     * Two trees joined on 2026-09-14, from two separate pieces of work: `kyc` (an applicant's
     * identity-card scans and the selfie holding them) and `admin-identity` (the same class of
     * document for a member of platform staff). They are deliberately **separate trees** —
     * see the reasoning at the source — so a retention or export policy written for one cannot
     * be silently applied to the other.
     *
     * ⚠ Changing this line means changing **wi-admin's copy** of the same map in the same
     * commit (`admin/src/infra/storage/storage-trees.ts`); its own `test:files` re-reads this
     * repository's file from disk and fails on any difference, in both directions.
     */
    assert('the private trees are exactly admin-identity, digital, kyc, shipments, ticket-attachments', () =>
        [...PRIVATE_STORAGE_TREES].sort().join(',')
            === 'admin-identity,digital,kyc,shipments,ticket-attachments');
    assert('an unknown tree is PRIVATE — a tree added next year is not public by default', () =>
        isPrivateStorageKey('some-new-tree/2027/01/x.pdf'));
    assert('…and so is a key with no tree at all', () =>
        isPrivateStorageKey('loose-file.pdf') && isPrivateStorageKey(''));
    assert('a WINDOWS-separated key classifies the same as a POSIX one', () =>
        // `path.join` in the local provider produces `\` on this machine and `/` in the
        // container. Classifying differently by platform would make a file private in
        // development and public in production.
        isPrivateStorageKey('shipments\\2026\\08\\x.jpg') === isPrivateStorageKey('shipments/2026/08/x.jpg'));

    // Every folder any writer can name must be classified, or its files 404 with nothing
    // saying why. This is what turns "remember to add a row" into a failing suite.
    assert('every `folder:` literal in src/ is classified', () => {
        const named = new Set<string>();
        for (const file of srcFiles) {
            for (const match of code(fs.readFileSync(file, 'utf8')).matchAll(/folder:\s*'([a-z-]+)'/g)) {
                if (match[1] !== 'by-type') named.add(match[1]);
            }
        }
        const unclassified = [...named].filter((tree) => !(tree in STORAGE_TREE_VISIBILITY));
        if (unclassified.length) console.error(`     unclassified: ${unclassified.join(', ')}`);
        return unclassified.length === 0;
    });
    assert('…and so is every media-category folder the by-type intake can produce', () => {
        const unclassified = Object.values(MEDIA_CATEGORY_FOLDERS)
            .filter((tree) => !(tree in STORAGE_TREE_VISIBILITY));
        return unclassified.length === 0;
    });

    console.log('\n▶ toFileDetail is the only builder, and it decides the URL');

    const publicDetail = toFileDetail(
        { id: 'f1', key: 'images/2026/08/a.png', mimeType: 'image/png', size: 10 },
        { getPublicUrl: (key: string) => `http://x/api/files/${key}` } as any,
    );
    const privateDetail = toFileDetail(
        { id: 'f2', key: 'shipments/2026/08/proof.jpg', mimeType: 'image/jpeg', size: 20 },
        { getPublicUrl: (key: string) => `http://x/api/files/${key}` } as any,
    );

    assert('a public file keeps its URL and reports access: public', () =>
        publicDetail.url === 'http://x/api/files/images/2026/08/a.png'
        && publicDetail.access === 'public');
    assert('a PRIVATE file has url: null and reports access: authorized', () =>
        privateDetail.url === null && privateDetail.access === 'authorized');
    assert('…and still carries the id, which is the handle its authorized route takes', () =>
        privateDetail.id === 'f2' && privateDetail.key === 'shipments/2026/08/proof.jpg');

    const blockedDetail = toFileDetail(
        {
            id: 'f3',
            key: 'images/2026/08/b.png',
            mimeType: 'image/png',
            size: 30,
            quotaBlockedAt: new Date('2026-09-01T00:00:00Z'),
        },
        { getPublicUrl: (key: string) => `http://x/api/files/${key}` } as any,
    );
    const blockedPrivateDetail = toFileDetail(
        {
            id: 'f4',
            key: 'shipments/2026/08/proof.jpg',
            mimeType: 'image/jpeg',
            size: 40,
            quotaBlockedAt: new Date('2026-09-01T00:00:00Z'),
        },
        { getPublicUrl: (key: string) => `http://x/api/files/${key}` } as any,
    );

    assert('a QUOTA-BLOCKED file has url: null and reports access: quota_blocked', () =>
        blockedDetail.url === null && blockedDetail.access === 'quota_blocked');
    assert('…and blocking OUTRANKS privacy — a blocked private file is not merely authorized', () =>
        blockedPrivateDetail.access === 'quota_blocked' && blockedPrivateDetail.url === null);
    assert('…and it still carries id, key and size, because blocking is not deletion', () =>
        blockedDetail.id === 'f3' && blockedDetail.key === 'images/2026/08/b.png' && blockedDetail.size === 30);

    assert('no file under src/ builds a FileDetail by hand — toFileDetail is the choke point', () => {
        // Three sites used to, which is how a rule at the "single choke point" reached only
        // some of the platform's files. The tell is `getPublicUrl` outside the resolver and
        // the storage layer itself.
        //
        // ⚠ The pattern here used to anchor on the ASSIGNMENT — roughly
        // "url: <something>storage<something>.getPublicUrl(" — and it MISSED ALL THREE
        // offenders it was written to catch: VectorisationService put a ternary before the
        // call, ticket-attachment.service returned the call directly with no `url:` at all,
        // and ticket-reference.service named its field `firstFileUrl`. A guard anchored on
        // one spelling only ever catches the shape somebody already thought of, so it now
        // matches ANY call outside the two files allowed to make one.
        const offenders = srcFiles.filter((file) => {
            if (file.includes(path.join('core', 'storage'))) return false;
            if (file.endsWith('file-detail.resolver.ts')) return false;
            /**
             * ⚠ **The one exemption, and it is exempt because it builds no FileDetail at all.**
             *
             * This guard's subject is the FileDetail choke point: every *stored file record*
             * must get its `url` from `toFileDetail`, so the private-tree and quota rules are
             * applied in one place. An app release is not a stored file record — it has no
             * owner, no quota, no `file_references` row and no `File` document (see the
             * APP_RELEASE note in `core/database/collections.ts`), and nothing it returns
             * reaches a client as a FileDetail. It answers a `302 Location`.
             *
             * Routing it through `toFileDetail` anyway was the alternative and it is worse: it
             * needs a synthetic `id` for a record that does not exist, and it would tell the
             * next reader that a release IS a file record, contradicting the model.
             *
             * What replaces the choke point here is the same rule applied explicitly: the
             * service calls `isPrivateStorageKey` BEFORE `getPublicUrl` and turns a private
             * key into a named 503. `test:app-releases` § 4 pins that ordering, and § 1 pins
             * the tree's `public` verdict — so the property this guard protects is asserted,
             * just in the suite that owns the module.
             *
             * ⚠ Do NOT widen this into a pattern. The header above explains that a guard
             * anchored on a *spelling* missed all three offenders it was written to catch; a
             * guard with a growing allowlist fails the same way, one plausible entry at a
             * time. A second exemption needs its own reason written here.
             */
            if (file.endsWith(path.join('app-distribution', 'services', 'app-release.service.ts'))) return false;
            return /[.]getPublicUrl[(]/.test(code(fs.readFileSync(file, 'utf8')));
        });
        if (offenders.length) {
            console.error(`     offenders: ${offenders.map((f) => path.relative(ROOT, f)).join(', ')}`);
        }
        return offenders.length === 0;
    });

    // ─────────────────────────────────────────────────────────────────────────
    // `/api/files/*` answers the RECORD, plus url + access
    //
    // The gap this closes: a media library and an "you just uploaded this" confirmation
    // show a file BEFORE it is attached to anything, so no owning entity can hand them a
    // FileDetail. Those four endpoints answered a record with no URL, and the vendor
    // dashboard responded by rebuilding the rules client-side — a copy that could not
    // express quota_blocked at all and failed OPEN on an unclassified tree.
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n▶ /api/files/* records carry url + access (the pre-attachment window)');

    const fakeStorage = { getPublicUrl: (key: string) => `http://x/api/files/${key}` } as any;
    const record = {
        id: 'r1',
        key: 'images/2026/08/a.png',
        provider: 'local' as const,
        mimeType: 'image/png',
        size: 10,
        originalName: 'a.png',
        ownerType: 'vendor' as const,
        ownerId: 'v1',
        quotaBlockedAt: null,
        createdAt: new Date('2026-08-01T00:00:00Z'),
        updatedAt: new Date('2026-08-02T00:00:00Z'),
    };
    const enriched = withUrlAndAccess(record, fakeStorage);

    assert('withUrlAndAccess adds a url and an access to a stored record', () =>
        enriched.url === 'http://x/api/files/images/2026/08/a.png' && enriched.access === 'public');

    // This is the property decision 4.1 rests on. GET /api/files sorts on createdAt and
    // updatedAt, which a FileDetail does not carry — replacing the shape would let a client
    // sort by upload date and never display it. So the result must be a strict SUPERSET.
    assert('…and is a strict SUPERSET — every field of the record survives', () =>
        Object.keys(record).every((k) => (enriched as any)[k] === (record as any)[k])
        && Object.keys(enriched).length === Object.keys(record).length + 2);
    assert('…including createdAt/updatedAt, which the list endpoint sorts on and FileDetail lacks', () =>
        enriched.createdAt === record.createdAt && enriched.updatedAt === record.updatedAt);

    assert('…a PRIVATE record gets url: null / access: authorized, exactly as toFileDetail says', () => {
        const r = withUrlAndAccess({ ...record, key: 'shipments/2026/08/proof.jpg' }, fakeStorage);
        return r.url === null && r.access === 'authorized';
    });
    assert('…a QUOTA-BLOCKED record reports quota_blocked, and blocking still outranks privacy', () => {
        const blocked = withUrlAndAccess(
            { ...record, quotaBlockedAt: new Date('2026-09-01T00:00:00Z') }, fakeStorage);
        const blockedPrivate = withUrlAndAccess(
            { ...record, key: 'shipments/2026/08/p.jpg', quotaBlockedAt: new Date('2026-09-01T00:00:00Z') },
            fakeStorage);
        return blocked.access === 'quota_blocked' && blocked.url === null
            && blockedPrivate.access === 'quota_blocked' && blockedPrivate.url === null;
    });

    // A source scan, because the behavioural half above only proves the HELPER works. The
    // defect was four endpoints that never called anything of the sort, and a fifth added
    // next year would reproduce it silently — the response simply lacks a field, which no
    // type error and no runtime failure reports.
    assert('all FOUR /api/files/* responses go through withUrlAndAccess', () => {
        const sites: Array<[string, number]> = [
            ['src/api/controllers/file-management.controller.ts', 2], // list + get
            ['src/api/controllers/file-upload.controller.ts', 2],     // files + video
        ];
        return sites.every(([rel, expected]) => {
            const body = code(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
            const hits = (body.match(/withUrlAndAccess\(/g) || []).length;
            if (hits < expected) {
                console.error(`     ${rel}: ${hits} call(s), expected at least ${expected}`);
                return false;
            }
            return true;
        });
    });

    assert('…and neither controller re-derives the rules instead of calling the resolver', () => {
        // The whole point of routing through toFileDetail is that the privacy rule, the quota
        // rule and the order between them exist ONCE. A controller that reached for the tree
        // classifier itself would be the vendor-dashboard defect, reproduced server-side and
        // wearing an authoritative address.
        const offenders = [
            'src/api/controllers/file-management.controller.ts',
            'src/api/controllers/file-upload.controller.ts',
        ].filter((rel) => {
            const body = code(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
            return /isPrivateStorageKey|quotaBlockedAt\s*[?&|]/.test(body);
        });
        if (offenders.length) console.error(`     offenders: ${offenders.join(', ')}`);
        return offenders.length === 0;
    });

    console.log('\n▶ The private trees have an authorized route each');

    const proofService = code(fs.readFileSync(
        path.join(SRC, 'modules', 'shipments', 'delivery-proof.service.ts'), 'utf8'));
    assert('the delivery proof streams through the SHIPMENT\'s own scoping, not a new rule', () =>
        /streamTo\(/.test(proofService)
        && /findByIdAndAgent\(shipmentId, viewer\.id\)/.test(proofService)
        && /findByIdAndAgency\(shipmentId, viewer\.id\)/.test(proofService));
    assert('…and answers 404, never 403 — an unrelated agent learns nothing', () => {
        const streamFn = proofService.slice(proofService.indexOf('async streamTo('));
        return streamFn.includes('SHIPMENT_NOT_FOUND, 404') && !/,\s*403/.test(streamFn);
    });
    assert('both roles have a route to it', () => {
        const agent = code(fs.readFileSync(path.join(SRC, 'modules', 'delivery', 'agent.routes.ts'), 'utf8'));
        const agency = code(fs.readFileSync(path.join(SRC, 'modules', 'delivery', 'agency.routes.ts'), 'utf8'));
        return agent.includes("'/shipments/:id/delivery-proof/file'")
            && agency.includes("'/shipments/:id/delivery-proof/file'");
    });
    assert('the digital tree already had its authorized route', () => {
        const routes = code(fs.readFileSync(
            path.join(SRC, 'modules', 'digital-delivery', 'routes', 'customer.routes.ts'), 'utf8'));
        return /'\/download\/:token'/.test(routes);
    });
    assert('the proof bytes are not cacheable — the old URL was, which is half the leak', () => {
        const controller = code(fs.readFileSync(
            path.join(SRC, 'modules', 'shipments', 'agent-delivery-proof.controller.ts'), 'utf8'));
        return /Cache-Control['"],\s*['"]private, no-store/.test(controller);
    });
    assert('the provider switch warns the NEXT author about reinstating a public URL', () => {
        // ADR-019 D-1a: an object-storage provider returning a public CDN URL would undo all
        // of the above without touching a single file this suite checks.
        const factory = fs.readFileSync(path.join(SRC, 'core', 'storage', 'storage.factory.ts'), 'utf8');
        return /ADR-A01 D-2/.test(factory) && /signed URL/.test(factory);
    });

    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n▶ The environment contract');

    const envExample = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
    for (const variable of ['UPLOAD_CLAMAV_HOST', 'UPLOAD_CLAMAV_PORT', 'UPLOAD_CLAMAV_TIMEOUT_MS']) {
        assert(`${variable} is documented`, () => envExample.includes(variable));
    }
    assert('the template warns that `mock` is the default and is refused in production', () =>
        /TEST DOUBLE/.test(envExample) && /DEFAULT/.test(envExample));

    // ⚠ The workspace compose file is OUTSIDE this repository — `backend/` is the
    // workspace root and is in no git repository at all (page 02, C-9). So this block
    // can run on a developer machine and can never run in jovi-mall's CI, which checks
    // out jovi-mall alone. It threw ENOENT on the first CI run that ever happened.
    //
    // Skipped LOUDLY, not quietly: a silent pass would advertise a guarantee that is
    // not being checked. The four assertions below are about the STACK, not about this
    // service, and they will only become enforceable once the workspace root is itself
    // versioned and something checks it out.
    const composePath = path.join(ROOT, '..', 'docker-compose.yml');
    let composeSkipped = 0;
    if (!fs.existsSync(composePath)) {
        console.log(
            `  ⏭  SKIPPED — the workspace compose file is not beside this repository.\n` +
            `     Looked for: ${composePath}\n` +
            `     These 4 assertions describe the 9-service workspace stack and can only\n` +
            `     run from a full checkout. They are NOT enforced by this run.`,
        );
        composeSkipped = 4;
    } else {
        const compose = fs.readFileSync(composePath, 'utf8');
        assert('the compose stack runs a clamav service', () => /^\s{2}clamav:/m.test(compose));
        assert('…with a healthcheck that proves a LOADED DATABASE, not an open port', () =>
            /clamdcheck\.sh/.test(compose));
        assert('…and jovi-mall waits for it to be HEALTHY, not merely started', () => {
            const joviBlock = compose.slice(compose.indexOf('\n  jovi-mall:'), compose.indexOf('\n  jovi-mall-toolbox:'));
            return /clamav:\s*\n\s*condition: service_healthy/.test(joviBlock);
        });
        assert('…and the signature database survives a restart on a named volume', () =>
            /clamav-db:\/var\/lib\/clamav/.test(compose) && /^\s{2}clamav-db:/m.test(compose));
    }

    console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed${composeSkipped > 0 ? `, ${composeSkipped} skipped` : ''}\n`);
    if (failed > 0) process.exit(1);
}

void main();
