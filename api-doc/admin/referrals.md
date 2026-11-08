# `/api/internal/admin/referrals`

The write half of the referral program. **Consumed by wi-admin only**, behind `requireAdminCaller`, which
resolves permissions before it calls. wi-admin reads `referral_settings`, `referral_partners`,
`referral_relationships` and `referral_rewards` directly (ADR-004). Administrators use
`admin/api-doc/api/referrals.md`.

Every partner write answers a thin acknowledgement, never the document:

```json
{ "id": "…", "status": "active", "code": "ULRICH123", "canReapply": false, "balanceReleased": false }
```

| Route | Body | Refusal |
|---|---|---|
| `PATCH /settings` | any of `enabled`, `terms.{vendor,customer,agency,provider}.{ratePercent,durationMonths}`, `minPayoutAmount`, `rewardWaitDays` | `400` out of range |
| `POST /partners/:id/approve` | `{ reason? }` | `409 REFERRAL_PARTNER_STATUS_CONFLICT` unless `pending` |
| `POST /partners/:id/reject` | `{ reason }` | same |
| `POST /partners/:id/suspend` | `{ reason }` | unless `active` |
| `POST /partners/:id/reinstate` | `{ reason? }` | unless `suspended` |
| `POST /partners/:id/terminate` | `{ reason }` | unless `active` or `suspended` |
| `POST /partners/:id/allow-reapply` | none | unless `rejected` or `terminated`, and not already allowed |
| `POST /partners/:id/release-balance` | `{ reason }` | `409 REFERRAL_BALANCE_NOT_FROZEN` unless frozen |
| `PATCH /partners/:id/terms` | `terms.{vendor,customer,agency,provider}.{ratePercent,durationMonths}`, `null` resets a field | `400` out of range |

🆕 **`provider` (2026-11-08, owner RS-3).** A vendor who registered as a service provider is referred under `provider`,
not `vendor`. It earns a percentage of the **full price** the provider pays Wi-Mall for a plan or a credit pack
(RS-6), judged **at the payment** (RS-5) and held for `rewardWaitDays` like any reward. A payment later reversed —
a lost card dispute, or a completed refund — claws the whole reward back. Such a reward has
`commission_allocation_id: null`, `source_type` `plan_purchase` | `credit_topup`, and `commission_earned` holding
the price paid. A seller referred as `vendor` still earns on commission only, never on what they pay for a plan.

A rate is 0 to 25 with up to two decimals, and a duration is 1 to 120 whole months.

`reason` on a rejection, suspension or termination is **shown to the partner**, on their page and in the WhatsApp message or email.

There is deliberately no route that creates or changes a referral relationship (owner, 2026-11-02: someone
who forgot the code asks the referrer).
