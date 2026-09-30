/**
 * test:payout-reconciliation — the sweep that closes a payout whose transfer callback never
 * arrived (`earnings/workers/payout-reconciliation.worker.ts`). DB-free: fake rows, fake
 * gateways, and a fake `applyTransferOutcome` that keeps the real one's compare-and-set.
 *
 *   1. Verdicts        success → paid, failed → failed (hold kept), pending → untouched,
 *                      CANCELLED is a failure, anything else is not a verdict
 *   2. Stored gateway  a switched payout aggregator still asks the gateway that SENT it;
 *                      a null means NotchPay
 *   3. Races           the callback already settled it; a callback after the sweep; one bad row
 *   4. No fallback     a gateway without verifyPayout is skipped, never asked via verifyPayment
 *   5. Adapters        NotchPay's /transfers verdict and Campay's /transaction/ verdict refuse a
 *                      record that is not THIS payout
 *   6. Scans           the worker takes the lock, pauses for maintenance, reads no settings
 *
 * Run: npm run test:payout-reconciliation
 */

// Before the first import: the pino console bridge otherwise swallows this suite's output.
process.env.LOG_STDOUT = 'false';

import { readFileSync } from 'fs';
import { join } from 'path';
import { originalConsole } from '../../src/core/logging/sink-guard';
import {
    PayoutReconcileDeps,
    PayoutTransferOutcome,
    PayoutVerifier,
    StuckPayout,
    outcomeFor,
    reconcileStuckPayouts,
} from '../../src/modules/earnings/domain/payout-reconciliation';
import { PaymentGatewayName, PaymentGatewayStatus, PayoutVerifyResult } from '../../src/modules/payments/gateways/gateway.interface';
import { notchPayTransferVerdict } from '../../src/modules/payments/gateways/notchpay.gateway';
import { campayWithdrawalVerdict } from '../../src/modules/payments/gateways/campay.gateway';

let passed = 0;
let failed = 0;

async function assert(name: string, fn: () => boolean | Promise<boolean>): Promise<void> {
    let ok: boolean;
    try {
        ok = await fn();
    } catch (err) {
        originalConsole.error(`  ❌ THROW: ${name} — ${(err as Error).message}`);
        failed++;
        return;
    }
    if (ok) {
        passed++;
        originalConsole.log(`  ✅ ${name}`);
    } else {
        failed++;
        originalConsole.error(`  ❌ FAIL: ${name}`);
    }
}

function section(title: string): void {
    originalConsole.log(`\n── ${title} ${'─'.repeat(Math.max(0, 72 - title.length))}`);
}

// ── Fakes ────────────────────────────────────────────────────────────────────

type Status = 'processing' | 'paid' | 'failed';

/**
 * A payout store with the REAL settlement's one property that matters here: the write is a
 * compare-and-set on `processing`, and the loser gets null. That is what makes the sweep and
 * the callback safe against each other, so the fake must not be laxer than the real thing.
 */
function fakeStore(rows: StuckPayout[]) {
    const status = new Map<string, Status>(rows.map((r) => [r.id, 'processing']));
    const applied: Array<{ id: string; outcome: PayoutTransferOutcome; by: string }> = [];
    const apply = (by: string) => async (id: string, outcome: PayoutTransferOutcome) => {
        if (status.get(id) !== 'processing') return null;
        status.set(id, outcome.settled ? 'paid' : 'failed');
        applied.push({ id, outcome, by });
        return { id };
    };
    return { status, applied, apply };
}

function row(id: string, over: Partial<StuckPayout> = {}): StuckPayout {
    return {
        id,
        transfer_gateway: 'NOTCHPAY',
        transfer_reference: `jm_po_${id.padStart(32, '0')}`,
        transfer_gateway_ref: `trf_${id}`,
        ...over,
    };
}

/** A gateway whose verifyPayout answers from a table, and which records every question. */
function fakeGateway(answers: Record<string, PayoutVerifyResult | Error>) {
    const asked: string[] = [];
    let verifyPaymentCalls = 0;
    const gateway: PayoutVerifier & { verifyPayment(): Promise<never> } = {
        async verifyPayout(payload) {
            asked.push(payload.gatewayRef);
            const answer = answers[payload.gatewayRef];
            if (answer instanceof Error) throw answer;
            return answer ?? { status: 'PENDING', gatewayRef: null };
        },
        async verifyPayment() {
            verifyPaymentCalls += 1;
            throw new Error('verifyPayment must never be used for a payout');
        },
    };
    return { gateway, asked, verifyPaymentCalls: () => verifyPaymentCalls };
}

const verdict = (status: PaymentGatewayStatus, extra: Partial<PayoutVerifyResult> = {}): PayoutVerifyResult =>
    ({ status, gatewayRef: null, ...extra });

(async () => {
    // ═══ 1. Verdicts ════════════════════════════════════════════════════════════
    section('1. Verdicts — only a sure answer moves anything');

    {
        const rows = [row('1'), row('2'), row('3')];
        const store = fakeStore(rows);
        const gw = fakeGateway({
            trf_1: verdict('SUCCEEDED', { gatewayRef: 'trf_1' }),
            trf_2: verdict('FAILED', { reason: 'Insufficient float' }),
            trf_3: verdict('PENDING'),
        });
        const tally = await reconcileStuckPayouts(rows, {
            gatewayFor: () => gw.gateway,
            applyTransferOutcome: store.apply('sweep'),
        });

        await assert('success → settled through applyTransferOutcome (paid)', () =>
            store.status.get('1') === 'paid'
            && store.applied.some((a) => a.id === '1' && a.outcome.settled && a.outcome.gatewayRef === 'trf_1'));
        await assert("failed → failed with the gateway's reason (the hold is kept by applyTransferOutcome)", () =>
            store.status.get('2') === 'failed'
            && store.applied.some((a) => a.id === '2' && !a.outcome.settled && a.outcome.reason === 'Insufficient float'));
        await assert('pending → untouched, and applyTransferOutcome is not even called', () =>
            store.status.get('3') === 'processing' && !store.applied.some((a) => a.id === '3'));
        await assert('the tally says so: 1 settled, 1 failed, 1 pending', () =>
            tally.checked === 3 && tally.settled === 1 && tally.failed === 1 && tally.pending === 1 && tally.errors === 0);
    }

    await assert('CANCELLED is a failure verdict', () =>
        outcomeFor(verdict('CANCELLED'), { transfer_gateway_ref: 'x' }, 'CAMPAY')?.settled === false);
    await assert('INITIATED and REFUNDED are NOT verdicts for a transfer — left alone', () =>
        outcomeFor(verdict('INITIATED'), { transfer_gateway_ref: 'x' }, 'NOTCHPAY') === null
        && outcomeFor(verdict('REFUNDED' as PaymentGatewayStatus), { transfer_gateway_ref: 'x' }, 'NOTCHPAY') === null);
    await assert("a verdict without its own transfer id keeps the row's", () =>
        outcomeFor(verdict('SUCCEEDED'), { transfer_gateway_ref: 'trf_row' }, 'NOTCHPAY')?.gatewayRef === 'trf_row');
    await assert('a failure with no provider wording still carries a reason naming the gateway', () =>
        /MYCOOLPAY/.test(outcomeFor(verdict('FAILED'), { transfer_gateway_ref: 'x' }, 'MYCOOLPAY')?.reason ?? ''));

    {
        const rows = [row('9')];
        const store = fakeStore(rows);
        const logs: string[] = [];
        const gw = fakeGateway({ trf_9: verdict('PENDING', { inconclusive: 'record is a collect, not a withdrawal' }) });
        const tally = await reconcileStuckPayouts(rows, {
            gatewayFor: () => gw.gateway,
            applyTransferOutcome: store.apply('sweep'),
            log: (l) => logs.push(l),
        });
        await assert('an inconclusive answer is pending, and the reason is logged', () =>
            tally.pending === 1 && store.status.get('9') === 'processing' && logs.some((l) => l.includes('not a withdrawal')));
    }

    // ═══ 2. Stored gateway ══════════════════════════════════════════════════════
    section('2. The STORED gateway — never the payout setting');

    {
        // The platform has since switched payouts to MYCOOLPAY. These were sent before that.
        const rows = [
            row('c', { transfer_gateway: 'CAMPAY', transfer_gateway_ref: 'cmp_c' }),
            row('n', { transfer_gateway: 'NOTCHPAY', transfer_gateway_ref: 'trf_n' }),
            row('legacy', { transfer_gateway: null, transfer_gateway_ref: 'trf_legacy' }),
        ];
        const store = fakeStore(rows);
        const askedFor: Array<[PaymentGatewayName, string]> = [];
        const deps: PayoutReconcileDeps = {
            gatewayFor: (name) => ({
                async verifyPayout(p) {
                    askedFor.push([name, p.gatewayRef]);
                    return verdict('SUCCEEDED');
                },
            }),
            applyTransferOutcome: store.apply('sweep'),
        };
        await reconcileStuckPayouts(rows, deps);

        await assert('a Campay payout is asked of CAMPAY, after the switch to MyCoolPay', () =>
            askedFor.some(([g, ref]) => g === 'CAMPAY' && ref === 'cmp_c'));
        await assert('a NotchPay payout is asked of NOTCHPAY', () =>
            askedFor.some(([g, ref]) => g === 'NOTCHPAY' && ref === 'trf_n'));
        await assert('a legacy payout (no stored gateway) is asked of NOTCHPAY, the only sender then', () =>
            askedFor.some(([g, ref]) => g === 'NOTCHPAY' && ref === 'trf_legacy'));
        await assert('the active aggregator (MYCOOLPAY) was never asked', () =>
            !askedFor.some(([g]) => g === 'MYCOOLPAY'));
    }

    {
        const r = row('ref');
        let seen: { gatewayRef: string; reference: string | null } | null = null;
        await reconcileStuckPayouts([r], {
            gatewayFor: () => ({ async verifyPayout(p) { seen = p; return verdict('PENDING'); } }),
            applyTransferOutcome: async () => null,
        });
        await assert('the adapter is given BOTH references: theirs to look up, ours to check', () =>
            seen !== null && (seen as { gatewayRef: string }).gatewayRef === r.transfer_gateway_ref
            && (seen as { reference: string | null }).reference === r.transfer_reference);
    }

    // ═══ 3. Races ═══════════════════════════════════════════════════════════════
    section('3. Races — one settlement path, exactly once');

    {
        const rows = [row('r1')];
        const store = fakeStore(rows);
        // The callback landed between the sweep's SELECT and its write.
        await store.apply('callback')('r1', { settled: true, gatewayRef: 'trf_r1', reason: null });
        const gw = fakeGateway({ trf_r1: verdict('SUCCEEDED') });
        const tally = await reconcileStuckPayouts(rows, { gatewayFor: () => gw.gateway, applyTransferOutcome: store.apply('sweep') });

        await assert('callback already settled it → the sweep changes nothing and counts it alreadyResolved', () =>
            tally.alreadyResolved === 1 && tally.settled === 0
            && store.applied.filter((a) => a.id === 'r1').length === 1 && store.applied[0].by === 'callback');
    }

    {
        const rows = [row('r2')];
        const store = fakeStore(rows);
        const gw = fakeGateway({ trf_r2: verdict('SUCCEEDED') });
        await reconcileStuckPayouts(rows, { gatewayFor: () => gw.gateway, applyTransferOutcome: store.apply('sweep') });
        const late = await store.apply('callback')('r2', { settled: true, gatewayRef: 'trf_r2', reason: null });

        await assert('a callback AFTER the sweep is a no-op — settled once, by the sweep', () =>
            late === null && store.applied.filter((a) => a.id === 'r2').length === 1 && store.applied[0].by === 'sweep');
    }

    {
        const rows = [row('b1'), row('b2')];
        const store = fakeStore(rows);
        const gw = fakeGateway({ trf_b1: new Error('socket hang up'), trf_b2: verdict('SUCCEEDED') });
        const tally = await reconcileStuckPayouts(rows, { gatewayFor: () => gw.gateway, applyTransferOutcome: store.apply('sweep') });

        await assert('one row throwing does not stop the batch, and is not read as a failure', () =>
            tally.errors === 1 && store.status.get('b1') === 'processing' && store.status.get('b2') === 'paid');
    }

    // ═══ 4. No fallback ═════════════════════════════════════════════════════════
    section('4. No verifyPayout → skipped, never verifyPayment');

    {
        const rows = [row('u1', { transfer_gateway: 'STRIPE' }), row('u2', { transfer_gateway: 'MYCOOLPAY' })];
        const store = fakeStore(rows);
        let verifyPaymentCalls = 0;
        const noPayoutVerify = { async verifyPayment() { verifyPaymentCalls += 1; return verdict('SUCCEEDED'); } } as PayoutVerifier;
        const tally = await reconcileStuckPayouts(rows, {
            gatewayFor: (name) => (name === 'STRIPE' ? noPayoutVerify : null),
            applyTransferOutcome: store.apply('sweep'),
        });

        await assert('a gateway without verifyPayout, and an unregistered one, are counted unsupported', () =>
            tally.unsupported === 2 && tally.settled === 0);
        await assert('verifyPayment is never called as a fallback', () => verifyPaymentCalls === 0);
        await assert('…and both rows stay processing', () =>
            store.status.get('u1') === 'processing' && store.status.get('u2') === 'processing');
    }

    // ═══ 5. Adapters ════════════════════════════════════════════════════════════
    section('5. Adapter verdicts — the record must prove it is THIS payout');

    const npNormalize = (raw: unknown): PaymentGatewayStatus =>
        ({ complete: 'SUCCEEDED', failed: 'FAILED', sent: 'PENDING', reversed: 'FAILED' } as Record<string, PaymentGatewayStatus>)[String(raw)] ?? 'PENDING';
    const ours = 'jm_po_0123456789abcdef0123456789abcdef';

    await assert('NotchPay: a complete transfer with our reference → SUCCEEDED with its trf_ id', () => {
        const v = notchPayTransferVerdict({ transfer: { id: 'trf_1', reference: ours, status: 'complete' } }, ours, npNormalize);
        return v.status === 'SUCCEEDED' && v.gatewayRef === 'trf_1';
    });
    await assert("NotchPay: a transfer echoing ANOTHER reference → PENDING, not a verdict about someone else's money", () => {
        const v = notchPayTransferVerdict({ transfer: { id: 'trf_1', reference: 'jm_po_other', status: 'complete' } }, ours, npNormalize);
        return v.status === 'PENDING' && Boolean(v.inconclusive);
    });
    await assert('NotchPay: no transfer object (a payment body, an error body) → PENDING', () =>
        notchPayTransferVerdict({ transaction: { status: 'complete' } }, ours, npNormalize).status === 'PENDING');
    await assert('NotchPay: failed → FAILED with a reason', () => {
        const v = notchPayTransferVerdict({ transfer: { id: 'trf_1', reference: ours, status: 'failed', message: 'Invalid number' } }, ours, npNormalize);
        return v.status === 'FAILED' && v.reason === 'Invalid number';
    });

    await assert('Campay: a successful withdrawal with our reference → SUCCEEDED', () => {
        const v = campayWithdrawalVerdict({ reference: 'cmp_1', endpoint: 'withdraw', external_user: ours, status: 'SUCCESSFUL' }, ours);
        return v.status === 'SUCCEEDED' && v.gatewayRef === 'cmp_1';
    });
    await assert('Campay: a COLLECT record (same lookup serves both) → PENDING', () =>
        campayWithdrawalVerdict({ reference: 'cmp_1', endpoint: 'collect', external_user: ours, status: 'SUCCESSFUL' }, ours).status === 'PENDING');
    await assert('Campay: a withdrawal with ANOTHER reference → PENDING', () =>
        campayWithdrawalVerdict({ reference: 'cmp_1', endpoint: 'withdraw', external_user: 'jm_po_other', status: 'SUCCESSFUL' }, ours).status === 'PENDING');
    await assert('Campay: a record stating neither direction nor our reference → PENDING', () =>
        campayWithdrawalVerdict({ reference: 'cmp_1', status: 'SUCCESSFUL' }, ours).status === 'PENDING');
    await assert('Campay: no endpoint, but OUR jm_po_ reference → the reference proves it', () =>
        campayWithdrawalVerdict({ reference: 'cmp_1', external_user: ours, status: 'FAILED' }, ours).status === 'FAILED');

    // ═══ 6. Scans ═══════════════════════════════════════════════════════════════
    section('6. Scans — the worker file');

    const strip = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const worker = strip(readFileSync(
        join(__dirname, '..', '..', 'src', 'modules', 'earnings', 'workers', 'payout-reconciliation.worker.ts'), 'utf8'));
    const core = strip(readFileSync(
        join(__dirname, '..', '..', 'src', 'modules', 'earnings', 'domain', 'payout-reconciliation.ts'), 'utf8'));

    await assert('the scans read non-empty files (a vacuous scan passes hardest)', () => worker.length > 500 && core.length > 500);
    await assert('the pass runs inside the shared worker lock', () => worker.includes("withWorkerLock('payout-reconciliation'"));
    await assert('the cron tick pauses for maintenance', () => /cron\.schedule\([\s\S]*?maintenanceBlocksWorkers\(\)/.test(worker));
    await assert('it selects only processing rows WITH a provider transfer id', () =>
        /status:\s*'processing'/.test(worker) && /transfer_gateway_ref:\s*\{\s*\$nin:\s*\[''\s*,\s*null\]/.test(worker));
    await assert('it settles through applyTransferOutcome — the callback path — and nothing else', () =>
        worker.includes('payoutRequestService.applyTransferOutcome(') && !/markTransferFailed|settleTransferPaid|markPaid\(/.test(worker + core));
    await assert('neither file reads the payout SETTING (the stored gateway decides)', () =>
        !/resolvePayoutAggregator|getPaymentSettingsSync|payout_aggregator/.test(worker + core));
    await assert('neither file calls verifyPayment', () => !/verifyPayment\(/.test(worker + core));
    await assert('the core resolves the gateway with storedPayoutGateway', () => core.includes('storedPayoutGateway(row)'));

    originalConsole.log(`\n${'═'.repeat(76)}`);
    originalConsole.log(`  ${passed} passed, ${failed} failed`);
    originalConsole.log('═'.repeat(76));
    process.exit(failed > 0 ? 1 : 0);
})();
