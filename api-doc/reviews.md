# Reviews & ratings

> **Cross-role.** One module, two subjects, three author roles, four HTTP surfaces.
> Built 2026-08-21 (Phase 6 · 6.E.4). Moderation lives in wi-admin —
> [admin/reviews.md](./admin/reviews.md).

This document is at the `api-doc/` root rather than in a role folder because a review is
the same object whoever writes it, and splitting it four ways would be four copies of one
eligibility table. Each role's endpoints are listed under [Endpoints](#endpoints).

---

## 1 · What a review is

A **rating (1–5)**, optionally some **prose**, by one identified person, about one
identified thing, moderated once.

There are two kinds of thing, told apart by `subjectType`:

| `subjectType` | `subjectId` is | Who may write one | What it is |
|---|---|---|---|
| `product` | a product id | the **customer** who bought it | the storefront review a shopper reads |
| `delivery` | a **shipment** id | the **customer**, the **vendor** and the **agency** | a rating of one delivery run |

### The part that is easy to get wrong

**A product review and a delivery review are not the same feature wearing two hats.** A
product review is public and is what the storefront's `aggregateRating` is built from. A
delivery review is **internal**: it is attributed server-side to the agent who carried the
parcel, and it feeds that agent's trust score. There is **no public endpoint that returns a
delivery review**, and there will not be one — only its aggregate leaves the platform, as
an agency's service rating.

### The three delivery authors rate the same shipment

All three post `subjectType: 'delivery'` against the same `subjectId`, and each lands in a
different aggregate:

| Author | What they are attesting to | Feeds |
|---|---|---|
| `customer` | the recipient's experience — did it arrive, and well? | the agent's **customer** rating |
| `vendor` | the seller's — was my consignment collected and carried well? | the agent's **vendor** rating |
| `agency` | the employer's — did my agent run this well? | the agent's **agency** rating |

⚠ **The customer never CHOOSES which agent their review lands on** — they rate the *delivery*
and the platform performs the attribution server-side. Nothing here takes an agent id.

That is the part that matters for reviews, and it is unchanged. What *did* change, on
2026-08-23, is a sentence this paragraph used to lead with: `GET
/api/customer/orders/:orderId/shipments` no longer withholds the agent outright. It publishes
a **partial name and photo, never a phone number**, and only while that agent is physically
carrying the parcel — see
[ADR-A06](../docs/ADR-A06-AGENT-IDENTITY-DISCLOSURE.md) and
[customer/orders.md](./customer/orders.md#who-is-carrying-it--agent). A reviewer may now
recognise who delivered to them; they still cannot aim a review at anybody.

⚠ **An agency's review moves the agent's aggregate and never its own.** An agency rating
itself is not evidence of anything, and its own directory score would then be
self-reported. An agency's public rating comes from its **customers'** delivery reviews.

---

## 2 · Eligibility

Verified purchase / verified delivery, always. There is no path to reviewing something you
were not party to.

| Subject | Rule |
|---|---|
| `product` | the author has a **completed** order (`completion.confirmed_at` set) containing that product |
| `delivery` · customer | the author is the order's customer, and the shipment is `delivered` |
| `delivery` · vendor | the author is the order's vendor, and the shipment is `delivered` |
| `delivery` · agency | the shipment is the author's own, and it is `delivered` |

"Completed" is `Order.completion.confirmed_at`, not `fulfillment_status`. It is set when the
customer confirms, when COD cash changes hands, or by the auto-confirm sweep — so every
route to "this person actually received what they bought" converges on it, including the
partially-returned order that never reaches `fulfillment_status: 'delivered'`.

A **delivered shipment with no agent bound** is refused (`REVIEW_SUBJECT_NOT_REVIEWABLE`).
Every attribution needs the agent, and a real delivery always has one.

### Check before you show the form

```http
GET /api/customer/reviews/eligibility?subjectType=product&subjectId=<id>
```

```json
{ "success": true, "data": { "eligible": false, "reason": "REVIEW_ALREADY_EXISTS", "existingReviewId": "507f…" } }
```

**200 with `eligible: false`** — this is a question, and "no, and here is why" is a
successful answer to it. `reason` is the same error code the write path would have raised,
so one copy table serves both. Present on `/customer`, `/vendor` and `/agency`.

---

## 3 · Moderation, and where a review lands

`pending` → `published` → (or) `rejected`.

**A review carrying free text is held for a moderator. A bare star rating publishes
immediately.**

That is the rule, and both halves are deliberate. A number cannot be abusive, defamatory or
a link to somewhere else, and the eligibility gate has already established that the author
bought the item or received the parcel — so there is nothing for a human to decide. Prose is
where the risk is, and it gets one. Holding everything would put the moderation queue in
front of a signal that moves an agent's cash limit.

The response to `POST` says which happened, in `status`. Clients should render "published"
and "submitted for review" differently.

**A rejected review counts for nothing — its star included.** Aggregates are recomputed over
published rows only, so exclusion is a property of the query rather than of a subtraction
somebody has to remember. The rejection reason is the moderator's record and is **never**
shown to the author or the public.

There is no edit verb and no delete verb. One review per author per subject, enforced by a
unique index; a second attempt is `409 REVIEW_ALREADY_EXISTS`.

---

## 4 · Endpoints

### Authoring — `/api/{customer,vendor,agency}/reviews`

The three are an endpoint-for-endpoint mirror. **The author's role comes from the mount**,
never from the body — there is no `authorRole` field to send.

| | |
|---|---|
| `POST /` | submit. `201`. |
| `GET /eligibility?subjectType=&subjectId=` | may I write one? |
| `GET /?page=&limit=&status=` | my own reviews, **every status** — you can see your held row |

`POST` body:

```json
{
  "subjectType": "delivery",
  "subjectId": "507f1f77bcf86cd799439077",
  "rating": 5,
  "title": "Right on time",          // optional, ≤120 — presence holds it for moderation
  "body": "Called ahead, very careful with the box."  // optional, ≤2000
}
```

`.strict()` — an unknown key is a `400`. `rating` is an **integer 1–5**; there is no
half-star.

`/vendor/reviews` and `/agency/reviews` accept `subjectType: 'delivery'` only; a product
review from either is `400 REVIEW_ROLE_NOT_ALLOWED`. The product review is the buyer's.

Author response shape:

```json
{
  "success": true,
  "data": {
    "id": "507f…",
    "subjectType": "delivery",
    "subjectId": "507f…",
    "rating": 5,
    "title": "Right on time",
    "body": "Called ahead…",
    "status": "pending",
    "publishedAt": null,
    "createdAt": "2026-08-21T09:00:00.000Z"
  }
}
```

### Public — `GET /api/public/products/:productId/reviews`

Unauthenticated. Published **product** reviews, newest first, `Cache-Control: public,
max-age=300` like the rest of `/api/public`.

```json
{
  "success": true,
  "data": [
    { "id": "507f…", "rating": 5, "title": "Beautiful fabric", "body": "…", "publishedAt": "2026-08-20T…" }
  ],
  "meta": {
    "total": 12, "page": 1, "limit": 10, "totalPages": 2,
    "rating": { "average": 4.25, "count": 12, "distribution": { "1": 0, "2": 1, "3": 1, "4": 4, "5": 6 } }
  }
}
```

- **`meta.rating` is `null` when nothing is published.** Never a zero-count object — see
  [§6](#6--ratings-on-other-surfaces).
- **No author identity is published.** No name, no id, no initial. This platform's customers
  are largely passwordless accounts created from a phone number, so the only available
  display name is frequently derived from it, and publishing a shopper's name beside their
  purchase history is a decision nobody has taken. A "verified purchase" badge is implicit:
  eligibility means every published review is one.
- An unknown or unpublished product answers an **empty page**, not a 404 — "nothing has been
  said about this id" is a truthful answer, and a 404 would make the route an existence
  oracle for draft products.

### Moderation — `/api/internal/admin/reviews`

wi-admin only, behind the service token. See [admin/reviews.md](./admin/reviews.md).

---

## 5 · Errors

| Code | Status | When |
|---|---|---|
| `REVIEW_ALREADY_EXISTS` | 409 | you have already reviewed this subject. Terminal — there is no edit |
| `REVIEW_NOT_ELIGIBLE` | 422 | you are party to it, but it has not reached a reviewable state |
| `REVIEW_SUBJECT_NOT_FOUND` | 404 | no such product/shipment — **or** it is not yours. Deliberately the same answer |
| `REVIEW_SUBJECT_NOT_REVIEWABLE` | 422 | a delivered shipment with no agent bound to it |
| `REVIEW_ROLE_NOT_ALLOWED` | 400 | e.g. a vendor posting a product review |
| `REVIEW_NOT_FOUND` | 404 | moderation only |
| `REVIEW_NOT_PENDING` | 409 | moderation only — another moderator decided first |

The 404-vs-422 split is load-bearing: 404 hides whether an id exists, 422 is only ever
returned to somebody who already knows it does.

---

## 6 · Ratings on other surfaces

The same aggregate reaches three other places. All three follow **one rule: `null`, never a
zero-count.**

| Surface | Field | Source |
|---|---|---|
| `GET /api/public/products` (row) | `rating: { average, count } \| null` | customers' **product** reviews |
| `GET /api/public/products/:id` (detail) | `rating: { average, count, distribution } \| null` | as above, plus the histogram |
| `GET /api/vendor/agency-connections/browse`, `GET /api/agent/agencies/browse` | `rating: number \| null` + `ratingCount: number` | customers' **delivery** reviews of that agency |

The agency card keeps `rating` as a bare number and gains `ratingCount` beside it — a
purely **additive** change, so a client that never read a count still works. Render both: 5.0
from one delivery and 4.6 from two hundred are not the same claim.

### `aggregateRating` in JSON-LD

Emit it **if and only if** `rating` is non-null. The backend never sends a zero-count
summary, so there is no branch to remember and no way to publish an invented review count —
which is a Google review-snippet spam-policy violation that earns a manual action. Do not
synthesise `ratingValue: 0` from a null.

---

## 7 · Why a delivery review matters more than it looks

`DeliveryAgent.trust_signals` carries three rating factors worth **50 of the trust
composite's 100 weight**, and until this shipped nothing wrote any of them — every agent's
rating factors blended to the seed, so the composite could only ever *raise* a score.

The chain is one path with one writer at each hop:

```
delivery review published
  → ReviewService.refreshTargets recomputes review_aggregates (agent, author_role)
  → AgentTrustService.collectSignals reads it
  → AgentTrustRecomputeWorker writes trust_signals
```

Nothing in the reviews module touches `delivery_agents`, and the trust collector never reads
`reviews` directly.

⚠ **As of this document the composite is still a SHADOW** (Phase 6 D-2): it writes
`trust_signals.composite_score` while `cod.trust_score` — the number that sets an agent's
COD cash limit — is still owned by `CodTrustService.applyEvent`. **Phase 6 Step 11 flips
that**, and after the flip a customer's delivery rating influences how much cash an agent
may carry. That is a product fact, not an implementation detail.
