# Agent app — you now follow every ticket about the deliveries you accept

> **Date:** 2026-10-09 · **Audience:** the agent mobile app · **Status:** built, **not deployed yet**
> **Breaking:** no — no route, field or parameter changed. What changed is **which tickets you receive**.
>
> Full contract: [tickets.md](./tickets.md) (the agent route set) and
> [../vendor/tickets.md](../vendor/tickets.md) § *Order tickets reach every party automatically* (the shared payload reference).
> Counterparts: [vendor](../vendor/FRONTEND-CHANGELOG-ticket-followers.md) · [agency](../agency/FRONTEND-CHANGELOG-ticket-followers.md) · [customer](../customer/FRONTEND-CHANGELOG-ticket-followers.md)

---

## What changed

A ticket **about an order** (entity type `ORDER`, or `SHIPMENT`) is now followed automatically by
the order's vendor, and by every delivery agency and agent on its shipments.

For the agent: **once you accept a shipment, every open ticket about its order appears in
`GET /api/agent/tickets`, even though you did not open it** — a customer's complaint, the
vendor's, the agency's, and tickets the platform opens itself (a refund owed, a payment dispute).

### When you are added

| Moment | Result |
|---|---|
| You **accept** an offer | You join every **open** ticket about that order |
| A ticket is opened later on an order whose shipment you hold | You follow it immediately |
| You cancel the delivery or are replaced by another agent | **You keep following** — you were party to the case |

An offer you have only *received* does not add you. Acceptance does.

## What you see on such a ticket

The payload is the one you already render (`GET /api/agent/tickets/:id`):

| Field | Now |
|---|---|
| `created_by` | Often **not you**: a customer, the vendor, the agency, or `created_by_admin` ("Wi-Mall (automatic)") for a platform ticket |
| `followers[]` | Several entries — customer, vendor, agency, you — each `{ user_id, role, name, avatar, verified? }` |
| Notes | A public system note (`is_system_note: true`) `User added as follower (Role: agent)` marks the moment you joined. Render it as a timeline event, not a message |

You read **public** notes and attachments only. Private notes not addressed to you never arrive.

## What you may do on a ticket you did not open

The backend checks followership, not authorship:

| Action | Allowed? |
|---|---|
| Read, add a note (`POST /:ticketId/notes`), attach a file | ✅ |
| `PATCH /:id/status`, `PATCH /:id/priority` (unless `priority_locked`), `PATCH /:id/assign`, `PATCH /:id` | ✅ |
| **`POST /:id/close`** | ❌ **`403 TICKET_ACCESS_DENIED`** — only the ticket's creator (or an administrator) closes it |

→ **Show the Close button only when `created_by_user_id` is the signed-in user's id.**

- **`waiting_on_vendor` / `waiting_on_agency`** now work on order tickets, because those parties
  follow them (they used to fail with `400 TICKET_WAITING_TARGET_NOT_PARTICIPANT`). The rule is
  unchanged: offer a `waiting_on_<role>` status only when `followers` contains that role.
- **Private notes** (`visibility: "private"`, `visibleToUserIds`) can address any follower. Build
  the recipient picker from `followers`.

## Things to handle

- **No push notification is sent when you are added.** The ticket simply appears in the list.
  Refresh the ticket list when the screen opens and after accepting an offer.
- **Telling them apart.** `GET /api/agent/tickets?createdByUserId=<your user id>` returns only the
  tickets you opened.
- **Tickets for the delivery in hand.** `GET /api/agent/tickets?entityType=ORDER&entityId=<orderId>`
  — usable on the shipment screen ("1 open ticket on this order"). Tickets filed against the
  shipment itself use `entityType=SHIPMENT&entityId=<shipmentId>`.
- **You can be removed.** An administrator may remove a follower. The ticket then leaves your list
  and `GET /:id` answers `403 TICKET_ACCESS_DENIED`; handle that on a stale screen.
- The 5-follower limit (`422 TICKET_FOLLOWER_LIMIT_EXCEEDED` on `PATCH /:id/assign`) no longer
  counts the automatically added parties.

## Checklist

- [ ] Ticket list and detail render a ticket whose `created_by` is someone else (customer, vendor, agency, platform)
- [ ] Followers section renders several people, with role labels
- [ ] System notes render as timeline events
- [ ] Close button only for the creator
- [ ] `waiting_on_<role>` options driven by `followers`
- [ ] List refreshes on open and after an accept; `403` on a ticket you were removed from is handled
