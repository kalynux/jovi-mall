# Shipment administration — the internal API

> **This is not a dashboard surface.** Every endpoint here lives under
> `/api/internal/admin/shipments` and is called by the **wi-admin backend**, never by a
> browser. There has never been an `/api/admin/shipments` mount, so unlike the order router
> this one has no public twin and no legacy consumer.
>
> The dashboard talks to wi-admin's `/api/v1/shipments`, which reads `jovi_mall` directly
> and delegates both writes to the calls below.
>
> Design record: `../../../admin/docs/ADR-010-ORDERS-AND-SHIPMENTS.md`.

## Writes only

wi-admin reads `shipments`, `shipment_assignment_offers`, `cash_collections` and
`tracking_outbox` directly (ADR-004 D-2: delegate a write, not a query). What is here is
what has invariants — and in this domain they reach outside the database entirely.

A reassignment detaches the current agent under a compare-and-set, opens a handover record,
re-offers through the assignment ranking, returns the old agent's capacity, re-opens a COD
collection with a fresh delivery code when the shipment was `returned`, **and emits the
outbox row that closes the old agent's live tracking session in geo-tracker**. Move
`agent_id` from another process and the row is right, the session stays open, and somebody
who is no longer delivering keeps being watched.

## Authentication

`requireAdminCaller` (`src/api/middlewares/admin-caller.middleware.ts`):

| Header | Required | Meaning |
|---|---|---|
| `X-Service-Token` | yes | `INTERNAL_ADMIN_SERVICE_TOKEN`, compared in constant time. `Authorization: Bearer <token>` is accepted as an alternative |
| `X-Actor-Id` | yes | The acting administrator's `admin_accounts._id` from the **wi-admin** database. Must be a valid ObjectId |
| `X-Actor-Name` | no | Snapshotted onto every actor stamp this surface writes. Defaults to `Administrator` |
| `X-Request-Id` | no | Correlation id, echoed into logs |

`X-Actor-Id` resolves to **nothing in this database**. Both writes here carry the companion
fields that make that legible: a rejection stamps `rejection.rejectedBySource: 'admin'` and
`rejection.rejectedByName`, and an offer created by an administrator stamps
`created_by.role: 'admin'` with `created_by.name`. See
`src/core/types/actor-source.types.ts`.

## How the ownership scope is resolved

Every shipment command path in this service is scoped by `findByIdAndAgency`. An
administrator has no agency, so both controllers here perform **one unscoped read, take the
shipment's own `agency_id`, and call the ordinary agency-scoped service**. Nothing is
bypassed and nothing is duplicated — the scope is supplied from the record instead of from
a session, and every guard, compare-and-set and post-commit effect is the agency path's.

---

## `POST /:shipmentId/reassign`

Body:

```jsonc
{
  "agentId": "…",            // optional pre-pickup (omit to auto-assign); REQUIRED past pickup
  "reason": "…",             // required, 3–500 chars
  "pickupLocation": { … }    // optional override of the derived handover point
}
```

Moves the shipment to a different agent. The old agent is **released, not terminated** — the
shipment lives on, their tracking session closes, and their capacity slot returns.

| Current status | Result |
|---|---|
| `assigned` | resets to `assigned` and re-offers (auto when `agentId` is omitted) |
| `picked_up` `in_transit` `failed` `returned` | enters `handing_over`; `agentId` is **required** |

`handing_over` is trackable and non-terminal: it ends when the replacement picks the parcel
up, or when the handover is returned.

Where the replacement collects is derived from the status at reassignment
(`previous_agent_location`, `original_pickup`, `agency_business`) and may be overridden with
`pickupLocation`.

| Refusal | Code | Status |
|---|---|---|
| no agent bound to reassign from | `SHIPMENT_NOT_REASSIGNABLE` | 422 |
| status outside `REASSIGNABLE_STATUSES` | `SHIPMENT_REASSIGNMENT_NOT_ALLOWED` | 422 |
| post-pickup without an explicit agent | `SHIPMENT_REASSIGN_REQUIRES_MANUAL_AGENT` | 422 |
| same agent | `SHIPMENT_REASSIGN_SAME_AGENT` | 422 |
| replacement not eligible | `AGENT_NOT_ELIGIBLE_FOR_ASSIGNMENT` (`details.rules`) | 422 |
| the order is already settled | — | 422 |
| **the shipment moved under you** | `SHIPMENT_REASSIGNMENT_CONFLICT` | **409** |

The 409 is the `claimForReassignment` compare-and-set missing — a concurrent accept, pickup,
COD collection or second reassign. Reload and retry; it is never a reason to force.

---

## `POST /:shipmentId/cancel`

Body: `{ "reason"?: ShipmentRejectionReason, "note": string }`.

`reason` defaults to **`platform_intervention`**, the reason an administrator owns — added
in Phase 10 and deliberately disjoint from every agency-driven reason, so a later reader can
tell "the agency could not carry this" from "the platform pulled it".

`note` is **required** here where the agency's equivalent is optional. This service stores
it on the shipment, and it has to: wi-admin's audit trail lives in a database jovi-mall
cannot read, and the vendor whose delivery just vanished has to be tellable why by the
service that holds their data.

### This applies to `assigned` shipments only

It delegates to `ShipmentService.reject`, which refuses anything else. **That refusal is
inherited, not widened.** So the window is exactly: dispatched to an agency, not yet picked
up (an agent may or may not have accepted). A picked-up parcel is physically with somebody,
and the domain's answer there is a reassignment or a return.

A dashboard should disable the button outside `assigned`; the 422 carries `details.status`.

What happens on success: `status` → `rejected`, every order item goes on hold at
`pending_agency_reassignment` (the same mechanism the agency-deactivation cascade uses), any
pending offer is cancelled, agent capacity is released, the tracking outbox is notified and
the vendor is told so they can re-route.

| Refusal | Code | Status |
|---|---|---|
| not `assigned` | `SHIPMENT_REJECTION_NOT_ALLOWED` (`details.status`) | 422 |
| **the shipment moved under you** | `SHIPMENT_STATUS_CONFLICT` | **409** |
| unknown shipment | `SHIPMENT_NOT_FOUND` | 404 |

The 409 is new in Phase 10. `applyRejection` was previously a blind update, so two
concurrent rejects both succeeded and both fired the post-commit block for a status nobody
was in. **This also changes the agency's own `POST /api/agency/shipments/:id/reject`**,
which now returns 409 in the same race.

---

## Not offered, deliberately

- **A status transition.** Driving a delivery through `picked_up → in_transit → delivered`
  is the agent's job and the agency desk's. It would also need a third member on
  `ShipmentStatusActor` carrying neither an `agencyId` nor an `agentId` — and those two are
  precisely what `applyStatusChangeIfCurrent` puts in its compare-and-set filter, so a third
  actor would strip both ownership predicates out of the guard that makes two actors on one
  shipment safe.
- **A cancellation past pickup.** See above.
- **Reads.** wi-admin reads these collections directly; routing a `find()` through HTTP buys
  nothing and costs a hop.
