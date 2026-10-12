# Agency app — you now follow every ticket about the orders you carry

> **Date:** 2026-10-09 · **Audience:** the agency dashboard (agency-dash) · **Status:** built, **not deployed yet**
> **Breaking:** no — no route, field or parameter changed. What changed is **which tickets you receive**.
>
> Full contract: [tickets.md](./tickets.md) (agency routes and enums) and
> [../vendor/tickets.md](../vendor/tickets.md) § *Order tickets reach every party automatically* (the shared payload reference).
> Counterparts: [vendor](../vendor/FRONTEND-CHANGELOG-ticket-followers.md) · [agent](../agent/FRONTEND-CHANGELOG-ticket-followers.md) · [customer](../customer/FRONTEND-CHANGELOG-ticket-followers.md)

---

## What changed

A ticket **about an order** (entity type `ORDER`, or `SHIPMENT`) is now followed automatically by
the order's vendor, and by every delivery agency and agent on its shipments.

For you: **every ticket about an order you carry now appears in `GET /api/agency/tickets`, even
though you did not open it** — a customer's complaint, the vendor's, one of your agents', and
tickets the platform opens itself (a refund owed, a payment dispute).

### When you are added

| Moment | Result |
|---|---|
| A ticket is opened on an order that has a shipment with you | You follow it immediately |
| A shipment is moved to you (by the vendor or an administrator) | You join every **open** ticket about that order |
| The shipment later moves to another agency | **You keep following** — you were party to the case |

⚠ Your agency is on a shipment from **checkout**, before the vendor dispatches it. So you can
receive a ticket about an order whose shipment is not on your shipments list yet
(`GET /api/agency/shipments` hides undispatched ones). Do not assume the ticket's order opens in
your shipment screens — link to it only when you can resolve it.

## What you see on such a ticket

The payload is the one you already render (`GET /api/agency/tickets/:id`):

| Field | Now |
|---|---|
| `created_by` | Often **not you**: a customer, the vendor, an agent, or `created_by_admin` ("Wi-Mall (automatic)") for a platform ticket |
| `followers[]` | Several entries — customer, vendor, you, the agent — each `{ user_id, role, name, avatar, verified? }` |
| Notes | A public system note (`is_system_note: true`) `User added as follower (Role: agency)` marks the moment a party joined later. Render it as a timeline event, not a message |

You read **public** notes and attachments only. Private notes not addressed to you never arrive.

## What you may do on a ticket you did not open

The backend checks followership, not authorship:

| Action | Allowed? |
|---|---|
| Read, add a note (`POST /:ticketId/notes`), attach a file | ✅ |
| `PATCH /:id/status`, `PATCH /:id/priority` (unless `priority_locked`), `PATCH /:id/assign`, `PATCH /:id` | ✅ |
| **`POST /:id/close`** | ❌ **`403 TICKET_ACCESS_DENIED`** — only the ticket's creator (or an administrator) closes it |

→ **Show the Close button only when `created_by_user_id` is the signed-in user's id.**

- **`waiting_on_vendor` / `waiting_on_agent`** now work on order tickets, because those parties
  follow them (they used to fail with `400 TICKET_WAITING_TARGET_NOT_PARTICIPANT`). The rule is
  unchanged: offer a `waiting_on_<role>` status only when `followers` contains that role.
- **Private notes** (`visibility: "private"`, `visibleToUserIds`) can address any follower — the
  vendor or your agent, for example. Build the recipient picker from `followers`.

## Things to handle

- **No notification is sent when you are added.** The ticket simply appears in your list. Refresh
  the list on screen focus, and consider a badge for tickets you have not opened.
- **Telling them apart.** `GET /api/agency/tickets?createdByUserId=<your user id>` returns only the
  tickets you opened.
- **Tickets for one order.** `GET /api/agency/tickets?entityType=ORDER&entityId=<orderId>` — usable
  on a shipment's order card. Tickets filed against the shipment itself use
  `entityType=SHIPMENT&entityId=<shipmentId>`.
- **You can be removed.** An administrator may remove a follower. The ticket then leaves your list
  and `GET /:id` answers `403 TICKET_ACCESS_DENIED`; handle that on a stale link.
- The 5-follower limit (`422 TICKET_FOLLOWER_LIMIT_EXCEEDED` on `PATCH /:id/assign`) no longer
  counts the automatically added parties.

## Checklist

- [ ] Ticket list and detail render a ticket whose `created_by` is someone else (customer, vendor, agent, platform)
- [ ] Followers section renders several people, with role labels
- [ ] System notes render as timeline events
- [ ] Close button only for the creator
- [ ] `waiting_on_<role>` options driven by `followers`
- [ ] A ticket whose order is not in your shipment list yet does not produce a dead link
- [ ] List refreshes on focus; `403` on a ticket you were removed from is handled
