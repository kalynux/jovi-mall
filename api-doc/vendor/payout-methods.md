# Vendor Payout Methods

**Where the platform sends your money.** This page is the complete field reference for
`payout_details` on the vendor side — the [Onboarding](./onboarding.md) and
[Profile](./profile.md) docs link here for the sub-schema.

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
> **Build the mobile-money form now**; leave bank and card out of the UI, or render them disabled.
> Their field references are kept below so you can build against them the day they come back.
>
> **Nothing already stored is affected.** An entry configured before the switch still reads back in
> full, and a payout already destined for it is still paid — switching a kind off never strands
> money. The one catch: writes are a **full replace**, so you cannot re-send a list containing a
> switched-off entry. Replace it with a mobile-money one. (Omitting `payout_details` entirely leaves
> the stored list untouched, so unrelated profile edits are unaffected.)

> [!IMPORTANT]
> **Not to be confused with [Payment methods](./payment-methods.md).** Those are the cards you pay
> *with* — billing plans, credit top-ups. These are where you get paid *to*. Different collection,
> different endpoints, different lifecycle. A card saved as a payment method does **not** become a
> payout destination, and vice versa.

The schema is shared byte-for-byte with agencies and agents, so anything you learn here transfers.

---

## Where you set it

| Action | Endpoint | Notes |
|---|---|---|
| First time (onboarding) | `PUT /api/vendor/onboarding/basic-setup` | Step 1, alongside `country` + `timezone`. See [Step 1](./onboarding.md#step-1-basic-setup-required) |
| Every edit afterwards | `PATCH /api/vendor/profile` | Requires `version`. Onboarding endpoints return `409` once complete |
| Read it back | `GET /api/vendor/profile` → `payoutDetails` | **Masked**, and only the preferred method — see [Reading it back](#reading-it-back) |

**Auth**: all three require a `vendor` JWT.

---

## The list

`payout_details` is an **ordered array**, and the order is the meaning:

- **Minimum 1** entry, **maximum 3**.
- **Index 0 is the preferred method** — the one a payout request actually uses. Reordering *is* the
  edit.
- **Any mix of kinds is allowed**, including duplicates: two mobile-money numbers are valid.
  Nothing dedupes by `method`.
- **Full replace, never a merge.** Send the complete desired array every time; the value you send
  replaces the stored one wholesale.

```jsonc
"payout_details": [
  { "method": "mobile_money", "mobile_money": { /* … */ } },   // ← preferred
  { "method": "mobile_money", "mobile_money": { /* … */ } }
]
```

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

```json
{
  "method": "mobile_money",
  "mobile_money": {
    "provider": "MTN Mobile Money",
    "phone_number": "+237670000000",
    "account_name": "Tech Solutions Sarl"
  }
}
```

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
    "account_name": "Tech Solutions Sarl",
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
    "card_holder_name": "JEAN DUPONT",
    "expiry_month": 8,
    "expiry_year": 2029,
    "country": "CM",
    "issuing_bank": "Afriland First Bank"
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

If your client has tokenized the card through a payment-gateway SDK, send the resulting token as
`gateway_token` (with `gateway_provider` naming the gateway). It is stored alongside the display
fields and is what an automated push-to-card transfer will use once a card-payout gateway is wired
up.

**Until then a card destination is settled the same way a bank one is:** the admin processing the
payout request confirms the destination from brand + last4 + holder + expiry, sends the money out of
band, and records the external reference. So a card with no token is a perfectly valid destination —
it is just not yet an automatable one. If you want the fastest settlement today, make a mobile-money
or bank entry your **index 0**.

---

## Full example — replace your payout list

```bash
# 1. Read your current version
curl -X GET https://api.example.com/api/vendor/profile \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
# Response: { "data": { "version": 8, ... } }

# 2. Replace the whole list — a primary number and a fallback
curl -X PATCH https://api.example.com/api/vendor/profile \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "payout_details": [
      {
        "method": "mobile_money",
        "mobile_money": {
          "provider": "MTN Mobile Money",
          "phone_number": "+237670000000",
          "account_name": "Tech Solutions Sarl"
        }
      },
      {
        "method": "mobile_money",
        "mobile_money": {
          "provider": "Orange Money",
          "phone_number": "+237690000000",
          "account_name": "Tech Solutions Sarl"
        }
      }
    ],
    "version": 8
  }'
```

Swapping either entry for a `bank` or `card` object is what will work once those are switched back
on; today it returns `400` on `payout_details[n].method`.

---

## Reading it back

Payout details are **write-mostly by design**. You already know your own account, so echoing a full
account number to anything that can read your profile would turn a session hijack into a banking
detail leak for no benefit.

**Reads are not gated by the switch.** All three kinds render, because an entry configured before
`bank`/`card` were switched off must still be visible to the owner who set it.

- `mobile_money.phone_number` → `phone_number_masked`
- `bank.account_number` → `account_number_masked`
- `card` → unchanged. Nothing is redacted, because nothing sensitive was ever stored: `last4` is
  returned as-is, plus a rendered `number_masked` so a client can print all three kinds through one
  code path. `gateway_token` and `gateway_provider` are **never** returned.

> [!NOTE]
> **The vendor read shape is the PREFERRED method only** — `payoutDetails` on `GET /api/vendor/profile`
> is a single object (or `null`), not the array you sent, and it carries no `is_preferred` flag
> because there is nothing to compare it to. You store an ordered list of up to 3; this read returns
> index 0, the one payouts actually use. (Agencies and agents get the whole list, each entry flagged
> with `is_preferred`.)

```json
{
  "payoutDetails": {
    "method": "mobile_money",
    "mobile_money": {
      "provider": "MTN Mobile Money",
      "phone_number_masked": "••••••0000",
      "account_name": "Tech Solutions Sarl"
    },
    "bank": null,
    "card": null
  }
}
```

A pre-switch card entry reads back like this — still rendered, still masked, just no longer
re-writable:

```json
{
  "payoutDetails": {
    "method": "card",
    "mobile_money": null,
    "bank": null,
    "card": {
      "brand": "visa",
      "last4": "4242",
      "number_masked": "•••• •••• •••• 4242",
      "card_holder_name": "JEAN DUPONT",
      "expiry_month": 8,
      "expiry_year": 2029,
      "issuing_bank": "Afriland First Bank",
      "country": "CM"
    }
  }
}
```

> **A read-back is not a round-trip.** You cannot GET the masked value, change one field and PATCH it
> back — the masked values are not the stored ones. Because writes are a full replace, editing one
> method means re-collecting the others' secrets, or (better) keeping the unedited entries as the
> user typed them client-side. This has always been true of `bank` and `mobile_money`; `card` is the
> one kind that *could* round-trip, but the list is validated as a whole, so it can't.

---

## What happens at payout time

A payout request **snapshots** the preferred method (index 0) onto itself at creation. Editing your
payout details afterwards does not move an in-flight request — see
[Earnings — Requesting a payout](./earnings.md#requesting-a-payout).

With **no** payout method configured, `POST /api/vendor/earnings/payout` is refused with
`409 EARNINGS_PAYOUT_METHOD_MISSING`, and the nightly automatic-payout sweep (at 2,000,000 XAF) hits
the same wall on your behalf and logs it. Configure at least one before your balance matures.

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
| `409` | `EARNINGS_PAYOUT_METHOD_MISSING` | A payout was requested with an empty list. |
| `409` | `CONFLICT` | The `version` you sent to `PATCH /profile` is stale (optimistic locking) — re-read and retry. |

Full catalog: [errors/README.md](../errors/README.md).
