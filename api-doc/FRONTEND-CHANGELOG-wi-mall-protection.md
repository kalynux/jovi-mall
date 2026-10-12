# Wi-Mall Protection: 3 days after delivery (cross-role, 2026-10-10)

**Status: backend built and tested, not deployed. Legal documents published 2026-10-10**
(Terms 2.2 § 19, Returns 1.2, Seller Agreement 1.2, Delivery Partner Agreement 1.2, EN + FR, same
URLs under `https://cdn.wi-mall.com/legal/`). Owner decisions of 2026-10-09 and 2026-10-10.

Each app has its own task list: [customer / landing](./customer/FRONTEND-CHANGELOG-wi-mall-protection.md) ·
[vendor](./vendor/FRONTEND-CHANGELOG-wi-mall-protection.md) ·
[agency](./agency/FRONTEND-CHANGELOG-wi-mall-protection.md) ·
[agent](./agent/FRONTEND-CHANGELOG-wi-mall-protection.md) ·
admin: `backend/admin/api-doc/FRONTEND-CHANGELOG-wi-mall-protection.md`. This file is the shared rule.

## The rule in one paragraph

Wi-Mall holds an order's money for **3 days after delivery**. While it holds the money it can
settle a problem between a customer and a seller. Once the money is released it has very little
power left. So the customer has those 3 days to report a problem, and **a problem reported in
time puts the money on hold until the request ends**. After the 3 days the customer and the
seller deal with each other; Wi-Mall may still step in at its own discretion for serious cases
(fraud, counterfeit, dangerous goods), and nobody should count on it.

## The three numbers, all in the env file

| Variable | What it sets | Default |
|---|---|---|
| `EARNINGS_HOLD_DAYS` | days the money is held after delivery — the protection window | 3 |
| `EARNINGS_SHIPMENT_AUTO_CONFIRM_DAYS` | days after the agent marks a parcel delivered before it is confirmed for the customer (COD with no code: recorded as cash collected) | 3 (was 7) |
| `EARNINGS_AUTO_CONFIRM_DAYS` | days before a delivered order is marked completed | 3 (was 7) |

Never hardcode "3" in an app. Read the window from the order (below).

## What a customer's problem report does now

A customer opens a support request (`POST /api/customer/tickets`, the bot's support form, or the
bot's ticket tool) **about their own order, shipment or booking**, with one of these types:

`ORDER_ISSUE` · `ORDER_CANCELLATION` · `ORDER_REFUND` · `ORDER_DISPUTE` · `ORDER_FULFILLMENT` ·
`PAYMENT_ISSUE` · `CHARGEBACK` · `BOOKING_ISSUE` · `BOOKING_CANCELLATION` · `PRODUCT_ISSUE` ·
`SHIPPING_ISSUE` · `DELIVERY_DELAY` · `DELIVERY_CONFIRMATION` · `GENERAL_SUPPORT` · `OTHER`

If the money for that purchase has not been released yet:

- the order's (or booking's) earnings are **paused**, for every actor on it: seller, agency,
  agent. New pause reason: **`customer_problem_reported`**;
- the ticket carries **`holds_earnings: true`**;
- a public system note is added to the ticket: *"The earnings for this purchase are on hold
  while this request is open."*

If the money was already released, the request is created exactly as before and holds nothing
(`holds_earnings: false`). No error, no different status code.

Not a problem report, so never a pause: `INVOICE_REQUEST`, `ADDRESS_CHANGE`,
`BOOKING_RESCHEDULE`, `POLICY_QUESTION`, the account types, and anything about a product or
about nothing (`entityType: PRODUCT`, `OTHER`).

## What lifts the pause

| Who ends the request (resolved or closed) | Result |
|---|---|
| the **customer** who opened it | pause lifted. They may report a different problem later, and that pauses again |
| an **administrator** | pause lifted, and recorded as their decision: a later request about the same purchase does **not** pause it again by itself |
| the **seller**, agency or agent | **nothing**. They follow the request and can change its status, but that never frees their own money |

Also:

- an administrator can resume the earnings by hand at any time
  (`POST /api/v1/money/earnings/pauses/:kind/:id/resume`). That clears `holds_earnings` on every
  request about the purchase;
- with two open requests on one order, the pause stands until the **last** one ends;
- a **completed refund** closes the pause. A refund request that is rejected leaves it in place
  while a request is still open;
- when the pause lifts, the hold **continues** where it stopped. Paused time does not count.

## New fields

### `protection` on the customer's order and booking

On `GET /api/customer/orders/:id`, each order of the group read, and every customer booking read
(list, detail, cancel, reschedule). An order's window opens at delivery; a booking's when the
service is marked completed.

```json
"protection": {
  "days": 3,
  "startsAt": "2026-10-10T09:12:00.000Z",
  "endsAt": "2026-10-13T09:12:00.000Z",
  "status": "active",
  "onHold": false,
  "problemReported": false
}
```

| Field | Meaning |
|---|---|
| `days` | the configured window (`EARNINGS_HOLD_DAYS`) |
| `startsAt` | delivery. `null` until the order is delivered |
| `endsAt` | when the window closes. `null` before delivery **and while the money is on hold** |
| `status` | `not_started` · `active` · `ended` |
| `onHold` | the order's earnings are paused right now, whatever the reason |
| `problemReported` | …and the reason is this customer's own problem report |

Always present. A display hint: it is computed from the order alone, so it can lag the real
release by up to the daily sweep, in the customer's favour.

### `holds_earnings` on a ticket

Present on every enriched ticket read (create, list, detail), for every role. `true` while the
request keeps the purchase's earnings paused.

### Pause reason `customer_problem_reported`

A sixth value of `pause.reason`. **Only the admin API exposes the reason** (wi-admin's pause
queue and pause record). Seller, agency and agent APIs never carried a pause reason and still do
not: those apps learn about the hold from `holds_earnings` on the ticket. Suggested admin label:
"Customer reported a problem".

## Per app

| App | What to do |
|---|---|
| **Customer / shop** | Show the deadline from `protection` on a delivered order ("Report a problem before …"). When `problemReported`, say the seller's payment is on hold while the request is open. After `ended`, say Wi-Mall has limited means to help and the seller is the first contact. On ticket creation, read `holds_earnings` to confirm which of the two happened |
| **Vendor dash** | On a ticket with `holds_earnings: true`, say the earnings for that order are on hold, and that resolving it yourself does not release them: the customer or Wi-Mall does. Update the paused-earnings help text |
| **Agency dash / agent app** | Same banner on a ticket with `holds_earnings: true`: their delivery fee on that order is on hold too. "7 days" becomes "3 days" wherever the app explains a parcel left at `agent_delivered` |
| **Admin dash** | The new reason appears in the pause queue. Resolving or closing the request lifts the pause; so does a manual resume. Both are final for that purchase |
| **Bot (n8n)** | Nothing to change in the workflows: the bot's ticket paths go through the same service |

## Where it lives

- Rule: `src/modules/tickets/domain/problem-report.rule.ts`
- Service: `src/modules/tickets/services/ticket-earnings-hold.service.ts`
- Window: `protectionWindowOf` in `src/modules/earnings/domain/earnings-hold.ts`
- Tests: `npm run test:problem-report-hold` (offline, 32) · `npm run verify:problem-report-hold`
  (database, 21)

## Known limits

- A request nobody ends keeps the money paused. It is visible in the admin pause queue with its
  reason; there is no automatic expiry.
- A request opened while a **card dispute** pause is active is recorded, but when the dispute is
  won the money resumes without re-checking the request. The refund path does re-check.
- Reopening a closed ticket does not pause again. An administrator can pause by hand.
- **A booking's window opens when the service is marked completed** (`Booking.completedAt`, new
  on 2026-10-10). A booking completed before that date has no stamp: its `protection` falls back
  to the settlement date, or reads `not_started`.
- **The customer's booking reads no longer carry `earningsPause`** (the raw internal pause
  record, with the administrator's name and note). `protection` replaces it.
