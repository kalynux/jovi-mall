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
import { getDefaultUploadConfig, UploadPolicyConfig } from '../../src/core/uploads/upload-config';
import { IVirusScanner, UploadRequest } from '../../src/core/uploads/upload-policy.types';
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
    console.log('\n▶ The environment contract');

    const envExample = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
    for (const variable of ['UPLOAD_CLAMAV_HOST', 'UPLOAD_CLAMAV_PORT', 'UPLOAD_CLAMAV_TIMEOUT_MS']) {
        assert(`${variable} is documented`, () => envExample.includes(variable));
    }
    assert('the template warns that `mock` is the default and is refused in production', () =>
        /TEST DOUBLE/.test(envExample) && /DEFAULT/.test(envExample));

    const compose = fs.readFileSync(path.join(ROOT, '..', 'docker-compose.yml'), 'utf8');
    assert('the compose stack runs a clamav service', () => /^\s{2}clamav:/m.test(compose));
    assert('…with a healthcheck that proves a LOADED DATABASE, not an open port', () =>
        /clamdcheck\.sh/.test(compose));
    assert('…and jovi-mall waits for it to be HEALTHY, not merely started', () => {
        const joviBlock = compose.slice(compose.indexOf('\n  jovi-mall:'), compose.indexOf('\n  jovi-mall-toolbox:'));
        return /clamav:\s*\n\s*condition: service_healthy/.test(joviBlock);
    });
    assert('…and the signature database survives a restart on a named volume', () =>
        /clamav-db:\/var\/lib\/clamav/.test(compose) && /^\s{2}clamav-db:/m.test(compose));

    console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
    if (failed > 0) process.exit(1);
}

void main();
