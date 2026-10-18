# Agency dashboard: connection rows name the vendor, and setting a display name can activate the agency

**2026-10-18 · not deployed yet · additive.** Follow-up to
[FRONTEND-CHANGELOG-connection-activation.md](./FRONTEND-CHANGELOG-connection-activation.md),
answering the two asks raised against it.

## 1. `counterpartyProfile` on every connection

Every `ConnectionDto` now carries the vendor's display fields, beside `counterpartyStatus`, on the
same responses: `GET /api/agency/vendor-connections`, `GET /:id`, and the request / approve /
reject / withdraw / terminate responses.

```ts
counterpartyProfile: {
  businessName: string;        // the vendor's Store name; '' if no Store yet
  displayName: string | null;  // the vendor's display name
  logo: FileDetail | null;     // the Store logo
  kycVerified: boolean;
} | null;                      // null only if the vendor record no longer exists
```

**Delete the `/browse` scan.** Name and draw connection rows from `counterpartyProfile`. Browse
lists `active` vendors only, so it cannot name a `pending_verification` vendor, and those are
the rows that carry the "Not active yet" badge. The scan also cost up to 6 pages of 100 per load.

Suggested rendering: `businessName || displayName || "Vendor"`, logo or initials, and the KYC
badge from `kycVerified`.

## 2. Setting a display name can activate the agency

An agency becomes `active` when it has **a verified phone and a non-blank `displayName`**.
Before this change only the phone proof evaluated that, so an agency that verified its phone
first and set its name afterwards stayed `pending_verification` for good, and since the change
above vendors could not find it.

`PATCH /api/agency/profile` now evaluates activation after every save. If the save completes the
pair, the agency is promoted in the same request and the response's `status` is already
`"active"`.

- Refresh the session's agency state (status) from the PATCH response. No extra call is needed.
- Take the "not active yet" banner down when `status` becomes `"active"`.
- An agency that already has both and is stuck at `pending_verification` heals on its next profile
  save, whatever field it changes.
- Activation never fails the save. A suspended (`inactive`) agency is never promoted.

Contracts: [vendor-connections.md](./vendor-connections.md) · [profile.md](./profile.md) ·
[auth/README.md](../auth/README.md) (account activation) ·
[vendor/agency-connections.md](../vendor/agency-connections.md#response-field-reference) (full
`ConnectionDto`).
