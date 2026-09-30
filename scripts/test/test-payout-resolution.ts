/**
 * test:payout-resolution — the manual, audited exit for a payout whose transfer outcome is
 * UNKNOWN (`POST /api/internal/admin/payout-requests/:id/resolve-unknown`). DB-free: the real
 * `PayoutResolutionService` and the real `applyTransferOutcome`, over a fake repository that
 * keeps the real one's compare-and-set on `processing`.
 *
 *   1. The gate      `manualResolveRefusal`: processing only; the sweep's MIN_AGE measured from
 *                    `updated_at` (the claim), never `created_at`; the boundary is inclusive
 *   2. Refusals      404, 409 NOT_PROCESSING, 409 TRANSFER_IN_FLIGHT with `settleAfter` — and
 *                    none of them reaches the settlement
 *   3. paid          settles through applyTransferOutcome: balance debited in the same
 *                    transaction, `resolved_by` is the ADMINISTRATOR (source admin + name), the
 *                    ticket names them and their evidence
 *   4. failed        processing → failed, hold KEPT (no balance call at all), reason on the row
 *   5. Races         a callback/sweep settled it between the read and the write → 409, and the
 *                    row is not overwritten
 *   6. Unchanged     a GATEWAY settlement still stamps the platform
 *   7. Scans         route + validator + controller wiring
 *
 * Run: npm run test:payout-resolution
 */

// Before the first import: the pino console bridge otherwise swallows this suite's output.
process.env.LOG_STDOUT = 'false';

import { readFileSync } from 'fs';
import { join } from 'path';
import mongoose from 'mongoose';
import { originalConsole } from '../../src/core/logging/sink-guard';
import { transactionManager } from '../../src/core/database/transaction.manager';
import { eventBus } from '../../src/core/events/event-bus';
import { ActorRef } from '../../src/core/types/actor-source.types';
import { ERROR_CODES } from '../../src/core/error-codes';
import { EARNINGS_CONFIG } from '../../src/modules/earnings/config/earnings.config';
import { manualResolveRefusal } from '../../src/modules/earnings/domain/payout-reconciliation';
import { PayoutRequestService } from '../../src/modules/earnings/services/payout-request.service';
import { PayoutResolutionService } from '../../src/modules/earnings/services/payout-resolution.service';
import { ticketService } from '../../src/modules/tickets/services/ticket.service';
import { ResolveUnknownTransferSchema } from '../../src/modules/earnings/validators/payout-request.validator';

// Anything that reaches Mongo by accident must fail at once, not buffer for ten seconds.
mongoose.set('bufferCommands', false);

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

async function codeOf(fn: () => Promise<unknown>): Promise<{ code: string | null; status: number | null; details: any }> {
    try {
        await fn();
        return { code: null, status: null, details: null };
    } catch (err) {
        const e = err as { code?: string; statusCode?: number; details?: unknown };
        return { code: e.code ?? null, status: e.statusCode ?? null, details: e.details ?? null };
    }
}

// ── Fakes ────────────────────────────────────────────────────────────────────

const MIN = EARNINGS_CONFIG.PAYOUT_RECONCILE_MIN_AGE_MINUTES;
const NOW = new Date('2026-09-30T12:00:00Z');
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

const ADMIN: ActorRef = { userId: '64b000000000000000000a01', source: 'admin', name: 'Ada Admin' };

function row(overrides: Record<string, unknown> = {}): any {
    return {
        id: '64b0000000000000000000p1',
        status: 'processing',
        owner_type: 'vendor',
        owner_id: { toString: () => '64b0000000000000000000v1' },
        requested_by_user_id: { toString: () => '64b0000000000000000000u1' },
        amount: 25_000,
        currency: 'XAF',
        ticket_id: { toString: () => '64b0000000000000000000t1' },
        transfer_reference: 'jm_po_abc',
        transfer_gateway: 'MYCOOLPAY',
        transfer_gateway_ref: null,
        transfer_failure_reason: 'Outcome unknown: MYCOOLPAY gave no answer we could read.',
        created_at: ago(60 * 24 * 3),
        updated_at: ago(MIN + 5),
        ...overrides,
    };
}

/**
 * A payout store whose two writes are compare-and-set on `processing`, like the real
 * repository's. `racer` lets a test settle the row "between the read and the write".
 */
function world(initial: any) {
    let current = { ...initial };
    const calls = {
        balanceDebits: [] as number[],
        settledBy: [] as ActorRef[],
        failedWith: [] as string[],
        notes: [] as string[],
        ticketResolvedBy: [] as string[],
    };
    let racer: (() => void) | null = null;
    let reads = 0;
    let readRacer: { onRead: number; status: string } | null = null;

    const payoutRepo: any = {
        findById: async () => {
            reads++;
            if (readRacer && reads === readRacer.onRead) current = { ...current, status: readRacer.status };
            return { ...current };
        },
        markTransferFailed: async (_id: string, reason: string) => {
            racer?.(); racer = null;
            if (current.status !== 'processing') return null;
            current = { ...current, status: 'failed', transfer_failure_reason: reason };
            calls.failedWith.push(reason);
            return { ...current };
        },
        settleTransferPaid: async (_id: string, resolvedBy: ActorRef) => {
            if (current.status !== 'processing') return null;
            current = { ...current, status: 'paid', resolved_by: resolvedBy.userId,
                resolved_by_source: resolvedBy.source, resolved_by_name: resolvedBy.name ?? null };
            calls.settledBy.push(resolvedBy);
            return { ...current };
        },
        setTransferGatewayRef: async () => undefined,
    };
    const accounts: any = {
        markPayoutPaidInSession: async (_t: string, _o: string, amount: number) => {
            racer?.(); racer = null;
            calls.balanceDebits.push(amount);
        },
        revertPayoutToAvailableInSession: async () => { throw new Error('a hold must never be released here'); },
    };
    const ticketNotes: any = { createSystemNote: async (_t: string, text: string) => { calls.notes.push(text); } };

    const service = new PayoutRequestService(payoutRepo, accounts, {} as any, {} as any, {} as any, ticketNotes);
    const resolution = new PayoutResolutionService(service, () => NOW);
    return {
        service,
        resolution,
        calls,
        get row() { return current; },
        raceWith(status: string) { racer = () => { current = { ...current, status }; }; },
        /** The status changes just before the Nth read — i.e. between two services' reads. */
        raceOnRead(onRead: number, status: string) { readRacer = { onRead, status }; },
    };
}

// The real settlement runs in a transaction and resolves a ticket; neither needs a database
// for what this suite asserts.
(transactionManager as any).runInTransaction = async (fn: (s: unknown) => Promise<unknown>) => fn(undefined);
const ticketResolutions: string[] = [];
(ticketService as any).updateStatus = async (_id: string, _status: string, by: string) => { ticketResolutions.push(by); };
const published: string[] = [];
(eventBus as any).publish = async (name: string) => { published.push(name); };

(async () => {
    section('1. The gate — manualResolveRefusal');

    await assert('pending, failed, paid and rejected are refused as not_processing', () =>
        ['pending', 'failed', 'paid', 'rejected'].every((status) =>
            manualResolveRefusal({ status, updated_at: ago(999) }, NOW, MIN)?.kind === 'not_processing'));
    await assert('processing, quieter than MIN_AGE → too_recent with settleAfter = updated_at + MIN_AGE', () => {
        const updated = ago(MIN - 1);
        const refusal = manualResolveRefusal({ status: 'processing', updated_at: updated }, NOW, MIN);
        return refusal?.kind === 'too_recent'
            && refusal.settleAfter.getTime() === updated.getTime() + MIN * 60_000;
    });
    await assert('exactly MIN_AGE old is allowed (the boundary matches the sweep)', () =>
        manualResolveRefusal({ status: 'processing', updated_at: ago(MIN) }, NOW, MIN) === null);
    await assert('age is measured from updated_at, NOT created_at — an old request just sent is still refused', () =>
        manualResolveRefusal({ status: 'processing', updated_at: ago(1), created_at: ago(10_000) } as any, NOW, MIN)
            ?.kind === 'too_recent');
    await assert('MIN_AGE is a positive setting', () => MIN > 0);

    section('2. Refusals never reach the settlement');

    {
        const w = world(row());
        (w.service as any).payoutRepo.findById = async () => null;
        const r = await codeOf(() => w.resolution.resolveUnknownTransfer('x', { outcome: 'paid', reason: 'checked the dashboard' }, ADMIN));
        await assert('unknown id → 404 EARNINGS_PAYOUT_REQUEST_NOT_FOUND', () =>
            r.status === 404 && r.code === ERROR_CODES.EARNINGS_PAYOUT_REQUEST_NOT_FOUND);
    }
    for (const status of ['pending', 'failed', 'paid', 'rejected']) {
        const w = world(row({ status }));
        const r = await codeOf(() => w.resolution.resolveUnknownTransfer('x', { outcome: 'paid', reason: 'checked the dashboard' }, ADMIN));
        await assert(`${status} → 409 EARNINGS_PAYOUT_NOT_PROCESSING naming the status, nothing written`, () =>
            r.status === 409 && r.code === ERROR_CODES.EARNINGS_PAYOUT_NOT_PROCESSING
            && r.details?.status === status
            && w.calls.balanceDebits.length === 0 && w.calls.settledBy.length === 0 && w.calls.failedWith.length === 0);
    }
    {
        const w = world(row({ updated_at: ago(1) }));
        const r = await codeOf(() => w.resolution.resolveUnknownTransfer('x', { outcome: 'failed', reason: 'checked the dashboard' }, ADMIN));
        await assert('too recent → 409 EARNINGS_PAYOUT_TRANSFER_IN_FLIGHT with settleAfter + minAgeMinutes', () =>
            r.status === 409 && r.code === ERROR_CODES.EARNINGS_PAYOUT_TRANSFER_IN_FLIGHT
            && typeof r.details?.settleAfter === 'string' && r.details?.minAgeMinutes === MIN
            && w.row.status === 'processing' && w.calls.failedWith.length === 0);
    }

    section('3. paid — the administrator is the resolver');

    {
        const w = world(row());
        const result = await w.resolution.resolveUnknownTransfer(
            'x', { outcome: 'paid', reason: 'MyCoolPay dashboard shows SUCCESS', evidence: 'txn MCP-778' }, ADMIN);
        await assert('the payout is paid', () => result.status === 'paid' && w.row.status === 'paid');
        await assert('the balance was debited once, for the payout amount', () =>
            w.calls.balanceDebits.length === 1 && w.calls.balanceDebits[0] === 25_000);
        await assert('resolved_by is the ADMINISTRATOR — id, source admin and name snapshot', () =>
            w.calls.settledBy.length === 1
            && w.calls.settledBy[0].userId === ADMIN.userId
            && w.calls.settledBy[0].source === 'admin'
            && w.row.resolved_by_name === 'Ada Admin');
        await assert('the ticket is resolved BY the administrator', () =>
            ticketResolutions[ticketResolutions.length - 1] === ADMIN.userId);
        await assert('the ticket note names the administrator, the reason and the evidence', () => {
            const note = w.calls.notes[w.calls.notes.length - 1] ?? '';
            return note.includes('confirmed by administrator Ada Admin')
                && note.includes('MyCoolPay dashboard shows SUCCESS')
                && note.includes('txn MCP-778');
        });
        await assert('payout.paid is published', () => published.includes('payout.paid'));
    }

    section('4. failed — the hold is KEPT');

    {
        const w = world(row());
        const result = await w.resolution.resolveUnknownTransfer(
            'x', { outcome: 'failed', reason: 'MyCoolPay has no record of jm_po_abc' }, ADMIN);
        await assert('processing → failed', () => result.status === 'failed' && w.row.status === 'failed');
        await assert('no balance call of any kind (debit none; a release would have thrown)', () =>
            w.calls.balanceDebits.length === 0 && w.calls.settledBy.length === 0);
        await assert('the row says an administrator recorded it, and why', () =>
            w.row.transfer_failure_reason.includes('an administrator recorded it as failed')
            && w.row.transfer_failure_reason.includes('MyCoolPay has no record of jm_po_abc'));
        await assert('the ticket names the administrator and says the funds remain held', () => {
            const note = w.calls.notes[w.calls.notes.length - 1] ?? '';
            return note.includes('confirmed by administrator Ada Admin') && note.includes('funds remain held');
        });
    }

    section('5. Races — the callback or the sweep got there first');

    {
        const w = world(row());
        w.raceWith('paid');
        const r = await codeOf(() => w.resolution.resolveUnknownTransfer('x', { outcome: 'failed', reason: 'checked the dashboard' }, ADMIN));
        await assert('failed loses to a callback that settled it → 409 naming the new status, row stays paid', () =>
            r.status === 409 && r.code === ERROR_CODES.EARNINGS_PAYOUT_NOT_PROCESSING
            && r.details?.status === 'paid' && w.row.status === 'paid' && w.calls.failedWith.length === 0);
    }
    {
        const w = world(row());
        w.raceWith('failed');
        const r = await codeOf(() => w.resolution.resolveUnknownTransfer('x', { outcome: 'paid', reason: 'checked the dashboard' }, ADMIN));
        await assert('paid loses to a sweep that failed it → 409, nothing stamped paid', () =>
            r.status === 409 && r.code === ERROR_CODES.EARNINGS_PAYOUT_NOT_PROCESSING
            && w.row.status === 'failed' && w.calls.settledBy.length === 0);
    }

    {
        // The callback pays it after the resolution's pre-check read (read 1) and before
        // applyTransferOutcome's own read (read 2) — so applyTransferOutcome sees `paid`.
        const w = world(row());
        w.raceOnRead(2, 'paid');
        const r = await codeOf(() => w.resolution.resolveUnknownTransfer('x', { outcome: 'failed', reason: 'MyCoolPay has no record of it' }, ADMIN));
        await assert('admin failed vs a callback that paid it first → 409 {status: paid}', () =>
            r.status === 409 && r.code === ERROR_CODES.EARNINGS_PAYOUT_NOT_PROCESSING
            && r.details?.status === 'paid' && w.row.status === 'paid' && w.calls.failedWith.length === 0);
        await assert('⛔ ...and NO "ALREADY-PAID … manual cash adjustment" note — nothing was reversed', () =>
            w.calls.notes.every((n) => !n.includes('ALREADY-PAID') && !n.includes('cash adjustment')));
    }
    {
        // The gateway's own late `reversed` on a paid payout still gets the warning.
        const w = world(row({ status: 'paid' }));
        await w.service.applyTransferOutcome('x', { settled: false, gatewayRef: 'MCP-1', reason: 'reversed' });
        await assert('a GATEWAY reversal on an already-paid payout still writes the ALREADY-PAID warning', () =>
            w.calls.notes.some((n) => n.includes('ALREADY-PAID')));
    }

    section('6. A GATEWAY settlement is unchanged');

    {
        const w = world(row());
        await w.service.applyTransferOutcome('x', { settled: true, gatewayRef: 'MCP-1', reason: null });
        await assert('resolved_by is still the platform (the requester id, source platform, no name)', () =>
            w.calls.settledBy.length === 1
            && w.calls.settledBy[0].source === 'platform'
            && w.calls.settledBy[0].userId === '64b0000000000000000000u1'
            && (w.calls.settledBy[0].name ?? null) === null);
        await assert('...and the ticket says the gateway confirmed it', () =>
            (w.calls.notes[w.calls.notes.length - 1] ?? '').includes('confirmed by the payment gateway'));
    }

    section('7. The request shape and the wiring');

    await assert('reason is required, at least 10 characters', () =>
        !ResolveUnknownTransferSchema.safeParse({ outcome: 'paid' }).success
        && !ResolveUnknownTransferSchema.safeParse({ outcome: 'paid', reason: 'too short' }).success
        && ResolveUnknownTransferSchema.safeParse({ outcome: 'paid', reason: 'checked the dashboard' }).success);
    await assert('outcome is paid | failed only', () =>
        !ResolveUnknownTransferSchema.safeParse({ outcome: 'rejected', reason: 'checked the dashboard' }).success);
    await assert('.strict() — an amount key is a 400, not a silently dropped field', () =>
        !ResolveUnknownTransferSchema.safeParse({ outcome: 'paid', reason: 'checked the dashboard', amount: 1 }).success);

    const src = (...p: string[]) => readFileSync(join(__dirname, '..', '..', 'src', ...p), 'utf8');
    const routes = src('modules', 'earnings', 'routes', 'admin-payout-requests.routes.ts');
    const service = src('modules', 'earnings', 'services', 'payout-resolution.service.ts');

    await assert('the route is mounted on the admin payout-requests router', () =>
        routes.includes("router.post('/:id/resolve-unknown', AdminPayoutRequestsController.resolveUnknownTransfer)"));
    await assert('the resolution settles ONLY through applyTransferOutcome — no hand-rolled settle', () =>
        service.includes('applyTransferOutcome(')
        && !/settleTransferPaid|markTransferFailed|markPayoutPaidInSession|markPaid\(|revertPayout/.test(service));
    await assert("it passes source kind 'administrator' carrying the actor", () =>
        /kind:\s*'administrator',\s*actor,/.test(service));
    await assert('the floor is the SAME setting the sweep uses', () =>
        service.includes('EARNINGS_CONFIG.PAYOUT_RECONCILE_MIN_AGE_MINUTES'));

    originalConsole.log(`\n${'═'.repeat(76)}`);
    originalConsole.log(`  ${passed} passed, ${failed} failed`);
    originalConsole.log('═'.repeat(76));
    process.exit(failed > 0 ? 1 : 0);
})();
