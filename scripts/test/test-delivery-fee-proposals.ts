/**
 * Test: per-shipment delivery-fee proposals (modules/delivery-fee-proposals).
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no framework).
 * DB-free.
 *
 * What is worth testing without a database, and why:
 *
 *   1. **Who may propose.** The agency always; the agent only while holding the accepted
 *      offer AND only when the agency opted in. Getting the second half backwards lets every
 *      agent re-price their own jobs.
 *   2. **The window and the caps.** Before pickup only; one pending; two non-withdrawn.
 *   3. **The ceiling.** vendorNet > 0 on the split's unit — and NOT the 30% cap, which the
 *      owner explicitly lifted for a negotiated fee.
 *   4. **Money application.** `planFeeApplication` is the whole decision of what an
 *      approval writes; every branch is pinned.
 *   5. **The override outranks the formula** in `computeShipmentDeliveryFee` — the one
 *      function every split and quote calls.
 *   6. **The authority table**, the validators and the DTO's vendor-only money block.
 *   7. **Source scans** for the wiring nothing behavioural can see without Mongo: the pickup
 *      gate in the SHARED transition core and its CAS filter, the decline / detach hooks,
 *      the array-form create, and the migration ↔ model index names.
 *
 * NOT covered (needs a replica set): the transactions themselves, the partial unique index
 * binding, and the allocation compare-and-set under a race.
 *
 * Run: npm run test:delivery-fee-proposals
 */
import { readFileSync } from 'fs';
import path from 'path';
import {
  COUNTED_PROPOSAL_STATUSES,
  DELIVERY_FEE_PROPOSAL_WINDOW,
  MAX_NON_WITHDRAWN_PROPOSALS,
  checkCreation,
  checkProposer,
  checkVendorNet,
  codShipmentVendorNet,
  isInProposalWindow,
  planFeeApplication,
  prepaidOrderVendorNet,
  resolveAvailableActions,
  splitOrderVendorNetAfter,
  checkEdit,
  checkVendorVersion,
} from '../../src/modules/delivery-fee-proposals/domain/delivery-fee-proposal.rules';
import {
  CreateDeliveryFeeProposalSchema,
  RejectDeliveryFeeProposalSchema,
  ApproveDeliveryFeeProposalSchema,
  EditDeliveryFeeProposalSchema,
  VendorProposalQuerySchema,
} from '../../src/modules/delivery-fee-proposals/validators/delivery-fee-proposal.validator';
import {
  shipmentFeeProposalSummary,
  toDeliveryFeeProposalDto,
} from '../../src/modules/delivery-fee-proposals/dto/delivery-fee-proposal.dto';
import { IDeliveryFeeProposal } from '../../src/modules/delivery-fee-proposals/models/delivery-fee-proposal.model';
import { UpdateAssignmentSettingsSchema } from '../../src/modules/shipment-assignment/validators/assignment.validator';
import {
  EarningsQuoteService,
  approvedDeliveryFeeOf,
} from '../../src/modules/earnings/services/earnings-quote.service';
import { evaluateDeliveryCostCap } from '../../src/modules/earnings/services/delivery-cost-cap';
import { ERROR_CODES } from '../../src/core/error-codes';
import { DEFAULT_ERROR_MESSAGES } from '../../src/core/errors';
import { ShipmentStatus } from '../../src/modules/shipments/shipment.model';

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

function section(title: string): void {
  console.log(`\n${title}`);
}

const ROOT = path.resolve(__dirname, '..', '..');
const src = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

const AGENT = '507f1f77bcf86cd799439081';
const OTHER_AGENT = '507f1f77bcf86cd799439082';
const AT = new Date('2026-10-02T09:00:00.000Z');

function proposalDoc(overrides: Record<string, unknown> = {}): IDeliveryFeeProposal {
  return {
    _id: '507f1f77bcf86cd799439091',
    shipment_id: '507f1f77bcf86cd799439011',
    order_id: '507f1f77bcf86cd799439012',
    vendor_id: '507f1f77bcf86cd799439013',
    agency_id: '507f1f77bcf86cd799439014',
    proposed_by_role: 'agency',
    proposed_by_user_id: '507f1f77bcf86cd799439015',
    proposed_by_agent_id: null,
    payment_method: 'online',
    currency: 'XAF',
    fee_before: 1500,
    proposed_fee: 2500,
    reason: 'Bulky parcel',
    status: 'pending',
    responded_by_role: null,
    responded_by_user_id: null,
    responded_at: null,
    rejection_note: null,
    withdrawal_reason: null,
    application: null,
    status_history: [],
    created_at: AT,
    updated_at: AT,
    ...overrides,
  } as unknown as IDeliveryFeeProposal;
}

function main(): void {
  // ───────────────────────────────────────────────────────────────────────────
  section('1. The window — before pickup only');

  const inside: ShipmentStatus[] = ['assigned', 'handing_over'];
  const outside: ShipmentStatus[] = [
    'pending',
    'pending_agency_reassignment',
    'picked_up',
    'in_transit',
    'agent_delivered',
    'delivered',
    'failed',
    'returned',
    'rejected',
  ];
  assert('the window is exactly assigned + handing_over', () =>
    DELIVERY_FEE_PROPOSAL_WINDOW.length === 2 && inside.every(isInProposalWindow));
  for (const s of outside) {
    assert(`${s} is outside the window`, () => !isInProposalWindow(s));
  }

  // ───────────────────────────────────────────────────────────────────────────
  section('2. Who may propose');

  assert('the agency always may — setting off, no agent', () =>
    checkProposer({ role: 'agency', agentsMayPropose: false, shipmentAgentId: null }) === null);
  assert('an agent NOT holding the accepted offer is refused (as not-found)', () =>
    checkProposer({ role: 'agent', agentsMayPropose: true, shipmentAgentId: OTHER_AGENT, actorAgentId: AGENT })?.code
      === 'agent_not_on_shipment');
  assert('an agent on an unbound shipment is refused', () =>
    checkProposer({ role: 'agent', agentsMayPropose: true, shipmentAgentId: null, actorAgentId: AGENT })?.code
      === 'agent_not_on_shipment');
  assert('the bound agent is refused while the agency has NOT opted in', () =>
    checkProposer({ role: 'agent', agentsMayPropose: false, shipmentAgentId: AGENT, actorAgentId: AGENT })?.code
      === 'agents_not_allowed');
  assert('the bound agent may propose once the agency opted in', () =>
    checkProposer({ role: 'agent', agentsMayPropose: true, shipmentAgentId: AGENT, actorAgentId: AGENT }) === null);

  // ───────────────────────────────────────────────────────────────────────────
  section('3. Creation rules — pending, caps, fee value');

  const base = { shipmentStatus: 'assigned' as ShipmentStatus, pendingProposalId: null, countedProposals: 0, proposedFee: 2000, currentFee: 1500 };
  assert('a clean proposal passes', () => checkCreation(base) === null);
  assert('outside the window → window_closed (reported first)', () =>
    checkCreation({ ...base, shipmentStatus: 'picked_up', pendingProposalId: 'x' })?.code === 'window_closed');
  assert('a pending proposal → already_pending, with its id', () => {
    const r = checkCreation({ ...base, pendingProposalId: 'abc' });
    return r?.code === 'already_pending' && r.proposalId === 'abc';
  });
  assert(`MAX_NON_WITHDRAWN_PROPOSALS is 2 (one more after a rejection)`, () => MAX_NON_WITHDRAWN_PROPOSALS === 2);
  assert('one counted proposal (e.g. rejected) still allows ONE more', () =>
    checkCreation({ ...base, countedProposals: 1 }) === null);
  assert('two counted proposals → limit_reached', () =>
    checkCreation({ ...base, countedProposals: 2 })?.code === 'limit_reached');
  assert('withdrawn proposals do not count', () =>
    !COUNTED_PROPOSAL_STATUSES.includes('withdrawn') && COUNTED_PROPOSAL_STATUSES.length === 3);
  assert('a fractional fee is refused', () => checkCreation({ ...base, proposedFee: 1500.5 })?.code === 'invalid_fee');
  assert('a negative fee is refused', () => checkCreation({ ...base, proposedFee: -1 })?.code === 'invalid_fee');
  assert('a zero fee is allowed (an agency may waive it)', () => checkCreation({ ...base, proposedFee: 0 }) === null);
  assert('the same fee → no_change, with the current fee', () => {
    const r = checkCreation({ ...base, proposedFee: 1500 });
    return r?.code === 'no_change' && r.currentFee === 1500;
  });
  assert('a DECREASE is a proposal like any other', () => checkCreation({ ...base, proposedFee: 1000 }) === null);

  // ───────────────────────────────────────────────────────────────────────────
  section('4. The ceiling — vendorNet > 0, and NOT the 30% cap');

  // COD shipment: 10 000 cash, 10% commission, fixed COD fee 500.
  const codNet = (fee: number) =>
    codShipmentVendorNet({
      shipmentGross: 10_000,
      aiMargin: 0,
      commissionPercent: 10,
      fee,
      codHandling: { type: 'fixed', value: 500 } as any,
    });
  assert('COD: net = gross − commission − fee − COD fee', () => codNet(2000) === 10_000 - 1000 - 2000 - 500);
  assert('COD: a 50% fee passes the ceiling although the 30% cap would refuse it', () => {
    const cap = evaluateDeliveryCostCap({ subtotal: 10_000, commissionPercent: 10, deliveryFee: 5000, codHandling: { type: 'fixed', value: 500 } as any });
    return !cap.met && checkVendorNet(codNet(5000)) === null;
  });
  assert('COD: a fee leaving exactly 0 is refused', () => checkVendorNet(codNet(8500))?.code === 'vendor_net_not_positive');
  assert('COD: a fee leaving 1 passes', () => codNet(8499) === 1 && checkVendorNet(codNet(8499)) === null);
  assert('COD: a percentage COD fee is counted', () =>
    codShipmentVendorNet({ shipmentGross: 10_000, aiMargin: 0, commissionPercent: 0, fee: 0, codHandling: { type: 'percentage', value: 5 } as any }) === 9500);
  assert('COD: the AI margin comes off before commission (as the split does)', () =>
    codShipmentVendorNet({ shipmentGross: 10_000, aiMargin: 1000, commissionPercent: 10, fee: 0, codHandling: null }) === 9000 - 900);

  assert('prepaid, unsplit: sibling fees count against the same order net', () =>
    prepaidOrderVendorNet({ orderGross: 20_000, aiMargin: 0, commissionPercent: 10, otherShipmentsFees: 3000, fee: 2000 })
      === 20_000 - 2000 - 3000 - 2000);
  assert('prepaid, split: the allocation moves by (charged − fee)', () =>
    splitOrderVendorNetAfter({ vendorAllocation: 8000, chargedFee: 1500, fee: 2500 }) === 7000
    && splitOrderVendorNetAfter({ vendorAllocation: 8000, chargedFee: 1500, fee: 500 }) === 9000);
  assert('prepaid, split: an increase eating the whole allocation is refused', () =>
    checkVendorNet(splitOrderVendorNetAfter({ vendorAllocation: 1000, chargedFee: 1500, fee: 2500 }))?.code
      === 'vendor_net_not_positive');

  // ───────────────────────────────────────────────────────────────────────────
  section('5. Money application on approval — every branch');

  const held = (amount: number) => ({ amount, status: 'held' as const });
  assert('COD: override only — no snapshot rewrite, no allocation touched', () => {
    const p = planFeeApplication({ isCod: true, snapshot: null, vendorAllocation: null, orderSplit: false, newFee: 3000 });
    return p.ok && !p.rewriteSnapshot && p.allocationDelta === 0;
  });
  assert('prepaid, not split yet (no snapshot): override only — splitOrder charges it', () => {
    const p = planFeeApplication({ isCod: false, snapshot: null, vendorAllocation: null, orderSplit: false, newFee: 3000 });
    return p.ok && !p.rewriteSnapshot && p.allocationDelta === 0;
  });
  assert('prepaid, half-split (snapshot, no allocation at all): rewrite snapshot, no delta', () => {
    const p = planFeeApplication({ isCod: false, snapshot: 1500, vendorAllocation: null, orderSplit: false, newFee: 3000 });
    return p.ok && p.rewriteSnapshot && p.allocationDelta === 0 && p.allocationAfter === null;
  });
  assert('prepaid, split, fee DECREASE: vendor allocation grows by the delta', () => {
    const p = planFeeApplication({ isCod: false, snapshot: 1500, vendorAllocation: held(8000), orderSplit: true, newFee: 1000 });
    return p.ok && p.rewriteSnapshot && p.allocationDelta === 500 && p.allocationAfter === 8500;
  });
  assert('prepaid, split, fee INCREASE: vendor allocation shrinks by the delta', () => {
    const p = planFeeApplication({ isCod: false, snapshot: 1500, vendorAllocation: held(8000), orderSplit: true, newFee: 2500 });
    return p.ok && p.allocationDelta === -1000 && p.allocationAfter === 7000;
  });
  assert('prepaid, split: an increase leaving the allocation at 0 is refused', () => {
    const p = planFeeApplication({ isCod: false, snapshot: 1500, vendorAllocation: held(1000), orderSplit: true, newFee: 2500 });
    return !p.ok && p.reason === 'vendor_net_not_positive';
  });
  assert('prepaid, split: a RELEASED allocation is never re-priced', () => {
    const p = planFeeApplication({ isCod: false, snapshot: 1500, vendorAllocation: { amount: 8000, status: 'released' }, orderSplit: true, newFee: 1000 });
    return !p.ok && p.reason === 'allocation_not_held';
  });
  assert('prepaid, split with NO vendor row: refused rather than inventing one', () => {
    const p = planFeeApplication({ isCod: false, snapshot: 1500, vendorAllocation: null, orderSplit: true, newFee: 1000 });
    return !p.ok && p.reason === 'vendor_net_not_positive';
  });
  assert('the plan reconciles: after = before + (snapshot − newFee)', () => {
    const p = planFeeApplication({ isCod: false, snapshot: 1200, vendorAllocation: held(5000), orderSplit: true, newFee: 2000 });
    return p.ok && p.allocationAfter === 5000 + (1200 - 2000);
  });

  // ───────────────────────────────────────────────────────────────────────────
  section('6. The override outranks the formula');

  const quotes = new EarningsQuoteService();
  const policies = {
    pricing: {
      pickup_based: { base_rate_first_kg: 1500, additional_per_kg: 300 },
      storage_based: { local_delivery_fee: 0, pick_pack_fee_per_order: 0 },
      additional_fees: {},
    },
  } as any;
  const itemId = '507f1f77bcf86cd7994390a1';
  const orderItems = new Map([[itemId, { delivery: { pickup_location: { source: 'vendor_address' } } } as any]]);
  const shipmentWith = (override: unknown) =>
    ({ _id: 's', agency_id: 'a', items: [{ order_item_id: itemId, quantity: 1 }], delivery_fee_override: override }) as any;

  assert('no override → the formula (flat pickup rate, per-kg unused)', () =>
    quotes.computeShipmentDeliveryFee(shipmentWith(null), policies, orderItems, 'o') === 1500);
  assert('an approved override → the override', () =>
    quotes.computeShipmentDeliveryFee(shipmentWith({ amount: 4200 }), policies, orderItems, 'o') === 4200);
  assert('an approved override of 0 is honoured (not treated as absent)', () =>
    quotes.computeShipmentDeliveryFee(shipmentWith({ amount: 0 }), policies, orderItems, 'o') === 0);
  assert('the override needs no agency policy', () =>
    quotes.computeShipmentDeliveryFee(shipmentWith({ amount: 900 }), null, orderItems, 'o') === 900);
  assert('approvedDeliveryFeeOf: absent / null / garbage → null', () =>
    approvedDeliveryFeeOf({} as any) === null
    && approvedDeliveryFeeOf({ delivery_fee_override: null } as any) === null
    && approvedDeliveryFeeOf({ delivery_fee_override: { amount: -5 } } as any) === null);

  // ───────────────────────────────────────────────────────────────────────────
  section('7. The authority table');

  const pending = { status: 'pending' as const, proposed_by_role: 'agent' as const, proposed_by_agent_id: AGENT };
  assert('vendor → approve + reject', () => {
    const a = resolveAvailableActions(pending, { role: 'vendor' });
    return a.length === 2 && a.includes('approve') && a.includes('reject');
  });
  assert('agency → withdraw + edit (its agent\'s proposal too)', () =>
    JSON.stringify(resolveAvailableActions(pending, { role: 'agency' })) === '["withdraw","edit"]');
  assert('the proposing agent → withdraw + edit', () =>
    JSON.stringify(resolveAvailableActions(pending, { role: 'agent', agentId: AGENT })) === '["withdraw","edit"]');
  assert('the proposing agent loses EDIT when the agency preference is off (keeps withdraw)', () =>
    JSON.stringify(resolveAvailableActions(pending, { role: 'agent', agentId: AGENT, agentsMayPropose: false })) === '["withdraw"]');
  assert('once the AGENCY edited it, the agent can neither edit nor withdraw (agency-owned)', () =>
    resolveAvailableActions({ ...pending, agency_edited: true }, { role: 'agent', agentId: AGENT }).length === 0);
  assert('…and the agency still can', () =>
    JSON.stringify(resolveAvailableActions({ ...pending, agency_edited: true }, { role: 'agency' })) === '["withdraw","edit"]');
  assert('the vendor never gets edit', () => !resolveAvailableActions(pending, { role: 'vendor' }).includes('edit'));
  assert('another agent → nothing', () => resolveAvailableActions(pending, { role: 'agent', agentId: OTHER_AGENT }).length === 0);
  assert('an agent cannot withdraw the AGENCY\'s proposal', () =>
    resolveAvailableActions({ ...pending, proposed_by_role: 'agency', proposed_by_agent_id: null }, { role: 'agent', agentId: AGENT }).length === 0);
  assert('neither proposer can approve their own', () =>
    !resolveAvailableActions(pending, { role: 'agency' }).includes('approve'));
  for (const s of ['approved', 'rejected', 'withdrawn'] as const) {
    assert(`a ${s} proposal offers no verb to anyone`, () =>
      resolveAvailableActions({ ...pending, status: s }, { role: 'vendor' }).length === 0);
  }

  // ───────────────────────────────────────────────────────────────────────────
  section('8. Validators');

  assert('create: integer fee + reason passes', () =>
    CreateDeliveryFeeProposalSchema.safeParse({ proposedFee: 2500, reason: 'Bulky parcel' }).success);
  assert('create: a fractional fee is a 400', () =>
    !CreateDeliveryFeeProposalSchema.safeParse({ proposedFee: 2500.5, reason: 'Bulky parcel' }).success);
  assert('create: a negative fee is a 400', () =>
    !CreateDeliveryFeeProposalSchema.safeParse({ proposedFee: -1, reason: 'Bulky parcel' }).success);
  assert('create: reason is REQUIRED', () => !CreateDeliveryFeeProposalSchema.safeParse({ proposedFee: 2500 }).success);
  assert('create: a blank reason is refused', () =>
    !CreateDeliveryFeeProposalSchema.safeParse({ proposedFee: 2500, reason: '   ' }).success);
  assert('create: strict — an unknown key is refused', () =>
    !CreateDeliveryFeeProposalSchema.safeParse({ proposedFee: 2500, reason: 'Bulky parcel', agentId: 'x' }).success);
  assert('reject: the note is optional, the seen VERSION is required', () =>
    RejectDeliveryFeeProposalSchema.safeParse({ version: 1 }).success
    && RejectDeliveryFeeProposalSchema.safeParse({ note: 'Too high', version: 2 }).success
    && !RejectDeliveryFeeProposalSchema.safeParse({ note: 'Too high' }).success);
  assert('approve: the seen VERSION is required (a vendor never approves an unseen figure)', () =>
    ApproveDeliveryFeeProposalSchema.safeParse({ version: 3 }).success
    && !ApproveDeliveryFeeProposalSchema.safeParse({}).success
    && !ApproveDeliveryFeeProposalSchema.safeParse({ version: 0 }).success);
  assert('edit: fee alone, reason alone, or both', () =>
    EditDeliveryFeeProposalSchema.safeParse({ proposedFee: 3000 }).success
    && EditDeliveryFeeProposalSchema.safeParse({ reason: 'Longer route now' }).success
    && EditDeliveryFeeProposalSchema.safeParse({ proposedFee: 3000, reason: 'Longer route now', version: 2 }).success);
  assert('edit: an empty body (or version only) is refused', () =>
    !EditDeliveryFeeProposalSchema.safeParse({}).success && !EditDeliveryFeeProposalSchema.safeParse({ version: 2 }).success);
  assert('edit: fractional / negative fee and unknown keys are refused', () =>
    !EditDeliveryFeeProposalSchema.safeParse({ proposedFee: 1.5 }).success
    && !EditDeliveryFeeProposalSchema.safeParse({ proposedFee: -1 }).success
    && !EditDeliveryFeeProposalSchema.safeParse({ proposedFee: 1, status: 'approved' }).success);
  assert('vendor list: unknown status refused, limit capped', () =>
    !VendorProposalQuerySchema.safeParse({ status: 'cancelled' }).success
    && !VendorProposalQuerySchema.safeParse({ limit: '500' }).success);
  assert('assignment settings: either toggle alone is accepted', () =>
    UpdateAssignmentSettingsSchema.safeParse({ autoAssignEnabled: true }).success
    && UpdateAssignmentSettingsSchema.safeParse({ agentsCanProposeDeliveryFee: true }).success);
  assert('assignment settings: an empty body is refused', () => !UpdateAssignmentSettingsSchema.safeParse({}).success);

  // ───────────────────────────────────────────────────────────────────────────
  section('9. DTOs');

  const approvedDoc = proposalDoc({
    status: 'approved',
    responded_by_role: 'vendor',
    responded_at: AT,
    application: { fee_at_apply: 1500, vendor_allocation_before: 8000, vendor_allocation_after: 7000, snapshot_rewritten: true },
  });
  assert('the vendor sees what the approval did to their money', () =>
    toDeliveryFeeProposalDto(approvedDoc, { role: 'vendor' }).application?.vendorAllocationAfter === 7000);
  assert('the agency does NOT see the vendor\'s allocation', () =>
    !('application' in toDeliveryFeeProposalDto(approvedDoc, { role: 'agency' })));
  assert('the agent does NOT see the vendor\'s allocation', () =>
    !JSON.stringify(toDeliveryFeeProposalDto(approvedDoc, { role: 'agent', agentId: AGENT })).includes('8000'));
  assert('the DTO carries availableActions for its viewer', () =>
    JSON.stringify(toDeliveryFeeProposalDto(proposalDoc(), { role: 'vendor' }).availableActions) === '["approve","reject"]');
  assert('shipment summary: nothing pending, no override', () => {
    const s = shipmentFeeProposalSummary({ pending_delivery_fee_proposal_id: null, delivery_fee_override: null } as any);
    return s.deliveryFeeProposalPending === false && s.deliveryFeeOverride === null;
  });
  assert('shipment summary: pending + override surface', () => {
    const s = shipmentFeeProposalSummary({
      pending_delivery_fee_proposal_id: 'p1',
      delivery_fee_override: { amount: 2500, proposal_id: 'p0', approved_at: AT },
    } as any);
    return s.deliveryFeeProposalPending && s.pendingDeliveryFeeProposalId === 'p1' && s.deliveryFeeOverride?.amount === 2500;
  });

  // ───────────────────────────────────────────────────────────────────────────
  section('10. Error codes — registered, with a message');

  const codes = [
    'DELIVERY_FEE_PROPOSAL_NOT_FOUND',
    'DELIVERY_FEE_PROPOSAL_ALREADY_PENDING',
    'DELIVERY_FEE_PROPOSAL_NOT_PENDING',
    'DELIVERY_FEE_PROPOSAL_WINDOW_CLOSED',
    'DELIVERY_FEE_PROPOSAL_AGENTS_NOT_ALLOWED',
    'DELIVERY_FEE_PROPOSAL_LIMIT_REACHED',
    'DELIVERY_FEE_PROPOSAL_NO_CHANGE',
    'DELIVERY_FEE_PROPOSAL_VENDOR_NET_NOT_POSITIVE',
    'DELIVERY_FEE_PROPOSAL_NOT_YOURS',
    'DELIVERY_FEE_PROPOSAL_STALE',
    'DELIVERY_FEE_PROPOSAL_SETTLEMENT_CONFLICT',
    'DELIVERY_FEE_PROPOSAL_VERSION_MISMATCH',
    'SHIPMENT_DELIVERY_FEE_PENDING',
  ];
  for (const code of codes) {
    assert(`${code} exists and has a default message`, () =>
      (ERROR_CODES as Record<string, string>)[code] === code && !!(DEFAULT_ERROR_MESSAGES as Record<string, string>)[code]);
  }

  // ───────────────────────────────────────────────────────────────────────────
  section('11. Source scans — the wiring');

  const shipmentService = src('src/modules/shipments/shipment.service.ts');
  const transitionCore = shipmentService.slice(
    shipmentService.indexOf('private async _transitionStatus('),
    shipmentService.indexOf('await transactionManager.runInTransactionWithRetry', shipmentService.indexOf('private async _transitionStatus(')) + 2000
  );
  assert('the pickup gate lives in the SHARED transition core (both doors)', () =>
    transitionCore.includes('SHIPMENT_DELIVERY_FEE_PENDING') && transitionCore.includes("newStatus === 'picked_up' && shipment.pending_delivery_fee_proposal_id"));
  assert('the transition CAS carries the pointer guard on pickup', () =>
    transitionCore.includes("requireNoPendingDeliveryFeeProposal: newStatus === 'picked_up'"));
  const repo = src('src/modules/shipments/shipment.repository.ts');
  assert('the repository folds the guard into the CAS FILTER', () =>
    /if \(input\.requireNoPendingDeliveryFeeProposal\) filter\.pending_delivery_fee_proposal_id = null;/.test(repo));

  const rejectBody = shipmentService.slice(shipmentService.indexOf('async reject(agencyId'), shipmentService.indexOf('private async _emitShipmentRejected'));
  assert('decline withdraws the pending proposal inside the reject transaction', () =>
    rejectBody.includes("withdrawPendingInSession(rejected, 'shipment_declined', session)"));
  assert('decline cancels a bound agent\'s pending COD code', () =>
    rejectBody.includes('cancelPendingByShipment(shipmentId, session)'));
  assert('both agent-detach paths withdraw the detached agent\'s proposal', () =>
    (shipmentService.match(/withdrawPendingInSession\(detached, 'agent_detached', session/g) ?? []).length === 2);

  const proposalRepo = src('src/modules/delivery-fee-proposals/repositories/delivery-fee-proposal.repository.ts');
  assert('proposal create uses the ARRAY form (else it writes outside the session)', () =>
    proposalRepo.includes('DeliveryFeeProposalModel.create([doc], { session })'));

  const quote = src('src/modules/earnings/services/earnings-quote.service.ts');
  const feeFn = quote.slice(quote.indexOf('  computeShipmentDeliveryFee('), quote.indexOf('if (!policies) {', quote.indexOf('  computeShipmentDeliveryFee(')));
  assert('the override is read BEFORE the policy fallback', () => feeFn.includes('approvedDeliveryFeeOf(shipment)'));

  const model = src('src/modules/delivery-fee-proposals/models/delivery-fee-proposal.model.ts');
  const migration = src('scripts/migrate-delivery-fee-proposal-indexes.ts');
  const names = [...model.matchAll(/name: '(delivery_fee_proposal_[a-z_]+)'/g)].map((m) => m[1]);
  assert(`the model declares 4 named indexes (found ${names.length})`, () => names.length === 4);
  assert('the migration builds every one the model declares, by name', () => names.every((n) => migration.includes(`'${n}'`)));
  assert('the migration is in the ledger registry', () =>
    src('scripts/migrate.ts').includes("name: 'migrate:delivery-fee-proposal-indexes'"));
  assert('the migration keeps its require.main guard', () => migration.includes('if (require.main === module)'));

  // ───────────────────────────────────────────────────────────────────────────
  section('12. Editing a pending proposal — still ONE request, versioned');

  const editBase = { currentVersion: 2, proposedFee: 2500, reason: 'Bulky parcel', shipmentCurrentFee: 1500 };
  assert('a fee change passes', () => checkEdit({ ...editBase, newFee: 3000 }) === null);
  assert('a reason-only change passes', () => checkEdit({ ...editBase, newReason: 'Two parcels, not one' }) === null);
  assert('an edit changing nothing → no_change', () =>
    checkEdit({ ...editBase, newFee: 2500, newReason: 'Bulky parcel' })?.code === 'no_change'
    && checkEdit(editBase)?.code === 'no_change');
  assert('setting the fee back to the shipment\'s current fee is refused (that is a withdrawal)', () =>
    checkEdit({ ...editBase, newFee: 1500 })?.code === 'same_as_current');
  assert('a fractional / negative fee is refused', () =>
    checkEdit({ ...editBase, newFee: 10.5 })?.code === 'invalid_fee' && checkEdit({ ...editBase, newFee: -2 })?.code === 'invalid_fee');
  assert('a stale optional version on edit → version_mismatch, with the current one', () => {
    const r = checkEdit({ ...editBase, expectedVersion: 1, newFee: 3000 });
    return r?.code === 'version_mismatch' && r.currentVersion === 2;
  });
  assert('no version on edit → not checked (the CAS still is)', () => checkEdit({ ...editBase, newFee: 3000 }) === null);
  assert('vendor: the version seen must equal the current one', () =>
    checkVendorVersion(3, 3) === null && checkVendorVersion(2, 3)?.code === 'version_mismatch');

  const editedDoc = proposalDoc({
    proposed_by_role: 'agent',
    proposed_by_agent_id: AGENT,
    version: 2,
    agency_edited: true,
    edits: [{
      edited_by_role: 'agency', edited_by_user_id: '507f1f77bcf86cd799439015', edited_by_agent_id: null,
      fee_before: 2500, fee_after: 2200, reason_before: 'Bulky parcel', reason_after: 'Bulky, agreed lower',
      version: 2, at: AT,
    }],
    last_edited_by: { role: 'agency', user_id: '507f1f77bcf86cd799439015', agent_id: null, at: AT },
  });
  const edDto = toDeliveryFeeProposalDto(editedDoc, { role: 'vendor' });
  assert('DTO exposes version, edits[], lastEditedBy, agencyEdited', () =>
    edDto.version === 2 && edDto.edits.length === 1 && edDto.edits[0].feeAfter === 2200
    && edDto.edits[0].editedBy.role === 'agency' && edDto.lastEditedBy?.role === 'agency' && edDto.agencyEdited === true);
  assert('a never-edited (legacy) row reads version 1, no edits', () => {
    const d = toDeliveryFeeProposalDto(proposalDoc({ version: undefined, edits: undefined }), { role: 'agency' });
    return d.version === 1 && d.edits.length === 0 && d.lastEditedBy === null && d.agencyEdited === false;
  });
  assert('DTO: the agent who proposed it gets no verbs once the agency edited it', () =>
    toDeliveryFeeProposalDto(editedDoc, { role: 'agent', agentId: AGENT }).availableActions.length === 0);

  const svc = src('src/modules/delivery-fee-proposals/services/delivery-fee-proposal.service.ts');
  const repoSrc = src('src/modules/delivery-fee-proposals/repositories/delivery-fee-proposal.repository.ts');
  assert('the edit CAS keys on status pending AND the version read', () =>
    repoSrc.includes("{ _id: proposalId, status: 'pending', version: expectedVersion }"));
  assert('an edit creates NO new proposal document (no create() in edit)', () => {
    const body = svc.slice(svc.indexOf('  async edit('), svc.indexOf('// ── Vendor: approve / reject'));
    return body.length > 0 && !body.includes('this.proposals.create(') && body.includes('applyEdit(');
  });
  assert('approve AND reject carry the seen version into their CAS scope', () =>
    (svc.match(/scope: \{ vendor_id: new Types\.ObjectId\(vendorId\), version: seenVersion \}/g) ?? []).length === 2);
  assert('an agency edit makes it agency-owned: the detach auto-withdraw skips agency_edited', () =>
    svc.includes("agency_edited: { $ne: true },") && repoSrc.includes("{ agency_edited: true }"));
  assert('the edit publishes delivery_fee_proposal.edited', () => svc.includes("this.emit('delivery_fee_proposal.edited'"));
  const agencyRoutes = src('src/modules/delivery/agency.routes.ts');
  const agentRoutes = src('src/modules/delivery/agent.routes.ts');
  assert('PATCH edit routes exist for agency and agent', () =>
    agencyRoutes.includes("router.patch('/shipments/:id/delivery-fee-proposals/:proposalId', AgencyDeliveryFeeProposalController.edit)")
    && agentRoutes.includes("router.patch('/shipments/:id/delivery-fee-proposals/:proposalId', AgentDeliveryFeeProposalController.edit)"));

  console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main();
