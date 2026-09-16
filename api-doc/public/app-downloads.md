# Public API — app downloads

**The agent app's APK, for the marketing site's download button.**

The Wi-Agent Android app is not on Google Play yet. Until it is, a delivery agent installs it by
downloading an APK from the landing site, and these two endpoints are what that page reads.

**No authentication**, like everything else under `/api/public`. That is deliberate: the landing
site has no session and never will, and an APK's authenticity comes from the signature Android
verifies at install time rather than from the secrecy of a URL — which is why
[`/latest`](#get-apipublicappapplatest) publishes the signing certificate's fingerprint.

## Base path

```
/api/public/app
```

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/public/app/{app}/latest` | Metadata for the current build |
| GET | `/api/public/app/{app}/download` | **302** to the artefact — the stable link |

### `{app}` is a closed set

| Key | What |
|---|---|
| `agent-android` | Wi-Agent for Android (`com.wi_mall.wiagent`) |

Anything else is `404 APP_UNKNOWN`. The key names the app **and** the platform: when an iOS build
exists it will be `agent-ios`, a separate key with its own version and its own artefact — never a
second file under one key.

---

## GET /api/public/app/{app}/latest

```http
GET /api/public/app/agent-android/latest
```

```json
{
  "success": true,
  "data": {
    "app": "agent-android",
    "platform": "android",
    "versionName": "0.1.0",
    "versionCode": 1,
    "packageId": "com.wi_mall.wiagent",
    "minSdk": 24,
    "fileName": "wi-agent-0.1.0.apk",
    "sizeBytes": 82885308,
    "sha256": "…64 lowercase hex chars…",
    "signingCertSha256": "754b669109fd578938afd18eb8bd9931d8129559cfd31725c82c5bf9cf3fd389",
    "releaseNotes": null,
    "publishedAt": "2026-09-16T02:43:00.000Z",
    "downloadUrl": "https://api.wi-mall.com/api/public/app/agent-android/download"
  }
}
```

`Cache-Control: public, max-age=300`.

| Field | Notes |
|---|---|
| `versionName` | What to print. `0.1.0`. |
| `versionCode` | What Android compares. Monotonic; a phone refuses an install that lowers it. |
| `minSdk` | The lowest Android API level that can install this build. **24 = Android 7.0.** Worth printing: a visitor on an older phone otherwise downloads 79 MB and is told "App not installed" with no reason. |
| `sizeBytes` | Print it. This is a large download on a metered mobile connection and a visitor deserves to know before tapping. |
| `sha256` | The file hash. Proves the bytes are the bytes we published. |
| `signingCertSha256` | The **signing certificate** hash. Proves the build came from our keystore — a different and stronger claim than `sha256`, and the one Android itself enforces on every later update. May be `null` if the publisher's machine had no `apksigner`. |
| `releaseNotes` | Plain text or `null`. |
| `downloadUrl` | The absolute form of the endpoint below. Built from `API_PUBLIC_URL`. |

### `404 APP_RELEASE_NOT_FOUND` is a normal state, not an error

A known app with nothing published yet answers `404` with this code. **Render it as "not available
yet"**, not as a failure — it is what a new app key looks like before its first release. Only
`APP_UNKNOWN` (a key that does not exist) and `APP_RELEASE_UNAVAILABLE` (`503`, a storage
misconfiguration) are faults.

---

## GET /api/public/app/{app}/download

**This is the link to put in the download button.** It never changes.

```html
<a href="https://api.wi-mall.com/api/public/app/agent-android/download">
  Download Wi-Agent for Android
</a>
```

It answers `302` with a `Location` pointing at wherever the bytes currently live — today a
Cloudflare R2 CDN object. Follow the redirect; do not read `Location` and cache it.

| | |
|---|---|
| Status | `302` (never `301` — the target is *meant* to change) |
| `Cache-Control` | `public, max-age=300` |
| `X-App-Version` | `0.1.0+1`. Advisory, for an operator running `curl -I`. |

Publishing a new build changes what this redirects to and leaves the URL itself untouched, which
is the entire reason the endpoint exists rather than the CDN address being embedded directly.

### Why a redirect rather than the bytes

The artefact is ~79 MB and the API runs on a host sized for the whole platform. The bytes are
served by the CDN, which is closer to the user, free to egress, and — unlike a Node stream —
supports the range requests that resuming a 79 MB download over a mobile connection depends on.

### The saved filename carries a uuid prefix

The redirect target is the storage key, so a browser saves
`<uuid>_wi-agent-0.1.0.apk` rather than `wi-agent-0.1.0.apk`. Cosmetic, and the trade for
everything in the paragraph above. Use `fileName` from `/latest` when the page needs to *name* the
file in its own copy.

---

## What a landing page should actually show

Read `/latest` once at build or render time and put four things beside the button:

1. **the version** — `0.1.0`;
2. **the size** — 79 MB, before they tap;
3. **the Android requirement** — "Android 7.0 or later" from `minSdk`;
4. **the sha256**, in a `<details>` or on a "verify this download" page.

And say plainly that Android will warn about installing from an unknown source, with the two taps
needed to allow it. A visitor who hits that warning with no forewarning assumes the file is
unsafe and stops — which is the correct instinct, and the reason the checksum and the certificate
fingerprint are published at all.

⚠ **Do not present the `sha256` as a security guarantee on its own.** A page that serves both the
file and the hash it should match proves nothing to a visitor who does not trust the page. It is
useful against a corrupt or truncated download, and it is useful to somebody comparing against a
value they got from us another way. `signingCertSha256` is the claim that survives a hostile
mirror.

---

## Publishing a build (operators)

Not an API. Releases are written by a script, from a machine that holds the Android SDK:

```bash
cd jovi-mall
npm run app:publish -- --apk <path to app-release.apk> --dry-run    # rehearse every check
npm run app:publish -- --apk <path to app-release.apk> --notes "…"  # do it
npm run app:publish -- --list                                       # what is published
npm run app:publish -- --promote 3                                  # roll back to versionCode 3
```

`--dry-run` runs every gate — checksum sidecar, manifest read, **debug-key refusal**, duplicate
and version-ordering checks — and uploads nothing, so it genuinely rehearses the real run.

⚠ **Bump `version:` in `agent_app/pubspec.yaml` before every build.** Two artefacts sharing a
`versionCode` are indistinguishable to a phone, and the script refuses the second one.

⚠ After a **first** deploy of this feature, build the collection's indexes —
production runs `autoIndex: false`:

```bash
npm run migrate:up -- --only migrate:declared-indexes
```

## Related

- [Public API index](./README.md) — the other routers on this prefix
- [`../errors/README.md`](../errors/README.md) — the envelope these endpoints answer errors in
