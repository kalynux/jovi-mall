import { createPrivateKey, createPublicKey, type KeyObject } from 'crypto';
import type { InAppSurfaceKind } from '../../bot-surface/services/inapp-surface.store';

/**
 * The WhatsApp Flows endpoint's configuration — one private key, and one published Flow id
 * per screen.
 *
 * ── INERT BY DEFAULT, AND THAT IS THE DEPLOYED STATE TODAY ──────────────────
 * Unset means **this deployment has no Flows**, which is a valid and currently the ordinary
 * configuration. It is not a fault and must never refuse a boot: a Flow has to be published in
 * Meta's Flow Builder against a working number before its id exists, so "no id yet" is a
 * normal stage of the work rather than a misconfiguration.
 *
 * What that inertness buys is the reason the seam was built the way it was:
 * `channel-reply.ts` renders the `inapp` intent as a `cta_url` button whenever `flow` is
 * absent, so a WhatsApp customer on a deployment with no Flows gets the storefront in a
 * browser — the same sentence, the same label, a working feature. Nothing here may turn that
 * into an error.
 *
 * ⚠ This is deliberately the OPPOSITE posture to `INTERNAL_ADMIN_SERVICE_TOKEN` and
 * `BOT_WEBHOOK_SECRET`, which fail closed and refuse the boot. Those guard a door; this
 * describes a capability. The distinction is the same one `GEO_TRACKER_ADMIN_TOKEN` draws in
 * the workspace CLAUDE.md: absent means "this deployment has no data door", and only a
 * *mismatch* is a fault.
 *
 * ── READ THROUGH ACCESSORS, NOT AT MODULE LOAD ──────────────────────────────
 * The `internal-admin.config.ts` precedent, for its reason: a suite can set the variable
 * before the first call without racing the import order.
 */

/**
 * The private half of the RSA pair whose PUBLIC half is uploaded to Meta.
 *
 * ⚠ **Only the private key is configured, and the public one is DERIVED from it.** Holding
 * both as separate variables creates a failure that cannot be detected from either value
 * alone: a pair that does not match decrypts nothing, and both halves look perfectly
 * well-formed. Deriving removes the class entirely — `flowPublicKeyPem()` is what the upload
 * script publishes, so what Meta holds is provably the counterpart of what we decrypt with.
 *
 * ⚠ **`\n` escapes are honoured.** A PEM is multi-line and a `.env` value is not, so every
 * deployment path that carries this — a shell export, a compose `environment:` entry, the
 * Dokploy panel — flattens it. Accepting the escaped form is what stops somebody "fixing"
 * that by pasting a key that has lost its line breaks, which parses as nothing.
 */
function privateKeyPem(): string {
    return (process.env.WHATSAPP_FLOW_PRIVATE_KEY || '').replace(/\\n/g, '\n').trim();
}

/** Optional. An unencrypted key is acceptable; a wrong passphrase is not, and throws. */
function privateKeyPassphrase(): string {
    return process.env.WHATSAPP_FLOW_PRIVATE_KEY_PASSPHRASE || '';
}

/**
 * The published Flow per screen.
 *
 * ⚠ **One variable per screen, spelled out, rather than a JSON map in one variable.** Two
 * reasons and both have bitten this codebase: `test:env`'s census re-derives what `src/`
 * reads and cannot see a name that is only ever a map key, so a JSON map would be an
 * undocumented variable by construction; and a malformed map fails at parse for *every*
 * screen, where a missing single id degrades exactly one.
 *
 * ⚠ **The keys are `InAppSurfaceKind`, so a screen and its Flow name the same thing.** `ol`,
 * `sl`, `tf` and the three booking kinds are declared with no variable because their forms are
 * not published yet — a Flow cannot exist before the screen it mirrors, and leaving them out of
 * the type would mean editing this map when they land.
 *
 * ⚠ **`tf`, `bl`, `bk` and `bp` have DRAFT definitions already** (`ticket-form.flow.ts`,
 * `booking.flow.ts`), deliberately absent from `publish-whatsapp-flows.ts` until the reads they
 * project exist. A draft with no id here is exactly right: nothing can reach Meta, and the id
 * appears the day the Flow is published.
 *
 * ⚠ **The map is TOTAL over the kinds on purpose, and that is what makes it useful.** When
 * another stream adds a screen kind, this file stops compiling until somebody decides whether
 * that screen has a WhatsApp form — which is exactly the question that would otherwise be
 * answered by silence. `tf` (the ticket form) arrived that way.
 */
const FLOW_ID_READERS: Readonly<Record<InAppSurfaceKind, () => string>> = Object.freeze({
    pl: () => process.env.WHATSAPP_FLOW_ID_PRODUCT_LISTING || '',
    pd: () => process.env.WHATSAPP_FLOW_ID_PRODUCT_DETAIL || '',
    co: () => process.env.WHATSAPP_FLOW_ID_CHECKOUT || '',
    ol: () => '',
    sl: () => '',
    tf: () => '',
    bl: () => '',
    bk: () => '',
    bp: () => '',
});

let cachedKey: KeyObject | null = null;
let cachedFromPem = '';

/**
 * The parsed private key, or null when this deployment has no Flows.
 *
 * ⚠ **Parsed once and cached against the PEM it came from**, not against a boolean. A suite
 * that swaps the variable between cases gets the key it just set rather than the first one
 * ever parsed — which is the bug a plain `if (cachedKey) return cachedKey` would have, and it
 * would only ever show up in the suite, as a test that passes alone and fails in sequence.
 */
export function flowPrivateKey(): KeyObject | null {
    const pem = privateKeyPem();
    if (pem === '') {
        cachedKey = null;
        cachedFromPem = '';
        return null;
    }

    if (cachedKey && cachedFromPem === pem) return cachedKey;

    try {
        const passphrase = privateKeyPassphrase();
        cachedKey = createPrivateKey(passphrase ? { key: pem, passphrase } : { key: pem });
        cachedFromPem = pem;
        return cachedKey;
    } catch {
        // A key that will not parse is a configuration fault, not a request fault. It is
        // reported by `assertFlowKeyUsable()` at boot; here it reads as "no Flows", so a
        // broken key degrades to the `cta_url` fallback rather than 500ing a customer.
        cachedKey = null;
        cachedFromPem = '';
        return null;
    }
}

/**
 * The public half, in the SPKI PEM form Meta's key-upload endpoint expects.
 *
 * Used by the publishing script, never on the request path — it is derived, so calling it per
 * request would be re-deriving a constant. Null when there is no key to derive it from.
 */
export function flowPublicKeyPem(): string | null {
    const key = flowPrivateKey();
    if (!key) return null;
    return createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString();
}

/** Whether this deployment can serve the endpoint at all. */
export function flowsConfigured(): boolean {
    return flowPrivateKey() !== null;
}

/**
 * The published Flow id for a screen, or null when that screen has none.
 *
 * ⚠ **Both halves are required and the check is deliberately not `||`.** A deployment can
 * legitimately hold a key and no ids (the state between building the endpoint and publishing
 * the first Flow), and it can hold ids and no key only by mistake. Advertising a Flow whose
 * endpoint cannot answer produces the worst outcome available: the customer opens the form
 * and it fails inside Meta's UI, where none of our copy reaches them.
 */
export function flowIdFor(kind: InAppSurfaceKind): string | null {
    if (!flowsConfigured()) return null;
    const id = FLOW_ID_READERS[kind]();
    return id === '' ? null : id;
}

/**
 * Boot-time check, called from `lifecycle.ts` beside `assertSigningSecrets()`.
 *
 * ⚠ **Refuses a key that is SET AND BROKEN, and says nothing about one that is absent.** That
 * split is the whole point: absent is a deployment without Flows, while a key that will not
 * parse is somebody who believes they configured one. The second is invisible at runtime —
 * `flowPrivateKey()` swallows it and the endpoint answers "not configured" — so without this
 * assert a mis-pasted PEM looks exactly like a deployment that was never meant to have Flows.
 *
 * Throws a `RangeError` rather than an `AppError`, matching `assertInternalAdminToken()`:
 * there is no request in flight to attach a code to, and the boot asserts are read as a
 * group.
 */
export function assertFlowKeyUsable(): void {
    const pem = privateKeyPem();
    if (pem === '') return;

    try {
        const passphrase = privateKeyPassphrase();
        createPrivateKey(passphrase ? { key: pem, passphrase } : { key: pem });
    } catch {
        throw new RangeError(
            'WHATSAPP_FLOW_PRIVATE_KEY is set but could not be parsed as a private key. '
            + 'A PEM carried through an environment variable needs its line breaks escaped as '
            + '\\n; a key with a passphrase also needs WHATSAPP_FLOW_PRIVATE_KEY_PASSPHRASE. '
            + 'Leave the variable unset to run without WhatsApp Flows.',
        );
    }
}
