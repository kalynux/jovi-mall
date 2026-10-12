# Vendor app — you now follow every ticket about your orders

> **Date:** 2026-10-09 · **Audience:** the vendor dashboard (vendor-dash) · **Status:** built, **not deployed yet**
> **Breaking:** no — no route, field or parameter changed. What changed is **which tickets you receive**.
>
> Full contract: [tickets.md](./tickets.md) — § *Order tickets reach every party automatically*.
> Counterparts: [agency](../agency/FRONTEND-CHANGELOG-ticket-followers.md) · [agent](../agent/FRONTEND-CHANGELOG-ticket-followers.md) · [customer](../customer/FRONTEND-CHANGELOG-ticket-followers.md)

---

## What changed

A ticket **about an order** (entity type `ORDER`, or `SHIPMENT`) is now followed automatically by
the order's vendor, and by every delivery agency and agent on its shipments.

For you: **every ticket about one of your orders now appears in `GET /api/vendor/tickets`, even
though you did not open it** — a customer's complaint, an agency's or agent's delivery problem,
and tickets the platform opens itself (a refund owed, a payment dispute).

You are added the moment the ticket is created. Nothing was removed: tickets you opened yourself
behave exactly as before.

## What you see on such a ticket

The payload is the one you already render (`GET /api/vendor/tickets/:id`). Three things in it
will look different:

| Field | Now |
|---|---|
| `created_by` | Often **not you**: a customer, an agency, an agent, or `created_by_admin` ("Wi-Mall (automatic)") for a platform ticket |
| `followers[]` | Several entries — the customer, you, the agency, the agent — each `{ user_id, role, name, avatar, verified? }`. It used to be one or two |
| Notes | A public system note (`is_system_note: true`) `User added as follower (Role: agent)` appears when an agency or agent joins later. Render it as a timeline event, not a message |

You read **public** notes and attachments only. Private notes not addressed to you never arrive.

## What you may do on a ticket you did not open

Same rules as any follower — the backend checks followership, not authorship:

| Action | Allowed? |
|---|---|
| Read, add a note (`POST /:ticketId/notes`), attach a file | ✅ |
| `PATCH /:id/status`, `PATCH /:id/priority` (unless `priority_locked`), `PATCH /:id/assign`, `PATCH /:id` | ✅ |
| **`POST /:id/close`** | ❌ **`403 TICKET_ACCESS_DENIED`** — only the ticket's creator (or an administrator) closes it |

→ **Show the Close button only when `created_by_user_id` is the signed-in user's id.**

Two things this unlocks:

- **`waiting_on_agency` / `waiting_on_agent`** now work on order tickets, because those parties
  follow them. They used to fail with `400 TICKET_WAITING_TARGET_NOT_PARTICIPANT`. The rule itself
  is unchanged: offer a `waiting_on_<role>` status only when `followers` contains that role
  (so `waiting_on_customer` only when the customer is on the ticket).
- **Private notes** (`visibility: "private"`, `visibleToUserIds`) can address any follower — the
  agency or the agent, for example. Build the recipient picker from `followers`.

## Things to handle

- **No notification is sent when you are added.** The ticket simply appears in your list. Refresh
  the list on screen focus, and consider a badge for tickets you have not opened.
- **Telling them apart.** `GET /api/vendor/tickets?createdByUserId=<your user id>` returns only the
  tickets you opened. A "Opened by me / About my orders" switch is one parameter.
- **Tickets for one order.** `GET /api/vendor/tickets?entityType=ORDER&entityId=<orderId>` lists
  the tickets about an order — usable on the order detail screen.
- **You can be removed.** An administrator may remove a follower. The ticket then leaves your list
  and `GET /:id` answers `403 TICKET_ACCESS_DENIED`; handle that on a stale link.
- The 5-follower limit (`422 TICKET_FOLLOWER_LIMIT_EXCEEDED` on `PATCH /:id/assign`) no longer
  counts the automatically added parties.

## Checklist

- [ ] Ticket list and detail render a ticket whose `created_by` is someone else (customer, agency, agent, platform)
- [ ] Followers section renders several people, with role labels
- [ ] System notes render as timeline events
- [ ] Close button only for the creator
- [ ] `waiting_on_<role>` options driven by `followers`
- [ ] List refreshes on focus; `403` on a ticket you were removed from is handled
