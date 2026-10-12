# Customer shop — the seller and the delivery side now join an order ticket

> **Date:** 2026-10-09 · **Audience:** the customer shop (signed-in area of the landing site) · **Status:** built, **not deployed yet**
> **Breaking:** no — no route, field or parameter changed. This is mostly a **verify** pass.
>
> Full contract: [tickets.md](./tickets.md) and
> [../vendor/tickets.md](../vendor/tickets.md) § *Order tickets reach every party automatically* (the shared payload reference).

---

## What changed

When a customer opens a ticket **about an order** (entity type `ORDER`, or `SHIPMENT`), the
order's **vendor**, its **delivery agency** and its **agent** now follow that ticket automatically
and can answer it. Before, only the customer and platform support were on it.

The customer's own list (`GET /api/customer/tickets`) does **not** grow: a customer is not added
to a ticket somebody else opens about their order.

## What the customer now sees on their ticket

`GET /api/customer/tickets/:id` and `GET /api/customer/tickets/:ticketId/notes`, same payloads:

| Field | Now |
|---|---|
| `followers[]` | Several entries instead of one — the customer, the vendor, the agency, the agent — each `{ user_id, role, name, avatar, verified? }` |
| Notes, `author.role` | A public reply can now come from **`vendor`**, **`agency`** or **`agent`**, not only `admin`. Label the author by `author.role` and `author.name`; do not assume every reply is "Support" |
| System notes | `is_system_note: true`, e.g. `User added as follower (Role: agent)` when an agent accepts the delivery after the ticket was opened. Render as a timeline event, not a message |

- The existing **`ticket.replied`** notification now also fires for those replies (it already
  fired for any public reply not written by the customer). Its wording should not say "support
  replied" if it does today — the reply may be the seller's or the courier's.
- The customer still creates **public** notes only, and still closes their own ticket.
- An agent joins when they **accept** the delivery, so the followers list can change while the
  ticket is open. Read it from the response each time; do not cache it.

## Checklist

- [ ] Ticket detail renders several followers, with role labels ("Seller", "Delivery agency", "Courier")
- [ ] A reply shows who wrote it (`author.role` / `author.name`), for vendor, agency and agent as well as admin
- [ ] System notes render as timeline events
- [ ] Notification and empty-state copy does not assume only support answers
