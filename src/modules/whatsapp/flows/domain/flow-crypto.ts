import {
    constants,
    createDecipheriv,
    createCipheriv,
    privateDecrypt,
    type CipherGCMTypes,
    type KeyObject,
} from 'crypto';

/**
 * The WhatsApp Flows endpoint cipher — one request in, one response out.
 *
 * ── WHY THIS IS A VERDICT AND NEVER A THROW ─────────────────────────────────
 * `judgeLock` (`negotiation/domain/lock-verdict.rule.ts`) established the shape and the
 * reasoning transfers exactly: the caller must map a refusal onto a **foreign** contract, and
 * a throw bypasses that mapping. Here the foreign contract is Meta's, and it is unusually
 * strict — a key-unwrap failure must answer HTTP **421** and nothing else, because 421 is the
 * only signal that makes WhatsApp re-fetch our public key. An exception escaping into the
 * global error handler would answer this service's own 500 envelope, WhatsApp would keep the
 * stale key, and every Flow would stay broken until somebody noticed by hand.
 *
 * So this module decides WHAT WENT WRONG and the controller decides WHAT META IS TOLD. The
 * two are deliberately separable, and only one of them is testable without a network.
 *
 * ── THIS ENDPOINT DOES NOT SPEAK THIS SERVICE'S ERROR ENVELOPE ──────────────
 * ⚠ Worth stating plainly, because every other route here does. Meta does not read
 * `{success, requestId, error:{code, …}}` — on success it wants a **bare base64 string** as
 * the whole body, and on failure a bare status code with no body it will look at. This is the
 * payment-webhook situation (`payments/domain/webhook-response.ts`): somebody else's
 * protocol, so the status code IS the contract and our envelope is not part of it.
 *
 * ── THE CIPHER, AND WHY NONE OF IT IS A PREFERENCE ──────────────────────────
 * All of it is dictated by Meta:
 *
 *   1. The request carries an AES key encrypted to our PUBLIC key with **RSA-OAEP/SHA-256**.
 *      Not PKCS#1 v1.5. ⚠ `oaepHash` defaults to SHA-1 in Node, so omitting it decrypts
 *      nothing while looking entirely correct — and the symptom is indistinguishable from
 *      holding the wrong key, which sends the next person to rotate a key that was fine.
 *   2. The body is **AES-GCM** with the 16-byte auth tag APPENDED to the ciphertext rather
 *      than carried beside it. Node wants the two apart, so we split them.
 *   3. The response is encrypted with the **SAME** AES key and a **bitwise-inverted IV**.
 *      ⚠ This is the most counter-intuitive rule in the protocol and the one most likely to
 *      be "tidied" away by somebody who assumes reusing an IV must be the bug. Reusing it
 *      *unflipped* under the same key is the real catastrophe — two GCM messages sharing a
 *      key and IV leaks the authentication subkey — and the flip is what avoids that without
 *      a second key exchange. Do not replace it with a random IV: Meta derives the same
 *      inverted IV on its side and will not read anything else.
 */

/** Meta appends GCM's tag to the ciphertext. Always 16 bytes. */
const AUTH_TAG_BYTES = 16;

/**
 * Meta issues a 128-bit AES key today.
 *
 * ⚠ **Selected by the key's LENGTH rather than hardcoded**, so a widening on their side is a
 * working request instead of a mystery. An unexpected length is refused rather than guessed:
 * choosing the wrong cipher does not fail cleanly, it produces plausible garbage, which is
 * the worst available failure.
 */
/**
 * ⚠ **Typed `CipherGCMTypes`, not `string`, and that is load-bearing rather than tidy.** Node's
 * own types only expose `setAuthTag` / `getAuthTag` on the GCM overloads of
 * `createDecipheriv` / `createCipheriv`, so a plain `string` here compiles into the
 * *non-authenticated* overload — and the tag handling this protocol depends on stops being
 * visible to the compiler. Widening it back would not fail: it would silently permit a
 * non-GCM algorithm being added to the table below.
 */
const AES_ALGORITHMS: Readonly<Record<number, CipherGCMTypes>> = Object.freeze({
    16: 'aes-128-gcm',
    24: 'aes-192-gcm',
    32: 'aes-256-gcm',
});

/** The three base64 fields Meta posts. Shape only — trust nothing about the contents. */
export interface EncryptedFlowRequest {
    encrypted_flow_data: string;
    encrypted_aes_key: string;
    initial_vector: string;
}

/**
 * Why a request could not be opened.
 *
 * ⚠ **`key` and `body` are split because they mean different things to Meta**, and collapsing
 * them into one "decryption failed" throws away the only self-healing signal in the protocol:
 *
 *   - `key`  — the AES key would not unwrap, so our private key is not the one they encrypted
 *              to. Answer **421** and WhatsApp re-fetches the public key. This is the
 *              ordinary state during a key rotation and it recovers with no human involved.
 *   - `body` — the key worked and the GCM tag did not verify. A corrupted or tampered body,
 *              not a stale key, and re-fetching the key would fix nothing.
 */
export type FlowDecryptFailure =
    | { ok: false; reason: 'malformed' }
    | { ok: false; reason: 'key' }
    | { ok: false; reason: 'body' }
    | { ok: false; reason: 'payload' };

export type FlowDecryptResult =
    | {
          ok: true;
          /** The decrypted request body, JSON-parsed. Still entirely untrusted content. */
          payload: Record<string, unknown>;
          /**
           * Carried forward to `encryptFlowResponse`.
           *
           * ⚠ The AES key never leaves this request. It is not logged, not stored, never put
           * on a session — it is valid for exactly one request/response pair, and anything
           * that widened its lifetime would be a standing key in a hot path.
           */
          aesKey: Buffer;
          initialVector: Buffer;
      }
    | FlowDecryptFailure;

const isBase64 = (value: unknown): value is string =>
    typeof value === 'string'
    && value.length > 0
    && value.length % 4 === 0
    && /^[A-Za-z0-9+/]+={0,2}$/.test(value);

/**
 * Open one encrypted request.
 *
 * ⚠ **Every failure is caught and turned into a verdict**, including the ones that look like
 * programmer error. A malformed body on a public endpoint is ordinary traffic — scanners
 * reach it, and Meta itself posts a deliberately broken request while validating an endpoint
 * — so throwing would turn routine events into logged 500s and bury the real failures among
 * them.
 */
export function decryptFlowRequest(body: unknown, privateKey: KeyObject): FlowDecryptResult {
    const request = body as Partial<EncryptedFlowRequest> | null | undefined;

    if (
        !request
        || !isBase64(request.encrypted_aes_key)
        || !isBase64(request.encrypted_flow_data)
        || !isBase64(request.initial_vector)
    ) {
        return { ok: false, reason: 'malformed' };
    }

    let aesKey: Buffer;
    try {
        aesKey = privateDecrypt(
            {
                key: privateKey,
                padding: constants.RSA_PKCS1_OAEP_PADDING,
                // ⚠ Node defaults this to SHA-1. See the header: omitting it is the single
                // easiest way to build an endpoint correct in every other respect that
                // decrypts nothing.
                oaepHash: 'sha256',
            },
            Buffer.from(request.encrypted_aes_key, 'base64'),
        );
    } catch {
        return { ok: false, reason: 'key' };
    }

    if (!AES_ALGORITHMS[aesKey.length]) return { ok: false, reason: 'key' };
    const algorithm = AES_ALGORITHMS[aesKey.length];

    const initialVector = Buffer.from(request.initial_vector, 'base64');
    const encrypted = Buffer.from(request.encrypted_flow_data, 'base64');
    if (encrypted.length <= AUTH_TAG_BYTES) return { ok: false, reason: 'body' };

    // GCM's tag is APPENDED by Meta; Node wants it supplied separately.
    const ciphertext = encrypted.subarray(0, encrypted.length - AUTH_TAG_BYTES);
    const authTag = encrypted.subarray(encrypted.length - AUTH_TAG_BYTES);

    let plaintext: string;
    try {
        const decipher = createDecipheriv(algorithm, aesKey, initialVector);
        decipher.setAuthTag(authTag);
        plaintext = decipher.update(ciphertext, undefined, 'utf8') + decipher.final('utf8');
    } catch {
        // The tag did not verify: corrupted or tampered, never a stale key.
        return { ok: false, reason: 'body' };
    }

    let payload: unknown;
    try {
        payload = JSON.parse(plaintext);
    } catch {
        return { ok: false, reason: 'payload' };
    }

    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
        return { ok: false, reason: 'payload' };
    }

    return { ok: true, payload: payload as Record<string, unknown>, aesKey, initialVector };
}

/**
 * Seal one response.
 *
 * ⚠ **The IV is inverted, not regenerated** — see the header. `~b & 0xff` per byte, which is
 * what Meta computes on its side. A random IV here produces a response their client cannot
 * read, and the symptom is a Flow that opens and then shows a generic error, with nothing at
 * all wrong on this side to find.
 *
 * Returns the raw base64 string that is the ENTIRE response body. Not wrapped, not JSON.
 */
export function encryptFlowResponse(
    response: unknown,
    aesKey: Buffer,
    initialVector: Buffer,
): string {
    const algorithm = AES_ALGORITHMS[aesKey.length];
    if (!algorithm) {
        // Unreachable from `decryptFlowRequest`, which refuses an unknown length before a key
        // this shape can exist. Stated rather than silently mis-encrypted: this function has
        // no verdict channel, and a wrong cipher here would produce a response that looks
        // sent and can never be read.
        throw new RangeError('Unsupported AES key length for a Flow response');
    }

    const flippedIv = Buffer.from(initialVector.map((byte) => ~byte & 0xff));

    const cipher = createCipheriv(algorithm, aesKey, flippedIv);
    const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify(response), 'utf8'),
        cipher.final(),
    ]);

    // Tag appended, mirroring the request direction.
    return Buffer.concat([ciphertext, cipher.getAuthTag()]).toString('base64');
}
