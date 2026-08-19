import { createAppError } from '../../errors';
import { ERROR_CODES } from '../../error-codes';
import { UploadPolicyConfig } from '../upload-config';
import { IVirusScanner } from '../upload-policy.types';
import { ClamAVScanner, clamavConfigFromEnv } from './clamav-scanner';
import { MockScanner } from './mock-scanner';

/**
 * The ONE place a virus scanner is constructed.
 *
 * ── What this closes (S-2 / F-25 / ADR-A01 D-1) ───────────────────────────────
 * `UPLOAD_VIRUS_SCAN_PROVIDER` was parsed at `upload-config.ts` and **read by nothing**. All
 * four injection sites hand-constructed a scanner that returned `{ clean: true }` — two
 * separate definitions of a `NoOpVirusScanner` and, on the digital-products path, a
 * `MockScanner`. So the configuration named a provider, the pipeline reported scans, the
 * observers logged them, and no byte was ever examined.
 *
 * **The reason that survived is the reason this file exists: a scanner which does nothing is
 * indistinguishable from a scanner which works.** Nothing observable differs — same latency
 * order, same result shape, same log line. It cannot be caught by testing the happy path; it
 * can only be prevented structurally. So `test:uploads` scans `src/` and asserts that **no
 * file constructs a scanner directly**. This function is the only door.
 *
 * ── Why `cloud` and `mock` THROW rather than degrade ──────────────────────────
 * A configuration naming a provider that does not exist must refuse, not accept uploads
 * unscanned. Same posture as `getJwtSecret()` and `assertExposedConfigSafe()`: the failure
 * direction of "fall back to something harmless-looking" is a platform that believes it is
 * protected. `assertUploadScannerSafe()` below moves that refusal to BOOT, where it belongs —
 * a per-request throw is a scanner misconfiguration discovered by a vendor.
 */
export function resolveVirusScanner(config: UploadPolicyConfig): IVirusScanner {
    switch (config.virusScan.provider) {
        case 'clamav':
            return new ClamAVScanner(clamavConfigFromEnv());

        case 'mock':
            // Permitted in development, where there is no clamd and an upload path that
            // refuses every file makes the service unusable. REFUSED in production by
            // `assertUploadScannerSafe()` at boot — this branch is reachable there only if
            // somebody deletes that assertion, so it refuses again rather than trusting it.
            if (process.env.NODE_ENV === 'production') {
                throw createAppError(
                    ERROR_CODES.CONFIG_INVALID_UPLOAD_SCANNER,
                    500,
                    'UPLOAD_VIRUS_SCAN_PROVIDER=mock is a TEST DOUBLE and scans nothing',
                );
            }
            return new MockScanner();

        case 'cloud':
            throw createAppError(
                ERROR_CODES.CONFIG_INVALID_UPLOAD_SCANNER,
                500,
                'UPLOAD_VIRUS_SCAN_PROVIDER=cloud is declared but not implemented',
            );

        default:
            // An unrecognised value. `loadUploadConfig` casts the raw string through `as any`,
            // so this is reachable from a typo — and a typo must not open the door either.
            throw createAppError(
                ERROR_CODES.CONFIG_INVALID_UPLOAD_SCANNER,
                500,
                `UPLOAD_VIRUS_SCAN_PROVIDER="${String(config.virusScan.provider)}" is not a known provider`,
            );
    }
}

/**
 * Boot guard. Call beside `assertSigningSecrets()` / `assertExposedConfigSafe()`.
 *
 * Every injection site builds its scanner per request, so without this a production deploy
 * naming `mock` (which is the DEFAULT in `getDefaultUploadConfig`, and therefore the thing a
 * deploy gets by forgetting a variable) would start cleanly and fail on the first upload —
 * a vendor discovering the misconfiguration on the platform's behalf. Refuse at boot instead.
 *
 * ── ⚠ ONE config checked, ALL of them covered — and only since step 25.1 ──────
 * This is handed `loadUploadConfig()`, and that is sufficient **only because every upload
 * config now spreads `resolveVirusScanConfig()`** instead of writing its own `virusScan`
 * block. It was not sufficient before: four of the five factories hardcoded
 * `provider: 'mock'`, so this assertion passed on the one config that was already correct
 * while three live upload paths — video, digital assets, delivery proofs — were handed a test
 * double, and would have thrown on the first upload in production.
 *
 * So the guarantee is structural, not incidental, and `test:uploads` pins the structure:
 * **no config factory may contain a `provider:` literal.** If that assertion is ever removed,
 * this one silently narrows back to a single path.
 *
 * ⚠ `UPLOAD_VIRUS_SCAN_ENABLED=false` is deliberately NOT refused here, and the distinction is
 * the finding's own: that variable is an operator turning scanning off **on purpose**, which
 * claims nothing. S-2 was about a configuration that claimed to scan and did not. It is logged
 * loudly instead, so it appears in the boot record rather than being discovered.
 */
export function assertUploadScannerSafe(config: UploadPolicyConfig, log: (message: string) => void): void {
    if (!config.virusScan.enabled) {
        log('[uploads] ⚠ virus scanning is DISABLED (UPLOAD_VIRUS_SCAN_ENABLED=false) — every uploaded byte is accepted unexamined');
        return;
    }

    // Constructing it is the assertion: every refusal above is a throw, and a `clamav` config
    // that resolves here is a scanner whose reachability is proven on the first upload rather
    // than at boot (a TCP connect at boot would make a clamd restart a jovi-mall outage).
    resolveVirusScanner(config);

    log(`[uploads] virus scanning ON — provider=${config.virusScan.provider}, blockOnFailure=${config.virusScan.blockOnFailure}`);
}

export { ClamAVScanner, clamavConfigFromEnv } from './clamav-scanner';
