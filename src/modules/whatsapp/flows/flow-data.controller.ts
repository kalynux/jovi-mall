import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { decryptFlowRequest, encryptFlowResponse } from './domain/flow-crypto';
import {
    classifyFlowRequest,
    errorAcknowledgement,
    pingResponse,
} from './domain/flow-protocol';
import { flowAppSecret, verifyFlowSignature } from './domain/flow-signature';
import { flowPrivateKey } from './flows.config';
import { serveFlowScreen } from './flow-screens';
import { flowScreenPorts } from './flow-screen-ports';

/**
 * `POST /api/webhooks/whatsapp/flows` — the encrypted data endpoint.
 *
 * ── ⚠ THIS ROUTE ANSWERS IN SOMEBODY ELSE'S PROTOCOL ────────────────────────
 * Every other route in this service answers `{success, requestId, error:{…}}`. This one must
 * not. On success Meta wants a **bare base64 string** as the entire body; on failure it reads
 * the **status code** and nothing else. That is the payment-webhook situation
 * (`payments/domain/webhook-response.ts`) and the same rule applies: the status code IS the
 * contract.
 *
 * ⚠ **Consequently nothing here may `next(error)` on a protocol failure.** The global handler
 * would answer a correct-looking 500 envelope, and the three codes below would never be sent
 * — costing us the two that are self-healing. Genuine programmer errors still throw; those
 * are not protocol failures and a 500 is the honest answer to them.
 *
 * ── THE STATUS CODES, AND WHY TWO OF THEM MATTER MORE THAN THEY LOOK ────────
 *
 *   | code | meaning                          | what WhatsApp does about it            |
 *   |------|----------------------------------|----------------------------------------|
 *   | 200  | here is the encrypted answer     | renders the screen                     |
 *   | 421  | we could not unwrap the AES key  | **re-fetches our public key and retries** |
 *   | 427  | the flow token is spent or stale | ends the Flow, tells the customer to restart |
 *   | 432  | the signature did not verify     | treats the endpoint as untrusted       |
 *   | 400  | the plaintext was not a request  | gives up on this request               |
 *
 * 421 is the one that repairs a key rotation with no human involved, and 427 is the one that
 * tells a customer their checkout expired instead of showing them a generic failure. Both are
 * lost the moment somebody "tidies" a branch here into a throw.
 */

/** Meta's codes, named so a reader does not have to recognise 421 and 432 on sight. */
const STATUS = {
    /** Key could not be unwrapped — prompts WhatsApp to re-fetch the public key. */
    REFRESH_PUBLIC_KEY: 421,
    /** The flow token is unusable. Owned by the screen handlers, not by this file yet. */
    TOKEN_UNUSABLE: 427,
    /** `X-Hub-Signature-256` did not verify. */
    SIGNATURE_FAILED: 432,
    /** Decrypted fine and was not a Flow request. */
    MALFORMED: 400,
} as const;

/**
 * Answer with the encrypted body and nothing else.
 *
 * ⚠ **`text/plain`, not `application/json`.** The body is a base64 string, not JSON, and
 * `res.json` would wrap it in quotes — which Meta reads as ciphertext that will not decrypt.
 */
function sendEncrypted(res: Response, payload: string): void {
    res.status(200).type('text/plain').send(payload);
}

export class FlowDataController {
    /**
     * The whole endpoint.
     *
     * ⚠ **Deliberately not split into middleware.** Decrypt, classify and answer share the
     * AES key, which must not outlive the request — passing it down a middleware chain would
     * mean parking a live key on `req` for every later handler to see. One function keeps its
     * lifetime visible in one place.
     */
    static exchange = asyncHandler(async (req: Request, res: Response) => {
        const privateKey = flowPrivateKey();
        if (!privateKey) {
            /**
             * ⚠ **A deployment with no Flows is a valid deployment**, so this is not an
             * alarm. It is unreachable in practice — a Flow cannot be published without a
             * working endpoint, so nobody can be holding one — and it exists so the route is
             * safe to mount unconditionally, which is what keeps the mount out of the
             * configuration surface.
             */
            res.status(STATUS.MALFORMED).end();
            return;
        }

        const appSecret = flowAppSecret();
        if (appSecret !== '') {
            /**
             * ⚠ **THE MISSING RAW-BODY MOUNT DETECTS ITSELF HERE, AND THAT IS THE POINT.**
             *
             * The HMAC covers the exact bytes Meta sent, so this handler needs `express.raw`
             * mounted above the global `express.json` in `app.ts` — the arrangement the
             * payment gateways already have. Without it `req.body` arrives as a parsed
             * object, and the tempting repair is to re-serialise it, which silently verifies
             * nothing: key order and escaping differ, so every genuine request fails and it
             * reads as a wrong secret.
             *
             * So the check is on the TYPE rather than on the bytes. A configured secret plus
             * a parsed body means the mount is missing, and that is refused loudly rather
             * than skipped quietly. A verifier that cannot tell whether it ran is the exact
             * shape of the defect `resolveVirusScanner` was built to make impossible — a
             * scanner that does nothing is indistinguishable from one that works.
             */
            if (!Buffer.isBuffer(req.body)) {
                console.error(
                    '[WhatsAppFlows] WHATSAPP_APP_SECRET is set but the request body is not raw. '
                    + 'The express.raw mount for this path is missing from app.ts, so the '
                    + 'signature CANNOT be verified. Refusing rather than skipping the check.',
                );
                res.status(STATUS.SIGNATURE_FAILED).end();
                return;
            }

            if (
                !verifyFlowSignature(
                    req.body,
                    req.header('x-hub-signature-256'),
                    appSecret,
                )
            ) {
                res.status(STATUS.SIGNATURE_FAILED).end();
                return;
            }
        }

        /**
         * With the raw mount in place the body is a Buffer of JSON; without a configured
         * secret it is already parsed. Both are supported because the secret is optional and
         * the mount is not conditional on it.
         */
        const envelope = Buffer.isBuffer(req.body) ? safeParse(req.body) : req.body;
        if (envelope === null) {
            res.status(STATUS.MALFORMED).end();
            return;
        }

        const opened = decryptFlowRequest(envelope, privateKey);
        if (!opened.ok) {
            // Only a KEY failure earns the self-healing 421. A bad tag or unparseable
            // plaintext is not a stale key, and answering 421 to those would send WhatsApp
            // to re-fetch a key that is already correct, forever.
            res.status(opened.reason === 'key' ? STATUS.REFRESH_PUBLIC_KEY : STATUS.MALFORMED)
                .end();
            return;
        }

        const { payload, aesKey, initialVector } = opened;
        const request = classifyFlowRequest(payload);

        if (request.kind === 'malformed') {
            res.status(STATUS.MALFORMED).end();
            return;
        }

        if (request.kind === 'ping') {
            // ⚠ The health check resolves NO session. See `flow-protocol.ts`: requiring a
            // token here would fail every ping and make the Flow unpublishable, while looking
            // like correct authentication.
            sendEncrypted(res, encryptFlowResponse(pingResponse(), aesKey, initialVector));
            return;
        }

        if (request.kind === 'error') {
            console.warn(
                `[WhatsAppFlows] client reported an error: ${request.errorKey ?? 'unspecified'}`
                + (request.errorMessage ? ` — ${request.errorMessage}` : ''),
            );
            // Acknowledged with a 200 on purpose: anything else makes Meta retry a report
            // of a failure.
            sendEncrypted(res, encryptFlowResponse(errorAcknowledgement(), aesKey, initialVector));
            return;
        }

        /**
         * A screen. The product decisions live in `flow-screens.ts`; this file only encrypts
         * the verdict and sets its status.
         *
         * ⚠ **A 427 is encrypted too.** Meta's reference endpoint sends its `{ error_msg }`
         * through the same cipher as a 200, and the handset shows that sentence. A bare 427
         * ends the Flow with nothing for the customer to act on.
         */
        const verdict = await serveFlowScreen(request, flowScreenPorts);
        res.status(verdict.status)
            .type('text/plain')
            .send(encryptFlowResponse(verdict.body, aesKey, initialVector));
    });
}

/** A Buffer that is not JSON is ordinary traffic on a public endpoint, never an exception. */
function safeParse(raw: Buffer): unknown {
    try {
        return JSON.parse(raw.toString('utf8'));
    } catch {
        return null;
    }
}
