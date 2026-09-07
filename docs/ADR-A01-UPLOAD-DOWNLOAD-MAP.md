# ADR-A01 — Who can download whose uploads, and what gets scanned

**Date:** 2026-08-18 (evidence gathered 2026-08-17)
**Status:** Accepted. **D-1 IMPLEMENTED 2026-08-19** (plan step 4.A.4a) · D-2 awaits its own
release window (step 4.A.4b), which is deliberate — see [D-2](../../PRODUCTION-READINESS/PHASE-4-HARDENING-PLAN.md#d-2) of the Phase 4 plan
**Scope:** jovi-mall
**Answers:** [Q-5](../../PRODUCTION-READINESS/11-DECISIONS-REGISTER.md#q-5--who-can-download-whose-uploads)
of the Phase D register · closes **S-2** and **F-25**

---

## Why `docs/`, and why the `ADR-A0n` prefix

jovi-mall keeps its design records as top-level topic files (`AGENT-CONTRACT-REFACTOR.md`,
`MESSAGING-LOGIN.md`, `SHIPMENT-ASSIGNMENT.md`) — narratives about a subsystem, not decisions
about a question. Decisions get a directory. The `A` prefix keeps them from being read as part of
wi-admin's numbered ADR corpus, which they are not.

---

## Context

The `TODO` in `core/uploads/scanners/clamav-scanner.ts` survived because the question it depends
on had never been answered: **who can download whose uploads**. Writing that map answered it, and
surfaced the transport underneath it.

### The map

| Tree | Uploaded by | Reached by | How |
|---|---|---|---|
| `storage/images` · `products` · `videos` | vendor, agency, agent, customer | **anyone with the URL** | `express.static`; the URL is in every public product DTO |
| `storage/digital` | vendor | the buyer via `GET /api/digital/download/:token` — **and anyone with the raw URL** | the token path enforces single-use, a download counter and revocation; the static path enforces nothing |
| `storage/shipments` (delivery-proof photos) | agent | agency, vendor and customer through their own shipment reads — **and anyone with the URL** | `modules/shipments/delivery-proof.service.ts` |
| `storage/ticket-attachments` | any party to a ticket, and support | the other party, plus wi-admin's support module | wi-admin serves `support.tickets.attachments.*` |

**Uploaded bytes reach a second party on every surface.** Under Q-5's own test — *"if a customer
downloads a vendor's digital product, or an agency views an agent's proof photo, the risk is not
low"* — that settles the scanning question.

### The transport, verified

- `router.use('/files', express.static(path.join(__dirname, '../..', 'storage')))` —
  `src/api/index.ts:395`, mounted **before** `fileRoutes`, with no guard in front of it. The
  comment at `api/index.ts:61` already says so: *"`/files` also serves `express.static` and public
  reads"*.
- `baseUrl: process.env.STORAGE_LOCAL_URL || 'http://localhost:8022/api/files'` —
  `core/storage/storage.instance.ts:38`. So a stored file's `url` — the one every `FileDetail`
  carries — **is** that unauthenticated path.
- Filenames are `<uuidv4>_<originalName>`; `express.static` does not list directories. This is
  **capability-URL** access, not an open index. A URL, once seen, works forever and is shareable.

### The scanning, verified

Nothing is scanned, and the configuration that appears to control it is inert.
`UPLOAD_VIRUS_SCAN_ENABLED` defaults to on (`core/uploads/upload-config.ts:420`), but every call
site constructs a **`NoOpVirusScanner` returning `{ clean: true }`** — defined twice, at
`src/api/controllers/file-upload.controller.ts:92` and
`src/modules/shipments/delivery-proof.service.ts:34`. The ClamAV stub is wired nowhere and would
return `clean: true` as well. MIME sniffing is real
(`core/uploads/processors/file-sniffing.processor.ts`).

---

## D-1 · Scan on ingest, every surface

Implement `ClamAVScanner` against the existing `IVirusScanner` seam, or point that interface at a
hosted scanner. Both `NoOpVirusScanner` definitions become deletions — **both**, or the surface
that keeps one is the surface that is not scanned, and nothing in the config will say so. Keep
`blockOnFailure` on.

The seam is already correct: `VirusScanValidator` runs inside the upload pipeline, records a
violation per file, and the policy engine refuses the upload. What was missing is an
implementation on the other side of the interface.

## D-2 · The three private trees move off the static mount

`digital/`, `shipments/` and `ticket-attachments/` are served through authorized routes.
`digital/` already has one — `GET /api/digital/download/:token` — and gains nothing until the
second door closes. Public product imagery stays on `express.static`; that is what it is for.

**This is the larger half of the decision and the reason it is not just a scanner ticket.** While
the raw path is reachable, the download token's single-use consumption, its download counter and
its revocation are advisory: a buyer who shares the URL bypasses all three, permanently, and no
audit anywhere records that it happened. The same URL in a proof photo is a delivery address and
a timestamped location.

Implementation notes for 4.A.4:

- `STORAGE_LOCAL_URL` and the `FileDetail.url` resolver must stop emitting a public path for the
  three private trees; a `FileDetail` for a private file should carry an id the authorized route
  accepts, not a URL any client can fetch.
- The existing 73 files keep working only if the authorized routes read from the same tree —
  they do; this is a routing change, not a migration.
- ⚠ **Interaction with Phase 2 (ADR-019 D-1a).** Uploaded bytes are also moving off the container
  filesystem. Do these in a known order: whichever lands second must not silently reinstate a
  public URL for a private tree — an object-storage provider that returns a public CDN URL would
  undo D-2 without touching this repository.

---

## Consequences

- Two of the four surfaces stop being publicly fetchable, which is a **client-visible change** for
  anything that was rendering a proof photo or a support attachment from a raw URL. Check the
  agency and agent dashboards before shipping.
- The `UPLOAD_VIRUS_SCAN_*` variables become live for the first time; `.env.example`'s entries
  should say so, and `test:env` will keep them documented.
- Scanning adds latency and a daemon to the deployment (ADR-019). Sizing is a Phase 2 concern.

---

## D-1 as built (2026-08-19, plan step 4.A.4a)

**One correction to the decision, and it makes D-1 bigger than written.** The ADR says "both
`NoOpVirusScanner` definitions become deletions". There were **three** no-ops, not two: a third
lives at `digital-asset.service.ts` under a different class name — `MockScanner`, a test double
imported from the production barrel. It is the **digital-products** path: the tree whose bytes
travel furthest, behind a download token, to a paying stranger. Deleting the two named here and
leaving it would have left exactly one unscanned surface, the worst one, with the configuration
claiming otherwise — this finding reproduced rather than closed.

Built:

- **`core/uploads/scanners/index.ts`** — `resolveVirusScanner(config)`, the only construction
  path. `cloud`, an unrecognised value, and `mock` under `NODE_ENV=production` all **throw**
  (`CONFIG_INVALID_UPLOAD_SCANNER`). `assertUploadScannerSafe()` runs that at **boot**, beside
  `assertSigningSecrets()` — every injection site builds per request, so without it a
  misconfiguration is discovered by a vendor. `mock` is the built-in default, so this is what a
  production deploy that forgets the variable meets.
- **`ClamAVScanner`** — `clamd` INSTREAM over a raw TCP socket, no new dependency. One
  whole-operation deadline (`UPLOAD_CLAMAV_TIMEOUT_MS`), not `socket.setTimeout`: an idle
  timeout is restarted by every byte, so `blockOnFailure` never gets a verdict to act on.
- **All three no-ops removed from the runtime path.** `MockScanner` survives as a test double
  and left the `core/uploads` barrel, so nothing in `src/` can reach it by accident.
- **`test:uploads`** (37) — its spine is a source scan asserting **no file under `src/`
  constructs a scanner directly**, because the reason this survived is that a scanner which does
  nothing is indistinguishable from one that works.
- A `clamav` sidecar in `docker-compose.yml` (`service_healthy`, `clamdcheck.sh`, definitions on
  a named volume) and a `docs/RUNBOOK.md` § 1 subsection.

### The live check found a bug the source scans could not

Proven against a real `clamav/clamav:stable` on this host (database 28097, 2026-08-19), driving
`ClamAVScanner` and `VirusScanValidator` directly:

```
scan(EICAR)         -> {"clean":false,"virus":"Eicar-Test-Signature", ...}
scan(clean)         -> {"clean":true}
scan(2 MB clean)    -> {"clean":true}          # multi-chunk, so the framing is exercised
validator(EICAR)    -> [{"code":"VIRUS_DETECTED", ...}]
validator(no clamd) -> [{"code":"VIRUS_DETECTED","message":"Virus scan failed: File scanning is temporarily unavailable"}]
```

⚠ **The first run of that returned `stream: OK` for EICAR.** A `z`-prefixed clamd command gets a
**NUL-terminated** reply with no trailing newline, so the wire carries
`stream: Eicar-Test-Signature FOUND\0` — and an anchored `/…FOUND$/m` matches *neither* verdict,
because `$` wants a newline or end-of-string and finds `\0`. Every scan fell through to the
"unavailable" throw. The direction was safe (`blockOnFailure` refuses the upload), but the effect
was **a scanner that never returns a verdict, behind a configuration that says it does** — this
ADR's own finding in a new costume. A unit test written against a fixture the same author
invented would have carried the same wrong assumption. `test:uploads` now pins the wire protocol
against a fake clamd on a real socket, including both terminators and the chunk framing.

Two host facts worth recording: `docker pull` of this image needed a retry behind the local TLS
interception (R-1), and **an EICAR file cannot be written to disk on this machine at all** —
Avast quarantines it, so the probe holds the signature in memory only.

### Still open: `UPLOAD_VIRUS_SCAN_ENABLED=false` is not refused

Deliberate, and the distinction is this ADR's own: S-2 was about a configuration that *claimed*
to scan and did not. `enabled=false` claims nothing — it is an operator's explicit choice. It is
logged loudly at boot rather than refused.

---

## D-2 as built (2026-08-19, plan step 4.A.4b)

⚠ **Client-breaking. Its own release window, and it must not open until D-1 is deployed and
quiet** (Phase 4 plan D-2). Code landed; the *release* is a separate decision.

### The map above is wrong about `ticket-attachments/`, and the correction matters

This ADR names three private trees, each holding its category's files. **Two of the three are
real.** A census of every `folder:` literal in `src/` finds no writer for
`storage/ticket-attachments` at all; the directory holds **one** file predating the current
design, and the only other references to the name anywhere are stale example URLs in three
api-docs (which additionally show `/storage/…`, a prefix that has not been correct for longer
still).

A ticket attachment today is an ordinary `by-type` upload: it goes through
`POST /api/files/upload`, lands in `documents/` or `images/` **beside public product imagery**,
and is attached to the ticket by id afterwards. So it **cannot be made private by moving a
directory** — the tree it is in is the tree product photos are in.

The tree is classified `private` here anyway (the one legacy file stops being served, and the
name cannot become an unclassified surprise later), but **the real gap is open** and is stated
rather than papered over: closing it needs a dedicated ticket-attachment upload path writing to
a private purpose folder, plus an authorized read reusing the ticket's scope, plus a migration
for existing attachments. That is its own decision, not a line in this step.

### Built

- **`core/storage/storage-trees.ts`** — one verdict per tree, and `express.static` mounts are
  **derived** from it, so the mount and the classification cannot drift. An **unknown tree is
  private**: `isPrivateStorageKey` fails closed, so a tree added next year is private until
  somebody says otherwise. Keys are normalised for `\` — the local provider uses `path.join`,
  so the same file must not classify one way on Windows and another in the container.
  `test:uploads` asserts every `folder:` literal and every `MediaCategory` folder is
  classified, which turns "remember to add a row" into a failing suite rather than a 404.
- **`toFileDetail` returns `url: null` + `access: 'authorized'`** for a private key. `null`
  rather than the authorized path, because a path is a string indistinguishable from a public
  URL and every client would keep rendering it into nothing; `string | null` is a **type**
  change, so the compiler produces the migration list.
- ⚠ **Three sites were building `FileDetail` BY HAND** (`ProductListService`,
  `enrich-product-detail`, `vendor-profile.dto`), which is how a rule living at "the single
  choke point" reached only some of the platform's files. All three now call `toFileDetail`,
  and `test:uploads` scans for `getPublicUrl` outside the resolver so a fourth cannot appear.
  `VectorisationService` builds a different shape for an external payload and was given the
  same guard rather than an exemption.
- **`GET /api/{agent,agency}/shipments/:id/delivery-proof/file`** — the bytes, scoped by the
  **same** `findByIdAndAgent` / `findByIdAndAgency` predicates the shipment reads use. Re-used,
  not re-derived: a fresh rule here is how a file route and its entity drift apart, which is
  the defect this decision closes rather than relocates. 404 and never 403, matching the reads.
  `Cache-Control: private, no-store` — the URL this replaced was cacheable by anything, which
  is half of what made it a durable leak.
  Only those two roles, because `_buildDetail` — reached by `getDetailForAgency` and
  `getDetailForAgent` — is the only thing that surfaces a proof. **The customer and vendor
  cases in the map above do not exist in the code**; adding one means adding its read first.
- **`GET /api/digital/download/:token`** needed no change and becomes real: its single-use
  consumption, download counter and revocation stop being advisory the moment the second door
  closes.
- **The ADR-019 D-1a interaction is written at the provider switch**, in
  `core/storage/storage.factory.ts`, where the next author will actually be standing. The
  enforcement lives in `toFileDetail` and the mount list — **neither is inside a provider** —
  so an object-storage provider returning a public CDN URL reinstates the leak without touching
  either file and without failing a test. The note says what a new provider must do instead
  (no public read ACL; stream through the authorized route, or sign inside it — never in
  `getPublicUrl`, which has no idea who is asking).
- **`api-doc/FRONTEND-CHANGELOG-private-files.md`** — the delivery mechanism, since the clients
  are outside this workspace.

### Not verified here, and it cannot be

**R-3 stands.** The agency dashboard and the agent app may be rendering a proof photo from a raw
URL; this repository cannot check that, and the changelog is a notice rather than a
verification. Check both before the window opens.

---

## D-1 finished at plan step 4.A.4c (2026-08-19)

**D-1 was not closed by 4.A.4a.** Two things surfaced afterwards, and together they are the
same question: *which configuration decides whether bytes are scanned, and which paths reach
the pipeline that asks?*

### The scanner reached one of the four sites it was wired to

`resolveVirusScanner(config)` reads `config.virusScan.provider`, and **only
`loadUploadConfig()` read `UPLOAD_VIRUS_SCAN_PROVIDER`** — the other four factories hardcoded
`provider: 'mock'`. So in development the **digital-products path**, the tree this ADR's
correction exists for, was still unscanned *after the step that fixed it*; and in production
`resolveVirusScanner` refuses `mock`, so video, digital-asset and delivery-proof uploads would
all have failed outright.

⚠ **The boot guard could not see it.** `assertUploadScannerSafe` is handed
`loadUploadConfig()` — the one config that was already correct — so the boot passed and the
failure waited for the first upload. That is exactly the failure mode the guard exists to
prevent, one level up. **A guard is only as wide as the thing it is pointed at**, and this ADR
has now produced that lesson twice.

`resolveVirusScanConfig()` is the fix, spread by all six configs, with a source scan forbidding
a `provider:` literal in any factory.

### Two upload surfaces were never in the map

`POST /api/{vendor,agency}/profile/policy-documents` call `storageProvider.put` **directly** —
no scan, no sniffing, no fingerprint, no quota, and a gate on the **client-claimed** MIME type.
This ADR's map has four rows and these are a fifth: PDFs from a vendor or agency, returned as a
public URL the owner republishes into `policies.documents`, where counterparties read them.

They were invisible to 4.A.4a's source scan because they construct no scanner — they reach no
pipeline to need one. **A scan for the wrong thing being done finds nothing when the thing is
not done at all.**

Both now route through `PolicyDocumentUploadService`. `{ urls }` is unchanged, so this half is
not client-visible.

⚠ **And it could not be a one-liner, for a reason worth carrying forward.** A file that reaches
`UploadIntakeService` gets a `File` record, and `LonelyFileDeletionService` permanently deletes
a File with no live reference — its clock "falls back to `createdAt` for files that were
uploaded but never attached". Policy documents survive that sweep today only because they are
*not* File records. Creating the record without referencing it would have traded an unscanned
upload for **the loss of every vendor's policy PDFs**, with `policies.documents` still pointing
at them. The reference is therefore written at upload; the cost is that a document uploaded and
never submitted is retained rather than reclaimed, which is the correct direction to err.

**The map above should be read as five surfaces, not four.**
