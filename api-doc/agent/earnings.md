# Agent Earnings

## Base Path

```
/api/agent
```

## Authentication

**Authorization**: Agent access required. Bearer token with `agent` role.

## Endpoints

- [`GET /api/agent/earnings`](#earnings) — your held (pending) vs withdrawable (available) balance
- [`POST /api/agent/earnings/payout`](#requesting-a-payout) — request a payout of the entire available balance
- [`GET /api/agent/earnings/payout`](#requesting-a-payout) — your latest payout request
- [`GET /api/agent/payout-methods`](#payout-methods) — where payouts are sent (masked)
- [`PUT /api/agent/payout-methods`](#payout-methods) — set/replace your payout destinations
  (mobile money · bank · card — full reference in [Payout methods](./payout-methods.md))

Related: [`GET /api/agent/transactions?category=earning`](./billing.md) is the itemised history
feed; the endpoints here are the balance and the withdrawal.

---

## How your balance is built

You are paid **per delivery run**, a share of the delivery fee the vendor was charged for that
shipment. The share is set by `fee_split` on your contract with the agency that dispatched it —
either a percentage of the fee or a flat amount per delivery (see
[cod-cash.md](./cod-cash.md) and your agency's roster settings).

**Every physical delivery earns it — cash or card alike.** The moment it lands differs:

| Order type | You are credited when… |
|---|---|
| **Online-paid (prepaid)** | you mark the shipment `agent_delivered` |
| **Cash on delivery** | you submit the customer's delivery code and the cash is recorded |

A shipment that ends **`returned`** still earns: the agency's return-to-origin rate replaces the
delivery fee, and you take your contracted share of that instead.

Two things are worth knowing about the amount:

- **Your cut comes out of the agency's fee, not on top of it.** The vendor pays the same either
  way; the agency shares the fee with whoever actually made the run.
- **It is capped at the fee.** A flat `fee_split` negotiated above what a delivery earns is clamped
  down — the platform can only divide the fee it collected.
- If you have **no live contract** with the agency at the moment of the split (e.g. it was
  terminated with your shipment still in flight), the cut is `0` and the fee stays whole with the
  agency. Raise it with the agency; it is logged on our side.

### You are paid by the platform, not by the agency

The agency **owes** you the cut under your contract, but the **platform pays** it — it lands in
your own balance here and leaves through the ordinary payout request below. Nothing is settled
off-platform. This is the opposite direction to COD *cash*, which you collect and owe **upward**
(see [cod-cash.md](./cod-cash.md)) — the two balances are unrelated and never net against each
other.

### When it becomes withdrawable

Money is **held** (`pending`) when the split happens, and becomes **available** only after:

1. the **whole order** completes — every shipment on it confirmed or returned, not just yours
   (a customer who never confirms is auto-confirmed 7 days after delivery), **and**
2. a further **7-day hold window** elapses. A daily sweep moves matured holds to `available`.

Every actor on an order — vendor, platform, agency and you — matures on the same date. Your cut is
never released early and never held longer than theirs.

**COD only:** your cut is additionally held until the cash you collected has physically reached
the platform (agent → agency → platform, confirmed). You cannot withdraw a share of money you are
still holding. Prepaid earnings have no such gate — that money is already with the platform.

---

<a name="earnings"></a>
### GET /api/agent/earnings

**Description**: Your current pending (held) and available (withdrawable) balance.

**Success Response** (`200 OK`):
```json
{
  "success": true,
  "data": {
    "pending": 4500,
    "available": 12000,
    "reserve": 0,
    "requested": 0,
    "currency": "XAF"
  }
}
```

| Field | Meaning |
|---|---|
| `pending` | Earned, held in escrow — not yet withdrawable |
| `available` | Withdrawable now |
| `reserve` | Always `0` for agents. The rolling reserve applies only to agencies, against COD cash-handling risk; the field is present for shape-parity with the other roles |
| `requested` | Earmarked for an in-flight payout request |

Amounts are integers in minor currency units.

---

<a name="requesting-a-payout"></a>
### POST /api/agent/earnings/payout

**Description**: Request a payout of your **entire** available balance. Opens a `PAYOUT_REQUEST`
ticket for an admin to process; track it under Tickets.

**Request Body**: none.

**Success Response** (`201 Created`):
```json
{
  "success": true,
  "data": {
    "id": "665f...",
    "amount": 12000,
    "currency": "XAF",
    "status": "pending",
    "origin": "manual",
    "ticketId": "665f...",
    "createdAt": "2026-07-29T10:12:00.000Z"
  },
  "message": "Payout request created. Track its progress under Tickets."
}
```

Rules — the same for every role:

- **All or nothing.** You cannot request a partial amount.
- **Minimum 10 000** (`EARNINGS_MIN_PAYOUT_AMOUNT`) → `EARNINGS_PAYOUT_BELOW_MINIMUM`.
- **One at a time.** A pending request must be resolved first.
- **A payout method is required** → `EARNINGS_PAYOUT_METHOD_MISSING` if you have none set. Set one
  first, below.
- The method is **snapshotted** onto the request, so editing it afterwards does not redirect a
  payout already in flight.
- If your balance reaches **2 000 000** (`EARNINGS_AUTO_PAYOUT_THRESHOLD`) the platform opens a
  request on your behalf automatically — same flow, `origin: "auto_threshold"`. This still needs a
  payout method on file, so set one even if you do not intend to withdraw soon.

### GET /api/agent/earnings/payout

Your latest payout request, or `data: null` if you have never made one. Includes
`rejectionReason` and `resolvedAt` once an admin has acted.

---

<a name="payout-methods"></a>
### PUT /api/agent/payout-methods

**Description**: Set or replace where your payouts are sent.

> 🚧 **Only `mobile_money` can be configured right now.** `bank` and `card` are switched off at the
> write path — sending either returns `400 VALIDATION_ERROR` on `payout_details[n].method`. Entries
> stored before the switch still read back and are still paid. See
> [Payout methods](./payout-methods.md#availability).

**Request Body**:
```json
{
  "payout_details": [
    {
      "method": "mobile_money",
      "mobile_money": {
        "provider": "MTN",
        "phone_number": "+237670000000",
        "account_name": "Jean Doe"
      }
    },
    {
      "method": "mobile_money",
      "mobile_money": {
        "provider": "Orange Money",
        "phone_number": "+237690000000",
        "account_name": "Jean Doe"
      }
    }
  ]
}
```

- **Ordered**: the **first** entry is the one payouts actually use. Reordering is how you change
  the preferred destination.
- 1–3 entries. The shape knows `mobile_money`, `bank` and `card`, but only **`mobile_money`** may be
  sent today; the unused branches are ignored. Duplicates of one kind are fine (two numbers, say).
- **Replaced wholesale**, not merged — because the list is ordered, a field-by-field merge would
  have no meaning.
- `mobile_money.phone_number` must be **E.164** (leading `+` and country code) — this is where the
  platform sends money, so a national number is rejected. See
  [Contact formats](../README.md#contact-formats-phone--email).
- **A `card` never carries a card number or CVV.** Send brand + last4 + holder + expiry + country
  (plus a `gateway_token` if your app tokenized the card). Sending `number`/`pan`/`cvv` is a `400`,
  refused rather than silently dropped. The card must not already be expired.

> **Full field reference — every kind, every validation rule, the card policy in depth, masking and
> how a card payout is settled today: [Payout methods](./payout-methods.md).** This section is the
> short version.

**Success Response** (`200 OK`): the saved list, **masked** (see below).

### GET /api/agent/payout-methods

**Success Response** (`200 OK`):
```json
{
  "success": true,
  "data": [
    {
      "method": "mobile_money",
      "is_preferred": true,
      "mobile_money": {
        "provider": "MTN",
        "phone_number_masked": "•••••••6000",
        "account_name": "Jean Doe"
      },
      "bank": null,
      "card": null
    },
    {
      "method": "card",
      "is_preferred": false,
      "mobile_money": null,
      "bank": null,
      "card": {
        "brand": "visa",
        "last4": "4242",
        "number_masked": "•••• •••• •••• 4242",
        "card_holder_name": "JEAN DOE",
        "expiry_month": 8,
        "expiry_year": 2029,
        "issuing_bank": null,
        "country": "CM"
      }
    }
  ]
}
```

Account identifiers are **never echoed in full** — only the last 4 characters. You already know
your own account, and masking means a stolen session cannot read your banking details out of the
API. To correct a number, send the whole list again.

A `card` block is returned unredacted, because there was never anything sensitive to redact: only
`last4` is stored. `gateway_token` and `gateway_provider` are write-only and never returned.

**Reads return every kind, including switched-off ones.** The card at index 1 above is an entry
saved before `card` was switched off — still listed, still paid if it were index 0, just no longer
re-writable. Reads and payouts never consult the switch; only writes do.

Note that a read-back is **not** a round-trip: the masked values are not the stored ones, so you
cannot GET the list, edit one entry and PUT it straight back. See
[Payout methods — Reading it back](./payout-methods.md#reading-it-back).

---

## Error Codes

| Code | HTTP | Meaning |
|---|---|---|
| `AGENT_NOT_FOUND` | 404 | No agent record for the authenticated user |
| `VALIDATION_ERROR` | 400 | A payout destination failed validation — see [Payout methods → Errors](./payout-methods.md#errors) |
| `EARNINGS_PAYOUT_NO_AVAILABLE_BALANCE` | 409 | `available` is `0` — nothing to request |
| `EARNINGS_PAYOUT_BELOW_MINIMUM` | 409 | Available balance is under the minimum |
| `EARNINGS_PAYOUT_METHOD_MISSING` | 409 | No payout method configured |
| `EARNINGS_PAYOUT_ALREADY_PENDING` | 409 | A payout request is already in flight |
