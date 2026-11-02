# The referral page: `/api/me/referral`

Shared by every role. The partner belongs to the person, not to the role they are signed in as, so a
vendor who also shops sees the same partnership in both apps. All routes need a signed-in user.

The program starts **switched off**. While it is off, `program.enabled` is `false` and applying is refused.

## `GET /api/me/referral`

Everything the page needs to decide what to show.

**Someone who has never applied:**

```json
{
  "program": { "enabled": true, "minPayoutAmount": 1000, "rewardWaitDays": 14 },
  "status": "none",
  "canApply": true
}
```

**A partner:**

```json
{
  "program": { "enabled": true, "minPayoutAmount": 1000, "rewardWaitDays": 14 },
  "status": "active",
  "statusReason": null,
  "canApply": false,
  "code": "ULRICH123",
  "codeActive": true,
  "links": {
    "registerUrl": "https://wi-mall.com/register?ref=ULRICH123",
    "whatsappUrl": "https://wa.me/237652705926?text=Wi-Mall%20ref%3A%20ULRICH123",
    "telegramUrl": "https://t.me/WiMallBot?start=ref_ULRICH123"
  },
  "appliedAt": "2026-11-02T10:00:00.000Z",
  "approvedAt": "2026-11-02T12:00:00.000Z",
  "terms": {
    "vendor": { "ratePercent": 3, "durationMonths": 6 },
    "customer": { "ratePercent": 3, "durationMonths": 6 },
    "agency": { "ratePercent": 3, "durationMonths": 6 }
  },
  "balances": { "pending": 630, "available": 2100, "reserve": 0, "requested": 0, "clawback": 0, "currency": "XAF" },
  "balanceFrozen": false,
  "canWithdraw": true,
  "payoutDestination": {
    "source": "vendor",
    "editableHere": false,
    "method": { "method": "mobile_money", "is_preferred": true, "mobile_money": { "provider": "mtn", "phone_number_masked": "••••••••5831", "account_name": "Ulrich M" }, "bank": null, "card": null }
  },
  "referred": { "total": 12, "earning": 9 }
}
```

| Field | Meaning |
|---|---|
| `status` | `none` · `pending` · `active` · `rejected` · `suspended` · `terminated` |
| `statusReason` | The administrator's reason for a rejection, suspension or termination. Written to be shown to the partner |
| `canApply` | Show the application form. True for someone new and for a rejected or terminated person only after an administrator allowed it |
| `codeActive` | `false` while suspended or terminated. The code and link are still shown, but people who use them register normally and earn the partner nothing, so say so |
| `balances.pending` | Rewards still in the wait (`program.rewardWaitDays`) |
| `balances.available` | What can be withdrawn |
| `balances.clawback` | What the partner owes back after a refund. While above 0, `available` is 0 and later rewards pay it first. It runs the other way: never add it to the others |
| `balanceFrozen` | Suspended or terminated, and no administrator has released the balance. Withdrawing is refused |
| `canWithdraw` | Show the withdraw button: not frozen, at least `minPayoutAmount` available, and a destination exists |

### The payout destination

Show `payoutDestination.method` masked, whichever source it came from.

| `source` | `editableHere` | What the page does |
|---|---|---|
| `vendor`, `agency` or `agent` | `false` | Shows it with a link to that app's existing payout page. It is read live, so editing it there changes it here |
| `referral` | `true` | The person's own, saved on this page. Offer to change it |
| `null` | `true` | Nothing yet (a customer). Ask for one before they can withdraw |

## `POST /api/me/referral/application`

```json
{ "termsAccepted": true, "motivation": "I know many shops in Douala" }
```

`termsAccepted` must be literally `true`: accepting the Partner Terms is what an application is.
`motivation` is optional, up to 1,000 characters. Answers `201` with `{ status, appliedAt }`.

| Code | Status | When |
|---|---|---|
| `REFERRAL_PROGRAM_DISABLED` | 409 | The program is off |
| `REFERRAL_ALREADY_APPLIED` | 409 | Already pending, active or suspended |
| `REFERRAL_REAPPLY_NOT_ALLOWED` | 409 | Rejected or terminated, and no administrator has allowed it |

## `GET /api/me/referral/referred`

`?page=1&limit=20`. The accounts this partner referred, newest first.

```json
{
  "data": [
    {
      "id": "…",
      "name": "C***** N*****",
      "category": "customer",
      "registeredAt": "2026-11-02T10:00:00.000Z",
      "expiresAt": "2027-05-01T23:00:00.000Z",
      "earning": true,
      "totalEarned": 420
    }
  ],
  "meta": { "total": 12, "page": 1, "limit": 20, "totalPages": 1 }
}
```

`category` may be `agent`: recorded, with `expiresAt: null` and `earning: false`, because an agent's own
activity never earns.

## `GET /api/me/referral/rewards`

`?page=1&limit=20`. Rewards, newest first.

```json
{
  "data": [
    {
      "id": "…",
      "name": "C***** N*****",
      "category": "customer",
      "amount": 120,
      "currency": "XAF",
      "status": "released",
      "earnedAt": "2026-11-02T10:00:00.000Z",
      "availableFrom": "2026-11-16T10:00:00.000Z",
      "adjusted": true
    }
  ],
  "meta": { "total": 1, "page": 1, "limit": 20, "totalPages": 1 }
}
```

| Field | Meaning |
|---|---|
| `amount` | What this reward is worth **now**, after any refund |
| `adjusted` | A refund reduced it |
| `status` | `held` (waiting) · `released` (counted in available) · `reversed` (the whole commission was refunded; show it as 0) |

⛔ There is deliberately no order, product, vendor or commission figure on this list or the one above.
Don't ask for them: a commission and a vendor's plan reveal that vendor's sales, and an order reveals what
a person bought.

## `POST /api/me/referral/payout`

No body. Withdraws the **whole** available balance through the usual payout process: an administrator
handles it. Answers `201` with one row in the shape below.

| Code | Status | When |
|---|---|---|
| `REFERRAL_PARTNER_NOT_FOUND` | 404 | Never applied |
| `REFERRAL_BALANCE_FROZEN` | 409 | Suspended or terminated, not yet released |
| `EARNINGS_PAYOUT_METHOD_MISSING` | 409 | No destination |
| `EARNINGS_PAYOUT_ALREADY_PENDING` | 409 | One is already waiting |
| `EARNINGS_PAYOUT_NO_AVAILABLE_BALANCE` | 409 | Nothing available |
| `EARNINGS_PAYOUT_BELOW_MINIMUM` | 409 | Below the minimum. `details.minAmount` |

## `GET /api/me/referral/payouts`

`?page=1&limit=20`.

```json
{
  "data": [
    {
      "id": "…",
      "amount": 2100,
      "currency": "XAF",
      "status": "paid",
      "destination": { "method": "mobile_money", "is_preferred": true, "mobile_money": { "provider": "mtn", "phone_number_masked": "••••••••5831", "account_name": "Ulrich M" }, "bank": null, "card": null },
      "rejectionReason": null,
      "requestedAt": "2026-11-20T10:00:00.000Z",
      "resolvedAt": "2026-11-20T15:00:00.000Z"
    }
  ],
  "meta": { "total": 1, "page": 1, "limit": 20, "totalPages": 1 }
}
```

## `PUT /api/me/referral/payout-method`

For someone with no destination on a role. The body is one payout method, the same shape as the existing
payout pages:

```json
{ "method": "mobile_money", "mobile_money": { "provider": "mtn", "phone_number": "+237672745831", "account_name": "Carine N" } }
```

Answers `{ source, editableHere, method }`. `REFERRAL_PAYOUT_METHOD_MANAGED_ELSEWHERE` (409,
`details.source`) means a role on the account already holds one: send them to that page.

## Public: `GET /api/public/referral/:code`

No sign-in. For the page behind a referral link.

```json
{
  "valid": true,
  "code": "ULRICH123",
  "registerUrl": "https://wi-mall.com/register?ref=ULRICH123",
  "whatsappUrl": "https://wa.me/237652705926?text=Wi-Mall%20ref%3A%20ULRICH123",
  "telegramUrl": "https://t.me/WiMallBot?start=ref_ULRICH123"
}
```

An unknown code, a suspended partner and a disabled program all answer `valid: false`, `code: null`, with
the same links carrying no code. Treat that as an ordinary visit and show no error.

## Registering with a code

`POST /api/auth/register` and `POST /api/auth/mobile/register` accept an optional `referral_code`. It never
refuses a registration: a bad code is simply ignored, and nothing in the response says what happened to it.
Only a brand-new account can be referred, so adding a role never takes one.
