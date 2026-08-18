/**
 * Test: agent-driven shipment status transitions
 * (POST /api/agent/shipments/:id/status).
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no
 * framework). DB-free: the transition maps, the failure-reason enum, the Zod
 * schema and the notification catalog's completeness assert are all pure.
 *
 * Importing ShipmentService for the maps pulls in a large module graph and
 * registers Mongoose models (safe with no connection), so this doubles as a
 * require-cycle smoke test for the shipments module.
 *
 * Run: npx ts-node scripts/test/test-agent-shipment-status.ts
 */
import { ZodError } from 'zod';
import {
  TRIGGERABLE_TRANSITIONS,
  AGENT_TRANSITIONS_NOTIFYING_AGENCY,
} from '../../src/modules/shipments/shipment.service';
import { AgentUpdateShipmentStatusSchema } from '../../src/modules/shipments/shipment.validator';
import {
  SHIPMENT_FAILURE_REASONS,
  AGENT_CANCELLATION_REASONS,
  ShipmentStatus,
} from '../../src/modules/shipments/shipment.model';
import { assertAgencyCatalogComplete } from '../../src/modules/notifications/catalog/agency-notification-catalog';
import { shipmentStatusToAction } from '../../src/modules/tracking-integration/services/agent-action-audit.service';

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

/** True when `arr` holds exactly `expected`, order-insensitively. */
function sameSet(arr: readonly string[] | undefined, expected: string[]): boolean {
  if (!arr) return false;
  return arr.length === expected.length && expected.every((e) => arr.includes(e));
}

function parses(body: unknown): boolean {
  try {
    AgentUpdateShipmentStatusSchema.parse(body);
    return true;
  } catch {
    return false;
  }
}

function rejects(body: unknown): boolean {
  try {
    AgentUpdateShipmentStatusSchema.parse(body);
    return false;
  } catch (err) {
    return err instanceof ZodError;
  }
}

function main(): void {
  console.log('\n▶ The transition map — shared by the agency and the agent');

  assert('assigned → picked_up', () => sameSet(TRIGGERABLE_TRANSITIONS.assigned, ['picked_up']));
  assert('picked_up → in_transit', () => sameSet(TRIGGERABLE_TRANSITIONS.picked_up, ['in_transit']));
  assert('in_transit → agent_delivered | failed', () =>
    sameSet(TRIGGERABLE_TRANSITIONS.in_transit, ['agent_delivered', 'failed']));
  assert('agent_delivered → failed', () => sameSet(TRIGGERABLE_TRANSITIONS.agent_delivered, ['failed']));
  assert('failed → in_transit | returned', () =>
    sameSet(TRIGGERABLE_TRANSITIONS.failed, ['in_transit', 'returned']));

  // A reassigned shipment is not a second-class one: the replacement agent
  // records their own pickup out of `handing_over` exactly as the original agent
  // does out of `assigned`. Acceptance binds agent_id while the status is still
  // `handing_over`, which is what makes this reachable from the agent endpoint.
  assert('handing_over → picked_up | returned (reassignment parity)', () =>
    sameSet(TRIGGERABLE_TRANSITIONS.handing_over, ['picked_up', 'returned']));

  assert('exactly six triggerable sources', () =>
    sameSet(Object.keys(TRIGGERABLE_TRANSITIONS), [
      'assigned', 'picked_up', 'in_transit', 'agent_delivered', 'failed', 'handing_over',
    ]));

  // The system-only statuses must never become directly settable. `delivered` in
  // particular: on COD it would leave an order delivered, completed, and that
  // nobody is ever paid for.
  assert('no path to delivered / rejected / pending_agency_reassignment / assigned', () => {
    const targets = new Set<string>();
    Object.values(TRIGGERABLE_TRANSITIONS).forEach((v) => v?.forEach((s) => targets.add(s)));
    return !['delivered', 'rejected', 'pending_agency_reassignment', 'assigned', 'pending'].some((s) =>
      targets.has(s));
  });

  console.log('\n▶ Schema ↔ map drift guard');

  // A future edit to the map that forgets the schema (or vice versa) fails here.
  assert('schema status literals === the union of the map targets', () => {
    const targets = new Set<string>();
    Object.values(TRIGGERABLE_TRANSITIONS).forEach((v) => v?.forEach((s) => targets.add(s)));
    const accepted = ['picked_up', 'in_transit', 'agent_delivered', 'failed', 'returned'];
    return sameSet([...targets], accepted) && accepted.every((s) => parses({ status: s }));
  });

  console.log('\n▶ Agency-notification trigger set');

  assert('notifies on picked_up / agent_delivered / failed / returned', () =>
    sameSet(AGENT_TRANSITIONS_NOTIFYING_AGENCY, ['picked_up', 'agent_delivered', 'failed', 'returned']));
  assert('in_transit does NOT notify the agency', () =>
    !AGENT_TRANSITIONS_NOTIFYING_AGENCY.includes('in_transit'));
  assert('every notified status is agent-reachable', () => {
    const targets = new Set<string>();
    Object.values(TRIGGERABLE_TRANSITIONS).forEach((v) => v?.forEach((s) => targets.add(s)));
    return AGENT_TRANSITIONS_NOTIFYING_AGENCY.every((s) => targets.has(s));
  });

  console.log('\n▶ Failure reasons stay distinct from cancellation reasons');

  // Reusing AGENT_CANCELLATION_REASONS would invite an agent to strand a parcel
  // at `failed` for a reason whose correct action is cancelling the shipment.
  assert('no agent-incapacity reason leaked into the failure enum', () =>
    !['vehicle_breakdown', 'personal_emergency', 'too_far', 'safety_concern'].some((r) =>
      (SHIPMENT_FAILURE_REASONS as string[]).includes(r)));
  assert('the two enums are not the same list', () =>
    !sameSet(SHIPMENT_FAILURE_REASONS, AGENT_CANCELLATION_REASONS as unknown as string[]));
  assert('every failure reason parses', () =>
    SHIPMENT_FAILURE_REASONS.every((r) => parses({ status: 'failed', reason: r, note: 'x' })));

  console.log('\n▶ Zod schema');

  assert('{status:failed} parses — reason is optional', () => parses({ status: 'failed' }));
  assert('{status:returned, reason} parses', () =>
    parses({ status: 'returned', reason: 'customer_refused' }));
  assert("reason 'other' without a note is rejected", () =>
    rejects({ status: 'failed', reason: 'other' }));
  assert("reason 'other' with a whitespace-only note is rejected (post-trim)", () =>
    rejects({ status: 'failed', reason: 'other', note: '   ' }));
  assert("reason 'other' with a note parses", () =>
    parses({ status: 'failed', reason: 'other', note: 'gate locked' }));
  assert('a reason on picked_up is rejected', () =>
    rejects({ status: 'picked_up', reason: 'customer_refused' }));
  assert('a note on in_transit is rejected', () =>
    rejects({ status: 'in_transit', note: 'running late' }));
  assert('a 201-character note is rejected', () =>
    rejects({ status: 'failed', reason: 'customer_absent', note: 'x'.repeat(201) }));
  assert('a 200-character note parses', () =>
    parses({ status: 'failed', reason: 'customer_absent', note: 'x'.repeat(200) }));
  assert('an unknown status is rejected', () => rejects({ status: 'delivered' }));
  assert('an unknown reason is rejected', () =>
    rejects({ status: 'failed', reason: 'ran_out_of_fuel', note: 'x' }));

  console.log('\n▶ Agent-action audit mapping used by the controller');

  assert('picked_up → pickup', () => shipmentStatusToAction('picked_up') === 'pickup');
  assert('agent_delivered → delivery', () => shipmentStatusToAction('agent_delivered') === 'delivery');
  assert('returned → return', () => shipmentStatusToAction('returned') === 'return');
  assert('failed → cancel', () => shipmentStatusToAction('failed') === 'cancel');
  // The controller skips the audit entirely for this one — geo-tracker rejects
  // unknown action kinds at its transport boundary.
  assert('in_transit → null (audit skipped)', () => shipmentStatusToAction('in_transit') === null);

  console.log('\n▶ Agency notification catalog — the 5-language fence');

  // The four new situations need base copy in en/fr/pt/es/ar or the consumer
  // throws at boot. This is the only DB-free check for that.
  assert('assertAgencyCatalogComplete() does not throw', () => {
    assertAgencyCatalogComplete();
    return true;
  });

  console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main();
