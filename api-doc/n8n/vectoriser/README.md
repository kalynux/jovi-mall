# The vectoriser — jovi-mall ↔ n8n ↔ pgvector

**Status: COMPLETE on both sides, write and read (2026-09-06), and verified live.**
The vectoriser is active (§ 12), jovi-mall's two internal routes are built (§ 4),
and the search tool `wi-mall-product-search` is published and wired into
`wi-mall-core` (§ 14). 29 real dev products were indexed through the whole path —
202, embed, pgvector write, callback — and searched back out with live prices.

⚠ **jovi-mall was deliberately given NO pgvector access.** Retrieval lives with the
index, inside n8n. What jovi-mall grew instead is one hydration route,
`GET /api/public/products/by-ids`, because the index is a snapshot and price and
stock have to come from the service that owns them.

| Piece | Where |
|---|---|
| The flow | n8n workflow **`wi-mall-vectoriser`** (`YYt00wVi3AoKIOuX`) |
| The table + the search function | [`product_vectors.sql`](product_vectors.sql) — **all applied** to `vector_db` |
| The search tool | n8n workflow **`wi-mall-product-search`** (`GUrwafUbWGNv4XW7`) — published |
| The schema applier | n8n workflow **`wi-mall-vectoriser-schema`** (`i4Zo7LPGZx9Rh7mE`) |
| Product photos (image arm) | [`image-vectoriser/`](image-vectoriser/) + n8n **`UP-wi-mall-image-vectoriser`** (`SiWU1FWg3sFoilQE`) — ✅ live (§ 15) |
| The caller | [`VectorisationService.ts`](../../../src/modules/catalog/domain/services/VectorisationService.ts) |
| Its config | [`vectoriser.config.ts`](../../../src/config/vectoriser.config.ts) |
| The internal door | [`internal-vectoriser.routes.ts`](../../../src/modules/catalog/routes/internal-vectoriser.routes.ts) |

It replaces the old `VECTORISER` workflow, which wrote to a Supabase store that no
longer exists and built its text from a **product schema this platform has never
had** — `is_available`, `open_hrs`, `store_address`, `product_code`, `negotiable`,
`regions`. None of those fields exist in jovi-mall. That workflow is left in place,
inactive, as a reference; it should be archived once this one has run for real.

---

## 1. The three paths, and who calls them

All three hang off `VECTORISER_BASE_URL`, which `VectorisationService` already
composes. They authenticate on the **`VECTORISER_API_KEY`** header.

| Path | Caller | Body | Answer |
|---|---|---|---|
| `POST <base>` | `executePreparedVectorisation`, `vectoriseBulk` | one payload object, an array, or `{products:[…]}` | **202** `{success, job_id, accepted[], rejected[], callback_url}` |
| `POST <base>/status` | `notifyStatusChange` | `{product_id, vectorised_id, new_status}` | 200 `{success, product_id, new_status, rows_updated, indexed}` |
| `POST <base>/delete` | `deleteVectorisation` | `{product_id, vectorised_id}` | 200 `{success, product_id, rows_deleted}` |

A fourth path, `POST <base>/file`, takes a **CSV or Excel upload** as
`multipart/form-data` under the field `data`. jovi-mall never calls it; it is the
human bulk-loading path.

### The spreadsheet contract

Column names are matched case- and punctuation-insensitively, so `Product ID`,
`product_id` and `productid` are the same column.

- **`product_id` is required on every row.** There is no fallback to SKU or title.
  A row that cannot be linked back to a Mongo product is a search result whose
  "view details" button has nowhere to go, so it is rejected and named in the
  response rather than indexed.
- A row carrying **both a title and a price** is used as-is. Anything less is
  treated as a reference and its full payload is fetched from jovi-mall. A sheet
  that is one column of ids is the normal case and works.
- Other recognised columns: `description`, `category`, `tags` (`,` `;` or `|`
  separated), `type`, `status`, `slug`, `currency`, `sku`, `stock`, `vendor`,
  `vendor_id`, `country`, `compare_at_price`, `variant`.

---

## 2. The 202, and what the caller owes it

`POST <base>` no longer returns `{product_id, vectorised_id}`. It returns
immediately, before any embedding happens:

```json
{
  "success": true,
  "job_id": "833",
  "accepted": ["000000000000000000000001", "000000000000000000000002"],
  "rejected": [{ "product_id": null, "reason": "no product_id on entry 2" }],
  "callback_url": "http://100.124.149.1:8022/api/internal/vectoriser/callback"
}
```

**The caller must read both lists.** `accepted` means *now genuinely pending —
wait for the callback*. `rejected` means *this one is already over; mark it failed
and refund the credit now*, because no callback will ever mention it.

Why async at all: Voyage plus a pgvector write for a few hundred products does not
fit inside `VECTORISER_TIMEOUT_BULK_MS`, and a dropped connection under the old
design lost the whole batch with the products still marked `pending`.

## 3. The callback

When the loop finishes, n8n POSTs the report to `callback_url` with the
**jovi-mall service-token bearer** — the same credential the bot surface uses.

```json
{
  "job_id": "833",
  "finished_at": "2026-09-06T05:38:20.938Z",
  "total": 2, "succeeded": 2, "failed": 0,
  "results": [
    { "product_id": "000000000000000000000001", "status": "completed", "vectorised_id": "000000000000000000000001", "error": null },
    { "product_id": "000000000000000000000002", "status": "failed",    "vectorised_id": null,                       "error": "…" }
  ]
}
```

⚠ **`vectorised_id` is the product id, and that is deliberate.** `product_vectors`
is keyed by product, one logical document per product, so there is no second
identity to invent — and `/status` and `/delete` both resolve by `product_id`
anyway. Storing it still earns its keep as the "this product has been indexed at
least once" flag the service already treats it as.

⚠ **The callback destination is not caller-controlled in practice.** A request may
name `callbackUrl`, but n8n honours it **only if its origin matches the jovi-mall
origin it already trusts**; anything else is ignored and noted. The report is sent
with a service-token credential attached, so a free-form destination would be a
way to harvest that token.

## 4. What jovi-mall grew — BUILT 2026-09-06

Two routes on a new `/api/internal/vectoriser` mount, the **fourth** member of the
`/internal` family, behind `requireServiceToken` on the **existing
`INTERNAL_SERVICE_TOKEN`**. No new shared secret: the writes it accepts are
`vectorisationStatus`, `vectorisedDataId` and a credit refund — the same value
class as `/internal/agents`, not the customer data that made the bot surface
demand two credentials.

| File | What |
|---|---|
| `src/modules/catalog/routes/internal-vectoriser.routes.ts` | the mount + the reasoning for one credential |
| `src/modules/catalog/controllers/internal-vectoriser.controller.ts` | both handlers |
| `src/modules/catalog/validators/internal-vectoriser.validator.ts` | the two request schemas |
| `src/api/index.ts` | `router.use('/internal/vectoriser', …)` |

**`POST /api/internal/vectoriser/payloads`** — `{ product_ids: string[] }` →
`{success, data:{ products: VectoriserPayloadEntry[], missing: string[] }}`.
Straight `buildPayload()` per id, needed only by the spreadsheet path. It writes
nothing — no status, no credit, no claim ticket. Duplicate ids are collapsed, ids
are capped at **500** per request (`buildPayload` is a dozen queries per product,
so this is a database-load ceiling), and the builds run 25 at a time rather than
as one unbounded `Promise.all`. **No eligibility filter, deliberately**: a human
named these ids in a file, and a row silently dropped because the product is a
draft is a row they will never learn about.

**`POST /api/internal/vectoriser/callback`** — the § 3 report. `completed` sets
`vectorisedDataId` + status; `failed` sets status **and refunds the credit**.
It answers **200 on any well-formed body**, even when every result was ignored:
the report is the vectoriser's only delivery — it does not retry — so a non-2xx
buys nothing and loses the rows that *were* applicable. The per-result verdict is
in the body (`applied / completed / failed / refunded / ignored / unknown`).

### The claim ticket, and why the refund needed one

§ 4 as originally written said the refund "has to move here". Moving it turned out
to need a fact the callback cannot otherwise know: **whether this attempt was
billed at all.** The vendor paths debit; the admin bulk path deliberately does
not — and the callback body is byte-identical for both. Reading the current
`VECTORISATION_COST` instead would hand a vendor a credit they never spent every
time an admin sweep failed on their product.

So a product now carries **`vectorisationJob: { jobId, billed, requestedAt }`**,
written when the 202 puts it in `accepted` and cleared by whatever ends the
attempt. It does two jobs:

- **`billed`** — the fact above, recorded at request time because it is not
  recoverable at report time.
- **`jobId`** — the idempotency mechanism, and the whole of it. Every callback
  write is `findOneAndUpdate({ _id, 'vectorisationJob.jobId': jobId })`, which
  claims the attempt and returns the pre-update document in one round trip. A
  duplicate report, a report for an attempt superseded by a newer submit, or one
  for a product whose vendor switched vectorisation off meanwhile all match zero
  documents and land in `ignored`. There is no separate seen-job store.

⚠ **The claim happens BEFORE the refund, and the order is load-bearing.**
Refunding first lets two deliveries of one report pay a vendor twice. This way
the worst case is a refund that fails after the claim — the claimed credits not returned,
logged at error level — rather than credits minted by a retry.

⚠ Every write that **ends or restarts** an attempt clears the ticket:
`prepareForVectorisation`'s pending mark, the ineligible reset, both credit-debit
failure branches, `deleteVectorisation`'s reset, and every failure path in the two
submits. A ticket left behind is a late callback able to write `completed` onto a
product that has moved on.

### The three `VectorisationService` edits, as built

1. **`executePreparedVectorisation` no longer writes `completed`.** It reads the
   202: in `accepted` → write the ticket and stay `pending`; **not** in `accepted`
   (rejected, or in neither list) → fail and refund **now**, because no callback
   will ever name it. A missing `job_id` on an otherwise-accepted product is also
   failed here — the callback matches on it, so nothing could resolve that product
   and `pending` locks it against editing. The three pre-202 failures share one
   `failAndRefund` exit; the post-202 refund is `applyCallbackReport`'s, and the
   two must never both fire for one attempt.
2. **`vectoriseBulk` likewise.** Its "vectoriser did not return a result" branch
   is now "was not in `accepted`", with the matching `rejected` reason where there
   is one. Rejections carrying `product_id: null` cannot be attributed to any id,
   so they are counted and logged rather than pinned on an arbitrary victim.
3. **`vectoriserConfig.baseUrl`'s default is `https://the8n.fante.cloud/webhook/vectorise`.**
   The old default had no `/webhook` segment and never existed on any deployment.

⚠ **`BulkVectorisationResult.succeeded` was renamed to `accepted`.** Nothing is
indexed when `vectoriseBulk` returns, and the rename is the point — TypeScript
found both call sites, and both now say "submitted" rather than "complete". The
admin endpoint's message and `scripts/reconcile-vectorisation.ts` changed with it.

⚠ **Re-running the reconcile script immediately re-submits work still in flight.**
Its query matches `pending`, and everything accepted a moment ago is pending. That
was harmless when a run finished what it started. Give a run time to report back.

### Two decisions about where this route does *not* appear

**Not on the maintenance-mode exemption list** (`modules/system/domain/maintenance-mode.ts`),
unlike `/internal/agents`, `/internal/shipments` and `/tracking`. Those three are
exempt because blocking them turns a jovi-mall maintenance window into a
geo-tracker **outage** — watchers dropped, every live subscription failing
authorization. Nothing here has that property; n8n is serving nobody in real time.

The cost is real but bounded: a report lost during a window leaves those products
at `pending`, which locks them against editing and leaves a debited credit
unrefunded, until the reconcile script sweeps them up. Worth knowing before
opening a long window; not somebody else's outage, which is the bar that list
holds.

**Not on the rate-limit exemption list** (`api/rate-limit/exempt-paths.ts`), for
the same reason and one more: the volume is one callback per job.

## 5. What is in the embedded text, and what is not

The text is built by code, not a model, in the `build all texts` node (it was `build product text` before § 11 batched it). Same
product in, same vector out — otherwise an unrelated price edit reshuffles every
customer's search results, and a model will happily invent attributes ("breathable
mesh") that no vendor typed and that the agent then quotes as fact.

It carries: the title, a type-appropriate identity sentence, category and tags, the
price or price range, any discount, whether the price is negotiable, availability,
the option axes (`Size (41, 42)`), every variant with SKU / price / stock /
weight / dimensions, the digital asset and its download limits, the service
duration / booking mode / peak surcharge, the delivery agency, the description, the
photo count, the SEO strings, and the id and slug.

Three things are held back on purpose:

- **The bargain window numbers.** `minPrice` *is* the selling price and `maxPrice`
  is the ceiling haggling may reach (`bargain-price.rule.ts`). That is the
  negotiating agent's hand, and this text is read straight into a customer-facing
  model's context. The text says only that the item is negotiable; the numbers sit
  in `metadata.bargain_windows` for a server-side caller. **The product-search
  endpoint must not return that field to the bot** — which is why `product_search()`
  (§ 13) strips it with `metadata - 'bargain_windows'` inside the function rather
  than leaving it to each caller to remember.
- **Image URLs** — embedding tokens, no meaning. `metadata.primary_image` instead.
- **The product status.** It is a filter column, not a semantic feature, which is
  exactly what lets `/status` archive a product with one `jsonb_set` and no new
  embedding.

Stock is a snapshot. The text says "in stock"; it does not promise stock. The
add-to-cart tool remains the only authority.

## 6. The environment, as measured

Probed 2026-09-06, not assumed. n8n's `Postgres account` credential points at
**`vector_db` on `10.0.2.13`** — the `pgvector/pgvector:pg17` container, *not*
n8n's own metadata Postgres (which is plain `postgres:17-alpine` and carries no
pgvector at all, so a credential pointed there would fail at the first
`CREATE EXTENSION`).

| | |
|---|---|
| PostgreSQL | 17.11 |
| pgvector | 0.8.6, already installed |
| index method taken | **`hnsw`** — the DDL's `pg_am` check found it |
| `product_vectors` | created: 20 columns, 15 generated, 7 indexes, `vector(1024)` |
| still present | `product_test_vector_data`, the old flow's table. Left alone; drop it when you are ready |

## 7. Setup — where it stands

1. ✅ **`product_vectors.sql` is applied.** Idempotent, so re-running costs nothing.
2. ⛔ **The Header Auth credential is still owed.** The four webhooks were
   auto-assigned **`whatsapp_auth`**, whose header is `Authorization`, so a real
   `VECTORISER_API_KEY` call 403s. Create a Header Auth credential with Name
   `VECTORISER_API_KEY` and Value `={{ $env.VECTORISER_API_KEY }}` — the leading `=` makes
   it an expression, and it resolves because the container sets
   `N8N_BLOCK_ENV_ACCESS_IN_NODE=false`. Select it on `vectorise`, `vectorise file`,
   `status change` and `delete request`.
   **Do not edit `whatsapp_auth`** — WhatsApp uses it.
3. ✅ **jovi-mall's `.env` carries `VECTORISER_BASE_URL` and `VECTORISER_API_KEY`.**
   Both belong to *jovi-mall*, not to the n8n container: n8n **is** the vectoriser,
   and its webhook auth comes from the credential store rather than `$env` — except
   through the expression in step 2.
4. ⬜ **Activate the workflow.**

## 8. What has actually been run

End to end through `execute_workflow`, 2026-09-06 — which injects the webhook
payload directly and so exercises everything except the HTTP hop and its header
auth.

- ✅ **The PGVector node writes the pre-created table happily.** It sets only
  `id/text/metadata/embedding`; all 15 generated columns populated, the weighted
  `tsv` matched both `nike` and `sneaker`, and the trigram index scored
  `similarity(title, 'nike air max') = 0.500`.
- ✅ **Voyage returned 1024 dimensions**, matching `vector(1024)`.
- ✅ **`queryReplacement` accepts an array expression.** The metadata JSON is full
  of commas and arrived as `$2` intact — the comma-separated string form would have
  shredded it.
- ✅ **The loader's own metadata does not survive.** LangChain adds
  `{source, blobType, loc}`; the metadata UPDATE overwrites it wholesale, as
  designed.
- ✅ **Re-indexing replaces rather than duplicates.** The same product sent twice
  with a different price left **one** row carrying the new price. Purge → insert
  works and the UNIQUE index holds.
- ✅ **A batch is per-product.** Three entries, one with no `product_id`: it was
  rejected at the gate with `"no product_id on entry 2"` and the other two
  completed.
- ✅ **`/status` moves the column with no re-embedding** — `indexed_at` did not
  change and the embedding was untouched.
- ✅ **`/delete` removes the row.**
- ✅ **n8n reaches jovi-mall over Tailscale.** The callback drew a real jovi-mall
  error envelope (`404 NOT_FOUND · Route not found`) rather than a connection
  failure — the expected answer until § 4 exists, and proof of the transport.

~~Still genuinely unverified, and reachable only over real HTTP:~~ **All three were closed over real HTTP on 2026-09-06 — see § 12.**

- **The `={{ $env.VECTORISER_API_KEY }}` expression resolving at webhook-auth
  time.** Credential expressions are supported; webhook-time resolution is the one
  spot this exercise could not reach. If a correct key still 403s, paste the literal
  value in — that is the fallback, not a redesign.
- **Multipart upload landing in `$binary.data`** on `/vectorise/file`, and
  `$binary.data.fileExtension` telling csv from xlsx.
- **`vectorise/file` not shadowing `vectorise`.** n8n registered them as distinct
  production URLs, so this is likely fine, but no real request has been routed.

## 9. Seeing what was embedded, and what it cost  ⚠ its token section is SUPERSEDED by § 11

Every product writes one row to the n8n **`vectoriser_debug`** data table
(`UVdTPOYC3pRsIrG9`), from the `log what was embedded` node. It carries the exact
`embedded_text` that went to Voyage, the full `metadata_json`, the derived figures
(`price_min`, `variant_count`, `in_stock`, `bargainable`), the `job_id`, and the
`outcome` — **including failures**, because the text a product failed on is
usually what explains why it did.

It hangs off `mark done` and `mark failed` as a **parallel sink**, not in the
loop-back path. Putting it in that path would make the loop collect data-table
receipts instead of the per-product outcomes `compose report` needs — the
"inserting a node changes what downstream receives" trap.

⚠ **`embedding_tokens` is an ESTIMATE, and `tokens_are_estimated` says so in its
own column.** The Voyage node is a LangChain *sub-node*: it hands the vector store
a vector and nothing else, so the provider's own `usage.total_tokens` never
reaches the main flow. Probed 2026-09-06 — an HTTP Request node cannot borrow the
`voyageApi` credential either: the community node does not implement the auth
hook, and Voyage answers `Unauthorized`.

The exact number is available, at a price worth stating plainly. It needs a direct
HTTP call to Voyage, and that call cannot be **added** beside the node — embedding
twice doubles the bill. It has to **replace** it. Doing so would also buy real
batching (Voyage accepts 128 inputs per call; the loop currently embeds one at a
time) and would collapse the insert-then-update into a single INSERT. The cost is
one secret: `VOYAGE_API_KEY` in the n8n container's environment, because the
credential store cannot lend its key to an HTTP node.

Until then the estimate is BPE-shaped — letters at ~4.5 characters per token,
digit runs denser, punctuation one each. On the three fixtures it reports
321 / 190 / 216 tokens for 947 / 569 / 703 characters. Good enough to price a
catalogue; not good enough to reconcile an invoice.

## 10. The throughput blocker (RESOLVED in § 11 — kept because the failure mode is the lesson)

Found 2026-09-06 by running eight real products and getting **three rows**.

```
Request failed with status code 429
"You have not yet added your payment method in the billing page and will have
 reduced rate limits of 3 RPM and 10K TPM."
```

The loop makes **one Voyage call per product**, so on this account the fourth
product of any minute is refused. It is not a batch-size bug and it is not
payload-dependent: 4 in → 3 rows, 8 in → 3 rows, every time, always the first
three.

### The worse half: the run reported those products as `completed`

The 429 is raised inside the **Voyage embeddings sub-node**, which n8n classifies
as a `configuration-node` error. **`onError: continueErrorOutput` on the parent
vector-store node does not route that to the error output** — the item continued
down the *success* path. The metadata UPDATE then matched no row and still
answered `{success: true}`, because in the n8n Postgres node that means *the
statement ran*, never *it matched something*. So `mark done` fired and the job
reported eight successes for three indexed products.

**Fixed by not trusting the node.** The UPDATE now carries `RETURNING product_id`
and a `row actually written?` gate gives the verdict; only a returned row reaches
`mark done`. Verified: 4 products → `succeeded: 3, failed: 1`, with the failure
naming the rate limit. **The rule this establishes: verify the ROW, never the
node.** Any future step that writes must prove it wrote.

### What actually fixes the throughput

Two options, and the second is the one that scales:

1. **Add a payment method** to the Voyage account. That lifts the standard rate
   limits and the free token allowance still applies. Nothing in the workflow
   changes.
2. **Replace the Voyage sub-node with a direct HTTP call.** Voyage accepts **128
   inputs per request**, so 128 products become ONE request instead of 128 — even
   at 3 RPM that is ~384 products a minute rather than 3. It also makes the 429 an
   ordinary HTTP response the workflow can see and retry with backoff, and it
   returns `usage.total_tokens`, the exact figure § 9 currently estimates.

   ⚠ The token ceiling still binds: **10K TPM** on the free tier. At ~150–300
   tokens per product that is roughly 30–60 products a minute, so batching turns a
   hard blocker into a manageable one rather than removing it.

⚠ **The `Voyage Bearer` credential is not usable yet.** Its **Name** field is the
*HTTP header name*, and it was set to `Voyage Bearer` — n8n refuses it outright:
`Header name must be a valid HTTP token ["Voyage Bearer"]`. It must be
**`Authorization`**, with the value `Bearer <voyage key>`. The credential's own
label stays whatever you like; that is the title at the top of the dialog.

## 11. The batched HTTP embed — what replaced the Voyage node, and why

Applied 2026-09-06. **This supersedes § 9's "tokens are an estimate" note and
resolves § 10's blocker.** § 10 is kept because *how* it failed is the more
valuable half.

### The shape now

```
one queue → build all texts   (all prose in one pass, grouped into chunks of 32)
          → one chunk at a time
               → is it a chunk?
                    yes → embed chunk   (ONE Voyage HTTP call for up to 32 inputs)
                        → assemble rows (pairs vectors to products, guards the count)
                        → store chunk   (ONE upsert, RETURNING product_id)
                        → chunk outcome (verdict from the returned rows)
                    no  → straight to the report (payload never built)
          → compose report → callback
```

Gone: the Voyage sub-node, the Default Data Loader, the text splitter, the
PGVector insert, the separate purge, and the separate metadata UPDATE — six nodes
replaced by three.

### What it bought

- **The 3 RPM wall is gone for any batch up to 32.** Eight real products now index
  in **one** request instead of eight. Verified: 8 in → 8 rows, 8 embeddings, 8
  distinct products.
- **Real token usage.** Voyage reports `usage.total_tokens` per *request*, so the
  chunk total is exact. A one-product chunk is therefore exact per product; a
  larger one gets the exact SUM apportioned by each product's estimated share, and
  `tokens_are_estimated` describes the **split**, not the total.
- **A 429 is now an ordinary HTTP response** the workflow can SEE, instead of
  failing invisibly inside a sub-node. `assemble rows` reads `res.detail` /
  `res.error` and fails the chunk loudly with the rate-limit message.

  ⚠ **It does NOT retry it, and this bullet used to say it did** (corrected
  2026-09-06). `embed chunk` carries `retryOnFail: true, maxTries: 5,
  waitBetweenTries: 5000` — but it also carries `neverError: true`, which makes a
  non-2xx an ordinary output rather than a node failure, and `retryOnFail` only
  fires on a node FAILURE. So the retry config covers timeouts and connection
  errors and is inert for exactly the status it was added for. Left as-is
  deliberately: a batch job that fails a chunk loudly and gets re-run is fine, and
  the alternative (dropping `neverError`) would lose the parsed error body that
  `assemble rows` reports. **`wi-mall-product-search` does the opposite** — its
  `Embed Query` omits `neverError` so the retry is real, because a customer is
  waiting on that one.
- **No delete-then-insert gap.** `INSERT … ON CONFLICT (product_id) DO UPDATE`
  replaces purge-then-insert-then-update, so a re-index never leaves a product
  briefly absent from search, and it is one statement instead of three.
- **No dependency on a community node** for the embedding.

### Two guards worth not removing

⚠ **`assemble rows` refuses to pair by position on a count mismatch.** A batched
call returns vectors positionally, so if the provider ever returns a different
number than we sent, index-pairing would attach the **wrong vector to a product** —
which is worse than a failure, because the product becomes silently unfindable by
its own name and findable under someone else's. A mismatch fails the whole chunk.

⚠ **The verdict comes from `RETURNING product_id`, never from a node reporting
success.** See § 10 for what happened the one time it didn't.

### The limit that still binds

**10K tokens per minute** on the free tier. At ~150–300 tokens a product that is
roughly **30–60 products a minute**, whatever the chunk size — which is exactly why
`CHUNK_SIZE` is 32 and not Voyage's maximum of 128: a chunk too big to fit in one
minute's token budget cannot be retried into success, it just fails bigger. Adding
a payment method to the Voyage account lifts this and needs no workflow change.

`Voyage Bearer` (`aIUCGerxuUIrWTtO`) is a Header Auth credential with
**Name `Authorization`**, value `Bearer <key>`. The old `Voyage AI account`
(`voyageApi`) credential is now unused by this workflow.

## 12. Verified over real HTTP (2026-09-06) — and two things that bit

The workflow is **active**. Everything in § 8 that was reachable only over real
HTTP has now been exercised against `https://the8n.fante.cloud/webhook/vectorise`.

| Check | Result |
|---|---|
| no auth header | **403** |
| wrong key | **403** |
| correct key, one product | **202**, `accepted:[…]` |
| the product actually landed | `/status` → `rows_updated: 1, indexed: true` |
| `={{ $env.VECTORISER_API_KEY }}` resolving at webhook-auth time | ✅ works |
| CSV upload to `/vectorise/file` | **202**, 3 accepted, 1 rejected |
| a sheet row with no id | rejected: `"row 5 has no product id column"` |
| an id-only sheet row | `indexed: false` — correct **at the time**: § 4's `/payloads` route did not exist yet. It does now; this row is worth re-running |
| `vectorise/file` shadowing `vectorise` | it does not; both route correctly |
| `/delete` | `rows_deleted: 1`, ×11 — index left clean |

### ⚠ Multipart lands in `$binary.data0`, not `$binary.data`

n8n appends an index to the configured binary prefix for `multipart/form-data`.
The type router read an undefined extension, always fell through to the Excel
branch, and `read excel` then failed on a missing field — and because the failure
happened before `Respond to Webhook`, **the caller got a bare `200` with an empty
body**, which looks like success. All three nodes now resolve
`$binary.data0` with a `data` fallback for a raw-body post.

### ⚠ Editing through the API changes the DRAFT, not what is running

This n8n versions workflows: an **active** workflow serves its *published* version,
and an MCP/API update writes the **draft**. The first fix above appeared to do
nothing — the live webhook kept failing on the old node — until the workflow was
published. **After any edit to an active workflow, publish it, or you are testing
the previous version.** The give-away is an error whose node parameters do not
match what the editor shows.

### ⚠ The API key is stored in clear text in every saved execution

n8n records the full inbound request headers in execution data, so
`vectoriser_api_key` is readable by anyone with editor access, on every execution
of these four webhooks. Nothing here can prevent that — the key is a request
header and n8n saves request headers. If that matters for this deployment, reduce
execution retention or stop saving successful production executions; rotating the
key does not help, because the next execution records the new one.
---

## 13. The read path — `product_search()`, and how it differs from Supabase's

The reference RRF query that sat commented at the bottom of `product_vectors.sql`
is now a real function, `product_search(...)`, in the same file. **It has not been
applied to `vector_db` yet** — the DDL above it has. It is `CREATE OR REPLACE`, so
applying it is one statement and re-applying costs nothing.

It was written against Supabase's `hybrid_search`
(<https://supabase.com/docs/guides/ai/hybrid-search>), which is the canonical
worked example of this pattern. Same skeleton: rank each retrieval method
independently, fuse by **Reciprocal Rank Fusion** rather than by summing scores,
because cosine distance and `ts_rank_cd` are on incomparable scales and any fixed
weight between raw scores is a number nobody can defend. RRF only ever compares an
item's *position* in one ranking against its position in another, so the scales
never have to meet.

Six differences, and the reasons matter more than the list:

| | Supabase `hybrid_search` | `product_search` here |
|---|---|---|
| arms | semantic + full-text | **+ trigram on the title** |
| distance | `<#>` inner product, `vector_ip_ops` | `<=>` cosine, `vector_cosine_ops` |
| candidate pool | `least(match_count,30) * 2` | fixed, default **50** |
| `rrf_k` | 50 | **60** |
| filters | none | `status='active'` + five optional |
| result | `setof documents` | `metadata` **minus `bargain_windows`** |

**1. A third arm, because chat input is typo-prone.** Both of Supabase's arms fail
on a misspelling: `websearch_to_tsquery('simple','nikee')` produces a lexeme that
matches nothing, and an embedding of a typo is not reliably near the embedding of
the word. `product_vectors_title_trgm_idx` was created for exactly this — the DDL
comment says *"fuzzy title match; chat input is typo-prone"* — and the old
reference query never used it. RRF is what makes the third arm nearly free: it
generalises to N rankings. That is also why the arms are `UNION`ed into a
candidate set and `LEFT JOIN`ed back, rather than `FULL OUTER JOIN`ed as in the
two-arm original, which does not extend to three.

It uses `word_similarity(query, title)` with the `<%` operator, not `similarity()`.
`similarity('nike', 'Nike Air Max 270 Running Shoe')` is low because it compares
whole strings; `word_similarity` asks how well the query matches *some part* of the
title, which is the actual question when somebody types two words at a catalogue.

**2. Cosine, not inner product — and this one is a trap, not a preference.** For
Voyage's unit-norm vectors the two rank identically, so `<#>` looks like a free
optimisation. It is not: an operator that does not match the index's operator class
gets **no index at all**, and the query silently degrades to a sequential scan over
the catalogue. Changing it means rebuilding the HNSW index in the same change.

**3. The candidate pool is fixed, not derived from `match_count`.** Supabase takes
`least(match_count,30)*2`, which for a bot showing 5 results is a pool of **10** —
too shallow for fusion to do anything, because an item ranked 11th semantically and
1st lexically is invisible before the join. The pool is what fusion has to work
with; the match count is only what gets displayed. Coupling them makes a
five-result search worse than a fifty-result one at finding the right five.

**4. `rrf_k` 60 rather than 50** — the value from the original RRF paper (Cormack,
Clarke & Buettcher, 2009). Both are arbitrary smoothing constants; this one is at
least cited. Larger `k` flattens the advantage of the top ranks and lets agreement
*across* arms count for more.

**5. It filters, and `status = 'active'` is not optional** — an archived product
must never be offered. The other five (`country`, `product_type`, `category`,
`price_max`, `in_stock_only`) are `NULL`-defaulted and are what
`product_vectors_filter_idx` exists for.

⚠ **The pgvector filter hazard.** The filters sit *inside* the semantic CTE, so
HNSW returns its candidates and the filter is applied to them — the index does not
go back for more. A highly selective filter can therefore yield fewer than
`p_candidate_pool` rows. With `status='active'` being nearly every row this is
immaterial; with a narrow country or price band it is not. Two levers if it bites:
raise `hnsw.ef_search` for the session, or add a **partial** HNSW index
`WHERE status = 'active'`, which makes the dominant filter free. The partial index
is deliberately not created — it doubles the vector index's build cost and memory,
and the right moment to decide is when the table has enough rows to measure.

**6. It strips `metadata.bargain_windows`, and that is the one difference that is a
safety rule rather than a design preference.** `minPrice` *is* the selling price and
`maxPrice` the ceiling haggling may reach — the negotiating agent's hand — and
search results are read straight into a customer-facing model's context. The strip
is `metadata - 'bargain_windows'` **inside the function**, so it happens once for
every caller instead of depending on each one remembering. A server-side caller
that genuinely needs the window reads the row directly and does not come through
here. This is the strongest argument for it being a function at all rather than a
query pasted into TypeScript.

### The three per-arm ranks come back on purpose

`semantic_rank`, `keyword_rank` and `fuzzy_rank` are in the result. The three
weights — `p_semantic_weight`, `p_keyword_weight` and `p_fuzzy_weight`, all
defaulting to **1.0** — are the one part of this that cannot be reasoned to a
correct value. They have to be tuned against real queries, and a result set that
says **which arm found each row** is the difference between tuning and guessing.
(Why all three are 1.0, rather than the fuzzy arm being discounted as it first
was, is the first of the three corrections below.) A caller shipping to a
customer drops the three columns; a caller tuning keeps them.

The keyword arm is weaker here than in an English-stemmed corpus, and knowingly so:
`tsv` is built with the `simple` configuration because the catalogue is mixed
FR/EN and a stemmer guessing the wrong language is worse than no stemmer. That is
part of why the fuzzy arm earns its place, and why the weights are parameters
rather than constants.

### It was RUN, and running it changed it three times

Against a throwaway `pgvector/pgvector:pg17` container — **PostgreSQL 17.11, the
same version as `vector_db`** — with 3 004 rows: four hand-built products shaped
like real `buildPayload` output (one of them archived, one carrying a
`bargain_windows` key) and 3 000 filler rows so the planner had a reason to
choose indexes.

| Check | Result |
|---|---|
| the whole file applies clean, twice | ✅ idempotent |
| `"nike air max"` | Nike **first**, found by all three arms (`sem 1, kw 1, fz 1`), score 0.049 vs 0.016 for the rest |
| `"nikee air max"` (typo) | Nike **still first**. `keyword_rank` is **NULL** — the full-text arm found nothing, exactly as predicted — and `fuzzy_rank` is 1 |
| typo **and** an unrelated query vector | Nike returned at #2 **on the trigram arm alone**… |
| …the same call with `p_fuzzy_weight => 0` (the Supabase two-arm shape) | **Nike does not appear at all** |
| `bargain_windows` | 1 row in the table has it, **0** come back through the function |
| the archived product | never returned, under any query |
| `country` / `category` / `price_max` / `in_stock_only` | each drops exactly what it should |
| weights | `p_keyword_weight => 0` and `p_semantic_weight => 0` produce visibly different orderings |
| empty query text | 5 rows, no error (an empty `tsquery` simply matches nothing) |
| `tsv` GIN index | used |
| trigram index | used — the planner rewrites `'nikee air max' <% title` to `title %> 'nikee air max'` |
| HNSW index | used |
| `INSERT … ON CONFLICT (product_id)` | 1 row, new price — the workflow's write path holds against this schema |

The middle two rows are the ones worth keeping: they are the measured case for the
third arm, not an argument for it.

**Three things only running it could have found**, and all three are now fixed in
the file:

1. **`p_fuzzy_weight` was 0.5, and that silently disabled the arm.** A fuzzy-only
   rank-1 hit scores `0.5/(60+1) = 0.0082`; a semantic-only rank-**fifty** hit
   scores `1.0/(60+50) = 0.0091`. Because the semantic arm has no relevance floor
   it always returns a full pool, so a product found only by trigram could never
   reach a top-5. The typo query returned five unrelated fillers. Weight is now
   1.0, and the arithmetic is written above the function — a weight below 1.0 does
   not reduce an arm's influence, it can remove it.
2. **`CREATE OR REPLACE FUNCTION` does not replace a function whose signature
   changed** — a function's identity is name + argument types, so adding
   `p_max_distance` created a *second* `product_search` and every existing call
   died with `function product_search(vector, unknown, integer) is not unique`.
   That is a failure of the **callers**, at their next request, not of the deploy
   that caused it. The file now drops every overload by OID before creating.
3. **Positional calls are a trap at thirteen parameters.** Inserting one parameter
   shifted every filter one place right; the first positional caller got
   `invalid input syntax for type double precision: "CM"` — the *lucky* version,
   since two adjacent parameters of the same type would have swapped a price
   ceiling for a rank constant in silence. Callers must use `=>`.

### The one defect that is documented rather than fixed

**The semantic arm has no relevance floor**, and that is inherited from Supabase's
design rather than introduced here. `@@` and `<%` both return nothing when nothing
matches; a nearest-neighbour scan always returns `p_candidate_pool` rows, however
unrelated. Measured: a nonsense query against an orthogonal vector returns **five
products**, all of them wrong.

`p_max_distance` is the lever, and it works — the same query returns **0** rows at
`p_max_distance => 0.5`, while a genuine hit still comes back. It defaults to
**NULL (off)** on purpose: a threshold picked without measuring real voyage-4
distances would silently drop good results, which is worse than ranking some weak
ones alongside good ones. **Calibrate it against the live index and then set it** —
that is a task for whoever builds the search endpoint, not a decision to guess now.

### What is still owed before anything can call it

- **A Postgres client in jovi-mall.** There is none — no `pg`, no connection pool,
  no config block. This is new infrastructure and it needs its own decisions
  (pool sizing, where the credentials live, what happens to a bot search when
  `vector_db` is unreachable).
- **The query embedding.** `product_search` takes a `vector(1024)`; something has
  to call Voyage with `inputType=query` — note *query*, not *document* — before it
  can be called at all.
- **Applying the function** to `vector_db`.

---

## 14. The read path, BUILT — `wi-mall-product-search`

The tool the shopping bot actually calls. Built and verified 2026-09-06.

| Piece | Where |
|---|---|
| The search tool | n8n workflow **`wi-mall-product-search`** (`GUrwafUbWGNv4XW7`) — published |
| The schema applier | n8n workflow **`wi-mall-vectoriser-schema`** (`i4Zo7LPGZx9Rh7mE`) |
| The hydration route | `GET /api/public/products/by-ids` — [`api-doc/public/catalog.md`](../../public/catalog.md) |
| The consumer | `wi-mall-core`'s `Search-Products` tool |

### The decision that shaped it: jovi-mall gets no pgvector access

Retrieval and the index stay on the same side. jovi-mall grew **no Postgres client,
no new credential, and no new way to be unhealthy** — the vectoriser already owns
`product_vectors`, and giving a second service read access would have meant two
owners for one store.

What jovi-mall did grow is one read route, `GET /api/public/products/by-ids`,
because of the split below.

### pgvector retrieves. jovi-mall prices.

⚠ **The index is a snapshot.** Stock only refreshes when a product is
re-vectorised, and an order does not trigger one — so a price quoted from the
index will eventually be a lie to a customer about money.

So the tool splits the question. `product_search()` answers *which products, in
what order*; `/products/by-ids` answers *what they cost and whether they are
there*. That route returns rows **in the order the ids were sent**, so the RRF
ranking survives hydration with nothing re-sorting it, and it names ids that are
no longer publishable in `missing` — which makes it a **freshness gate** as well:
a product still sitting in the index but withdrawn from sale is dropped by its
absence. That fired on the very first live run (`"1 match(es) were withdrawn from
sale and omitted."`).

### The shape

```
Search Request  (query, limit?, category?, maxPrice?, inStockOnly?, country?, maxDistance?)
  → Normalise Query          fold case/spacing for the cache key; cap limit at 10
  → Cache Lookup             UPDATE … RETURNING — reads, stamps a sliding expiry, proves its own hit
  → Cached?
       hit  ─────────────────────────────────────────┐
       miss → Embed Query    Voyage, input_type=QUERY │  (not `document` — asymmetric embeddings)
            → Shape Vector ──┬────────────────────────┤
                             └→ Cache Embedding       │  parallel sink, never in the data path
  → Run Hybrid Search        product_search(), 3-arm weighted RRF
  → Found Anything?
       yes → Collect Ids → Hydrate Live Prices → Shape Result   (source: "hybrid")
       no  ────────────────────→ Keyword Fallback → Shape Fallback Result  (source: "keyword")
```

Returns **one** item: `{ query, source, count, products[], note }`.

### Four failures, one fallback

`Keyword Fallback` (jovi-mall's own `$text` search) catches **all** of: Voyage
returned no vector, `vector_db` was unreachable, the hydration failed, and the
hybrid search matched nothing. It is a weaker search — Mongo `$text` is whole-word
with no stemming, so `dres` will not find "dress" — but it is live data, so the
prices are right and the customer still gets an answer. `source` says which engine
answered; both are valid successes.

### The allowlist

`Shape Result` builds every field the agent sees, by name. Two reasons it is not a
passthrough:

- **`metadata.bargain_windows` is the negotiating hand.** `product_search()`
  already strips it and this never reads `metadata` at all, so leaking it into a
  customer-facing model's context would take two independent mistakes.
- **`product_text` is 500–900 characters per product.** Five of those is 4 KB of
  context for nothing. Only a 160-character snippet survives.

### The query cache is Postgres, not Redis

⚠ **The n8n Redis node's `set` operation exposes no TTL** — its `expire`/`ttl`
fields belong to `incr` — so a Redis cache here would grow without bound and need
a sweeper anyway. `product_search_query_cache` stores a real `vector(1024)`
instead of a ~20 KB JSON string, on a connection that is already open.

The lookup is an `UPDATE … RETURNING`, not a `SELECT`: it fetches the vector and
stamps `last_used_at` in one round trip, which makes the expiry a **sliding**
window and makes the hit/miss verdict a returned **row** rather than a node
reporting success. Nothing prunes it; the `DELETE` is in `product_vectors.sql`.

⚠ **The cached vector is voyage-4 @ 1024 dims, `input_type=query`.** Changing the
embedding model means `TRUNCATE`-ing this table in the same change — a stale row
here is not a stale price, it is a vector from a different space, and it returns
confident nonsense rather than failing.

### The relevance floor, measured

`maxDistance` defaults to **0.60**, and that number came from the index rather
than from judgement. `wi-mall-vectoriser-schema` node 6 measures it:

| query | nearest | p25 | median |
|---|---|---|---|
| `ventilateur sur pied` — a real match | **0.3044** | 0.6691 | 0.7283 |
| `chaussures de sport` — nothing matches | **0.6908** | 0.7753 | 0.7909 |

Without a floor, "chaussures de sport" against a catalogue holding no shoes
returned five confident, unrelated products — earphones, a t-shirt, a fan — because
the semantic arm has no natural floor and always fills its pool. **For an AI agent
that is worse than nothing**, since it presents them as recommendations. With the
floor it answers `count: 0, note: "No products matched."`

⚠ **Re-measure as the catalogue grows** (this was 29 products) **and always after
changing the embedding model.** A distance from one vector space means nothing in
another.

### What the three arms actually did

Live, on `ventilateur sur pied`:

| result | semantic | keyword | fuzzy | score |
|---|---|---|---|---|
| Ventilateur sur pied | 1 | 1 | 2 | **0.0489** |
| Ventilateur sur pied (other store) | 2 | 2 | 1 | **0.0487** |
| Fer à repasser vapeur | 3 | — | — | 0.0159 |

A 3× gap between "all three arms agree" and "the floorless semantic arm alone".
That gap *is* the fusion working, and it is why the per-arm ranks are returned.

### Still owed

- **`STOREFRONT_BASE_URL` in the n8n container.** Unset, so every result carries
  `url: null` and only the relative `path`. The bot cannot send a clickable link
  until it is set. This is a fourth env var owed to that container, alongside the
  three in the bot workflows.
- **`wi-mall-core` is still inactive**, as it was before this change. Activating it
  is the owner's call.

---

## 15. Product photos — the image arm  ✅ LIVE (2026-09-22)

**What it adds.** A fourth retrieval arm over what the product *photos* look like. A
text query can then reach a product whose text never mentions it (*"voiture de sport
noire"* finds the Porsche photo), and a customer's **photo** can reach the product it
shows. Only pictures are embedded: PNG/JPEG/WEBP/GIF from the gallery and from each
variant. **No video, no digital asset.** Both are excluded by how the list is built,
not by a filter someone has to remember (§ 15.3).

**Where it stands.** Applied and published on the production n8n and `vector_db`, and
proven end to end there with a test product (§ 15.9). ⚠ **It has no real photos to work
on yet**: on 2026-09-22 production had one public product, and it had no photo; the
production index held only stale dev products (§ 15.10). Photos start flowing as soon
as real products with photos are vectorised through jovi-mall's normal opt-in.

| Piece | Where | State |
|---|---|---|
| Table, trigger, claim/settle, cache, 4th arm | [`product_vectors.sql`](product_vectors.sql) → `wi-mall-vectoriser-schema` | ✅ applied; `7. Fingerprint` = the proven container, 10/10 hashes |
| SQL proofs | [`image_arm.test.sql`](image_arm.test.sql) | ✅ 47/47, 4 guards proven to bite, old-schema upgrade path proven |
| The drainer | **`UP-wi-mall-image-vectoriser`** (`SiWU1FWg3sFoilQE`), built from `image-vectoriser/nodes/*.js` | ✅ published, every minute |
| The one change to the text flow | `UP-wi-mall-vectoriser` → `build all texts` → **`metadata.image_files`** | ✅ published; draft proven byte-identical to the patched file |
| n8n-side proofs | [`image-vectoriser/test.js`](image-vectoriser/test.js) · [`search/test.js`](image-vectoriser/search/test.js) | ✅ 51/51 · 42/42 |
| The search side | `UP-wi-mall-product-search` (`GUrwafUbWGNv4XW7`), `UP-wi-mall-core` → `Search-Products` | ✅ published (§ 15.7) |
| Floor calibration | [`image-vectoriser/calibrate-floors.js`](image-vectoriser/calibrate-floors.js) + `calibration-2026-09-21.json` | ✅ real voyage-multimodal-3.5 vectors |
| Live smoke test | **`wi-mall-image-arm-smoke`** (`c6jCwddhot1pa5qN`) — seed / check / photo / clean | ✅ keep INACTIVE; run by hand |

### 15.1 · Why a separate arm, not a new model for the whole index

The image model is **`voyage-multimodal-3.5`**, and it is **not in the voyage-4
vector space**. Voyage's shared space covers only the four voyage-4 text models. That
left two options:

- Move the whole index to the multimodal model. That means a full re-index,
  re-measuring the § 14 floor, emptying the query cache, and leaving pure-text
  matching to a model that isn't voyage-4.
- Keep the text index **exactly as it is** and add photos as a ranking of their own.

The owner chose the second. It is additive: the live text search can't regress, and
RRF never compares distances across the two spaces, only positions.

**Each photo is embedded alone, with no caption.** Adding the title would make this
arm re-find what the three text arms already find, and RRF would count the same
evidence twice. The arm exists to add what the text doesn't say.

### 15.2 · Designed for the free tier, on the owner's instruction

The owner asked for the flow to be designed **as if no Voyage payment method
existed**, which means **3 requests and 10K tokens per minute**. Voyage charges
**1 token per 560 pixels**, capped at about 2M pixels, so a full-size product photo
costs **up to ~3,572 tokens**. One 32-product text chunk carrying six photos each
would be ~100× the per-minute budget.

So images are **not** embedded inside the text job. The text flow gains exactly one
metadata key, and a separate **scheduled drainer** embeds the photos at a pace the
free tier can carry:

```
wi-mall-vectoriser  (same shape as before)
  build all texts    ── metadata.image_files = embeddableImages(p)   ← the ONLY edit
  store chunk        ── INSERT … ON CONFLICT (product_id) DO UPDATE
                           └─ trigger → product_image_vectors rows ('pending'),
                              same transaction, only when the image list changed

wi-mall-image-vectoriser  (new, every minute)
  mint claim id → claim images → build embed request → embed images
               → assemble results → settle images → verify settled
```

**The two settings** are `EVERY_MINUTES = 1` and `BATCH = 2` in `build-workflow.js`.
Two full-size photos are ~7.1K tokens in one request per minute. That leaves two
requests and ~2.9K tokens of each minute for the live search's own multimodal calls,
and it works out to **120 photos an hour**. On a paid tier you change those two
numbers; the workflow's shape stays the same.

⚠ **Voyage's free-tier limiter refuses requests by IMAGE COUNT, not by pixels.**
Measured 2026-09-21 with the key in `jovi-mall/.env`:

| request | billed tokens | answer |
|---|---|---|
| 1 image, 512 px | 334 | 200 |
| 3 × 512 px | 1,003 | 200 |
| 4 × 512 px | 1,338 | 200 |
| 6 × 512 px | 2,007 | 200 |
| **11 × 256 px** | ~1,000 | **429** |
| 11 × 512 px | ~3,700 | **429** |
| 3 × 1024 px · 2 × 1440 px | 4,015 · 5,292 | 200 · 200 |

Eleven images are refused at any size, even though they'd bill a tenth of the
budget. The per-request ceiling is somewhere between 7 and 10 images regardless of
size, and the **billed** tokens are what use up the minute. `BATCH = 2` stays under
both limits.

⚠ **The key in `jovi-mall/.env` (`VOYAGE_EMBEDDINGS_API_KEY`) belongs to a Voyage
organisation with NO payment method.** Every probe above came back with the
reduced-limits message. If a payment method was added, it went on a different
organisation, or n8n's `Voyage Bearer` credential holds a different key. Check which
organisation the production key belongs to before relying on paid limits anywhere.

### 15.3 · Which photos (`embeddableImages`)

This function lives in `build all texts` (inside `buildProductText`), and its result becomes
`metadata.image_files` beside the older `metadata.images`. It never enters the embedded
**text**, so § 5's rule still holds.

- **PNG / JPEG / WEBP / GIF only**, the four formats Voyage accepts. A video in the
  gallery (`video/mp4`) is skipped. A digital asset lives under
  `variants[].digitalConfig.asset` and is never read.
- **https only.** Voyage fetches each URL itself. An `http://` URL points at a dev
  laptop's storage, which Voyage can never reach, so queuing it would only burn five
  attempts. In production the URLs are on the R2 CDN (`cdn.fante.cloud`).
- **Gallery first, then each variant's own photos**, deduplicated by file id. A
  gallery photo reused on a variant counts once, as a gallery photo.
- **At most 6 per product.** At 2 photos a minute that is three minutes of drainer
  time per product, and it limits the queue one vendor with 40 photos could build.
- **`url: null`** means the file is quota-blocked and the platform withheld its
  address. It is skipped, never guessed.

### 15.4 · The queue, and the rules that make it safe to run every minute

`product_image_vectors` is both the queue **and** the index: one row per (product,
file), moving `pending → claimed → embedded | failed`. The trigger keeps it in step
with `product_vectors.metadata.image_files`. The foreign key **cascades from
`product_vectors`**, so `/delete` needed no change. `/status` needed none either,
because the arm joins `product_vectors` and inherits its status filter.

- **Re-indexing with the same photos touches no row.** This is the common case, e.g.
  a price edit. The trigger fires only when the image list changed, and the upsert
  rewrites only rows whose URL, variant or position moved. Proven by `xmin` (test 1e).
- **An embedded photo keeps its vector when only its URL moves**, e.g. after a
  storage migration: same file id, same bytes. A *failed* photo whose URL moved gets a
  fresh start.
- **Primary photos go first, across all products.** The claim orders by position, so
  every product's photo 0 is embedded before any product's photo 1.
- **Settling a claim is idempotent**, the same way jovi-mall's
  `vectorisationJob.jobId` works. Settle writes only rows that still carry *its*
  `claim_id`. A duplicate, late or foreign settle writes nothing, and `verify settled`
  catches that in the returned rows.
- ⚠ **One bad URL fails the whole Voyage request.** So new work is claimed in
  batches, but **a retry is always claimed alone**. The bad photo fails its
  batch-mate once; after that each is retried by itself, and only the bad one keeps
  failing.
- ⚠ **Only a failure caused by the photo itself uses up an attempt.** `failed`
  (attempts + 1, backoff 1-2-4-8 min, 5 attempts) is reserved for a 400/413/415/422.
  A 429, a 5xx, a refused credential or no answer at all is `deferred`: the photo goes
  back to pending in a minute and **no attempt is spent**. Otherwise one afternoon of
  Voyage outage would exhaust the whole queue. 401/403/5xx/no-answer also **throw** in
  `verify settled`, so the run reaches the automation board through `errorWorkflow`. A
  429 doesn't throw: on the free tier it's expected, not an incident.
- **An abandoned claim** (the run died between claim and settle) is recovered after
  10 minutes and **counts as an attempt**, so a photo that crashes its run every time
  eventually stops being retried.
- Successful executions are **not saved** (`saveDataSuccessExecution: none`). The
  drainer runs 1,440 times a day and nearly every run is "nothing to claim". Failures
  are saved.

When photo search seems thin, run this first to see where the photos stand:

```sql
SELECT status, count(*) AS images,
       count(*) FILTER (WHERE attempts >= 5) AS gave_up,
       min(next_attempt_at) FILTER (WHERE status <> 'embedded') AS next_due
FROM product_image_vectors GROUP BY status;
```

### 15.5 · The fourth arm in `product_search()`

Three new parameters, **appended last** so every existing call with named arguments
is untouched, and **off by default**:

| | |
|---|---|
| `p_image_embedding` | the query as a `voyage-multimodal-3.5` vector, `input_type=query`: a customer's photo, or their words |
| `p_image_weight` | 1.0 (§ 13's lesson: a weight below 1.0 can disable an arm) |
| `p_max_image_distance` | the floor. ⚠ **never omit it when the embedding is set** |

A product counts as close as its **closest** photo, since one good angle is a match.
The arm is an **exact** scan over the photos of products that pass the filters.
Filtering first means the pgvector filter hazard in § 13 can't starve it, and it takes
milliseconds at a few thousand photos. There is deliberately no HNSW index: the
planner couldn't use one from inside this query, and an unused index still slows
every write. `image_rank` is returned beside the other three ranks.

`p_query_embedding` may now be **NULL**. A photo with no words skips the text semantic
arm (`One-Time Filter: false` in the plan) and ranks on the image arm alone.

⚠ **A finding about the EXISTING function, recorded here, not fixed.** § 13's table
says the HNSW index is used. **It isn't, from inside `product_search()`.** The
`filtered` CTE is referenced by every arm, PostgreSQL materialises any CTE referenced
more than once, and so the semantic arm runs as a sequential scan plus sort over it.
Measured with `EXPLAIN` on PG 17.11 + pgvector 0.8.6, 2026-09-21. At today's
catalogue size that is *exact* search costing milliseconds, and it's more accurate
than HNSW. It stops being cheap somewhere in the tens of thousands of products. The
fix then is `AS NOT MATERIALIZED` on the semantic arm's own scan, or a direct HNSW
scan joined back to `filtered`, with `hnsw.iterative_scan`.

### 15.6 · The floors, MEASURED

Measured with real `voyage-multimodal-3.5` vectors: 11 catalogue photos from dev
storage, 9 photo queries, 22 text queries (`calibration-2026-09-21.json`).

| search | true matches | nothing matches (nearest) | floor |
|---|---|---|---|
| **photo → photo** | 0.146 – 0.379 | 0.641 – 0.738 | **0.50**: clean gap |
| **text → photo** | 0.498 – 0.827 | 0.773 – 0.925 | **0.72**: the ranges overlap |

- **The realistic photo case is the book.** A *different page* of the same workbook
  still found it, at 0.373. The crops (0.15–0.21) flatter the numbers.
- ⚠ **Photo search finds THE SAME PRODUCT, not look-alikes.** A different car scored
  0.712 against the Porsche crop, further away than an empty road (0.641). Don't
  promise "similar items" from a photo; promise "this item, if we sell it".
- **Text → photo is the weaker direction**, so 0.72 is deliberately conservative. It
  keeps 9 of 12 matches and admits **no** non-match (the nearest was 0.7725). It drops
  *sac à dos* (0.815), *chat roux* (0.827) and *livre pour apprendre le chinois*
  (0.751). The three text arms still cover those words, and showing a wrong product is
  worse than missing a weak one.
- ⚠ **Re-measure on the live index once the backlog is embedded.** The same photo at
  1440 px and at 512 px drifted **0.084 – 0.162**, and these vectors were made at
  512 px while production embeds the originals. Also re-measure after any model
  change, the same rule as § 14.

### 15.7 · The search side, as built

Owner decisions, 2026-09-22: **customer photos may be sent to Voyage** for the search,
and a photo is **searchable only in the message it arrived with**. It is used for that
one search and dropped: never cached, never stored.

**`wi-mall-core` → `Search-Products`** gained three inputs:

| input | value | why this shape |
|---|---|---|
| `usePhoto` | a standalone from-AI boolean | the model decides whether this search is about the picture. Same shape as `inStockOnly`, the one pattern already proven in that node |
| `photoBase64` | `$('Inbound').first().json.media.contentBase64`, **image messages only** | a voice note or PDF never travels; `$('Inbound').first()` is how the node's other tools read the message |
| `photoMimeType` | the message's mime | |

⚠ **Why not one expression gating the bytes on the model's answer.** It would put a
from-AI call inside a larger expression, which no tool in this bot does. If n8n parsed
it wrongly, every product search would break for every customer. The two-input shape
costs one thing: on a turn that carried a picture *and* ran a search, the picture also
lands in product-search's execution log, as it already does in core's.

**`wi-mall-product-search`**, in order:

```
Search Request  (+ photoBase64, photoMimeType, usePhoto)
  → Normalise Query       zero = not given (§ 15.10); has_text / has_photo / image_arm
  → Cache Lookup → Cached?
       hit ───────────────────────────────┐
       miss → Has Text?                   │
                yes → Embed Query → Shape Vector ─┤ (+ Cache Embedding)
                no  ──────────────────────────────┤
  → Text Vector Ready  (NoOp — the text vector's single meeting point)
  → Image Arm?
       no  → Run Hybrid Search
       yes → Image Cache Lookup → Image Cached?
                hit → Run Hybrid Search
                miss → Embed Image Query → Shape Image Vector → Run Hybrid Search
                                                             └→ Cache Image Embedding
  → Found Anything? → Collect Ids → Hydrate Live Prices → Shape Result → Any Live?
                                                                          yes → Return Hybrid Result
                                                                          no  → Keyword Fallback
```

- **The image arm is best-effort.** `Embed Image Query` has a real retry (no
  `neverError`, § 11's rule for a call a customer waits on) and `continueRegularOutput`.
  `Shape Image Vector` never throws. When the multimodal call fails, the search runs
  on its three text arms exactly as before.
- **Free-tier budgets are per MODEL**, measured: a fourth `voyage-4` call in a minute
  got 429, and a `voyage-multimodal-3.5` call in the same minute got 200. The image
  arm cannot starve the text search. Its own 3 RPM is shared between the drainer (1)
  and search-time image embeds (2).
- **Typed words are cached** (`product_image_query_cache`, key `text:<normalised
  query>`). **A photo never is**: its key is `null`, the lookup matches nothing and
  the insert's `WHERE` refuses it. Proven live (§ 15.9).
- **A photo with no words never reaches the keyword search.** jovi-mall answers an
  empty `q` with `400 VALIDATION_ERROR`, and a listing would have been worse.
  `Shape Fallback Result` answers `source: "photo"`, `count: 0`, with an honest note.
- The answer carries **`searchedPhoto`**. After a photo match, the note tells the
  agent to confirm with the customer: a photo finds the same item, not look-alikes.

Source of every node body and expression: [`image-vectoriser/search/`](image-vectoriser/search/)
(`normalise-query.js`, `shape-image-vector.js`, `shape-result.js`,
`shape-fallback-result.js`, `expressions.js`), proven by `search/test.js` (42/42, 3
guards bite). [`image-vectoriser/check-core-tool.js`](image-vectoriser/check-core-tool.js)
checks core's stored tool node and that nothing else in core changed.

### 15.8 · How it was applied, and how to re-apply it

Every edit was checked by **fetching the saved draft back and comparing it
byte-for-byte with the tested file** before publishing. An API edit writes the
draft (§ 12), and a transcription slip would otherwise ship unseen. That check caught
nothing in the workflows. It **did** catch a corrupted test photo I had pasted by
hand (§ 15.9), which is why nothing long is pasted by hand any more.

1. **Schema.** `wi-mall-vectoriser-schema` gained nodes `2a`–`2j` (cut verbatim from
   `product_vectors.sql` by `image-vectoriser/applier-statements.js`). They run
   **before** step 3/4, because `product_search()` now reads `product_image_vectors`.
   A new node **`7. Fingerprint`** hashes what is *installed*: functions, triggers,
   columns, constraints, indexes. Run the same query on a throwaway container with
   the file applied; equal hashes mean `vector_db` holds exactly the proven schema.
   On 2026-09-22: **10/10 equal**.
2. **Text flow.** `image-vectoriser/patch-build-all-texts.js` builds the new `build all
   texts` from the LIVE one by anchored insertion. It proves every output field
   except `image_files` is byte-identical. ⚠ The key is **`image_files`, not
   `images`**: the live node already wrote `metadata.images` as five bare URL strings,
   and reading objects out of it would have produced zero rows, silently.
3. **Drainer.** Created from SDK source generated by `image-vectoriser/sdk-source.js`
   (the same definition `build-workflow.js` writes to JSON). Settings: failure
   reporter `d2JZ7jA2jJCg0O9S`, successful runs not saved, 300 s timeout.
4. **Search side**: § 15.7.
5. **Backfill.** Nothing indexed before 2026-09-22 has `image_files`. Products get
   them the next time jovi-mall vectorises them (vendor opt-in, or the admin bulk
   vectorise). ⚠ Do **not** push products into the index some other way: the
   vendor's opt-in is a billing gate.

### 15.9 · Proven live, 2026-09-22

With `wi-mall-image-arm-smoke`: a test product `imgsmoke-1`, two real photos on
`cdn.fante.cloud`. It is not a jovi-mall product, so customer searches drop it at
hydration.

| step | result |
|---|---|
| seed | the trigger queued **2 `pending` rows** in production |
| drainer, one manual run | claimed 2; Voyage fetched both from the CDN by URL (**200**, 5,656 tokens, 3.17 M px); settled **2 embedded**; `verify settled` clean |
| photo search through the real `Search Request`, core's argument shape | photo embedded as `image_base64`; `Run Hybrid Search` → **`imgsmoke-1`, `image_rank: 1`**, image arm only; `Cache Image Embedding` wrote **nothing** |
| clean | product deleted; **0 image rows left** (the FK cascade, in production) |
| core's OLD 7-input call against the new search | still answers (keyword: *Nike Air Max 90*, `searchedPhoto: false`) |

⚠ **Voyage's answer carried `x-api-warning: You have not yet added your payment
method`**. n8n's production key (`Voyage Bearer`) is on the free tier too, as the
owner said, so the free-tier shape is the right one.

### 15.10 · Found on the way, and fixed

**1 · Every bot search had been falling to the keyword fallback.** Core's
`Search-Products` sends `maxDistance: 0`, and a missing budget arrives as
`maxPrice: 0`; typed numeric inputs can't be blank (see the typed-input trap).
`Normalise Query` read both literally: a 0.00 relevance floor and a 0 XAF price
ceiling. `product_search()` returned nothing for **every** bot search, and every turn
fell to the weaker keyword search (execution 1335, 2026-09-17). **Fixed**: zero means
"not given" for both. Proven live: *ventilateur sur pied* with core's zeros now gets
the hybrid ranks.

**2 · The production index holds dev products.** The 29 rows in production
`vector_db` are dev seeds ("COD shipment seed", "agent-app seed") that production
jovi-mall does not know, so hydration drops them all. With fix 1 in place, the tool
would have answered "No products matched." where the bug used to fall through to a
keyword search that *does* find real products. **Guarded**: `Any Live?`. When every
hybrid match turns out withdrawn, the keyword search answers instead. ⏳ **Still owed
by the owner**: re-index the real catalogue through jovi-mall. The dev rows can
then be removed (`DELETE FROM product_vectors WHERE product_id = ANY(…)`); they are
harmless meanwhile, since hydration drops them.

**3 · `product_search()` never used its HNSW index** (§ 15.5), recorded rather than
fixed: at today's size, exact search is cheaper and more accurate.
