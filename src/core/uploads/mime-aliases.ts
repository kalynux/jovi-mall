/**
 * MIME Type Equivalence
 *
 * The same binary format is frequently labelled with different MIME strings by
 * different clients and operating systems. `file-type` sniffs the canonical
 * IANA type from magic bytes, but browsers (especially on Windows) send a
 * vendor/legacy synonym in the multipart `Content-Type` header. For example a
 * plain `.zip` is sent as `application/x-zip-compressed` by Windows yet sniffs
 * to `application/zip`.
 *
 * Those synonyms are NOT spoofing — they describe the exact same bytes — so a
 * strict `claimed !== detected` comparison produces false `MIME_TYPE_MISMATCH`
 * violations on legitimate uploads.
 *
 * IMPORTANT: this map ONLY governs the claimed-vs-detected comparison. The
 * sniffed (detected) type remains the single source of truth for the allowlist
 * (see MimeTypeValidator), so widening the equivalence set here can never let a
 * disallowed format through — a spoofed file still fails the allowlist on its
 * real sniffed type.
 */

/**
 * Equivalence classes. Every member of an inner array maps to the same
 * canonical group, so a claimed type in the group is accepted against any
 * detected type in the same group.
 */
const MIME_ALIAS_GROUPS: string[][] = [
  // ZIP (the case that prompted this: Windows sends application/x-zip-compressed)
  ['application/zip', 'application/x-zip-compressed', 'application/x-zip'],
  // RAR
  ['application/x-rar-compressed', 'application/vnd.rar', 'application/rar', 'application/x-rar'],
  // 7-Zip
  ['application/x-7z-compressed', 'application/x-7z'],
  // gzip
  ['application/gzip', 'application/x-gzip'],
  // tar
  ['application/x-tar', 'application/tar'],
  // PDF
  ['application/pdf', 'application/x-pdf'],
  // Images
  ['image/jpeg', 'image/jpg', 'image/pjpeg'],
  ['image/png', 'image/x-png'],
  ['image/svg+xml', 'image/svg'],
  // Audio
  ['audio/mpeg', 'audio/mp3', 'audio/mpeg3', 'audio/x-mpeg-3', 'audio/x-mp3'],
  ['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave'],
  ['audio/mp4', 'audio/x-m4a', 'audio/m4a'],
  // Video
  ['video/mp4', 'video/x-m4v'],
  ['video/quicktime', 'video/x-quicktime'],
];

/**
 * "Unspecified" client claims. When the client sends one of these it is not
 * asserting any specific format, so a difference from the sniffed type cannot
 * be a deliberate spoof. The sniffed type alone decides allow/deny.
 *
 *  - application/octet-stream / binary/octet-stream — generic "binary"
 *  - application/x-compressed — legacy "compressed, type unspecified" (used by
 *    some clients for .rar/.zip/.gz)
 */
const GENERIC_CLAIMS = new Set<string>([
  'application/octet-stream',
  'binary/octet-stream',
  'application/x-compressed',
]);

/** Member MIME type -> canonical group index. */
const CANONICAL: Map<string, number> = (() => {
  const map = new Map<string, number>();
  MIME_ALIAS_GROUPS.forEach((group, index) => {
    for (const mime of group) {
      map.set(mime, index);
    }
  });
  return map;
})();

/**
 * Normalise a MIME string for comparison: lowercase, trimmed, and stripped of
 * any parameters (e.g. `application/zip; charset=binary` -> `application/zip`).
 */
function normalize(mime: string | undefined): string {
  if (!mime) return '';
  const semicolon = mime.indexOf(';');
  const base = semicolon === -1 ? mime : mime.slice(0, semicolon);
  return base.trim().toLowerCase();
}

/**
 * True when the client-claimed MIME type is an acceptable match for the
 * detected (sniffed) MIME type — i.e. they are identical, the claim is an
 * unspecified/generic type, or both belong to the same equivalence class.
 *
 * Returning true here suppresses the MIME_TYPE_MISMATCH violation. It does NOT
 * affect the allowlist check, which always runs against the detected type.
 */
export function areMimeTypesEquivalent(claimed: string | undefined, detected: string): boolean {
  const c = normalize(claimed);
  const d = normalize(detected);

  if (!c) return true;            // No claim to contradict the sniffed type.
  if (c === d) return true;       // Exact match.
  if (GENERIC_CLAIMS.has(c)) return true; // Unspecified/ambiguous claim.

  const claimedGroup = CANONICAL.get(c);
  const detectedGroup = CANONICAL.get(d);
  return claimedGroup !== undefined && claimedGroup === detectedGroup;
}

/**
 * Build the set of client-declared ("claimed") MIME types that a lightweight
 * pre-pipeline gate should let through, derived from the canonical types the
 * upload pipeline actually allows (i.e. the keys of
 * `UploadPolicyConfig.perMimeType`).
 *
 * This is the mechanism that keeps a controller's cheap up-front check in sync
 * with the authoritative pipeline allowlist: pass the pipeline's allowed types
 * and you get back every declared type that could legitimately map to one of
 * them — each allowed type plus its known synonyms (see `MIME_ALIAS_GROUPS`)
 * plus the generic/unspecified claims (`application/octet-stream`, etc.).
 *
 * The returned set is NOT a security boundary — the pipeline still validates
 * the SNIFFED type against the same allowlist. It only prevents rejecting a
 * legitimate upload before sniffing because the client used a synonym header.
 */
export function getAcceptableClaimedMimeTypes(allowedDetectedTypes: Iterable<string>): Set<string> {
  const result = new Set<string>();

  for (const type of allowedDetectedTypes) {
    const n = normalize(type);
    if (!n) continue;
    result.add(n);
    const group = CANONICAL.get(n);
    if (group !== undefined) {
      for (const member of MIME_ALIAS_GROUPS[group]) result.add(member);
    }
  }

  // A declared generic/unspecified type can map to any allowed format once
  // sniffed, so it must clear the gate and defer to the pipeline.
  for (const generic of GENERIC_CLAIMS) result.add(generic);

  return result;
}

/**
 * Whether a client-declared MIME type passes a pre-pipeline gate built from
 * {@link getAcceptableClaimedMimeTypes}. An absent/empty declared type is
 * accepted (the pipeline will sniff the real type).
 */
export function isAcceptableClaimedMimeType(
  claimed: string | undefined,
  acceptable: ReadonlySet<string>,
): boolean {
  const n = normalize(claimed);
  if (!n) return true; // No declared type — defer to pipeline sniffing.
  return acceptable.has(n);
}
