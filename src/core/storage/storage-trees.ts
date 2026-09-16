/**
 * Which storage trees are public, and which are reachable only through an authorized route.
 *
 * ── The defect this closes (ADR-A01 D-2) ──────────────────────────────────────
 * `api/index.ts` served the WHOLE of `storage/` through one unguarded `express.static`, and a
 * stored file's `url` — the one every `FileDetail` on the platform carries — *is* that path. So
 * a digital product's file, and an agent's delivery-proof photo, were fetchable by anyone
 * holding the URL, forever.
 *
 * For the digital tree that made three enforcement mechanisms **advisory**: the download
 * token's single-use consumption, its download counter and its revocation are all bypassed by
 * the raw path, permanently, with nothing anywhere recording that it happened. For the
 * shipments tree the URL is a delivery address and a timestamped location.
 *
 * ── An ALLOWLIST, and why it is a full census rather than a short list ────────
 * The obvious form — "mount these three, deny the rest" — has a silent failure of its own: a
 * tree nobody classified 404s every file in it, and nothing says so. The obvious opposite —
 * "deny these three" — is a denylist, and a private tree added next year would be public by
 * default, which is exactly how this defect happened.
 *
 * So every tree carries an explicit verdict here, an unknown one is **private** (safe
 * direction), and `test:uploads` asserts that **every folder any writer in `src/` can name is
 * classified** — so an unclassified tree fails a suite rather than 404ing in production.
 */

export type TreeVisibility = 'public' | 'private';

/**
 * Every storage tree this service writes, with its verdict and the reason.
 *
 * ⚠ **Adding a `folder:` to any upload call means adding a row here**, or `test:uploads` fails.
 * That is the mechanism, not a convention — an unclassified tree is unreachable.
 */
export const STORAGE_TREE_VISIBILITY: Readonly<Record<string, TreeVisibility>> = Object.freeze({
    // ── Type folders (`by-type` general media intake) ─────────────────────────
    // One per `MediaCategory`. These hold whatever a vendor, agency, agent or customer
    // uploads through `POST /api/files/upload` without yet saying what it is for: avatars,
    // store logos and banners, product imagery, and the documents attached to a ticket.
    // Their ids reach PUBLIC product DTOs, so `express.static` is exactly what they want.
    images: 'public',
    videos: 'public',
    audio: 'public',
    documents: 'public',
    archives: 'public',
    other: 'public',

    // ── Purpose folders ───────────────────────────────────────────────────────
    // Product media, named by the caller. Public for the same reason as the type folders.
    products: 'public',
    variants: 'public',
    // Written by `storageProvider.put` directly (NOT the upload pipeline — see the ⚠ below),
    // and both endpoints RETURN the public URL for the owner to submit back on their profile.
    // Public by design and by contract.
    'vendor-policy-documents': 'public',
    'agency-policy-documents': 'public',
    // No writer today; kept classified so it cannot become an unclassified surprise.
    system: 'public',

    // The Android build of the agent app, distributed by direct download because the app is
    // not on Play yet (`modules/app-distribution/`). Public, and the word does LESS work here
    // than it does above: an APK is signed, and its authenticity comes from the signature
    // Android verifies at install time, never from the secrecy of its URL. Anyone may hold
    // this link — putting it on a marketing page is the entire point.
    //
    // ⚠ Written ONLY by `scripts/publish-app-release.ts`, never by the upload pipeline. A
    // release artefact is not user content: it has no owner, no quota, no virus scan and no
    // `file_references` row, and it is ~79 MB — two orders of magnitude past what
    // `multer.memoryStorage()` is sized for. No route under `/api/files/upload` can name it.
    'app-releases': 'public',

    // ── PRIVATE. Served only by an authorized route. ──────────────────────────
    // A vendor's digital product, sold to a named buyer. `GET /api/digital/download/:token`
    // is the only door, and its single-use consumption, download counter and revocation only
    // mean anything once this tree is off the static mount.
    digital: 'private',
    // An agent's delivery-proof photo: a place and a time, about a real address. Reachable
    // through the shipment reads, whose scoping already answers "may this viewer see it".
    shipments: 'private',
    // Identity-verification documents — a scan of somebody's national identity card, front
    // and back, and a photograph of their face holding it. The most disclosing thing this
    // platform stores about any person, and the one tree where a misclassification is not a
    // broken thumbnail but an identity-theft kit at a guessable URL.
    //
    // ⚠ This tree is the ENTIRE privacy mechanism for the KYC module — there is no
    // `sensitive` column on a file and no second gate. Read by the owner through their own
    // `GET /api/{vendor,agency,agent}/kyc/documents/:fileId/content`, and by an administrator
    // through wi-admin's audited `GET /api/v1/files/:fileId/content`. Nothing else.
    kyc: 'private',
    // Identity evidence for a member of PLATFORM STAFF — an administrator's own identity
    // card, the selfie holding it, the photograph of their front door and the sketch of how
    // to get there. The same class of document as `kyc/` above, and deliberately NOT the
    // same tree.
    //
    // ⚠ **Its own tree because the two have different SUBJECTS and will get different
    // rules.** `kyc/` holds applicants: people the platform is deciding whether to admit,
    // whose documents are reviewed once and whose retention follows the account. This holds
    // employees, whose documents are an employment record — a different legal basis, a
    // different retention clock, and a different answer to "export everything you hold about
    // me". Sharing a tree would mean a policy written for either silently applied to both,
    // and the person writing it would have no way to see that from the folder name.
    //
    // ⚠ Nothing in THIS service records what these files depict. jovi-mall stores the bytes
    // and one `file_references` row proving the file is in use; the slot, the identity
    // number, the salary and every other employee fact live in wi-admin's PRIVATE database.
    // That split is the point — see `modules/staff-identity/`.
    'admin-identity': 'private',
    // ⚠ **Legacy, and the ADR's map is wrong about it.** ADR-A01 lists
    // `storage/ticket-attachments` as one of the three private trees. NOTHING in `src/`
    // writes it — a census of every `folder:` literal finds no such value — and it holds one
    // file predating the current design. A ticket attachment today is an ordinary `by-type`
    // upload that lands in `documents/` or `images/` and is attached to the ticket BY ID
    // afterwards, which means it shares a tree with public product imagery and CANNOT be made
    // private by moving a directory. Private here so the one legacy file stops being served;
    // closing the real gap needs a dedicated ticket-attachment upload path, which is its own
    // decision. See ADR-A01 § "D-2 as built".
    'ticket-attachments': 'private',
});

/** The trees `express.static` may serve. Derived, so the mount and the verdict cannot drift. */
export const PUBLIC_STORAGE_TREES: readonly string[] = Object.freeze(
    Object.entries(STORAGE_TREE_VISIBILITY)
        .filter(([, visibility]) => visibility === 'public')
        .map(([tree]) => tree),
);

export const PRIVATE_STORAGE_TREES: readonly string[] = Object.freeze(
    Object.entries(STORAGE_TREE_VISIBILITY)
        .filter(([, visibility]) => visibility === 'private')
        .map(([tree]) => tree),
);

/**
 * The tree a storage key belongs to.
 *
 * Keys are `<tree>/<yyyy>/<mm>/<uuid>_<name>`, and BACKSLASHES ARE POSSIBLE: the local
 * provider builds them with `path.join`, so a key written on Windows carries `\`. Normalising
 * here rather than at the call sites is what stops "is this private?" answering differently on
 * the developer's machine than in the container.
 */
export function treeOfKey(key: string): string | null {
    const normalized = key.replace(/\\/g, '/').replace(/^\/+/, '');
    const [tree] = normalized.split('/');
    return tree || null;
}

/**
 * Is this stored file behind an authorized route rather than a public URL?
 *
 * ⚠ **Fails CLOSED on an unrecognised tree.** A key whose tree nobody classified is treated as
 * private, because the alternative — assume public — is this defect's own failure mode, and
 * because such a tree is not on the static mount anyway, so a "public" URL for it would be a
 * link to a 404. Same posture as the scanner factory: refuse rather than degrade.
 */
export function isPrivateStorageKey(key: string): boolean {
    const tree = treeOfKey(key);
    if (!tree) return true;
    return STORAGE_TREE_VISIBILITY[tree] !== 'public';
}
