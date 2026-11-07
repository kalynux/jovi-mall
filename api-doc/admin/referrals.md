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
| `PATCH /settings` | any of `enabled`, `terms.{vendor,customer,agency}.{ratePercent,durationMonths}`, `minPayoutAmount`, `rewardWaitDays` | `400` out of range |
| `POST /partners/:id/approve` | `{ reason? }` | `409 REFERRAL_PARTNER_STATUS_CONFLICT` unless `pending` |
| `POST /partners/:id/reject` | `{ reason }` | same |
| `POST /partners/:id/suspend` | `{ reason }` | unless `active` |
| `POST /partners/:id/reinstate` | `{ reason? }` | unless `suspended` |
| `POST /partners/:id/terminate` | `{ reason }` | unless `active` or `suspended` |
| `POST /partners/:id/allow-reapply` | none | unless `rejected` or `terminated`, and not already allowed |
| `POST /partners/:id/release-balance` | `{ reason }` | `409 REFERRAL_BALANCE_NOT_FROZEN` unless frozen |
| `PATCH /partners/:id/terms` | `terms.{vendor,customer,agency}.{ratePercent,durationMonths}`, `null` resets a field | `400` out of range |

A rate is 0 to 25 with up to two decimals, and a duration is 1 to 120 whole months.

`reason` on a rejection, suspension or termination is **shown to the partner**, on their page and in the WhatsApp message or email.

There is deliberately no route that creates or changes a referral relationship (owner, 2026-11-02: someone
who forgot the code asks the referrer).
