# Agency dashboard — the Orange Money payment code, and mobile-money limits

**Applies to:** the agency dashboard's billing (plan purchase, credit top-up)
**Status:** ✅ built 2026-10-05; live after the next production deploy. Visible only once an
administrator makes NovaSend the collection aggregator.
**Breaks:** nothing. Without this change, an agency paying with Orange is refused
`PAYMENT_CODE_REQUIRED` while NovaSend is active, with nowhere to type the code.

The agency's billing doors take exactly the vendor's body and give exactly the vendor's answers,
under `/api/agency`:

- `POST /api/agency/plans/:planId/purchase` → `{ provider, channel: { phoneNumber, paymentCode } }`
- `POST /api/agency/credits/topups` → `{ packCode, provider, channel: { phoneNumber, paymentCode } }`

Do everything on the [vendor page](../vendor/FRONTEND-CHANGELOG-payment-code.md) with that
prefix: the `CODE_FIRST` entry from `GET /api/payments/options` (USSD hint from `codeUssd` + a
4–8-digit code input, never saved), `channel.paymentCode`, the three 422s
(`PAYMENT_CODE_REQUIRED`, `PAYMENT_CODE_REJECTED`, `PAYMENT_AMOUNT_OUT_OF_RANGE`) handled in the
dialog, and the `limits` warning. Why and the full table:
[cross-role page](../FRONTEND-CHANGELOG-payment-code.md).
