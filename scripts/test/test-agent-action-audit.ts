/**
 * Test: Agent Action Audit emitter (Phase 6) — the pure mappings jovi-mall uses
 * to describe an agent shipment action before it is pushed to geo-tracker's
 * spatial audit.
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no
 * framework). DB-free: `shipmentStatusToAction` and `outcomeFromError` are pure,
 * and `emit` is exercised against an in-memory outbox fake through the
 * repository seam. Importing the emitter also smoke-tests the module graph for
 * require cycles (it is imported by both a controller and ShipmentService).
 *
 * Run: npx ts-node scripts/test/test-agent-action-audit.ts
 */
import { ZodError, z } from 'zod';
import {
  AgentActionAuditService,
  shipmentStatusToAction,
  outcomeFromError,
} from '../../src/modules/tracking-integration/services/agent-action-audit.service';
import { EnqueueInput } from '../../src/modules/tracking-integration/repositories/tracking-outbox.repository';
import { createAppError } from '../../src/core/errors';
import { ERROR_CODES } from '../../src/core/error-codes';

let passed = 0;
let failed = 0;

function assert(name: string, fn: () => boolean | Promise<boolean>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then((ok) => {
      if (ok) {
        console.log(`  ✅ ${name}`);
        passed++;
      } else {
        console.error(`  ❌ FAIL: ${name}`);
        failed++;
      }
    })
    .catch((err) => {
      console.error(`  ❌ THROW: ${name} — ${(err as Error).message}`);
      failed++;
    });
}

// An in-memory stand-in for the outbox repository — records enqueued rows.
class FakeOutbox {
  rows: EnqueueInput[] = [];
  async enqueue(input: EnqueueInput): Promise<any> {
    this.rows.push(input);
    return input;
  }
}

async function main(): Promise<void> {
  console.log('\n▶ Agent Action Audit — status→action mapping');

  await assert('picked_up → pickup', () => shipmentStatusToAction('picked_up') === 'pickup');
  await assert('agent_delivered → delivery', () => shipmentStatusToAction('agent_delivered') === 'delivery');
  await assert('delivered → delivery', () => shipmentStatusToAction('delivered') === 'delivery');
  await assert('returned → return', () => shipmentStatusToAction('returned') === 'return');
  await assert('failed → cancel', () => shipmentStatusToAction('failed') === 'cancel');
  await assert('rejected → cancel', () => shipmentStatusToAction('rejected') === 'cancel');
  await assert('in_transit → null (not an audited action)', () => shipmentStatusToAction('in_transit') === null);
  await assert('assigned → null', () => shipmentStatusToAction('assigned') === null);
  await assert('pending → null', () => shipmentStatusToAction('pending') === null);

  console.log('\n▶ Agent Action Audit — error → outcome mapping');

  await assert('ZodError → validation_failure', () => {
    let zerr: unknown;
    try {
      z.object({ code: z.string() }).parse({});
    } catch (e) {
      zerr = e;
    }
    return zerr instanceof ZodError && outcomeFromError(zerr) === 'validation_failure';
  });
  await assert('AppError 403 → authorization_failure', () =>
    outcomeFromError(createAppError(ERROR_CODES.AUTH_ROLE_REQUIRED, 403)) === 'authorization_failure');
  await assert('AppError 401 → authorization_failure', () =>
    outcomeFromError(createAppError(ERROR_CODES.AUTH_MISSING_TOKEN, 401)) === 'authorization_failure');
  await assert('AppError 422 → validation_failure', () =>
    outcomeFromError(createAppError(ERROR_CODES.COD_AGENT_NOT_ASSIGNED, 422)) === 'validation_failure');
  await assert('AppError 400 → validation_failure', () =>
    outcomeFromError(createAppError(ERROR_CODES.SHIPMENT_INVALID_STATUS_TRANSITION, 400)) === 'validation_failure');
  await assert('AppError 500 → system_failure', () =>
    outcomeFromError(createAppError(ERROR_CODES.INTERNAL_SERVER_ERROR, 500)) === 'system_failure');
  await assert('plain Error → system_failure', () => outcomeFromError(new Error('boom')) === 'system_failure');

  console.log('\n▶ Agent Action Audit — emit()');

  await assert('emit enqueues an agent.action row with all fields', async () => {
    const outbox = new FakeOutbox();
    const svc = new AgentActionAuditService(outbox as any);
    await svc.emit({ action: 'delivery', outcome: 'success', agentId: 'agent-1', shipmentId: 'ship-1', actorRole: 'agent' });
    const row = outbox.rows[0];
    return (
      outbox.rows.length === 1 &&
      row.type === 'agent.action' &&
      row.action === 'delivery' &&
      row.outcome === 'success' &&
      row.agentId === 'agent-1' &&
      row.shipmentId === 'ship-1' &&
      row.actorRole === 'agent'
    );
  });

  await assert('emit is a no-op without an agent (audit needs a subject)', async () => {
    const outbox = new FakeOutbox();
    const svc = new AgentActionAuditService(outbox as any);
    await svc.emit({ action: 'pickup', outcome: 'success', agentId: null, shipmentId: 'ship-1', actorRole: 'agency' });
    return outbox.rows.length === 0;
  });

  await assert('emitShipmentTransition maps status and enqueues success', async () => {
    const outbox = new FakeOutbox();
    const svc = new AgentActionAuditService(outbox as any);
    const shipment: any = { _id: { toString: () => 'ship-9' }, agent_id: { toString: () => 'agent-9' }, status: 'picked_up' };
    await svc.emitShipmentTransition(shipment, 'agency');
    const row = outbox.rows[0];
    return outbox.rows.length === 1 && row.action === 'pickup' && row.outcome === 'success' && row.agentId === 'agent-9';
  });

  await assert('emitShipmentTransition no-ops on an unmapped status', async () => {
    const outbox = new FakeOutbox();
    const svc = new AgentActionAuditService(outbox as any);
    const shipment: any = { _id: { toString: () => 'ship-9' }, agent_id: { toString: () => 'agent-9' }, status: 'in_transit' };
    await svc.emitShipmentTransition(shipment, 'agency');
    return outbox.rows.length === 0;
  });

  await assert('emitShipmentTransition no-ops when the shipment has no agent', async () => {
    const outbox = new FakeOutbox();
    const svc = new AgentActionAuditService(outbox as any);
    const shipment: any = { _id: { toString: () => 'ship-9' }, agent_id: null, status: 'picked_up' };
    await svc.emitShipmentTransition(shipment, 'agency');
    return outbox.rows.length === 0;
  });

  console.log(`\n${failed === 0 ? '✅' : '❌'} Agent Action Audit: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

void main();
