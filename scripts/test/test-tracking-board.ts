/**
 * Test: the agency live-tracking board's pure assembly.
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no
 * framework). DB-free: `buildTrackingBoard` is the derivation lifted off the I/O
 * path — grouping shipments under their agent, and deciding whether a delivery
 * can actually be drawn. Everything it consumes is loaded by the service around
 * it, so it is fully exercisable with literals.
 *
 * What this cannot cover, and why the endpoint still needs a live check: that
 * the board's agent set matches GET /api/tracking/visible-agents (both select on
 * `trackableShipmentsForAgency`, which is a Mongo filter), and that the pickup
 * and drop-off resolution is correct (ShipmentService.resolveShipmentEndpoints
 * reads orders, magazins and customers).
 *
 * Run: npm run test:tracking-board
 */
import { IShipment, ShipmentStatus } from '../../src/modules/shipments/shipment.model';
import { ShipmentEndpoints, PickupSummary } from '../../src/modules/shipments/shipment.service';
import { AddressDetail } from '../../src/core/read-models/address-detail.resolver';
import { IDeliveryAgent } from '../../src/modules/agents';
import { FileDetail } from '../../src/modules/catalog/read-models/product-detail.read-model';
import { buildTrackingBoard } from '../../src/modules/tracking-integration/services/agency-tracking-board.service';

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

// ─── Fixtures ────────────────────────────────────────────────────────────────
// Shaped, not real documents: buildTrackingBoard reads a handful of fields and
// the casts keep the test free of Mongoose.

function address(coords: { lat: number; lng: number } | null, formatted = 'Somewhere'): AddressDetail {
  return {
    label: null,
    formattedAddress: formatted,
    addressLine1: null,
    addressLine2: null,
    city: null,
    state: null,
    country: null,
    coordinates: coords,
  };
}

function pickup(coords: { lat: number; lng: number } | null, mode: PickupSummary['mode'] = 'pickup_based', count = 1): PickupSummary {
  return { address: coords === null && mode === null ? null : address(coords, 'Pickup'), mode, count };
}

function shipment(
  id: string,
  agentId: string | null,
  opts: { status?: ShipmentStatus; orderId?: string; items?: number; trackingNumber?: string | null } = {},
): IShipment {
  return {
    _id: id,
    order_id: { toString: () => opts.orderId ?? `order-${id}` },
    agency_id: { toString: () => 'agency-1' },
    agent_id: agentId === null ? null : { toString: () => agentId },
    status: opts.status ?? 'in_transit',
    tracking_number: opts.trackingNumber === undefined ? `ACR-260802-000000-${id}` : opts.trackingNumber,
    items: new Array(opts.items ?? 1).fill({}),
    created_at: new Date('2026-08-02T10:00:00Z'),
    updated_at: new Date('2026-08-02T11:00:00Z'),
  } as unknown as IShipment;
}

function agent(id: string, name: string, opts: { phone?: string; vehicle?: string } = {}): IDeliveryAgent {
  return {
    _id: { toString: () => id },
    name,
    phone: opts.phone,
    vehicle_info: opts.vehicle ? { vehicle_type: opts.vehicle } : null,
    avatar_file_id: null,
  } as unknown as IDeliveryAgent;
}

const NO_AVATARS = new Map<string, FileDetail | null>();
const NO_ORDERS = new Map<string, { order_number?: string | null }>();

function endpoints(entries: Array<[string, ShipmentEndpoints]>): Map<string, ShipmentEndpoints> {
  return new Map(entries);
}

function main(): void {
  console.log('\n▶ Grouping — one row per agent, not per shipment');

  {
    const s1 = shipment('s1', 'a1');
    const s2 = shipment('s2', 'a1');
    const s3 = shipment('s3', 'a2');
    const board = buildTrackingBoard(
      [s1, s2, s3],
      endpoints([
        ['s1', { pickup: pickup({ lat: 4.05, lng: 9.7 }), deliveryAddress: address({ lat: 4.06, lng: 9.75 }) }],
        ['s2', { pickup: pickup({ lat: 4.05, lng: 9.7 }), deliveryAddress: address({ lat: 4.07, lng: 9.76 }) }],
        ['s3', { pickup: pickup({ lat: 4.01, lng: 9.6 }), deliveryAddress: address({ lat: 4.02, lng: 9.61 }) }],
      ]),
      NO_ORDERS,
      new Map([['a1', agent('a1', 'Awa')], ['a2', agent('a2', 'Bilal')]]),
      NO_AVATARS,
      false,
    );

    assert('two agents from three shipments', () => board.agents.length === 2);
    assert('an agent running two deliveries carries both', () => board.agents[0].shipments.length === 2);
    assert('agents appear in first-seen (newest-shipment) order', () =>
      board.agents.map((a) => a.agentId).join(',') === 'a1,a2');
    assert('meta counts agents and shipments separately', () =>
      board.meta.agentCount === 2 && board.meta.shipmentCount === 3);
    assert('agent identity is carried through', () => board.agents[1].name === 'Bilal');
  }

  {
    // The service filters on `agent_id: { $ne: null }`, but a null here must
    // never key an agent as the string "null" — it would render a phantom row.
    const board = buildTrackingBoard(
      [shipment('s1', null), shipment('s2', 'a1')],
      endpoints([['s2', { pickup: pickup({ lat: 1, lng: 1 }), deliveryAddress: address({ lat: 2, lng: 2 }) }]]),
      NO_ORDERS,
      new Map([['a1', agent('a1', 'Awa')]]),
      NO_AVATARS,
      false,
    );
    assert('an agentless shipment is dropped, not grouped under "null"', () =>
      board.agents.length === 1 && board.agents[0].agentId === 'a1');
  }

  {
    const board = buildTrackingBoard(
      [shipment('s1', 'a1')],
      endpoints([['s1', { pickup: pickup({ lat: 1, lng: 1 }), deliveryAddress: address({ lat: 2, lng: 2 }) }]]),
      NO_ORDERS,
      new Map(), // agent record missing — a deleted or unreadable row
      NO_AVATARS,
      false,
    );
    assert('a missing agent record still yields a trackable row', () =>
      board.agents.length === 1 && board.agents[0].agentId === 'a1');
    assert('missing agent identity degrades to null, never undefined', () =>
      board.agents[0].name === null && board.agents[0].phone === null && board.agents[0].vehicleType === null);
  }

  console.log('\n▶ mappable — can this delivery actually be drawn?');

  {
    const board = buildTrackingBoard(
      [shipment('ok', 'a1'), shipment('noOrigin', 'a1'), shipment('noDest', 'a1'), shipment('neither', 'a1')],
      endpoints([
        ['ok', { pickup: pickup({ lat: 4.05, lng: 9.7 }), deliveryAddress: address({ lat: 4.06, lng: 9.75 }) }],
        // A vendor address that was never geocoded: displayable, not mappable.
        ['noOrigin', { pickup: pickup(null), deliveryAddress: address({ lat: 4.06, lng: 9.75 }) }],
        // A legacy order predating order.delivery_address.
        ['noDest', { pickup: pickup({ lat: 4.05, lng: 9.7 }), deliveryAddress: address(null) }],
        ['neither', { pickup: { address: null, mode: null, count: 0 }, deliveryAddress: null }],
      ]),
      NO_ORDERS,
      new Map([['a1', agent('a1', 'Awa')]]),
      NO_AVATARS,
      false,
    );
    const byId = new Map(board.agents[0].shipments.map((s) => [s.shipmentId, s]));

    assert('both ends geocoded → mappable', () => byId.get('ok')!.mappable === true);
    assert('no pickup coordinates → not mappable', () => byId.get('noOrigin')!.mappable === false);
    assert('no drop-off coordinates → not mappable', () => byId.get('noDest')!.mappable === false);
    assert('neither end → not mappable', () => byId.get('neither')!.mappable === false);
    // The whole point of returning both anyway: an unmappable delivery is still
    // readable as text, and the agency can still see where it is meant to go.
    assert('an unmappable row still carries its addresses as text', () =>
      byId.get('noOrigin')!.origin.address?.formattedAddress === 'Pickup' &&
      byId.get('noDest')!.destination?.formattedAddress === 'Somewhere');
    assert('a shipment with no resolved endpoints degrades to an empty pickup', () =>
      byId.get('neither')!.origin.count === 0 && byId.get('neither')!.destination === null);
  }

  {
    // A shipment whose endpoints never made it into the map at all (its order
    // was deleted) must not throw or vanish — the agent is still trackable.
    const board = buildTrackingBoard(
      [shipment('s1', 'a1')],
      endpoints([]),
      NO_ORDERS,
      new Map([['a1', agent('a1', 'Awa')]]),
      NO_AVATARS,
      false,
    );
    assert('a shipment missing from the endpoint map survives as unmappable', () =>
      board.agents[0].shipments[0].mappable === false &&
      board.agents[0].shipments[0].origin.count === 0);
  }

  console.log('\n▶ Row shape — what the map reads');

  {
    const board = buildTrackingBoard(
      [shipment('s1', 'a1', { status: 'handing_over', orderId: 'o1', items: 4, trackingNumber: 'ACR-260802-101010-AB3CD' })],
      endpoints([['s1', { pickup: pickup({ lat: 1, lng: 1 }, 'mixed', 2), deliveryAddress: address({ lat: 2, lng: 2 }) }]]),
      new Map([['o1', { order_number: 'ORD-9001' }]]),
      new Map([['a1', agent('a1', 'Awa', { phone: '+237600000000', vehicle: 'bike' })]]),
      new Map([['a1', { id: 'f1', key: 'k', url: 'https://x/y.png', mimeType: 'image/png', size: 10, originalName: 'a.png' }]]),
      false,
    );
    const row = board.agents[0].shipments[0];

    assert('order number is joined onto the row', () => row.orderNumber === 'ORD-9001');
    assert('tracking number is carried', () => row.trackingNumber === 'ACR-260802-101010-AB3CD');
    assert('itemCount comes from the shipment, not the order', () => row.itemCount === 4);
    // handing_over is trackable: a picked-up parcel mid-reassignment is still
    // on the road and the agency must keep seeing it.
    assert('handing_over is a legitimate board status', () => row.status === 'handing_over');
    assert('mixed pickup mode and count pass through untouched', () =>
      row.origin.mode === 'mixed' && row.origin.count === 2);
    assert('avatar resolves to a FileDetail object, never a URL string', () =>
      typeof board.agents[0].avatar === 'object' && board.agents[0].avatar?.url === 'https://x/y.png');
    assert('an agent with no avatar gets null', () => {
      const b = buildTrackingBoard([shipment('s9', 'a9')], endpoints([]), NO_ORDERS, new Map(), NO_AVATARS, false);
      return b.agents[0].avatar === null;
    });
    // No position anywhere on the payload: last_known_tracking_state is stale by
    // construction and live movement belongs to the geo-tracker socket.
    assert('the board carries no position field', () =>
      !JSON.stringify(board).toLowerCase().includes('position'));
  }

  console.log('\n▶ Empty and truncated boards');

  {
    const empty = buildTrackingBoard([], endpoints([]), NO_ORDERS, new Map(), NO_AVATARS, false);
    assert('no trackable shipments → an empty board, not an error', () =>
      empty.agents.length === 0 && empty.meta.agentCount === 0 && empty.meta.shipmentCount === 0);
    assert('an empty board is not truncated', () => empty.meta.truncated === false);
  }

  {
    const truncated = buildTrackingBoard(
      [shipment('s1', 'a1')],
      endpoints([['s1', { pickup: pickup({ lat: 1, lng: 1 }), deliveryAddress: address({ lat: 2, lng: 2 }) }]]),
      NO_ORDERS,
      new Map([['a1', agent('a1', 'Awa')]]),
      NO_AVATARS,
      true,
    );
    assert('truncation is reported to the client', () => truncated.meta.truncated === true);
    assert('shipmentCount counts what was returned, not what exists', () =>
      truncated.meta.shipmentCount === 1);
  }

  console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main();
