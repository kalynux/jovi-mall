/**
 * The change of agency's own rules (`VendorOrderService.moveItemsToAgency`, ADR-A11 D-12) — pure,
 * no I/O, so the decisions the transaction takes can be asserted without a database
 * (`npm run test:change-agency-tx`).
 *
 * Two of them exist because the move is ONE transaction that the driver may re-run, and because
 * two callers may move the same item at the same instant:
 *
 *  - every item is pinned to WHERE THE PRE-CHECK SAW IT (`checkItemStillWhereSeen`). Inside the
 *    transaction the item is re-read and must still be on the same shipment and agency. A
 *    concurrent move that committed first, or a retried attempt of this one, sees a different
 *    location and REFUSES (409) instead of moving the item a second time. Without it a re-run
 *    found the item already on the destination, pushed it there again, and `$pull` then removed
 *    BOTH copies — emptying (and deleting) the destination shipment;
 *  - "whole shipment" is judged against the BATCH (`isWholeShipmentMove`), never one item at a
 *    time — see `ChangeAgencyFeeService`.
 */

/** Order-item delivery statuses an item may change agency from — not yet dispatched. */
export const REASSIGNABLE_ITEM_STATUSES: readonly string[] = ['pending', 'assigned', 'pending_agency_reassignment'];

/**
 * Statuses the SOURCE shipment may be in while items leave it. The order item's status is a
 * mirror of its shipment's; the shipment is the authority, so the transaction checks both.
 * `rejected`: an agency declined it and its items are held for reassignment.
 */
export const MOVABLE_SOURCE_SHIPMENT_STATUSES: readonly string[] = ['pending', 'assigned', 'rejected', 'pending_agency_reassignment'];

/** Where the pre-check saw an item — the transaction re-validates against this. */
export interface SeenItemLocation {
  itemId: string;
  shipmentId: string | null;
  agencyId: string | null;
}

export type ItemMoveRefusal =
  | { code: 'item_not_found'; itemId: string }
  | { code: 'not_reassignable'; itemId: string; status: string | null }
  | { code: 'moved_meanwhile'; itemId: string; seen: SeenItemLocation; now: { shipmentId: string | null; agencyId: string | null } };

/**
 * Inside the transaction: the item as it stands NOW against where the pre-check saw it. Null when
 * the move may proceed.
 */
export function checkItemStillWhereSeen(
  seen: SeenItemLocation,
  now: { shipmentId: string | null; agencyId: string | null; status: string | null } | null
): ItemMoveRefusal | null {
  if (!now) return { code: 'item_not_found', itemId: seen.itemId };
  if (now.shipmentId !== seen.shipmentId || now.agencyId !== seen.agencyId) {
    return { code: 'moved_meanwhile', itemId: seen.itemId, seen, now: { shipmentId: now.shipmentId, agencyId: now.agencyId } };
  }
  if (!REASSIGNABLE_ITEM_STATUSES.includes(now.status ?? '')) {
    return { code: 'not_reassignable', itemId: seen.itemId, status: now.status };
  }
  return null;
}

/**
 * Group the batch by the shipment each item leaves (null: an item on no shipment), keeping the
 * batch's order. The fee rules (whole vs partial) and the source's deletion are decided per
 * source, over every item leaving it at once.
 */
export function groupMovesBySource(items: SeenItemLocation[]): Array<{ sourceShipmentId: string | null; itemIds: string[] }> {
  const groups = new Map<string, { sourceShipmentId: string | null; itemIds: string[] }>();
  for (const item of items) {
    const key = item.shipmentId ?? '';
    const group = groups.get(key) ?? { sourceShipmentId: item.shipmentId, itemIds: [] };
    if (!group.itemIds.includes(item.itemId)) group.itemIds.push(item.itemId);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** Does the batch take EVERY item off the source (so the source row is deleted)? */
export function isWholeShipmentMove(sourceItemIds: string[], movingItemIds: string[]): boolean {
  if (sourceItemIds.length === 0) return false;
  const moving = new Set(movingItemIds);
  return sourceItemIds.every((id) => moving.has(id));
}

/**
 * A shipment an agent has ACCEPTED (bound, still `assigned`) must not be deleted from under them
 * by a whole move: its tracking session, capacity slot and delivery code all belong to a live
 * assignment. Same rule as the administrator's move (`AdminShipmentAgencyService`) — release or
 * reassign the agent first. A `rejected` shipment keeps its `agent_id` as history only (the
 * rejection already released the agent), so it does not block.
 */
export function wholeMoveBlockedByAgent(source: { status: string; agent_id?: unknown | null }, whole: boolean): boolean {
  return whole && source.status === 'assigned' && !!source.agent_id;
}
