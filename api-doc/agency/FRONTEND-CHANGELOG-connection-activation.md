# Agency dashboard: only active vendors in the directory, and each connection shows the vendor's status

**2026-10-18 · not deployed yet · additive** (one list gets shorter, one field is new).

## 1. The vendor directory lists `active` vendors only

`GET /api/agency/vendor-connections/browse` no longer returns vendors at `pending_verification`
(phone not yet verified, or no display name). This does not depend on the agency's own status.

A vendor that is still activating can still find the agency and send a request, and the agency
can still approve it. Nothing about requests or approvals changed. Existing connections are not
affected.

Nothing to change in the client.

## 2. New field on every connection: `counterpartyStatus`

Every `ConnectionDto` (list, detail, and the responses of request / approve / reject / withdraw /
terminate) now carries the **vendor's** account status:

```ts
counterpartyStatus: 'active' | 'pending_verification' | 'inactive' | null;
```

Show `pending_verification` as a "Not active yet" badge on the request and the connection. It
does not block approval. `null` means the vendor record no longer exists.

## 3. Why the agency's own activation matters to vendors now

Vendors browsing agencies see only **active** agencies (the vendor dashboard changed the same
way), because a vendor cannot publish physical products with an agency that has not finished
activating. An agency at `pending_verification` is therefore invisible to vendors who search, and
a vendor who accepts its request cannot use it until it activates. The agency onboarding screen
should push phone verification and a display name, since those are what make the agency
appear to vendors.
