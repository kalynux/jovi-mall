# ADR-A06 — A customer may see who is carrying their parcel, while they are carrying it

**Date:** 2026-08-23
**Status:** Accepted — decided by the product owner; implemented the same day
**Scope:** jovi-mall only (geo-tracker is not touched — see § Non-consequences)
**Raised by:** `api-doc/customer/BACKEND-REQUIREMENTS-order-detail.md` § 3, from device
testing of the customer app
**Amends:** the "never published" rule in `orders/dto/customer-shipment.dto.ts` and
`orders/customer-order.controller.ts`

---

## Context

The customer app deliberately published nothing about the agent carrying a parcel. It was
written down in two places rather than being an oversight:

> The agent's identity and the free-text internal note on a failed attempt are never
> published; only the fact of an attempt and its count.

The storefront asked for the agent's name and photo on the order-detail screen and — to its
credit — refused to assume the answer, because the reasons for the original rule are real:

1. It exposes a worker's name and face to every customer they deliver to, including after a
   dispute. Agents are individuals, not a company brand.
2. It is a data-protection change, so it belongs in the privacy policy and the Play
   data-safety declaration.
3. The customer status vocabulary is deliberately collapsed to five words to keep internal
   dispatch machinery private, and agent identity sits on that same boundary.

The counter-argument is equally real, and it is a safety argument rather than a convenience
one: for a cash-on-delivery handover the shopper is about to open their door to a stranger,
hand over money and read out a delivery code. "Who is coming" is a question they are
entitled to an answer to, and every mainstream delivery app answers it.

---

## D-1 · The decision

**A customer may see the carrying agent's partial name and photo, and only while that agent
is actually carrying their parcel.**

Concretely, on `GET /api/customer/orders/:orderId/shipments`:

```jsonc
"agent": {
  "displayName": "Jean T.",        // first name + surname initial, never the full name
  "photo": { … } | null,           // FileDetail, the platform's canonical file reference
  "visibleFrom": "shipped"
} | null
```

Four constraints are the decision, not decoration. Removing any one of them makes this a
different (and unapproved) disclosure:

- **Partial name.** Enough to recognise the person at a door, not enough to look them up
  afterwards. `toAgentDisplayName` is pure and is the only renderer.
- **No phone number, ever.** A customer with a question contacts the **agency**, whose
  `supportPhone` / `supportEmail` / `supportWhatsapp` are published in the same response.
  Those are business lines an agency chose to publish. An agent's handset is not.
- **Scoped to a live delivery.** Visible only while the shipment is `picked_up`,
  `in_transit`, `handing_over`, `agent_delivered` or `failed`.
- **Revoked on settlement.** `delivered` and `returned` return `agent: null`. The
  disclosure is not stamped into order history, so a dispute six months later does not
  re-serve a worker's face to the person disputing it.

## D-2 · The window opens at `shipped`, not at `out_for_delivery`

The request said `visibleFrom: "out_for_delivery"`, meaning the everyday sense — the parcel
is out and on its way. **In this API those are different things**, and taking the phrase
literally would have shipped a broken feature that passed review.

`CustomerShipmentStatus.out_for_delivery` maps from the internal `agent_delivered`: the
agent has *already reported the handover*. Publishing the courier only from there shows a
customer who came to their door after they came, which defeats the entire safety argument
this ADR rests on.

So the window opens at the customer-facing `shipped` (internal `picked_up` / `in_transit` /
`handing_over`) and `visibleFrom` reports `"shipped"`.

## D-3 · `failed` keeps the agent visible; `returned` does not

`failed` is **not terminal** — `failed → in_transit → failed → returned` is an allowed cycle,
the same agent still physically holds the parcel, and they are coming back. Closing the
window on a failed attempt would hide the courier at the exact moment a customer is trying to
work out what happened. `returned` is the end of that road and closes it.

This is also why the visibility table is keyed on the **internal** status: the customer
vocabulary collapses `failed` and `returned` into one word, and they are opposite answers here.

## D-4 · The enforcement lives at the query, not at the projection

`OrderService.listShipmentsForCustomer` consults `agentIdentityVisibleAt` **before** it looks
an agent up, so an agent outside the window is never fetched at all. There is nothing in
memory for a later projection, log line or spread to leak.

The lookup itself is `AgentRepository.findPublicIdentitiesByIds`, a two-field projection. The
agent document carries legal identity, payout details, an emergency contact, device telemetry,
trust signals and a cash balance; a caller that hydrates the whole thing to render a name is
one careless spread from publishing all of it. Same argument `AgentDirectoryMapper` already
makes one layer up.

The stored **full** name never reaches the DTO — `toAgentDisplayName` reduces it in the
service. The repository method's docstring says so explicitly, because it answers "what is on
file", not "what may be shown".

---

## Non-consequences

- **geo-tracker is not touched.** It consumes trackable/terminal verdicts and the
  visible-agents policy; who a customer may see *named* on an order screen is not a tracking
  authorization question and does not reach it. No event shape, webhook body or route changed.
- **No other surface changed.** The agency and vendor order views already showed the agent's
  name, phone and avatar and are unaffected. The internal `note` and `reason` on a failed
  attempt remain unpublished — that half of the original rule stands untouched.
- **No migration.** Nothing is stored; the block is derived per request.

## What this obliges, and is NOT discharged here

⚠ **The privacy policy and the Play data-safety declaration must say this.** The platform now
discloses a worker's name and photograph to a member of the public. Both documents were
already open items for the app release; this adds a required line to each, and no code in this
repository can close it.

⚠ **Agents are not asked.** This is a platform-wide term, not a per-agent opt-in. If that
becomes the wrong answer, the lever is a per-agent flag consulted by `agentIdentityVisibleAt`'s
caller — deliberately not a second visibility table.

---

## Alternatives considered

**Refuse, as before.** Rejected by the product owner. It is a defensible position and was the
status quo, but it leaves a COD customer with no answer to a reasonable safety question, and
the storefront had already shipped every screen around the gap.

**COD only.** Offered and not taken. It is the narrowest version of the safety argument, but a
prepaid customer opening their door to a stranger is in the same room as a COD one, and a rule
that changes with the payment method is one no customer can predict.

**Full name and a contact number.** Never on the table. The name is reducible without losing
the purpose, and a phone number has an agency-level answer that is strictly better for both
sides.
