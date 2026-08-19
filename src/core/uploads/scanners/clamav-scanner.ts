import net from 'net';
import { createAppError } from '../../errors';
import { ERROR_CODES } from '../../error-codes';
import { IVirusScanner } from '../upload-policy.types';

/**
 * ClamAV, over `clamd`'s INSTREAM protocol on a TCP socket.
 *
 * ── Why a raw socket rather than `clamscan` / `clamdjs` ───────────────────────
 * Three reasons, in order of weight:
 *
 *  1. **The timeout has to be ours.** `blockOnFailure` cannot fire on a call that never
 *     returns — a scanner that hangs holds an upload request open indefinitely, which is a
 *     worse outcome than a scanner that refuses. A socket we own has a deadline we control on
 *     connect, on write and on read; a wrapper's timeout option is whatever it happens to
 *     implement.
 *  2. **`clamscan` mostly shells out to the `clamdscan`/`clamscan` BINARIES**, which do not
 *     exist in this service's runtime image (`node:22-bookworm-slim`) and are not going to.
 *     Its TCP path is the smaller half of a package built around the other one.
 *  3. INSTREAM is about sixty lines, and this service has just put a hard `--audit-level=high`
 *     gate in CI. A dependency is not free.
 *
 * ── The protocol, since it is short enough to state ───────────────────────────
 * Send `zINSTREAM\0`. Then, for each chunk: a 4-byte big-endian length, then the bytes. Then a
 * zero length to terminate. `clamd` replies with a NUL-terminated line:
 *
 *     stream: OK
 *     stream: Eicar-Signature FOUND
 *     INSTREAM size limit exceeded. ERROR
 *
 * `FOUND` is a detection. `ERROR` and anything unrecognised is a scan FAILURE and is thrown —
 * never reported as clean. That distinction is the whole point of this class: the reason S-2
 * survived is that a scanner which does nothing is indistinguishable from one that works, so
 * "I could not tell" must never be spelled `{ clean: true }`.
 *
 * ⚠ **`StreamMaxLength` bounds this, not `UPLOAD_MAX_TOTAL_SIZE_BYTES`.** `clamd`'s default is
 * 25 MB, and this service accepts larger files. Over the limit `clamd` answers
 * `size limit exceeded … ERROR`, which surfaces here as a scan failure and — with
 * `blockOnFailure` true, which is the shipped setting — refuses the upload. That is the safe
 * direction, and it is the one operational knob that must be set to match: see
 * `docs/RUNBOOK.md` § 1.
 */

/** `clamd`'s own recommendation, and comfortably under most MTU-driven fragmentation. */
const CHUNK_BYTES = 64 * 1024;

export interface ClamAVScannerOptions {
    host: string;
    port: number;
    /** Whole operation, not per-socket-event: connect + stream + reply. */
    timeoutMs: number;
}

export function clamavConfigFromEnv(): ClamAVScannerOptions {
    return {
        host: process.env.UPLOAD_CLAMAV_HOST || '127.0.0.1',
        port: parseInt(process.env.UPLOAD_CLAMAV_PORT || '3310', 10),
        timeoutMs: parseInt(process.env.UPLOAD_CLAMAV_TIMEOUT_MS || '30000', 10),
    };
}

export class ClamAVScanner implements IVirusScanner {
    constructor(private readonly options: ClamAVScannerOptions) {}

    async scan(
        buffer: Buffer,
        filename?: string,
    ): Promise<{ clean: boolean; reason?: string; virus?: string }> {
        const raw = await this.instream(buffer, filename);

        /*
         * ⚠ **STRIP THE NUL FIRST, and this is not defensive tidying — it was a real bug,
         * caught by the live EICAR check and by nothing else.**
         *
         * A `z`-prefixed command gets a NUL-TERMINATED reply, so the wire carries
         * `stream: Eicar-Test-Signature FOUND\0` — no trailing newline. An anchored
         * `/…FOUND$/m` therefore matches NEITHER verdict, because `$` wants end-of-string or a
         * newline and finds `\0`. Every scan then fell through to the throw below.
         *
         * The failure direction happened to be safe (`blockOnFailure` refuses the upload), so
         * with `mock` in development and `clamav` in production the platform would have
         * refused **every** upload rather than passing an infected one. But it is the same
         * class of defect this whole step exists to close: a scanner that never gives a
         * verdict, behind a configuration that says it does. A source scan cannot see it, and
         * a unit test written against a fixture I also wrote would have carried the same
         * assumption. Only talking to a real daemon found it.
         */
        const reply = raw.replace(/\0/g, '').trim();

        // `stream: <name> FOUND`
        const found = /^stream:\s*(.+?)\s+FOUND$/m.exec(reply);
        if (found) {
            return { clean: false, virus: found[1], reason: `ClamAV: ${found[1]}` };
        }

        if (/^stream:\s*OK$/m.test(reply)) {
            return { clean: true };
        }

        // Anything else — `ERROR` (including `size limit exceeded`), a truncated reply, a
        // banner from something that is not clamd. THROWN, never returned clean:
        // `VirusScanValidator` turns a throw into a refusal when `blockOnFailure` is set, and
        // that is the behaviour a scan we could not complete must have.
        throw this.unavailable('ClamAV returned an unrecognised reply', {
            filename,
            reply: reply.slice(0, 200),
        });
    }

    /**
     * Every failure this class raises, in one shape.
     *
     * ⚠ **The MESSAGE is generic and the diagnostics go in `details`, and that split is not
     * decoration.** `VirusScanValidator` copies a thrown `message` verbatim into a violation
     * the uploading vendor reads — so a message carrying `clamav:3310` or an `ECONNREFUSED`
     * would publish internal topology to whoever uploaded a file. `details` is journaled and
     * dropped at the boundary for an `external_service` category, which is exactly where the
     * host, the port and the daemon's own words belong.
     */
    private unavailable(what: string, details: Record<string, unknown>): Error {
        return createAppError(
            ERROR_CODES.UPLOAD_VIRUS_SCAN_UNAVAILABLE,
            502,
            undefined,
            { ...details, scanner: 'clamav', host: this.options.host, port: this.options.port, cause: what },
        );
    }

    /** One socket, one file, one deadline. */
    private instream(buffer: Buffer, filename?: string): Promise<string> {
        const { host, port, timeoutMs } = this.options;

        return new Promise<string>((resolve, reject) => {
            const socket = new net.Socket();
            const chunks: Buffer[] = [];
            let settled = false;

            const finish = (err: Error | null, reply?: string): void => {
                if (settled) return;
                settled = true;
                clearTimeout(deadline);
                socket.destroy();
                if (err) reject(err); else resolve(reply!);
            };

            // ⚠ ONE deadline for the whole operation, not `socket.setTimeout`. An idle-timeout
            // is restarted by every byte, so a daemon dribbling data keeps an upload request
            // open forever while never being idle — and that is exactly the failure
            // `blockOnFailure` cannot save us from, because it never gets a verdict to act on.
            const deadline = setTimeout(
                () => finish(this.unavailable('scan timed out', { filename, timeoutMs })),
                timeoutMs,
            );

            socket.on('error', (err) => finish(
                this.unavailable('clamd unreachable', { filename, socketError: err.message }),
            ));
            socket.on('data', (data) => chunks.push(data));
            socket.on('end', () => finish(null, Buffer.concat(chunks).toString('utf8')));

            socket.connect(port, host, () => {
                socket.write('zINSTREAM\0');
                for (let offset = 0; offset < buffer.length; offset += CHUNK_BYTES) {
                    const slice = buffer.subarray(offset, offset + CHUNK_BYTES);
                    const header = Buffer.alloc(4);
                    header.writeUInt32BE(slice.length, 0);
                    socket.write(header);
                    socket.write(slice);
                }
                // Zero-length chunk = end of stream. clamd replies, then closes.
                socket.write(Buffer.from([0, 0, 0, 0]));
            });
        });
    }
}
