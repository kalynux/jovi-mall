/**
 * test:payout-routing — the payout switch (ADR-A08, W5), offline.
 *
 * The payout aggregator is an administrator's runtime switch now, and a payout can outlive a
 * switch. What this suite pins is that the switch only ever chooses for a payout that has never
 * been sent:
 *
 *   1. The rule         `payoutGatewayFor`: stored → legacy-sent is NOTCHPAY → never-sent takes
 *                       the active one. One assertion per branch, and the null cases.
 *   2. Mid-switch       BEHAVIOURAL, through the real `PayoutRequestService.sendPayout`, with a
 *                       fake repository and fake gateways swapped into the registry: a transfer
 *                       that failed on NotchPay is retried after the switch to My-CoolPay and
 *                       goes back to NotchPay with the SAME reference; a fresh payout goes to
 *                       My-CoolPay; a legacy row is sent through NotchPay and stamped.
 *   3. Refusals         no resolvable aggregator, or one that cannot send, is the existing 500
 *                       `EARNINGS_PAYOUT_GATEWAY_NOT_CONFIGURED`, before any claim. A retry is
 *                       never rerouted to a different aggregator when its own is off.
 *   4. Callbacks        a transfer callback on a different gateway's route is `ignored`, never
 *                       applied; a matching one is applied; a stored null counts as NOTCHPAY.
 *   5. Source           the pieces nothing behavioural reaches: the stamp is inside the atomic
 *                       claim, the constant is gone, and the webhook path reads no settings.
 *
 * Run: npm run test:payout-routing
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { originalConsole } from '../../src/core/logging/sink-guard';
import { PaymentGateway, PaymentGatewayName } from '../../src/modules/payments/gateways/gateway.interface';
import { PAYMENT_GATEWAYS } from '../../src/modules/payments/gateways/registry';
import { DEFAULT_PAYMENT_SETTINGS, PaymentSettingsRecord } from '../../src/modules/payments/domain/payment-routing';
import {
  __resetPaymentSettingsCacheForTests,
  __setPaymentSettingsStoreForTests,
} from '../../src/modules/payments/services/payment-settings.service';
import { resolvePayoutAggregator } from '../../src/modules/payments/services/payment-routing.service';
import {
  LEGACY_PAYOUT_GATEWAY,
  payoutGatewayFor,
  storedPayoutGateway,
} from '../../src/modules/earnings/domain/payout-gateway';
import { PayoutRequestService, payoutRequestService } from '../../src/modules/earnings/services/payout-request.service';
import { toAdminPayoutRequestDto } from '../../src/modules/earnings/dto/admin-payout-request.dto';
import { paymentWebhookProcessor } from '../../src/modules/payments/services/webhook-processor.service';

let passed = 0;
let failed = 0;

function assert(name: string, fn: () => boolean): void {
  let ok: boolean;
  try {
    ok = fn();
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

const read = (rel: string): string => readFileSync(join(__dirname, '../..', rel), 'utf8');

// ── Settings, without a database ─────────────────────────────────────────────

/** A store that is never ready, so the cache never tries to refresh past what a test set. */
__setPaymentSettingsStoreForTests({
  ready: () => false,
  read: async () => null,
  create: async () => { throw new Error('not in this suite'); },
  compareAndSet: async () => null,
});

function setPayoutAggregator(name: string): void {
  __resetPaymentSettingsCacheForTests(
    { ...DEFAULT_PAYMENT_SETTINGS, payout_aggregator: name } as PaymentSettingsRecord,
    true,
  );
}

// ── Fake gateways, swapped into the real registry ────────────────────────────

interface Call { gateway: PaymentGatewayName; reference: string }
const calls: Call[] = [];
const outcome: Record<string, { success: boolean; gatewayRef: string | null; message?: string }> = {};
const payoutsOn: Record<string, boolean> = {};

const registry = PAYMENT_GATEWAYS as unknown as Map<PaymentGatewayName, PaymentGateway>;
const realGateways = new Map(registry);

function fakeGateway(name: PaymentGatewayName, canPayout: boolean): PaymentGateway {
  const real = realGateways.get(name)!;
  const fake: any = { name, capabilities: real.capabilities };
  if (canPayout) {
    fake.payoutAvailable = () => payoutsOn[name] !== false;
    fake.createPayout = async (p: { reference: string }) => {
      calls.push({ gateway: name, reference: p.reference });
      return outcome[name] ?? { success: false, gatewayRef: null, message: 'refused by fixture' };
    };
  }
  return fake as PaymentGateway;
}

registry.set('NOTCHPAY', fakeGateway('NOTCHPAY', true));
registry.set('MYCOOLPAY', fakeGateway('MYCOOLPAY', true));
registry.set('STRIPE', fakeGateway('STRIPE', false));

// ── A fake repository with the real claim semantics ──────────────────────────

type Row = Record<string, any>;
const rows = new Map<string, Row>();
let nextId = 1;

function row(patch: Partial<Row> = {}): Row {
  const id = `po${nextId++}`;
  const r: Row = {
    id,
    _id: id,
    owner_type: 'vendor',
    owner_id: { toString: () => 'owner1' },
    amount: 1000,
    currency: 'XAF',
    status: 'pending',
    origin: 'manual',
    payout_method_snapshot: {
      method: 'mobile_money',
      mobile_money: { phone_number: '+237670000000', account_name: 'Fixture' },
    },
    ticket_id: null,
    requested_by_user_id: { toString: () => 'user1' },
    triage: null,
    transfer_reference: null,
    transfer_gateway: null,
    transfer_gateway_ref: null,
    transfer_failure_reason: null,
    resolved_at: null,
    resolved_by: null,
    resolved_by_source: 'platform',
    resolved_by_name: null,
    paid_reference: null,
    rejection_reason: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...patch,
  };
  rows.set(id, r);
  return r;
}

const fakeRepo: any = {
  findById: async (id: string) => rows.get(id) ?? null,
  /** Mirrors the pipeline: CAS on pending|failed; `$ifNull` on the reference AND the gateway. */
  beginTransfer: async (id: string, candidateReference: string, candidateGateway: PaymentGatewayName) => {
    const r = rows.get(id);
    if (!r || !['pending', 'failed'].includes(r.status)) return null;
    r.status = 'processing';
    r.transfer_reference = r.transfer_reference ?? candidateReference;
    r.transfer_gateway = r.transfer_gateway ?? candidateGateway;
    r.transfer_failure_reason = null;
    return r;
  },
  markTransferFailed: async (id: string, reason: string, gatewayRef: string | null) => {
    const r = rows.get(id);
    if (!r || r.status !== 'processing') return null;
    r.status = 'failed';
    r.transfer_failure_reason = reason;
    if (gatewayRef) r.transfer_gateway_ref = gatewayRef;
    return r;
  },
  setTransferGatewayRef: async (id: string, gatewayRef: string | null) => {
    if (gatewayRef) rows.get(id)!.transfer_gateway_ref = gatewayRef;
  },
};

const service = new PayoutRequestService(
  fakeRepo,
  {} as any,
  {} as any,
  {} as any,
  {} as any,
  { createSystemNote: async () => undefined } as any,
);

async function send(id: string): Promise<{ ok: true } | { ok: false; code: string; status: number; details: any }> {
  try {
    await service.sendPayout(id);
    return { ok: true };
  } catch (err: any) {
    return { ok: false, code: err?.code, status: err?.statusCode, details: err?.details };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  section('1. The rule');

  assert('stored gateway wins, whatever is active', () =>
    payoutGatewayFor({ transfer_gateway: 'MYCOOLPAY', transfer_reference: 'jm_po_x' }, 'NOTCHPAY') === 'MYCOOLPAY');
  assert('stored gateway wins even when nothing is active', () =>
    payoutGatewayFor({ transfer_gateway: 'NOTCHPAY', transfer_reference: 'jm_po_x' }, null) === 'NOTCHPAY');
  assert('no stored gateway, but SENT before ADR-A08 → NOTCHPAY, never the active one', () =>
    payoutGatewayFor({ transfer_gateway: null, transfer_reference: 'jm_po_x' }, 'MYCOOLPAY') === 'NOTCHPAY'
    && LEGACY_PAYOUT_GATEWAY === 'NOTCHPAY');
  assert('never sent → the active aggregator', () =>
    payoutGatewayFor({ transfer_gateway: null, transfer_reference: null }, 'MYCOOLPAY') === 'MYCOOLPAY');
  assert('never sent and nothing active → null', () =>
    payoutGatewayFor({ transfer_gateway: null, transfer_reference: null }, null) === null);
  assert('a callback judges a stored null as NOTCHPAY', () =>
    storedPayoutGateway({ transfer_gateway: null }) === 'NOTCHPAY'
    && storedPayoutGateway({ transfer_gateway: 'MYCOOLPAY' }) === 'MYCOOLPAY');

  setPayoutAggregator('CAMPAY_NOT_REGISTERED');
  assert('resolvePayoutAggregator: an unregistered stored name resolves to null', () =>
    resolvePayoutAggregator() === null);

  // ───────────────────────────────────────────────────────────────────────────
  section('2. A switch mid-flight (behavioural)');

  setPayoutAggregator('NOTCHPAY');
  const a = row();
  const first = await send(a.id);
  const refA = a.transfer_reference;

  assert('first send goes through the active NOTCHPAY', () =>
    first.ok && calls.length === 1 && calls[0].gateway === 'NOTCHPAY');
  assert('...and the claim stamped transfer_gateway = NOTCHPAY beside the reference', () =>
    a.transfer_gateway === 'NOTCHPAY' && typeof refA === 'string' && refA.startsWith('jm_po_'));
  assert('...the gateway refused, so the payout is failed and still held', () => a.status === 'failed');

  setPayoutAggregator('MYCOOLPAY');
  const retry = await send(a.id);
  assert('after the switch to MYCOOLPAY, the RETRY still goes to NOTCHPAY', () =>
    retry.ok && calls.length === 2 && calls[1].gateway === 'NOTCHPAY');
  assert('...with the SAME reference, so NotchPay can deduplicate it', () => calls[1].reference === refA);
  assert('...and the stored gateway is unchanged', () => a.transfer_gateway === 'NOTCHPAY');

  const b = row();
  await send(b.id);
  assert('a FRESH payout after the switch goes to MYCOOLPAY and is stamped so', () =>
    calls[2]?.gateway === 'MYCOOLPAY' && b.transfer_gateway === 'MYCOOLPAY');

  const legacy = row({ status: 'failed', transfer_reference: 'jm_po_' + 'a'.repeat(32), transfer_gateway: null });
  await send(legacy.id);
  assert('a LEGACY failed row (reference, no gateway) is retried through NOTCHPAY, not the active one', () =>
    calls[3]?.gateway === 'NOTCHPAY' && calls[3]?.reference === legacy.transfer_reference);
  assert('...and is stamped NOTCHPAY on that retry', () => legacy.transfer_gateway === 'NOTCHPAY');

  outcome.MYCOOLPAY = { success: true, gatewayRef: 'mcp_tr_1' };
  const c = row();
  await send(c.id);
  assert('a transfer the gateway accepts stays processing with its gateway ref', () =>
    c.status === 'processing' && c.transfer_gateway === 'MYCOOLPAY' && c.transfer_gateway_ref === 'mcp_tr_1');

  // ───────────────────────────────────────────────────────────────────────────
  section('3. Refusals, before any claim');

  setPayoutAggregator('CAMPAY_NOT_REGISTERED');
  const d = row();
  const unresolved = await send(d.id);
  assert('no resolvable aggregator → 500 EARNINGS_PAYOUT_GATEWAY_NOT_CONFIGURED, gateway: null', () =>
    !unresolved.ok && unresolved.status === 500
    && unresolved.code === 'EARNINGS_PAYOUT_GATEWAY_NOT_CONFIGURED' && unresolved.details?.gateway === null);
  assert('...and the payout was not claimed', () =>
    d.status === 'pending' && d.transfer_reference === null && d.transfer_gateway === null);

  setPayoutAggregator('STRIPE');
  const e = row();
  const noPayouts = await send(e.id);
  assert('an aggregator with no createPayout → the same 500, naming it', () =>
    !noPayouts.ok && noPayouts.status === 500 && noPayouts.details?.gateway === 'STRIPE' && e.status === 'pending');

  setPayoutAggregator('MYCOOLPAY');
  payoutsOn.NOTCHPAY = false;
  const before = calls.length;
  const stuck = await send(a.id);
  assert('a NOTCHPAY payout, with NotchPay payouts off, is REFUSED rather than rerouted to the active MYCOOLPAY', () =>
    !stuck.ok && stuck.status === 500 && stuck.details?.gateway === 'NOTCHPAY'
    && calls.length === before && a.status === 'failed');
  payoutsOn.NOTCHPAY = true;

  // ───────────────────────────────────────────────────────────────────────────
  section('4. Transfer callbacks');

  const applied: string[] = [];
  const svc = payoutRequestService as any;
  const saved = { get: svc.getByTransferReference, apply: svc.applyTransferOutcome };
  svc.getByTransferReference = async (ref: string) => [...rows.values()].find((r) => r.transfer_reference === ref) ?? null;
  svc.applyTransferOutcome = async (id: string) => { applied.push(id); return { ...rows.get(id)!, status: 'paid' }; };

  const settle = (routeGateway: PaymentGatewayName | undefined, ref: string) =>
    (paymentWebhookProcessor as any).settlePayout(
      { eventId: 'e', eventType: 'transfer.complete', direction: 'payout', gatewayRef: 'g', merchantRef: ref,
        status: 'SUCCEEDED', amount: 1000, currency: 'XAF', raw: {} },
      routeGateway,
    );

  try {
    const wrong = await settle('MYCOOLPAY', a.transfer_reference);
    assert('a NOTCHPAY payout\'s callback arriving on the MYCOOLPAY route → ignored, not applied', () =>
      wrong.kind === 'ignored' && !applied.includes(a.id));

    const right = await settle('NOTCHPAY', a.transfer_reference);
    assert('...the same callback on the NOTCHPAY route → applied', () =>
      right.kind === 'processed' && applied.includes(a.id));

    const legacyRow = row({ status: 'processing', transfer_reference: 'jm_po_' + 'b'.repeat(32), transfer_gateway: null });
    const legacyWrong = await settle('MYCOOLPAY', legacyRow.transfer_reference);
    const legacyRight = await settle('NOTCHPAY', legacyRow.transfer_reference);
    assert('a stored null is judged as NOTCHPAY: refused on MYCOOLPAY, applied on NOTCHPAY', () =>
      legacyWrong.kind === 'ignored' && legacyRight.kind === 'processed' && applied.includes(legacyRow.id));

    const mcp = await settle('MYCOOLPAY', b.transfer_reference);
    assert('a MYCOOLPAY payout settles on its own route after the platform switched away', () => {
      setPayoutAggregator('NOTCHPAY');
      return mcp.kind === 'processed' && applied.includes(b.id);
    });

    const noRoute = await settle(undefined, c.transfer_reference);
    assert('without a route gateway the check is skipped (the parameter only narrows)', () =>
      noRoute.kind === 'processed');
  } finally {
    svc.getByTransferReference = saved.get;
    svc.applyTransferOutcome = saved.apply;
  }

  // ───────────────────────────────────────────────────────────────────────────
  section('5. The admin read, and the source');

  assert('the admin DTO shows the stored gateway, NOTCHPAY for a legacy sent row, null if never sent', () =>
    toAdminPayoutRequestDto(b as any, null).transferGateway === 'MYCOOLPAY'
    && toAdminPayoutRequestDto({ ...legacy, transfer_gateway: null } as any, null).transferGateway === 'NOTCHPAY'
    && toAdminPayoutRequestDto(row() as any, null).transferGateway === null);

  const SERVICE = read('src/modules/earnings/services/payout-request.service.ts');
  const REPO = read('src/modules/earnings/repositories/payout-request.repository.ts');
  const MODEL = read('src/modules/earnings/models/payout-request.model.ts');
  const WEBHOOK = read('src/modules/payments/services/webhook-processor.service.ts');

  assert('the hardcoded PAYOUT_GATEWAY constant is gone', () => !/\bPAYOUT_GATEWAY\b/.test(SERVICE));
  assert('sendPayout chooses through the settings and the rule BEFORE the claim', () => {
    const body = SERVICE.slice(SERVICE.indexOf('async sendPayout('));
    const choose = body.indexOf('payoutGatewayFor(payoutRequest, resolvePayoutAggregator())');
    const claim = body.indexOf('this.beginTransfer(');
    return choose !== -1 && claim !== -1 && choose < claim;
  });
  assert('the gateway is stamped INSIDE the atomic claim, with $ifNull (kept once set)', () =>
    /beginTransfer[\s\S]{0,1500}transfer_gateway: \{ \$ifNull: \['\$transfer_gateway', candidateGateway\] \}/.test(REPO));
  assert('the model field is enumerated from PAYMENT_GATEWAY_NAMES and defaults to null', () =>
    /transfer_gateway: \{ type: String, enum: \[\.\.\.PAYMENT_GATEWAY_NAMES, null\], default: null \}/.test(MODEL));
  assert('the route passes its gateway into settlePayout', () =>
    WEBHOOK.includes('return this.settlePayout(event, gateway);'));
  assert('the webhook path reads no payment settings', () =>
    !/getPaymentSettingsSync|resolvePayoutAggregator|payment-settings\.service/.test(WEBHOOK));
  assert('no "reconciliation poll" is claimed for payouts any more', () =>
    !/reconciliation poll/.test(SERVICE) && !/reconciliation poll/.test(WEBHOOK));
}

main()
  .catch((err) => {
    originalConsole.error(`  ❌ THROW: suite — ${(err as Error).stack ?? err}`);
    failed++;
  })
  .finally(() => {
    for (const [name, gateway] of realGateways) registry.set(name, gateway);
    __setPaymentSettingsStoreForTests(null);
    originalConsole.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
  });
