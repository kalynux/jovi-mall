# Vendor dashboard: connection rows name the agency, and setting a display name can activate the vendor

**2026-10-18 · not deployed yet · additive.** Follow-up to
[FRONTEND-CHANGELOG-connection-activation.md](./FRONTEND-CHANGELOG-connection-activation.md).

## 1. `counterpartyProfile` on every connection

Every `ConnectionDto` now carries the agency's display fields, beside `counterpartyStatus`, on the
same responses: `GET /api/vendor/agency-connections`, `GET /:id`, and the request / approve /
reject / withdraw / terminate responses.

```ts
counterpartyProfile: {
  businessName: string;        // the agency's Magazin name; '' if no Magazin yet
  displayName: string | null;  // the agency's display name
  logo: FileDetail | null;     // the Magazin logo
  kycVerified: boolean;
} | null;                      // null only if the agency record no longer exists
```

Render connection rows from it. If the dashboard names a row by looking the agency up in
`GET /api/vendor/agency-connections/browse` or `GET /api/vendor/delivery-agencies`, remove that:
both list `active` agencies only, so a `pending_verification` agency's row would go nameless.

## 2. Setting a display name can activate the vendor

A vendor becomes `active` when it has **a verified phone and a non-blank `displayName`**. Before
this change only the phone proof evaluated that, so a vendor who verified the phone first and set
the name afterwards stayed `pending_verification`, which also hid them from agencies searching
for vendors.

`PATCH /api/vendor/profile` now evaluates activation after every save. If the save completes the
pair, the response's `status` is already `"active"`.

- Refresh the session's vendor state from the PATCH response. No extra call is needed.
- A vendor that already has both and is stuck heals on its next profile save.
- Activation never fails the save. A suspended (`inactive`) vendor is never promoted.

Contracts: [agency-connections.md](./agency-connections.md#response-field-reference) ·
[profile.md](./profile.md) · [auth/README.md](../auth/README.md) (account activation).
