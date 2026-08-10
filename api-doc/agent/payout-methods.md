# Agent Payout Methods

**Where the platform sends your money.** This page is the complete field reference for
`payout_details` on the agent side; [Earnings](./earnings.md) links here from the withdrawal flow.

<a name="availability"></a>

> [!IMPORTANT]
> ## 🚧 Only mobile money is available right now
>
> **`bank` and `card` are switched off.** They are built, validated and documented — the switch is
> temporary — but today they are refused at the write path:
>
> ```json
> {
>   "success": false,
>   "error": {
>     "code": "VALIDATION_ERROR",
>     "statusCode": 400,
>     "details": { "fields": [
>       { "path": "payout_details.0.method", "message": "Bank transfer payouts are not available right now. Currently accepted: mobile money." }
>     ] }
>   }
> }
> ```
>
> **Build the mobile-money form now**; leave bank and card out of the app, or render them disabled.
> Their field references are kept below so you can build against them the day they come back.
>
> **Nothing already stored is affected.** An entry configured before the switch still reads back in
> full, and a payout already destined for it is still paid — switching a kind off never strands
> money. The one catch: writes are a **full replace**, so you cannot re-send a list containing a
> switched-off entry. Replace it with a mobile-money one.

> [!IMPORTANT]
> **Not to be confused with [Payment methods](./payment-methods.md).** Those are the cards you pay
> *with* — your billing plan, credit top-ups. These are where you get paid *to*. Different
> collection, different endpoints, different lifecycle. A card saved as a payment method does **not**
> become a payout destination, and vice versa.

> [!NOTE]
> **This is deliberately not part of onboarding.** You can work, and accrue a balance, before you
> have told us where to send it — the *payout request* is what needs a destination, not the
> delivery. Set one before your balance matures, not before your first shipment.

The schema is shared byte-for-byte with vendors and agencies, so anything you learn here transfers.

---

## Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/agent/payout-methods` | Your saved destinations, **masked** |
| `PUT` | `/api/agent/payout-methods` | Set or replace the whole list |

**Auth**: both require an `agent` JWT. Unlike vendors and agencies — whose payout details ride on
the profile endpoint — the agent has a dedicated pair, and payout details are **never** included in
the agent profile response (they sit alongside `legal_identity` as a sensitive field with its own
door).

### PUT /api/agent/payout-methods

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

Swapping either entry for a `bank` or `card` object is what will work once those are switched back
on; today it returns `400` on `payout_details[n].method`.

**Success** (`200 OK`): the saved list, masked — the same shape `GET` returns.

---

## The list

`payout_details` is an **ordered array**, and the order is the meaning:

- **Minimum 1** entry, **maximum 3**.
- **Index 0 is the preferred method** — the one a payout request actually uses. Reordering *is* the
  edit.
- **Any mix of kinds is allowed**, including duplicates: two mobile-money numbers are valid.
  Nothing dedupes by `method`.
- **Replaced wholesale, never merged.** Because the list is ordered, a field-by-field merge would
  have no meaning. Send the complete desired array every time.

| Field | Type | Required? | Validation | Notes |
|---|---|---|---|---|
| `payout_details` | `object[]` | Yes | 1–3 entries | Ordered; index 0 is preferred. |
| `payout_details[].method` | `string` | Yes | **Today: `"mobile_money"` only.** `"bank"` and `"card"` are [switched off](#availability) | Selects which sub-object is required. |
| `payout_details[].mobile_money` | `object \| null` | Conditional | Required iff `method === "mobile_money"` | [Sub-fields](#mobile-money) |
| `payout_details[].bank` | `object \| null` | Conditional | Required iff `method === "bank"` | 🚧 Switched off — [sub-fields](#bank) |
| `payout_details[].card` | `object \| null` | Conditional | Required iff `method === "card"` | 🚧 Switched off — [sub-fields](#card) |

One switched-off entry rejects the **whole list**, wherever it sits — index 0 or last.

The unused branches may be omitted or sent as `null` — either way the server normalises them to
`null`. Sending a populated sub-object that doesn't match `method` is a `400 VALIDATION_ERROR`.

Every text field is **trimmed first, then length-checked**: `"   "` is refused, not stored blank.

---

<a name="mobile-money"></a>
## `mobile_money`

| Field | Type | Required? | Validation |
|---|---|---|---|
| `provider` | `string` | Yes | Min 1 char after trim. E.g. `"MTN Mobile Money"`, `"Orange Money"` |
| `phone_number` | `string` | Yes | **E.164** — leading `+` and country code (e.g. `+237670000000`). [Contact formats](../README.md#contact-formats-phone--email) |
| `account_name` | `string` | Yes | Min 1 char after trim |

A national number is rejected, not normalised: this is where the platform sends money, so an
un-dialable number is a payout instruction nobody can execute.

---

<a name="bank"></a>
## `bank` 🚧 switched off

> **Not configurable right now** — see [the notice above](#availability).
> Kept documented because the switch is temporary and stored entries still read back.

| Field | Type | Required? | Validation |
|---|---|---|---|
| `bank_name` | `string` | Yes | Min 1 char after trim |
| `account_number` | `string` | Yes | Min 1 char after trim. IBAN / RIB / local account number — not format-checked |
| `account_name` | `string` | Yes | Min 1 char after trim |
| `country` | `string` | Yes | Min 1 char after trim. ISO-2 recommended (e.g. `"CM"`) |

```json
{
  "method": "bank",
  "bank": {
    "bank_name": "Afriland First Bank",
    "account_number": "10005000123456789",
    "account_name": "Jean Doe",
    "country": "CM"
  }
}
```

---

<a name="card"></a>
## `card` — Visa, Mastercard & friends 🚧 switched off

> **Not configurable right now** — see [the notice above](#availability).
> Everything below is live in the code and under test; it is the *switch* that is off, not the
> feature that is unfinished. Read it when you build the form, not before.

> [!WARNING]
> **Read this before you build the form.**
>
> **The API never accepts a card number or a CVV. Not optionally, not "just for verification".**
> Send them and the request is **rejected** — not silently ignored, so you cannot mistake a `200`
> for "the number is on file". A card payout destination is identified by **brand + last 4 + holder
> + expiry**, and nothing more.
>
> This is the same rule the pay-in side already follows: full PANs and CVVs live at the payment
> gateway, never in jovi-mall's database. Storing one here would put every collection in PCI-DSS
> scope for no product benefit.

| Field | Type | Required? | Validation |
|---|---|---|---|
| `brand` | `string` | Yes | Enum: `visa` · `mastercard` · `amex` · `discover` · `unionpay` · `jcb` · `diners` · `verve` · `other`. **Case-insensitive** — `"VISA"` is accepted and stored as `"visa"` |
| `last4` | `string` | Yes | Exactly 4 digits — the last 4 of the card number. Take them client-side; never send the rest |
| `card_holder_name` | `string` | Yes | Min 1 char after trim. As embossed on the card |
| `expiry_month` | `number` | Yes | Integer 1–12 |
| `expiry_year` | `number` | Yes | Integer, 4-digit (2000–2100) |
| `country` | `string` | Yes | Min 1 char after trim. Issuing country, ISO-2 recommended |
| `issuing_bank` | `string \| null` | No | Max 100 chars. `""` / `null` clears it |
| `gateway_provider` | `string \| null` | No | Max 50 chars. E.g. `"stripe"` — see [Tokens](#tokens) below |
| `gateway_token` | `string \| null` | No | Max 255 chars. The gateway's handle for this card |

**The card must not be expired.** A card is valid *through* the last day of its expiry month, so the
current month is fine and last month is a `400`. This is checked at write time on purpose: by payout
time nobody is in the room to fix it.

```json
{
  "method": "card",
  "card": {
    "brand": "visa",
    "last4": "4242",
    "card_holder_name": "JEAN DOE",
    "expiry_month": 8,
    "expiry_year": 2029,
    "country": "CM"
  }
}
```

Rejected — the PAN is present:

```jsonc
{
  "method": "card",
  "card": { "brand": "visa", "number": "4242424242424242", "cvv": "123", /* … */ }
}
```

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "statusCode": 400,
    "details": {
      "fields": [
        { "path": "payout_details.0.card.number", "message": "Card numbers and security codes are never accepted or stored. Send only brand, last4, holder, expiry and country (plus a gateway token if you have one)." },
        { "path": "payout_details.0.card.cvv", "message": "Card numbers and security codes are never accepted or stored. Send only brand, last4, holder, expiry and country (plus a gateway token if you have one)." }
      ]
    }
  }
}
```

The refused field names are `number`, `card_number`, `pan`, `account_number`, `cvv`, `cvc`, `cvn`
and `security_code`. Any *other* unrecognised field is simply dropped — it is not stored and not
returned.

<a name="tokens"></a>
### `gateway_token` — optional today, the transfer handle tomorrow

If your app has tokenized the card through a payment-gateway SDK, send the resulting token as
`gateway_token` (with `gateway_provider` naming the gateway). It is stored alongside the display
fields and is what an automated push-to-card transfer will use once a card-payout gateway is wired
up.

**Until then a card destination is settled the same way a bank one is:** the admin processing the
payout request confirms the destination from brand + last4 + holder + expiry, sends the money out of
band, and records the external reference. So a card with no token is a perfectly valid destination —
it is just not yet an automatable one. If you want the fastest settlement today, make a mobile-money
or bank entry your **index 0**.

---

## Reading it back

### GET /api/agent/payout-methods

Payout details are **write-mostly by design**. You already know your own account, so echoing a full
account number back would mean a stolen session could read your banking details out of the API.

**Reads are not gated by the switch.** All three kinds render, because an entry configured before
`bank`/`card` were switched off must still be visible to the agent who set it — the card entry in
the example below is exactly that case.

- `mobile_money.phone_number` → `phone_number_masked`
- `bank.account_number` → `account_number_masked`
- `card` → unchanged. Nothing is redacted, because nothing sensitive was ever stored: `last4` is
  returned as-is, plus a rendered `number_masked` so your app can print all three kinds through one
  code path. `gateway_token` and `gateway_provider` are **never** returned.

`is_preferred` is read-only (`true` only for index 0) — never send it.

**Success** (`200 OK`):

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

> **A read-back is not a round-trip.** You cannot GET the masked list, change one entry and PUT it
> back — the masked values are not the stored ones. Because writes are a full replace, editing one
> method means re-collecting the others' secrets, or (better) keeping the unedited entries as the
> user typed them client-side. This has always been true of `bank` and `mobile_money`; `card` is the
> one kind that *could* round-trip, but the list is validated as a whole, so it can't. To correct a
> number, send the whole list again.

---

## What happens at payout time

A payout request **snapshots** the preferred method (index 0) onto itself at creation. Editing your
payout details afterwards does not move an in-flight request — see
[Earnings](./earnings.md#payout-methods).

With **no** payout method configured, `POST /api/agent/earnings/payout` is refused with
`409 EARNINGS_PAYOUT_METHOD_MISSING`, and the nightly automatic-payout sweep hits the same wall on
your behalf and logs it. Configure at least one before your balance matures.

**A switched-off kind is still paid.** The snapshot and the admin queue don't consult the switch —
if your index 0 was a bank entry before `bank` was switched off, that payout goes where it always
would have. Switching a kind off closes the door on *new* configuration, never on money already
addressed.

---

## Errors

| Status | Code | When |
|---|---|---|
| `400` | `VALIDATION_ERROR` on `payout_details[n].method` | The kind is **switched off** — today, anything but `mobile_money`. Message: *"Bank transfer payouts are not available right now. Currently accepted: mobile money."* |
| `400` | `VALIDATION_ERROR` | Any field above fails — including a PAN/CVV in the card object, an expired card, an off-vocabulary brand, a `last4` that isn't 4 digits, or a list outside 1–3 entries. Map `details.fields[].path` to your form. |
| `404` | `AGENT_NOT_FOUND` | No agent record for the authenticated user. |
| `409` | `EARNINGS_PAYOUT_METHOD_MISSING` | A payout was requested with an empty list. |

Full catalog: [errors/README.md](../errors/README.md).
