/**
 * test:whatsapp-flows — the encrypted Flows data endpoint. **No DB, no network, no Redis.**
 *
 * ── WHY THIS SUITE CARRIES MORE WEIGHT THAN MOST ────────────────────────────
 * **A Flow must be PUBLISHED before it can be exercised**, Meta refuses to publish against an
 * endpoint whose health check it can't complete, and publishing is an owner decision held until
 * the plan is finished. So the handshake has to be right *before* anyone can observe it being
 * right.
 *
 * (This header also used to say the sending number "cannot send a WhatsApp message at all" and
 * its display name "has never been approved". That stopped being true on 2026-09-16: the number
 * moved to +237 652 705 926, and a read-only Graph lookup that day returned `name_status:
 * APPROVED`, `status: CONNECTED`.)
 *
 * That makes this suite the main evidence the protocol is implemented correctly. It therefore
 * plays **both sides**: it generates a real RSA pair, does what Meta's client does — RSA-OAEP/
 * SHA-256 wrap an AES key, AES-GCM the body, append the tag — and then decrypts our response
 * with the *inverted* IV exactly as their client would. Nothing is stubbed; the ciphertext is
 * real.
 *
 * ⛔ **But a suite written from the same memory as the code passes the code's mistakes.** The
 * protocol shapes in §§ 3–5 were first asserted from memory, and three of them were wrong in
 * exactly the way the code was. They are now checked against Meta's endpoint guide and Meta's
 * reference endpoint (WhatsApp-Flows-Tools), and each section says which.
 *
 * ── THE MISTAKES IT EXISTS TO CATCH ─────────────────────────────────────────
 * Each of these produces an endpoint that is correct in every visible respect and works for
 * nobody, and none of them throws:
 *
 *  - **`oaepHash` omitted.** Node defaults RSA-OAEP to SHA-1. The key unwrap then fails on
 *    every genuine request and the symptom is identical to holding the wrong key — which
 *    sends the next person to rotate a key that was never wrong.
 *  - **The response IV not inverted.** Meta derives the flipped IV on its side. A random or
 *    re-used-unflipped IV produces a response their client silently cannot read: the Flow
 *    opens, then shows a generic error, with nothing wrong on this side to find.
 *  - **The ping answered in any shape but Meta's exact one.** `{ data: { status: 'active' } }`
 *    and nothing more. This service's `{success, data}` envelope fails it, and so did this
 *    endpoint's own first version, which added a `version` field.
 *  - **A client error report read as a screen request.** There is no `action: "error"`; a
 *    report arrives as an ordinary INIT or data_exchange with `data.error` set.
 *
 * Run: npm run test:whatsapp-flows
 */
import fs from 'fs';
import path from 'path';
import {
    constants,
    createCipheriv,
    createDecipheriv,
    createHmac,
    generateKeyPairSync,
    publicEncrypt,
    randomBytes,
} from 'crypto';
import {
    decryptFlowRequest,
    encryptFlowResponse,
} from '../../src/modules/whatsapp/flows/domain/flow-crypto';
import {
    classifyFlowRequest,
    completionResponse,
    errorAcknowledgement,
    pingResponse,
    screenResponse,
    tokenUnusableBody,
    FLOW_TERMINAL_SCREEN,
} from '../../src/modules/whatsapp/flows/domain/flow-protocol';
import { verifyFlowSignature } from '../../src/modules/whatsapp/flows/domain/flow-signature';
import { PRODUCT_LISTING_FLOW } from '../../src/modules/whatsapp/flows/definitions/product-listing.flow';
import { PRODUCT_DETAIL_FLOW } from '../../src/modules/whatsapp/flows/definitions/product-detail.flow';
import { CHECKOUT_FLOW } from '../../src/modules/whatsapp/flows/definitions/checkout.flow';
import { TICKET_FORM_FLOW } from '../../src/modules/whatsapp/flows/definitions/ticket-form.flow';
import {
    BOOKING_LIST_FLOW,
    BOOKING_PAY_FLOW,
    BOOKING_SLOT_FLOW,
} from '../../src/modules/whatsapp/flows/definitions/booking.flow';
import { FLOW_SCREEN_TITLE, NOTICE_SCREEN } from '../../src/modules/whatsapp/flows/definitions/notice.screen';
import type { FlowDefinition } from '../../src/modules/whatsapp/flows/definitions/flow-definition.types';
// ⚠ Safe to import: the publisher runs only under `require.main === module`.
import { FLOW_REQUIRED_PROPERTIES, missingRequiredProperties } from '../publish-whatsapp-flows';
import { FLOW_LISTING_PAGE_SIZE, toListingScreen } from '../../src/modules/whatsapp/flows/screens/listing.adapter';
import { toDetailScreen } from '../../src/modules/whatsapp/flows/screens/detail.adapter';
import { mayShowImageToCustomer, FLOW_IMAGE_MAX_SOURCE_BYTES } from '../../src/modules/whatsapp/flows/screens/image-policy';
import { FLOW_CAPS, fitText } from '../../src/modules/whatsapp/flows/screens/flow-text';
import type { FlowCopy } from '../../src/modules/whatsapp/flows/screens/flow-copy';
import type { ListingPage } from '../../src/modules/bot-surface/miniapp/surfaces/product-listing.read';
import type { ProductDetailView } from '../../src/modules/bot-surface/miniapp/surfaces/product-detail.read';
/**
 * ⚠ **The plan, never the handler.** The handler renders an "added to cart" answer with the
 * chat's own three controls, which live in a controller that reaches `orders/` and `payments/` —
 * importing it here would hang this suite with no output at all. The decision is therefore a
 * pure sibling module, and the handler is scanned as text further down.
 */
import { planCompletion } from '../../src/modules/whatsapp/flows/commands/flow-completion-plan';
import { asFlowOutcome, FLOW_OUTCOMES } from '../../src/modules/whatsapp/flows/domain/flow-outcome';
import { commandReplyIntent, screenReplyIntent } from '../../src/modules/command-bus/command-reply';
import { botChrome } from '../../src/modules/bot-surface/domain/bot-chrome-copy';
import {
    handleSurvived,
    needsTypedNumber,
    planCheckoutFailure,
    toCheckoutScreen,
} from '../../src/modules/whatsapp/flows/screens/checkout.adapter';
import type {
    CheckoutPlaced,
    CheckoutView,
} from '../../src/modules/bot-surface/miniapp/surfaces/checkout.controller';
import {
    CHECKOUT_CLAIM_IDENTITY,
    CLAIM_WAITS,
    serveFlowScreen,
    type FlowClaim,
    type FlowScreenPorts,
    type FlowScreenVerdict,
} from '../../src/modules/whatsapp/flows/flow-screens';
import type { FlowScreenRequest } from '../../src/modules/whatsapp/flows/domain/flow-protocol';
import { createAppError } from '../../src/core/errors';
import { ERROR_CODES } from '../../src/core/error-codes';
import { customerMessageFor } from '../../src/modules/bot-surface/domain/bot-error-copy';
import { inAppCopy } from '../../src/modules/bot-surface/miniapp/inapp-copy';
import {
    TTL_SECONDS,
    type InAppSurfaceSession,
} from '../../src/modules/bot-surface/services/inapp-surface.store';
import {
    BOT_IDEMPOTENCY_RECORD_TTL_SECONDS,
    type BotClaimResult,
    type BotIdempotentResponse,
} from '../../src/modules/bot-surface/services/bot-idempotency.store';
import type {
    PurchaseContext,
    PurchaseResult,
} from '../../src/modules/bot-surface/controllers/bot-purchase.controller';

let passed = 0;
let failed = 0;

function assert(name: string, ok: boolean, detail?: string): void {
    if (ok) {
        console.log(`  ✅ ${name}`);
        passed++;
    } else {
        console.error(`  ❌ FAIL: ${name}${detail ? `\n       ${detail}` : ''}`);
        failed++;
    }
}

function section(title: string): void {
    console.log(`\n▶ ${title}`);
}

/**
 * ⚠ **CRLF normalised once, here.** This repository has no `.gitattributes` and
 * `core.autocrlf=true`, so a Windows clone reads `\r\n`; two scan guards elsewhere failed on
 * correct code that way. Every scan below reads through this.
 */
const readSrc = (relative: string): string =>
    fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'modules', 'whatsapp', 'flows', relative),
        'utf8',
    ).replace(/\r\n/g, '\n');

/** Strip comments, so a scan cannot be satisfied by prose describing the rule. */
const stripComments = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

/**
 * Meta's client, reimplemented from their documented protocol.
 *
 * ⚠ **Deliberately written out rather than reusing our own helpers.** A suite that encrypts
 * with `encryptFlowResponse` and decrypts with `decryptFlowRequest` proves only that the two
 * agree with each other — which they would even if both had the IV rule backwards. Playing
 * the other side from the specification is the only thing that can catch a shared mistake.
 */
function metaEncrypts(payload: unknown, aesKey: Buffer, iv: Buffer) {
    const cipher = createCipheriv('aes-128-gcm', aesKey, iv);
    const body = Buffer.concat([
        cipher.update(JSON.stringify(payload), 'utf8'),
        cipher.final(),
    ]);

    return {
        encrypted_flow_data: Buffer.concat([body, cipher.getAuthTag()]).toString('base64'),
        encrypted_aes_key: publicEncrypt(
            {
                key: publicKey,
                padding: constants.RSA_PKCS1_OAEP_PADDING,
                oaepHash: 'sha256',
            },
            aesKey,
        ).toString('base64'),
        initial_vector: iv.toString('base64'),
    };
}

/** What Meta's client does with our answer: same key, IV inverted byte by byte. */
function metaDecrypts(base64: string, aesKey: Buffer, iv: Buffer): unknown {
    const flipped = Buffer.from(iv.map((b) => ~b & 0xff));
    const raw = Buffer.from(base64, 'base64');
    const body = raw.subarray(0, raw.length - 16);
    const tag = raw.subarray(raw.length - 16);

    const decipher = createDecipheriv('aes-128-gcm', aesKey, flipped);
    decipher.setAuthTag(tag);
    return JSON.parse(decipher.update(body, undefined, 'utf8') + decipher.final('utf8'));
}

async function main(): Promise<void> {
    console.log('\n═══ test:whatsapp-flows ═══');

    // ═════════════════════════════════════════════════════════════════════════
    section('1 · A real round trip, both sides played from the specification');

    const aesKey = randomBytes(16);
    const iv = randomBytes(16);
    const sent = {
        version: '3.0',
        action: 'INIT',
        flow_token: 'ia_abc123',
        data: { hello: 'world' },
    };

    const opened = decryptFlowRequest(metaEncrypts(sent, aesKey, iv), privateKey);

    assert('a request encrypted as Meta encrypts it opens', opened.ok === true);

    if (opened.ok) {
        assert('the payload survives the round trip intact',
            JSON.stringify(opened.payload) === JSON.stringify(sent),
            JSON.stringify(opened.payload));

        assert('the AES key comes back byte-identical',
            opened.aesKey.equals(aesKey));

        /**
         * ⚠ The load-bearing assertion of the whole suite. If `encryptFlowResponse` used a
         * random IV, or re-used the request's IV unflipped, this throws — and that failure
         * on a live number is a Flow that opens and then dies with no server-side symptom.
         */
        const answer = encryptFlowResponse({ version: '3.0', data: { ok: true } },
            opened.aesKey, opened.initialVector);

        let readBack: unknown = null;
        let threw = false;
        try {
            readBack = metaDecrypts(answer, aesKey, iv);
        } catch {
            threw = true;
        }

        assert('⚠ our response decrypts under the INVERTED IV, as Meta will read it',
            !threw && JSON.stringify(readBack) === JSON.stringify({ version: '3.0', data: { ok: true } }),
            threw ? 'the response could not be decrypted at all' : JSON.stringify(readBack));

        /**
         * The same ciphertext must NOT be readable with the un-inverted IV. Without this, a
         * future "simplification" that drops the flip would still pass the assertion above
         * if the suite's own reader were changed to match.
         */
        let unflippedWorked = false;
        try {
            const raw = Buffer.from(answer, 'base64');
            const d = createDecipheriv('aes-128-gcm', aesKey, iv);
            d.setAuthTag(raw.subarray(raw.length - 16));
            d.update(raw.subarray(0, raw.length - 16));
            d.final();
            unflippedWorked = true;
        } catch {
            // Expected: the tag must not verify under the un-inverted IV.
        }
        assert('⚠ and is NOT readable with the un-inverted IV — the flip is real',
            unflippedWorked === false);
    }

    // ═════════════════════════════════════════════════════════════════════════
    section('2 · The failure verdicts, which the controller maps onto Meta status codes');

    const wrongPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const wrongKey = decryptFlowRequest(metaEncrypts(sent, aesKey, iv), wrongPair.privateKey);
    assert('⚠ a key we cannot unwrap reports `key` — this is what earns HTTP 421',
        wrongKey.ok === false && wrongKey.reason === 'key',
        wrongKey.ok ? 'it opened' : wrongKey.reason);

    const tampered = metaEncrypts(sent, aesKey, iv);
    const bytes = Buffer.from(tampered.encrypted_flow_data, 'base64');
    bytes[2] ^= 0xff;
    const badTag = decryptFlowRequest(
        { ...tampered, encrypted_flow_data: bytes.toString('base64') },
        privateKey,
    );
    assert('⚠ a tampered body reports `body`, NOT `key` — re-fetching the key would not fix it',
        badTag.ok === false && badTag.reason === 'body',
        badTag.ok ? 'it opened' : badTag.reason);

    const notJson = decryptFlowRequest(
        (() => {
            const c = createCipheriv('aes-128-gcm', aesKey, iv);
            const b = Buffer.concat([c.update('not json at all', 'utf8'), c.final()]);
            return {
                encrypted_flow_data: Buffer.concat([b, c.getAuthTag()]).toString('base64'),
                encrypted_aes_key: publicEncrypt(
                    { key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
                    aesKey,
                ).toString('base64'),
                initial_vector: iv.toString('base64'),
            };
        })(),
        privateKey,
    );
    assert('plaintext that is not JSON reports `payload`',
        notJson.ok === false && notJson.reason === 'payload');

    for (const [label, body] of [
        ['null', null],
        ['an empty object', {}],
        ['a missing IV', { encrypted_flow_data: 'AAAA', encrypted_aes_key: 'AAAA' }],
        ['a non-base64 field', { encrypted_flow_data: '!!!', encrypted_aes_key: 'AAAA', initial_vector: 'AAAA' }],
    ] as const) {
        const verdict = decryptFlowRequest(body, privateKey);
        assert(`${label} reports \`malformed\` rather than throwing`,
            verdict.ok === false && verdict.reason === 'malformed');
    }

    /**
     * ⚠ A JSON array decrypts fine and is not a Flow request. Worth its own case because
     * `typeof [] === 'object'` — the obvious guard lets it through, and every later field
     * read then silently yields undefined.
     */
    const arrayPayload = decryptFlowRequest(
        (() => {
            const c = createCipheriv('aes-128-gcm', aesKey, iv);
            const b = Buffer.concat([c.update('[1,2,3]', 'utf8'), c.final()]);
            return {
                encrypted_flow_data: Buffer.concat([b, c.getAuthTag()]).toString('base64'),
                encrypted_aes_key: publicEncrypt(
                    { key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
                    aesKey,
                ).toString('base64'),
                initial_vector: iv.toString('base64'),
            };
        })(),
        privateKey,
    );
    assert('⚠ a JSON ARRAY is refused — `typeof [] === "object"` lets it past a naive guard',
        arrayPayload.ok === false && arrayPayload.reason === 'payload');

    // ═════════════════════════════════════════════════════════════════════════
    section('3 · The health check — the gate on publishing a Flow at all');

    /**
     * ⛔ Every shape in §§ 3–5 is checked against Meta's endpoint guide AND Meta's reference
     * endpoint (WhatsApp-Flows-Tools), read 2026-09-16. The first version of this section was
     * written from memory and asserted three of those shapes WRONG, as correct. A suite written
     * from the same memory as the code passes the code's mistakes.
     */
    const ping = classifyFlowRequest({ version: '3.0', action: 'ping' });
    assert('a ping is classified as a ping', ping.kind === 'ping');

    const pingBody = pingResponse();
    assert('⛔ the ping answer is EXACTLY {data:{status:"active"}} — Meta\'s "exact" body',
        JSON.stringify(pingBody) === JSON.stringify({ data: { status: 'active' } }),
        JSON.stringify(pingBody));

    assert('⛔ it carries no `version` — the first version of this answer did, wrongly',
        !('version' in pingBody));

    assert('⚠ and no `success` key — this service\'s envelope would fail the check',
        !('success' in pingBody) && !('requestId' in pingBody));

    /**
     * ⚠ A ping carries no flow_token. Requiring one would fail every health check while
     * looking like correct authentication, and the endpoint would be unpublishable.
     */
    assert('⚠ a ping needs no flow_token to classify',
        classifyFlowRequest({ action: 'ping' }).kind === 'ping');

    // ═════════════════════════════════════════════════════════════════════════
    section('4 · Classification — and where a client error report actually arrives');

    /**
     * ⛔ THE ONE THAT WAS INVERTED. There is no `action: "error"`. Meta's guide gives the shape
     * as `action: "data_exchange | INIT"` with `data: { error, error_message }`, and the
     * reference endpoint tests `data?.error`. Classified the old way, every client error report
     * was read as a screen request.
     */
    for (const action of ['INIT', 'data_exchange']) {
        const report = classifyFlowRequest({
            version: '3.0', action, flow_token: 'ia_x',
            data: { error: 'SOME_KEY', error_message: 'something broke' },
        });
        assert(`⛔ an error report on ${action} is classified as an error, NOT a screen`,
            report.kind === 'error' && report.errorKey === 'SOME_KEY'
            && report.errorMessage === 'something broke',
            JSON.stringify(report));
    }

    assert('⚠ `action: "error"` is not special — it does not exist, so it reads as a screen',
        classifyFlowRequest({ action: 'error', flow_token: 'ia_x' }).kind === 'screen');

    assert('⚠ the acknowledgement is EXACTLY {data:{acknowledged:true}}, no version',
        JSON.stringify(errorAcknowledgement()) === JSON.stringify({ data: { acknowledged: true } }));

    const exchange = classifyFlowRequest({
        version: '3.0', action: 'data_exchange', screen: 'CART', flow_token: 'ia_x',
        data: { quantity: 2 },
    });
    assert('a data_exchange with no error is a screen request',
        exchange.kind === 'screen');
    if (exchange.kind === 'screen') {
        assert('it carries the screen, the action, the data and the token',
            exchange.screen === 'CART' && exchange.action === 'data_exchange'
            && exchange.flowToken === 'ia_x' && exchange.data.quantity === 2);
    }

    /**
     * ⚠ INIT carries NO screen. Meta's guide: "`screen` may not be populated". A handler that
     * requires one refuses the mode every screen here opens with.
     */
    const init = classifyFlowRequest({ version: '3.0', action: 'INIT', flow_token: 'ia_y' });
    assert('⚠ an INIT with no screen is still a screen request, with screen null',
        init.kind === 'screen' && init.screen === null);

    assert('a payload with no action at all is malformed',
        classifyFlowRequest({ version: '3.0' }).kind === 'malformed');

    assert('a version Meta has not shipped yet is accepted, never refused',
        classifyFlowRequest({ version: '99.0', action: 'ping' }).kind === 'ping');

    // ═════════════════════════════════════════════════════════════════════════
    section('5 · Screen, completion and 427 answers — documented shapes only');

    const screen = screenResponse('ADDRESS', { city: 'Douala' });
    assert('a screen answer is {screen, data} and carries no version',
        JSON.stringify(screen) === JSON.stringify({ screen: 'ADDRESS', data: { city: 'Douala' } }),
        JSON.stringify(screen));

    const corrected = screenResponse('REVIEW', { a: 1 }, 'Check the number');
    assert('⚠ a correctable input rides Meta\'s `error_message` snackbar, on the same screen',
        corrected.screen === 'REVIEW' && corrected.data.error_message === 'Check the number'
        && corrected.data.a === 1);

    const done = completionResponse('ia_token', { orderCount: 1 });
    assert('a completion names the reserved terminal screen',
        done.screen === FLOW_TERMINAL_SCREEN && !('version' in done));

    const params = (done.data.extension_message_response as {
        params: Record<string, unknown>;
    }).params;
    assert('⛔ flow_token is ALWAYS in the params — Meta marks it Required',
        params.flow_token === 'ia_token' && params.orderCount === 1);

    /**
     * ⚠ Spread last. A param named `flow_token` must not overwrite the real one, or a finished
     * checkout is attributed to whatever that param said.
     */
    const smuggled = completionResponse('ia_real', { flow_token: 'ia_forged' });
    assert('⛔ a param named flow_token cannot overwrite the real one',
        (smuggled.data.extension_message_response as { params: Record<string, unknown> })
            .params.flow_token === 'ia_real');

    assert('⚠ a 427 carries {error_msg} — Meta\'s reference endpoint sends a sentence with it',
        JSON.stringify(tokenUnusableBody('Gone')) === JSON.stringify({ error_msg: 'Gone' }));

    // ═════════════════════════════════════════════════════════════════════════
    section('6 · The X-Hub-Signature-256 check');

    const secret = 'an-app-secret';
    const raw = Buffer.from(JSON.stringify({ a: 1 }));
    const good = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;

    assert('a correct signature verifies', verifyFlowSignature(raw, good, secret));
    assert('a wrong secret does not', !verifyFlowSignature(raw, good, 'other-secret'));
    assert('a tampered body does not',
        !verifyFlowSignature(Buffer.from(JSON.stringify({ a: 2 })), good, secret));
    assert('a missing header does not', !verifyFlowSignature(raw, undefined, secret));
    assert('a header without the sha256= prefix does not',
        !verifyFlowSignature(raw, 'deadbeef', secret));
    assert('⚠ a short digest does not throw — timingSafeEqual rejects a length mismatch',
        !verifyFlowSignature(raw, 'sha256=ab', secret));
    assert('⚠ an unset app secret NEVER verifies — absent must not mean "anything passes"',
        !verifyFlowSignature(raw, good, ''));

    // ═════════════════════════════════════════════════════════════════════════
    section('7 · Source scans — the three rules nothing behavioural can see');

    const crypto = stripComments(readSrc('domain/flow-crypto.ts'));

    /**
     * ⚠ Node defaults RSA-OAEP to SHA-1. The round trip in § 1 would still pass if BOTH
     * sides dropped it — the suite encrypts with sha256, so it would fail there; but a
     * reader "simplifying" both at once is exactly the change this pins.
     */
    assert('⚠ the RSA unwrap names oaepHash sha256 — the SHA-1 default decrypts nothing',
        /oaepHash:\s*['"]sha256['"]/.test(crypto));

    assert('⚠ the response IV is inverted in the source, not merely in the test',
        /~\s*byte\s*&\s*0xff/.test(crypto) || /~\s*b\s*&\s*0xff/.test(crypto));

    assert('the cipher table is GCM-typed, so setAuthTag stays visible to the compiler',
        /Record<number,\s*CipherGCMTypes>/.test(crypto));

    const signature = stripComments(readSrc('domain/flow-signature.ts'));
    assert('⚠ the signature comparison is timingSafeEqual, never ===',
        /timingSafeEqual\(/.test(signature)
        && !/presented\s*===\s*expected/.test(signature));

    const controller = stripComments(readSrc('flow-data.controller.ts'));

    /**
     * ⚠ The two self-healing codes. 421 is what makes a key rotation repair itself; without
     * it a rotation is a manual incident. Both are lost the moment a branch here becomes a
     * throw into the global error handler.
     */
    assert('⚠ the controller answers 421 on a key failure, and only on a key failure',
        /REFRESH_PUBLIC_KEY:\s*421/.test(controller)
        && /reason === 'key'\s*\?\s*STATUS\.REFRESH_PUBLIC_KEY/.test(controller));

    assert('the signature failure answers 432', /SIGNATURE_FAILED:\s*432/.test(controller));

    /**
     * ⚠ The endpoint must not answer this service's envelope. `sendSuccess` would wrap the
     * base64 string in `{success, data}`, which Meta reads as ciphertext that will not
     * decrypt — and the endpoint would be unpublishable with nothing visibly wrong.
     */
    assert('⚠ it never calls sendSuccess — Meta reads a bare base64 body, not our envelope',
        !/sendSuccess/.test(controller));

    assert('⚠ it sends text/plain — res.json would quote the base64 and break decryption',
        /type\(['"]text\/plain['"]\)/.test(controller));

    /**
     * ⚠ A 427 carries an ENCRYPTED `{error_msg}` the handset shows, as Meta's reference
     * endpoint does. A bare `res.status(427).end()` ends the Flow on a blank failure.
     */
    assert('⚠ a screen verdict (incl. 427) is encrypted — never a bare status',
        /res\.status\(verdict\.status\)[\s\S]{0,120}encryptFlowResponse\(verdict\.body/.test(controller)
        && !/TOKEN_UNUSABLE\)\.end\(\)/.test(controller));

    const protocolSource = stripComments(readSrc('domain/flow-protocol.ts'));
    assert('⛔ no answer echoes a version — no documented answer carries one',
        !/version\s*[,:}]/.test(protocolSource.replace(/data_api_version/g, '')));

    assert('⛔ client errors are detected on data.error, never on action "error"',
        /data\.error\s*!==\s*undefined/.test(protocolSource)
        && !/action\s*===\s*['"]error['"]/.test(protocolSource));

    /**
     * The missing-raw-body detection. A verifier that cannot tell whether it ran is the
     * `resolveVirusScanner` defect: a scanner that does nothing looks exactly like one that
     * works.
     */
    assert('⚠ a configured secret with a parsed body is REFUSED, never silently unverified',
        /Buffer\.isBuffer\(req\.body\)/.test(controller)
        && /SIGNATURE_FAILED/.test(controller));

    const config = stripComments(readSrc('flows.config.ts'));
    assert('⚠ every env var is a spelled-out property access, for test:env\'s census',
        /process\.env\.WHATSAPP_FLOW_PRIVATE_KEY\b/.test(config)
        && /process\.env\.WHATSAPP_FLOW_ID_PRODUCT_LISTING\b/.test(config));

    assert('⚠ the public key is DERIVED from the private one, never configured separately',
        /createPublicKey\(/.test(config)
        && !/process\.env\.WHATSAPP_FLOW_PUBLIC_KEY\b/.test(config));

    // ═════════════════════════════════════════════════════════════════════════
    section('8 · The published Flow definitions — what Meta validates at publish time');

    /**
     * ⚠ **The ticket form is a DRAFT and is held to every rule below anyway.** It is built against
     * the read and submit core the ticket stream is extracting, and it is deliberately absent from
     * `publish-whatsapp-flows.ts` until those land — so it cannot reach Meta early, while a
     * mistake in its shape still fails here rather than at publish, which is the one step this
     * platform cannot rehearse.
     */
    /** `[label, definition, the file it lives in]` — the three booking forms share one file. */
    const ALL_FLOWS = [
        ['product-listing', PRODUCT_LISTING_FLOW, 'product-listing.flow.ts'],
        ['product-detail', PRODUCT_DETAIL_FLOW, 'product-detail.flow.ts'],
        ['checkout', CHECKOUT_FLOW, 'checkout.flow.ts'],
        ['ticket-form', TICKET_FORM_FLOW, 'ticket-form.flow.ts'],
        ['booking-list', BOOKING_LIST_FLOW, 'booking.flow.ts'],
        ['booking-slot', BOOKING_SLOT_FLOW, 'booking.flow.ts'],
        ['booking-pay', BOOKING_PAY_FLOW, 'booking.flow.ts'],
    ] as const;

    /**
     * ⚠ **Each booking form stamps its OWN kind.** The stamp is what tells the chat which form
     * finished; a form stamping another's kind would have the chat answer for the wrong screen.
     * They were built with a placeholder for a day, before the kinds existed — this is what
     * replaced it.
     */
    const stampOf = (definition: typeof BOOKING_LIST_FLOW): unknown => {
        const notice = definition.screens.find((s) => s.id === NOTICE_SCREEN);
        const footer = notice?.layout.children.find((c) => c.type === 'Footer') as
            | { 'on-click-action'?: { payload?: Record<string, unknown> } } | undefined;
        return footer?.['on-click-action']?.payload?.screen;
    };
    assert('⛔ each booking form stamps its own screen kind — bl, bk, bp',
        stampOf(BOOKING_LIST_FLOW) === 'bl' && stampOf(BOOKING_SLOT_FLOW) === 'bk'
        && stampOf(BOOKING_PAY_FLOW) === 'bp');

    /** Every `${data.x}` string anywhere under a node, with the component it sits on. */
    const bindingsIn = (node: unknown, on = ''): Array<{ field: string; key: string; type: string }> => {
        if (Array.isArray(node)) return node.flatMap((n) => bindingsIn(n, on));
        if (node === null || typeof node !== 'object') return [];
        const rec = node as Record<string, unknown>;
        const type = typeof rec.type === 'string' ? rec.type : on;
        return Object.entries(rec).flatMap(([key, value]) => {
            if (typeof value === 'string') {
                const m = /^\$\{data\.([A-Za-z0-9_]+)\}$/.exec(value);
                return m ? [{ field: m[1], key, type }] : [];
            }
            return bindingsIn(value, type);
        });
    };

    for (const [label, definition, sourceFile] of ALL_FLOWS) {
        assert(`${label}: declares a data_api_version — without one the Flow is static`,
            definition.data_api_version === '3.0');

        /**
         * A house rule, not Meta's: a complete routing map lets reachability be checked here.
         * Meta requires the model when an endpoint powers the Flow.
         */
        const unrouted = definition.screens
            .filter((s) => !Object.prototype.hasOwnProperty.call(definition.routing_model, s.id))
            .map((s) => s.id);
        assert(`${label}: every screen is declared in the routing model`,
            unrouted.length === 0, unrouted.join(', '));

        const ids = new Set(definition.screens.map((s) => s.id));
        const danglingRoutes = Object.entries(definition.routing_model)
            .flatMap(([from, tos]) => tos.filter((to) => !ids.has(to) || to === from).map((to) => `${from}→${to}`));
        assert(`${label}: every route targets a real, different screen (Meta: no self-routes)`,
            danglingRoutes.length === 0, danglingRoutes.join(', '));

        /**
         * ⛔ AT LEAST ONE, and several are allowed. Meta: "Multiple screens can be marked as
         * terminal". This assertion used to demand exactly one, a rule Meta doesn't have, and
         * that left checkout nowhere to say "you have no saved address".
         */
        assert(`${label}: ⛔ at least one terminal screen (several are allowed)`,
            definition.screens.some((s) => s.terminal));

        const missingExample = definition.screens.flatMap((s) =>
            Object.entries(s.data ?? {})
                .filter(([, f]) => f.__example__ === undefined)
                .map(([name]) => `${s.id}.${name}`));
        assert(`${label}: every declared data field carries an __example__ (Meta: "mandatory")`,
            missingExample.length === 0, missingExample.join(', '));

        /**
         * ⛔ Meta's required properties, per component. The listing's radio group had no `label`
         * (required since Flow JSON 4.0) and Meta was the first to notice, on deploy day — the
         * publish stopped at a draft. The two booking forms had the same gap.
         */
        const missingRequired = missingRequiredProperties(definition);
        assert(`${label}: ⛔ every component carries Meta's required properties`,
            missingRequired.length === 0, missingRequired.join(' | '));

        /**
         * ⛔ THE CHECK THAT WOULD HAVE CAUGHT THE ARRAY BOUND TO A TEXT BOX. Every `${data.x}`
         * must name a field that screen declares, and text on a Text* component must bind to a
         * STRING field. The first checkout definition bound `TextBody.text` to an array, and no
         * earlier assertion looked.
         */
        const badBindings = definition.screens.flatMap((s) =>
            bindingsIn(s.layout.children).flatMap(({ field, key, type }) => {
                const declared = s.data?.[field];
                if (!declared) return [`${s.id}: \${data.${field}} is not declared`];
                if (key === 'text' && /^Text/.test(type) && declared.type !== 'string') {
                    return [`${s.id}: ${type}.text binds ${field}, a ${declared.type}`];
                }
                if (key === 'data-source' && declared.type !== 'array') {
                    return [`${s.id}: data-source binds ${field}, a ${declared.type}`];
                }
                return [];
            }));
        assert(`${label}: ⛔ every binding names a declared field of the right type`,
            badBindings.length === 0, badBindings.join(' | '));

        /**
         * ⛔ No English literal where a customer reads it. Every label and text is a binding
         * filled from the five-language screen copy; the one literal allowed is the screen
         * title, which is the brand and reads the same in every language.
         */
        const literals = definition.screens.flatMap((s) => {
            const found: string[] = [];
            const visit = (node: unknown): void => {
                if (Array.isArray(node)) { node.forEach(visit); return; }
                if (node === null || typeof node !== 'object') return;
                for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
                    if (['text', 'label', 'helper-text'].includes(key) && typeof value === 'string'
                        && !/^\$\{data\.[A-Za-z0-9_]+\}$/.test(value)) {
                        found.push(`${s.id}.${key}="${value}"`);
                    }
                    visit(value);
                }
            };
            visit(s.layout.children);
            if (s.title !== FLOW_SCREEN_TITLE) found.push(`${s.id}.title="${s.title}"`);
            return found;
        });
        assert(`${label}: ⛔ no literal customer-facing text — all of it comes from the copy table`,
            literals.length === 0, literals.join(', '));

        const source = stripComments(readSrc(`definitions/${sourceFile}`));
        assert(`${label}: no money maths in a definition — prices arrive formatted`,
            !/toFixed|parseFloat|Intl\.NumberFormat/.test(source));

        assert(`${label}: every screen that ends the Flow can reach the conversation (a NOTICE)`,
            definition.screens.some((s) => s.id === NOTICE_SCREEN && s.terminal));
    }

    /**
     * ⛔ **The table is Meta's, so its entries are pinned as LITERALS here** — a guard that took
     * its standard from the table it checks would pass on whatever the table says. These are the
     * components the forms actually use (Flow JSON components reference, 6.x).
     */
    const requires = (type: string, props: string[]): boolean =>
        props.every((p) => (FLOW_REQUIRED_PROPERTIES[type] ?? []).includes(p));
    assert('⛔ the required-properties table holds Meta\'s rules for every component the forms use',
        requires('RadioButtonsGroup', ['label', 'data-source', 'name'])
        && requires('Dropdown', ['label', 'data-source', 'name'])
        && requires('TextInput', ['label', 'name'])
        && requires('TextArea', ['label', 'name'])
        && requires('Footer', ['label', 'on-click-action'])
        && requires('Image', ['src'])
        && requires('TextHeading', ['text']) && requires('TextBody', ['text'])
        && requires('TextCaption', ['text']));

    /** A deep copy of the listing, with its radio group handed to `edit`. */
    const listingWith = (edit: (radio: Record<string, unknown>, children: unknown[]) => void): FlowDefinition => {
        const copy = JSON.parse(JSON.stringify(PRODUCT_LISTING_FLOW)) as FlowDefinition;
        const children = copy.screens[0].layout.children as unknown as Array<Record<string, unknown>>;
        const radio = children.find((c) => c.type === 'RadioButtonsGroup');
        if (radio) edit(radio, children);
        return copy;
    };
    assert('⛔ guard bites — the listing as first sent to Meta (no radio label) is refused here',
        missingRequiredProperties(listingWith((radio) => { delete radio.label; }))
            .some((f) => f.includes("RadioButtonsGroup: missing 'label'")));
    assert('⚠ guard bites — a component type nobody has looked up is a fault, not a pass',
        missingRequiredProperties(listingWith((_radio, children) => {
            children.push({ type: 'PhotoPicker', name: 'photo' });
        })).some((f) => f.includes('PhotoPicker: not in the required-properties table')));

    /**
     * ⛔ Images are BASE64, never URLs. Meta: `src` is "Base64 of an image", "up to 300kb", and
     * at most 3 images per screen. The first detail definition bound a URL.
     */
    const imageComponents = ALL_FLOWS.flatMap(([, d]) => d.screens.flatMap((s) =>
        s.layout.children.filter((c) => c.type === 'Image').map((c) => ({ screen: s, c }))));
    assert('⛔ every Image binds a field named for bytes, never a *Url field',
        imageComponents.length > 0
        && imageComponents.every(({ c }) => c.src === '${data.image}'),
        imageComponents.map(({ c }) => String(c.src)).join(', '));
    assert('no screen carries more than 3 images (Meta\'s per-screen cap)',
        ALL_FLOWS.every(([, d]) => d.screens.every((s) =>
            s.layout.children.filter((c) => c.type === 'Image').length <= 3)));

    // ── the listing ──────────────────────────────────────────────────────────
    const listing = PRODUCT_LISTING_FLOW.screens.find((s) => s.id === 'PRODUCTS');
    const listingFooter = listing?.layout.children.find((c) => c.type === 'Footer') as
        | { 'on-click-action'?: { name?: string; payload?: Record<string, unknown> } } | undefined;

    assert('listing: its contract mirrors the Telegram screen\'s read — heading + products',
        !!listing?.data?.heading && !!listing?.data?.products);
    assert('listing: the footer completes, handing the choice to the chat',
        listingFooter?.['on-click-action']?.name === 'complete');
    assert('⚠ listing: it hands back a productId, never a variantId',
        'productId' in (listingFooter?.['on-click-action']?.payload ?? {})
        && !('variantId' in (listingFooter?.['on-click-action']?.payload ?? {})));
    /**
     * Verified: Meta's reference says the business receives the completion "together with the
     * flow_token and all of the other parameters from the payload". So it isn't restated.
     */
    assert('listing: flow_token is not restated — Meta sends it with the completion',
        !('flow_token' in (listingFooter?.['on-click-action']?.payload ?? {})));
    assert('⚠ listing: the completion stamps which Flow finished, so no store lookup is needed',
        listingFooter?.['on-click-action']?.payload?.screen === 'pl');
    assert('listing rows declare `enabled` — a muted Telegram card is a disabled row here',
        JSON.stringify(listing?.data?.products).includes('"enabled"'));

    // ── the closing screen stamps WHAT HAPPENED, in every Flow ───────────────
    /**
     * ⛔ Without this the chat cannot tell "nothing here" from "your basket just changed", and a
     * WhatsApp customer's form closes onto an empty thread. The stamp is `${data.outcome}` rather
     * than a literal precisely because ONE screen closes every state.
     */
    for (const [label, definition] of ALL_FLOWS) {
        const notice = definition.screens.find((s) => s.id === NOTICE_SCREEN);
        const noticeFooter = notice?.layout.children.find((c) => c.type === 'Footer') as
            | { 'on-click-action'?: { name?: string; payload?: Record<string, unknown> } } | undefined;
        assert(`${label}: the closing screen stamps its outcome from data, never a literal`,
            noticeFooter?.['on-click-action']?.payload?.outcome === '${data.outcome}'
            && notice?.data?.outcome?.type === 'string');
        assert(`${label}: … and still stamps which form closed`,
            typeof noticeFooter?.['on-click-action']?.payload?.screen === 'string');
    }

    for (const s of PRODUCT_DETAIL_FLOW.screens.filter((x) => x.id !== NOTICE_SCREEN)) {
        const footer = s.layout.children.find((c) => c.type === 'Footer') as
            | { 'on-click-action'?: { payload?: Record<string, unknown> } } | undefined;
        /**
         * ⚠ `${data.openRef}`, not `${form.…}`: it is the value this open was drawn with, not
         * something the customer chose. It is what makes the write idempotent PER OPEN.
         */
        assert(`detail ${s.id}: the footer sends back this open's reference, from data`,
            footer?.['on-click-action']?.payload?.openRef === '${data.openRef}'
            && s.data?.openRef?.type === 'string');
    }

    // ── the detail ───────────────────────────────────────────────────────────
    const detailScreens = PRODUCT_DETAIL_FLOW.screens.filter((s) => s.id !== NOTICE_SCREEN);
    assert('detail: two product screens, one with the image and one without',
        detailScreens.length === 2
        && detailScreens.filter((s) => s.layout.children.some((c) => c.type === 'Image')).length === 1);

    /**
     * ⚠ Built from ONE list of children. Apart from the image, the two screens must be
     * identical, or they drift the first time one gains a caption.
     */
    const withoutImage = (s: { layout: { children: Array<Record<string, unknown>> } }) =>
        JSON.stringify(s.layout.children.filter((c) => c.type !== 'Image'));
    assert('⚠ detail: apart from the image, the two product screens are identical',
        withoutImage(detailScreens[0]) === withoutImage(detailScreens[1]));

    for (const s of detailScreens) {
        const selector = s.layout.children.find((c) => c.name === 'variant');
        /**
         * ⚠ Dropdown, because RadioButtonsGroup caps at 20 options and would silently drop
         * variant 21. A Dropdown takes 200.
         */
        assert(`⚠ detail ${s.id}: variants are a Dropdown — a radio group would drop variant 21`,
            selector?.type === 'Dropdown');
        assert(`⚠ detail ${s.id}: declares no option matrix — variants are flat`,
            !('options' in (s.data ?? {})));
        const footer = s.layout.children.find((c) => c.type === 'Footer') as
            | { 'on-click-action'?: { name?: string; payload?: Record<string, unknown> } } | undefined;
        /**
         * The Telegram page performs the purchase itself (`POST /act`), so this Flow's footer
         * exchanges and the endpoint calls the same purchase core.
         */
        assert(`detail ${s.id}: the footer exchanges — the purchase happens in the endpoint`,
            footer?.['on-click-action']?.name === 'data_exchange'
            && 'variantId' in (footer?.['on-click-action']?.payload ?? {}));
        assert(`detail ${s.id}: its only route is the notice screen`,
            JSON.stringify(PRODUCT_DETAIL_FLOW.routing_model[s.id]) === JSON.stringify([NOTICE_SCREEN]));
    }

    // ── the ticket form: a draft, and held to the same rules ─────────────────
    const supportScreens = TICKET_FORM_FLOW.screens.filter((s) => s.id !== NOTICE_SCREEN);
    const withoutContext = (s: { layout: { children: Array<Record<string, unknown>> } }) =>
        JSON.stringify(s.layout.children.filter((c) => c.type !== 'TextCaption'));
    assert('⚠ ticket form: two screens, and apart from the context line they are identical',
        supportScreens.length === 2
        && withoutContext(supportScreens[0]) === withoutContext(supportScreens[1])
        && supportScreens.filter((s) => s.layout.children.some((c) => c.type === 'TextCaption')).length === 1);
    assert('⚠ ticket form: the subjects are a radio group — eight options, none hidden behind a tap',
        supportScreens.every((s) => s.layout.children.some((c) => c.type === 'RadioButtonsGroup' && c.name === 'subject')));
    assert('⛔ ticket form: it submits the subject KEY and the customer\'s words, nothing else',
        supportScreens.every((s) => {
            const footer = s.layout.children.find((c) => c.type === 'Footer') as
                | { 'on-click-action'?: { name?: string; payload?: Record<string, unknown> } } | undefined;
            return footer?.['on-click-action']?.name === 'data_exchange'
                && JSON.stringify(Object.keys(footer['on-click-action'].payload ?? {})) === '["subject","description"]';
        }));

    /**
     * ⛔ **A draft must not be publishable.** Its read and submit core do not exist yet, so a Flow
     * published now would open a form that cannot be sent. The publish list is the gate, and this
     * is what keeps the draft on the safe side of it.
     */
    const publishSource = stripComments(fs.readFileSync(
        path.join(__dirname, '..', 'publish-whatsapp-flows.ts'), 'utf8',
    ).replace(/\r\n/g, '\n'));
    assert('⛔ the ticket form is NOT in the publish list while its seam is unbuilt',
        /PRODUCT_LISTING_FLOW/.test(publishSource) && !/TICKET_FORM_FLOW/.test(publishSource));
    assert('⛔ nor are the three booking forms, whose reads and screen kinds do not exist yet',
        !/BOOKING_LIST_FLOW|BOOKING_SLOT_FLOW|BOOKING_PAY_FLOW/.test(publishSource));

    /**
     * ⛔ **Meta must be TOLD where the endpoint is**, as `endpoint_uri` on the Flow — from Flow JSON
     * 3.0 there is no other way. The create call once sent a name and a category only, so every
     * Flow would have been refused at publish (deploy day, 2026-09-21). The path is pinned against
     * the mount in `app.ts`: a route that moves must break this suite, not a published form.
     */
    const createCall = publishSource.match(/graph\(`\$\{WABA_ID\}\/flows`[\s\S]*?\}\)\)/)?.[0] ?? '';
    const endpointPath = publishSource.match(/FLOW_ENDPOINT_PATH = '([^']+)'/)?.[1] ?? '';
    const appSource = stripComments(fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'app.ts'), 'utf8',
    ).replace(/\r\n/g, '\n'));
    assert('⛔ the create call is found at all (so the next two cannot pass on nothing)',
        createCall.length > 0 && endpointPath.length > 0);
    assert('⛔ the publisher sends endpoint_uri when it creates a Flow',
        /endpoint_uri:\s*ENDPOINT_URI/.test(createCall));
    assert('⛔ … built from the path app.ts actually mounts the Flow endpoint on',
        endpointPath === '/api/webhooks/whatsapp/flows' && appSource.includes(`'${endpointPath}'`)
        && /ENDPOINT_URI = API_PUBLIC_URL \? `\$\{API_PUBLIC_URL\}\$\{FLOW_ENDPOINT_PATH\}`/.test(publishSource));
    assert('⚠ … and --publish is refused unless that address is https',
        /if \(!ENDPOINT_URI\.startsWith\('https:\/\/'\)\)/.test(publishSource));

    // ── the booking forms: the cap is what shaped them ───────────────────────
    const slotFlow = BOOKING_SLOT_FLOW;
    const dayScreen = slotFlow.screens.find((s) => s.id === 'DAY');
    const timesScreen = slotFlow.screens.find((s) => s.id === 'TIMES');
    /**
     * ⛔ THE RULE THAT SHAPED THIS FORM. Twenty options is the radio cap, so a fortnight of slots
     * cannot be one screen — hence a day, then that day's times. Collapsing it back into one list
     * is the change this assertion exists to catch.
     */
    assert('⛔ booking a slot is TWO screens — a day, then that day\'s times',
        !!dayScreen && !!timesScreen
        && JSON.stringify(slotFlow.routing_model.DAY) === JSON.stringify(['TIMES', NOTICE_SCREEN]));
    assert('⚠ times are a Dropdown (200), because a day can hold more than twenty slots',
        timesScreen?.layout.children.some((c) => c.type === 'Dropdown' && c.name === 'slot') === true
        && !timesScreen?.layout.children.some((c) => c.type === 'RadioButtonsGroup'));
    assert('⚠ the day is confirmed with the footer, so a touch cannot move the customer on',
        dayScreen?.layout.children.some((c) => c.type === 'RadioButtonsGroup' && c.name === 'day') === true
        && !JSON.stringify(dayScreen).includes('on-select-action'));
    assert('⛔ the form hands back the opaque slot handle and nothing it computed',
        JSON.stringify((timesScreen?.layout.children.find((c) => c.type === 'Footer') as
            { 'on-click-action'?: { payload?: Record<string, unknown> } })?.['on-click-action']?.payload)
            === JSON.stringify({ slotId: '${form.slot}' }));

    const payScreen = BOOKING_PAY_FLOW.screens.find((s) => s.id === 'PAY');
    const payInputs = (payScreen?.layout.children ?? []).filter((c) =>
        ['TextInput', 'TextArea', 'DatePicker', 'Dropdown', 'RadioButtonsGroup', 'CheckboxGroup', 'OptIn']
            .includes(String(c.type)));
    assert('⛔ the booking payment screen has EXACTLY ONE input, and it is a phone number',
        payInputs.length === 1 && payInputs[0]['input-type'] === 'phone'
        && payInputs[0].required === false);
    assert('⚠ … whose helper text is the masked number, never its value',
        payInputs[0]?.['helper-text'] === '${data.phoneMasked}' && !('value' in (payInputs[0] ?? {})));

    // ── checkout: the four protections, each pinned on its own ───────────────
    const review = CHECKOUT_FLOW.screens.find((s) => s.id === 'REVIEW');
    const inputs = (review?.layout.children ?? []).filter((c) =>
        ['TextInput', 'TextArea', 'DatePicker', 'Dropdown', 'RadioButtonsGroup', 'CheckboxGroup', 'OptIn']
            .includes(String(c.type)));

    /**
     * ⛔ `co.html` has exactly one input and it is a phone. An address field here would be
     * ignored: `createOrdersFromCart` re-resolves the destination from saved addresses. That's
     * worse than no box, because the customer would believe they had changed where the
     * parcel goes.
     */
    assert('⛔ checkout has EXACTLY ONE input of any kind, and it is a phone number',
        inputs.length === 1 && inputs[0]['input-type'] === 'phone',
        `${inputs.length} inputs: ${inputs.map((i) => `${String(i.type)}:${String(i.name)}`).join(', ')}`);

    const phoneInput = inputs[0] ?? {};
    assert('⚠ the masked number is helper text, never the input\'s value',
        phoneInput['helper-text'] === '${data.phoneMasked}'
        && !('value' in phoneInput) && !('init-value' in phoneInput));
    assert('⚠ the phone field is OPTIONAL — empty means "use my account number"',
        phoneInput.required === false);

    const checkoutFooter = (review?.layout.children ?? []).find((c) => c.type === 'Footer') as
        | { 'on-click-action'?: { name?: string; payload?: Record<string, unknown> } } | undefined;
    assert('⛔ checkout\'s footer is a data_exchange — a complete would place no order',
        checkoutFooter?.['on-click-action']?.name === 'data_exchange');
    assert('⛔ checkout\'s footer sends only the phone — never an address, total or id',
        JSON.stringify(Object.keys(checkoutFooter?.['on-click-action']?.payload ?? {})) === '["phone"]');

    /**
     * ⚠ The basket is ONE string. `TextBody.text` is a string, and binding it to an array was the
     * first definition's mistake.
     */
    assert('⚠ checkout: the basket lines are a single string field',
        review?.data?.lines?.type === 'string');
    assert('checkout: the address label is data, so a digital basket can say "Sent to your account"',
        !!review?.data?.addressLabel);
    assert('⚠ checkout: the REVIEW screen routes only to the notice screen',
        JSON.stringify(CHECKOUT_FLOW.routing_model.REVIEW) === JSON.stringify([NOTICE_SCREEN]));

    // ═════════════════════════════════════════════════════════════════════════
    section('9 · The completion command — what each finished form leads to');

    /**
     * ⛔ THE LOAD-BEARING ONE. The checkout handle is SPENT by the write that places the order,
     * so by the time Meta sends the completion it is gone, correctly. A finished checkout must
     * therefore need no session at all — and it must not be mistaken for a failure.
     */
    assert('⛔ a SPENT checkout token is not an error — a finished checkout is simply silent',
        planCompletion({ completedScreen: 'co', params: { outcome: 'placed' }, sender: '237652705926', session: null }).kind === 'silent');
    assert('an unrecognised screen stamp is not trusted — it plans nothing',
        planCompletion({ completedScreen: null, params: { productId: '66f1a2b3c4d5e6f708192a3b' }, sender: '237652705926', session: null }).kind === 'silent');

    const live = { channel: 'whatsapp', externalId: '237652705926' };
    const pid = '66f1a2b3c4d5e6f708192a3b';
    const plan = (over: Partial<Parameters<typeof planCompletion>[0]> = {}) => planCompletion({
        completedScreen: 'pl', params: { screen: 'pl', productId: pid },
        sender: '237652705926', session: live, ...over,
    });

    assert('a listing choice, live session, same sender → open that product\'s detail screen',
        JSON.stringify(plan()) === JSON.stringify({ kind: 'open_detail', productId: pid }));
    assert('⚠ the sender compares on digits, so "+237 652…" and a bare-digits wa_phone_id agree',
        plan({ sender: '+237 652 705 926' }).kind === 'open_detail');

    /**
     * ⚠ A finished checkout stays quiet: the payment RESULT arrives through the payment path,
     * and a "got that" here would talk over the message the customer is waiting for.
     */
    for (const done of ['pd', 'co'] as const) {
        assert(`a ${done} form that changed nothing adds nothing to the chat`,
            plan({ completedScreen: done }).kind === 'silent');
    }
    assert('a notice screen closing adds nothing to the chat',
        plan({ params: { screen: 'pl', outcome: 'notice' } }).kind === 'silent');

    // ── the product form's outcome, which the chat must finish on WhatsApp ───
    /**
     * ⛔ THE GAP THIS CLOSES. A Telegram customer keeps the screen's own controls; a WhatsApp
     * customer's form CLOSES, so the basket changed and the thread said nothing at all.
     */
    const added = (over: Partial<Parameters<typeof planCompletion>[0]> = {}) => plan({
        completedScreen: 'pd', params: { screen: 'pd', outcome: 'added' }, ...over,
    });
    assert('⛔ a product form that added to the basket → the chat says so, with the three controls',
        added().kind === 'added_to_cart');
    assert('⚠ … and still does when the session has since lapsed: the basket really did change',
        added({ session: null }).kind === 'added_to_cart');
    assert('⛔ … but NOT for a live session belonging to a different conversation',
        added({ sender: '237600000000' }).kind === 'silent'
        && added({ session: { channel: 'telegram', externalId: '237652705926' } }).kind === 'silent');
    assert('⚠ `placed` is stamped but stays silent — the payment result comes through the payment path',
        plan({ completedScreen: 'pd', params: { outcome: 'placed' } }).kind === 'silent'
        && plan({ completedScreen: 'co', params: { outcome: 'placed' } }).kind === 'silent');
    /**
     * ⚠ The stamp ROUTES and never carries content, so a value from a Flow published later than
     * this code must not be guessed at.
     */
    assert('⚠ an outcome outside the closed set reads as "nothing happened", never as an add',
        asFlowOutcome('added') === 'added' && asFlowOutcome('something-new') === 'notice'
        && asFlowOutcome(undefined) === 'notice' && asFlowOutcome(7) === 'notice'
        && plan({ completedScreen: 'pd', params: { outcome: 'something-new' } }).kind === 'silent');
    /**
     * ⚠ The whole vocabulary, pinned. A screen stamping a value the chat does not know reads as
     * "nothing happened" — silently — so the set is asserted rather than left to grow by habit.
     */
    assert('the closed set is exactly the six the screens can stamp',
        JSON.stringify([...FLOW_OUTCOMES].sort())
        === JSON.stringify(['added', 'asked', 'booked', 'moved', 'notice', 'placed']));
    // ── the question a bargain or a booking asks, carried into the chat ──────
    /**
     * ⛔ THE OTHER HALF OF THE SAME GAP, now closed. These two rungs WRITE NOTHING — they start a
     * conversation — and the agent wakes on the customer's next message. On WhatsApp the question
     * lived only on the closing screen, so it died with it.
     */
    const asked = (over: Partial<Parameters<typeof planCompletion>[0]> = {}) => plan({
        completedScreen: 'pd', params: { screen: 'pd', outcome: 'asked' },
        session: { ...live, productId: pid }, ...over,
    });
    assert('⛔ a bargain or booking form → the chat carries the question, naming that product',
        JSON.stringify(asked()) === JSON.stringify({ kind: 'invite_reply', productId: pid }));
    assert('⚠ a lapsed session cannot name the product, so it says the page is gone …',
        asked({ session: null }).kind === 'expired'
        && asked({ session: live }).kind === 'expired');
    assert('⛔ … and a completion from another conversation says nothing at all',
        asked({ sender: '237600000000' }).kind === 'silent');

    // ── the appointment's acknowledgement ────────────────────────────────────
    /**
     * ⛔ The chat MUST speak here: the platform's booking notification picks one secondary
     * channel (telegram > email > whatsapp) and is mutable by a preference, so a WhatsApp
     * customer with a verified email could otherwise finish the form and hear nothing at all.
     */
    const booked = (outcome: string, over: Partial<Parameters<typeof planCompletion>[0]> = {}) =>
        plan({ completedScreen: 'bk', params: { screen: 'bk', outcome }, session: null, ...over });
    assert('⛔ a confirmed appointment → the chat acknowledges it',
        JSON.stringify(booked('booked')) === JSON.stringify({ kind: 'booking_ack', moved: false }));
    assert('⛔ a RESCHEDULE carries `moved` — "booked" would read as a second appointment',
        JSON.stringify(booked('moved')) === JSON.stringify({ kind: 'booking_ack', moved: true }));
    assert('⚠ it needs no session: the handle was consumed by the write that made the booking',
        booked('booked', { sender: null }).kind === 'booking_ack');
    assert('a booking form that changed nothing stays silent',
        booked('notice').kind === 'silent' && booked('added').kind === 'silent');
    assert('a listing completion with no valid product id opens nothing',
        plan({ params: { productId: 'not-an-id' } }).kind === 'silent');

    assert('a lapsed listing session says so, and opens nothing',
        plan({ session: null }).kind === 'expired');

    /**
     * ⛔ A completion arriving from anyone but the conversation the listing was minted for opens
     * nothing and SAYS nothing: "expired" would confirm the handle was real.
     */
    assert('⛔ a different sender → silent, never "expired", never a screen',
        plan({ sender: '237600000000' }).kind === 'silent');
    assert('⛔ no sender in the context → silent', plan({ sender: null }).kind === 'silent');
    assert('⛔ a non-WhatsApp session → silent',
        plan({ session: { channel: 'telegram', externalId: '237652705926' } }).kind === 'silent');

    const commandSource = stripComments(readSrc('commands/flow-complete.command.ts'));

    /**
     * ⚠ It may mint a VIEW session and nothing else. Adding, paying and placing stay in the
     * encrypted exchange, where the session is live and the retry guard sits.
     */
    assert('⛔ the completion never consumes, touches, adds to a basket, purchases or places',
        !/\.consume\(|\.touch\(/.test(commandSource)
        && !/executePurchase|placeCheckout|addToCart|createOrder|placeOrder/i.test(commandSource));
    assert('⚠ the only session it mints is a pd (view) session',
        (commandSource.match(/\.mint\(/g) ?? []).length === 1 && /kind:\s*'pd'/.test(commandSource));
    /**
     * ⚠ The read names the kind that STAMPED the completion, so a handle can only ever resolve as
     * the form it belongs to — and only the two forms that can need a session are looked up at
     * all. A `co` handle is spent by the write that placed the order; looking it up would find
     * nothing, and treating that as a failure would tell every customer whose order succeeded
     * that it failed.
     */
    assert('⚠ it resolves a session only for pl and pd, and always by naming the kind',
        /inAppSurfaceStore\.read\(completedScreen, flowToken\)/.test(commandSource)
        && /completedScreen === 'pl' \|\| completedScreen === 'pd'/.test(commandSource));

    /**
     * ⛔ The chat's three controls are IMPORTED, never rebuilt here. Two doors offering different
     * buttons for one outcome is how one of them quietly loses Checkout — the exported list's own
     * comment says so.
     */
    /**
     * ⛔ The THREE cart controls must come from the shared list — two doors offering different
     * buttons for one outcome is how one of them quietly loses Checkout.
     *
     * ⚠ **The ban names the trio's own ids, not `openSurfaceActionId` wholesale.** This guard
     * first refused that helper outright, and then went red on the My-bookings button, which is a
     * single unrelated control and not a second copy of anything. A guard that fails on correct
     * code teaches the next person to weaken it, so it is narrowed to the span it is actually
     * true of: `cart:view`, `open:co` and `open:pl` are the list's, and only the list may build
     * them.
     */
    assert('⛔ the added-to-cart buttons come from the shared list, not a second copy',
        /addedToCartActions,/.test(commandSource)
        && /actions: addedToCartActions\(language\)/.test(commandSource)
        && !/cartViewActionId\(/.test(commandSource)
        && !/openSurfaceActionId\('co'\)|openSurfaceActionId\('pl'\)/.test(commandSource));

    /**
     * ⛔ ONE CONSTRUCTION of the invite sentence, shared with the chat tap. A second copy here is
     * how the two channels start asking the same question in two different ways — and it is the
     * reason this branch waited for the extraction instead of being written twice.
     */
    assert('⛔ the bargain / booking question is purchaseInvitePrompt, never built here',
        /purchaseInvitePrompt\(product\.title, verb, language\)/.test(commandSource)
        && !/bargainInvitePrompt|bookInvitePrompt/.test(commandSource)
        && !/\\n\\n/.test(commandSource));

    /**
     * ⛔ THE RUNG IS RE-RESOLVED FROM THE LIVE PRODUCT, never taken from the stamp — the rule the
     * whole purchase surface is built on, and the reason a closed bargaining window produces no
     * invite rather than an invitation the platform would then refuse.
     */
    /**
     * ⛔ The acknowledgement names nothing about the appointment, and reaches the details through
     * a BUTTON instead — a tap code is not caller-supplied content.
     */
    assert('⛔ the booking acknowledgement is content-free and carries a My bookings button',
        /bookingChatAcknowledgement\(\{ moved: plan\.moved \}, language\)/.test(commandSource)
        && /openSurfaceActionId\('bl'\)/.test(commandSource)
        && !/bookingChatReceipt|plan\.reference|params\.reference|params\.bookingId/.test(commandSource));

    assert('⛔ it re-reads the product and refuses to invite on any rung but bargain or book',
        /readProductDetail\(plan\.productId, language\)/.test(commandSource)
        && /verb !== 'bargain' && verb !== 'book'/.test(commandSource)
        && !/params\.verb|params\.outcome === 'asked'/.test(commandSource));

    /**
     * ⚠ The DECISION must stay in a module this suite can import. The handler reaches a
     * controller that touches orders and payments, which never returns under bare ts-node — so a
     * plan that drifted back into the handler would take every assertion above with it, silently.
     */
    const planSource = stripComments(readSrc('commands/flow-completion-plan.ts'));
    assert('⛔ the completion PLAN is pure — no store, no service, no controller, no copy table',
        /export function planCompletion/.test(planSource)
        && !/inAppSurfaceStore|botChrome|addedToCartActions|Service|controller/.test(planSource));
    assert('⚠ the plan imports nothing but types and the outcome vocabulary',
        [...planSource.matchAll(/^import\s+(type\s+)?[^;]*?from\s+'([^']+)';/gm)]
            .every((m) => m[1] !== undefined || /flow-outcome$/.test(m[2])));

    /**
     * ⛔ The new session's identity comes from the live listing session, never the payload.
     * The payload is caller-supplied.
     */
    assert('⛔ the minted session\'s owner, customer and conversation come from the session',
        /owner:\s*listing\.owner/.test(commandSource)
        && /customerId:\s*listing\.customerId/.test(commandSource)
        && /externalId:\s*listing\.externalId/.test(commandSource)
        && !/payload\.(owner|customerId|externalId|userId)/.test(commandSource));
    assert('⚠ the sender comes from the command CONTEXT, never the payload',
        /context\?\.wa_phone_id/.test(commandSource) && !/payload\.wa_phone_id/.test(commandSource));

    const registry = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'modules', 'commands', 'index.ts'),
        'utf8',
    );
    assert('⛔ flow_complete is REGISTERED on the bus — unregistered means silently dropped',
        /FlowCompleteCommand\.command_name/.test(stripComments(registry))
        && /flows\/commands\/flow-complete\.command/.test(registry));

    // ═════════════════════════════════════════════════════════════════════════
    section('10 · The screen adapters — reshaping the shared reads, never re-deriving them');

    const copy: FlowCopy = {
        listingHeading: 'Browse', listingEmpty: 'Nothing here yet.', outOfStock: 'Out of stock',
        detailChoose: 'Choose', checkoutTotal: 'Total', checkoutAddress: 'Deliver to', checkoutDigitalDelivery: 'Sent to your account',
        checkoutNoAddress: 'No address.', checkoutPay: 'Pay now', checkoutWatchChat: 'Watch the chat.',
        expired: 'No longer available.', failed: 'Something went wrong.',
        flowOpenProduct: 'View product', flowBackToChat: 'Back to chat',
        flowPhoneLabel: 'Mobile money number', flowPhoneHint: 'Include the country code.',
        bookingOpen: 'Open', bookingSeeTimes: 'See times',
    };

    const listingProduct = (over: Partial<ListingPage['products'][number]> = {}): ListingPage['products'][number] => ({
        productId: 'p1', variantId: 'v1', title: 'Kettle', priceText: '12 500 FCFA', storeName: 'Chez Awa',
        inStock: true, imageSourceUrl: null, image: null, ...over,
    });

    assert('⚠ the listing asks the read for 20 — Meta\'s radio cap, not the read\'s default of 24',
        FLOW_LISTING_PAGE_SIZE === 20);

    const empty = toListingScreen({ heading: null, products: [], page: 1, hasMore: false }, copy);
    assert('an empty listing is the notice screen with the listing-empty sentence, not an empty form',
        empty.screen === NOTICE_SCREEN && empty.data.message === copy.listingEmpty
        && empty.data.closeLabel === copy.flowBackToChat);

    const many = toListingScreen({
        heading: null, page: 1, hasMore: true,
        products: Array.from({ length: 24 }, (_, i) => listingProduct({ productId: `p${i}` })),
    }, copy);
    const rows = many.data.products as Array<Record<string, unknown>>;
    assert('⛔ never more than 20 rows, even when the read hands back more',
        many.screen === 'PRODUCTS' && rows.length === 20);
    assert('the heading falls back to the localised copy when the read has none',
        many.data.heading === copy.listingHeading && many.data.openLabel === copy.flowOpenProduct);

    const shaped = toListingScreen({
        heading: 'Kettles', page: 1, hasMore: false,
        products: [
            listingProduct({ productId: 'a', title: 'An electric kettle with a very long vendor title indeed' }),
            listingProduct({ productId: 'b', variantId: null }),
            listingProduct({ productId: 'c', inStock: false }),
        ],
    }, copy);
    const [longRow, mutedRow, soldRow] = shaped.data.products as Array<Record<string, string | boolean>>;
    assert('⚠ a title is cut to Meta\'s 30 and repeated whole in the description',
        [...String(longRow.title)].length <= 30 && String(longRow.title).endsWith('…')
        && String(longRow.description).startsWith('An electric kettle with a very long vendor title indeed'));
    assert('⛔ a product with nothing sellable is a DISABLED row — the muted Telegram card',
        mutedRow.enabled === false && longRow.enabled === true);
    assert('⚠ out of stock is SAID, but the row still opens — its detail says what is sold out',
        soldRow.enabled === true && String(soldRow.description).includes(copy.outOfStock));
    assert('the price and store come through verbatim — nothing here formats money',
        String(longRow.description).includes('12 500 FCFA') && String(longRow.description).includes('Chez Awa'));

    const detailView = (over: Partial<ProductDetailView> = {}): ProductDetailView => ({
        productId: 'p1', title: 'Kettle', storeName: 'Chez Awa', storeCity: 'Douala',
        description: 'Steel.', imageSourceUrl: null, image: null,
        options: [{ name: 'Size', values: [{ id: 'x', label: 'M' }] }],
        variants: [
            { variantId: 'v1', label: 'Size: M', valueIds: ['x'], priceText: '12 500 FCFA', inStock: true,
              affordance: { verb: 'add', label: 'Add to cart', enabled: true } },
            { variantId: 'v2', label: 'Size: L', valueIds: ['y'], priceText: '12 500 FCFA', inStock: false,
              affordance: { verb: 'add', label: 'Add to cart', enabled: false } },
        ],
        defaultVariantId: 'v1',
        ...over,
    });

    const plain = toDetailScreen(detailView(), copy, null, 'openref-0001');
    const withImage = toDetailScreen(detailView(), copy, 'aGVsbG8=', 'openref-0001');
    assert('no picture → the no-image screen; a picture → the image screen with the bytes',
        plain.screen === 'PRODUCT_NO_IMAGE' && !('image' in plain.data)
        && withImage.screen === 'PRODUCT' && withImage.data.image === 'aGVsbG8=');
    assert('⚠ both product screens carry this open\'s reference, for the footer to send back',
        plain.data.openRef === 'openref-0001' && withImage.data.openRef === 'openref-0001');

    const detailRows = plain.data.variants as Array<Record<string, unknown>>;
    assert('⛔ a sold-out variant is SHOWN disabled — matching Telegram, not omitted',
        detailRows.length === 2 && detailRows[1].enabled === false
        && String(detailRows[1].description).includes(copy.outOfStock));
    assert('the button label is the purchase affordance, verbatim',
        plain.data.actionLabel === 'Add to cart' && plain.data.chooseLabel === copy.detailChoose);
    assert('⚠ city only on the store line — a ship-from address never reaches the form',
        plain.data.storeLine === 'Chez Awa · Douala');

    const nothingBuyable = toDetailScreen(detailView({
        variants: detailView().variants.map((v) => ({ ...v, affordance: { ...v.affordance, enabled: false } })),
    }), copy, null, 'openref-0001');
    assert('⚠ nothing buyable → the notice screen, never a required drop-down nobody can fill',
        nothingBuyable.screen === NOTICE_SCREEN && nothingBuyable.data.message === copy.outOfStock);

    const detailSource = stripComments(readSrc('screens/detail.adapter.ts'));
    /**
     * ⚠ The flattened list needs no positional matching. Reading `valueIds` or `options` would
     * reintroduce the misalignment defect `pd.html` warns about.
     */
    assert('⛔ the detail adapter never reads valueIds or options — no positional matching',
        !/\.valueIds\b/.test(detailSource) && !/\.options\b/.test(detailSource));

    /**
     * ⛔ Scan EVERYTHING that decides a screen, not only the entry file. backend-fc found three
     * "must not" assertions passing only because the logic they guarded had moved to a file
     * they didn't scan.
     */
    const adapterSources = ['screens/listing.adapter.ts', 'screens/detail.adapter.ts', 'screens/flow-text.ts']
        .map((f) => stripComments(readSrc(f))).join('\n');
    assert('⛔ no adapter does money maths or picks a purchase verb',
        !/toFixed|parseFloat|Intl\.NumberFormat|formatBotPrice/.test(adapterSources)
        && !/'bargain'|'add'|'buy'|'book'/.test(adapterSources));

    // ── the picture: a customer-display rule ─────────────────────────────────
    const img = (access: 'public' | 'authorized' | 'quota_blocked', over = {}) =>
        ({ key: 'products/a.jpg', access, mimeType: 'image/jpeg', size: 120_000, ...over });

    assert('a public product picture may be shown', mayShowImageToCustomer(img('public')));

    /**
     * ⛔ LOAD-BEARING, NOT A SPARE BELT. backend-fc proved against real file records that a
     * picture stored under a private folder reaches this adapter as `access: 'authorized'`,
     * with no URL. Encoding its bytes would go around the missing URL entirely, so this refusal
     * is the only thing between a private file and a customer's screen.
     */
    assert('⛔ an AUTHORIZED (private-folder) file is refused — proven to reach this path',
        !mayShowImageToCustomer(img('authorized')));
    assert('⛔ a QUOTA-BLOCKED file is refused — the platform took it off the shelf',
        !mayShowImageToCustomer(img('quota_blocked')));
    assert('a non-image file is refused', !mayShowImageToCustomer(img('public', { mimeType: 'application/pdf' })));
    assert('an oversized original is refused before a byte is read',
        !mayShowImageToCustomer(img('public', { size: FLOW_IMAGE_MAX_SOURCE_BYTES + 1 })));
    assert('no picture at all is simply no picture', !mayShowImageToCustomer(null));

    const loaderSource = stripComments(readSrc('screens/image-bytes.ts'));
    assert('⛔ the loader checks the policy BEFORE it opens storage',
        loaderSource.indexOf('mayShowImageToCustomer(') > -1
        && loaderSource.indexOf('mayShowImageToCustomer(') < loaderSource.indexOf('getStorageProvider('));
    assert('⚠ bytes come from storage by key, never an HTTP fetch of our own public URL',
        /getDownloadStream\(/.test(loaderSource) && !/\bfetch\(|axios|imageSourceUrl/.test(loaderSource));

    // ── text fitting ─────────────────────────────────────────────────────────
    assert('fitText leaves short text alone', fitText('Kettle', 30) === 'Kettle');
    const emoji = fitText('🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥', 5);
    assert('⚠ fitText counts code points — it never splits an emoji into a lone surrogate',
        [...emoji].length === 5 && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(emoji));
    assert('the caps are Meta\'s numbers', FLOW_CAPS.optionTitle === 30 && FLOW_CAPS.radioOptions === 20
        && FLOW_CAPS.dropdownOptions === 200 && FLOW_CAPS.footerLabel === 35 && FLOW_CAPS.heading === 80);

    // ═════════════════════════════════════════════════════════════════════════
    section('11 · Command replies that open a screen — command-reply.ts, which no suite covered');

    const savedBase = process.env.BOT_MINIAPP_BASE_URL;
    const savedStore = process.env.STOREFRONT_URL;
    try {
        process.env.BOT_MINIAPP_BASE_URL = 'https://shop.example.com';
        const opened = screenReplyIntent({
            kind: 'pd', handle: 'ia_h', language: 'fr', labelKey: 'openButton', fallbackPath: null,
        });
        assert('with a screen origin → an in-app button carrying the handle and the language',
            opened?.kind === 'inapp'
            && (opened as { url: string }).url.includes('/pd/ia_h')
            && (opened as { url: string }).url.includes('lang=fr'));
        assert('⚠ its label and default sentence are the chat\'s own copy, in the customer\'s language',
            opened?.kind === 'inapp'
            && (opened as { label: string }).label === botChrome('openButton', 'fr')
            && (opened as { text: string }).text === botChrome('browseProductsPrompt', 'fr'));

        process.env.BOT_MINIAPP_BASE_URL = '';
        process.env.STOREFRONT_URL = 'https://shop.example.com';
        const fallback = screenReplyIntent({
            kind: 'pl', handle: 'ia_h', language: 'en', labelKey: 'browseAllButton', fallbackPath: '/shop',
        });
        assert('no screen origin, a fallback path → a plain storefront link',
            fallback?.kind === 'link' && (fallback as { url: string }).url.includes('/shop'));
        assert('⚠ no screen origin and no fallback → nothing, never a dead button',
            screenReplyIntent({ kind: 'pd', handle: 'ia_h', language: 'en', labelKey: 'openButton', fallbackPath: null }) === null);

        process.env.BOT_MINIAPP_BASE_URL = 'https://shop.example.com';
        const viaCommand = commandReplyIntent({
            message: '',
            language: 'es',
            screen: { kind: 'pd', handle: 'ia_h', labelKey: 'openButton', fallbackPath: null },
        });
        /**
         * The gap this closes: a command used to be able to answer only with words or a contact
         * keyboard, so a listing choice got "got that" and nothing to tap.
         */
        assert('⛔ a command result with a screen and NO message still opens the screen',
            viaCommand?.kind === 'inapp');
        assert('⚠ the command\'s own language is used when the caller has none (webhooks pass null)',
            viaCommand?.kind === 'inapp' && (viaCommand as { url: string }).url.includes('lang=es'));
        assert('⚠ a language the CALLER supplies wins over the command\'s',
            (commandReplyIntent({ language: 'es', screen: { kind: 'pd', handle: 'ia_h', labelKey: 'openButton', fallbackPath: null } }, 'ar') as { url: string } | null)
                ?.url.includes('lang=ar') === true);

        process.env.BOT_MINIAPP_BASE_URL = '';
        const unreachable = commandReplyIntent({
            message: 'Hello',
            screen: { kind: 'pd', handle: 'ia_h', labelKey: 'openButton', fallbackPath: null },
        });
        assert('⚠ a screen that can\'t be offered falls back to the message — words, not silence',
            unreachable?.kind === 'text' && (unreachable as { text: string }).text === 'Hello');
        assert('the existing contract is unchanged: no message and no screen → nothing',
            commandReplyIntent({ message: '' }) === null);

        /**
         * ⛔ The buttons a finished WhatsApp form needs. They ride the `text` intent rather than a
         * `choice`: the customer may still type instead, which on this surface they often do.
         */
        const withButtons = commandReplyIntent({
            message: 'Ajouté à votre panier.',
            actions: [{ id: 'cart:view', label: 'Voir le panier' }, { id: 'open:co', label: 'Commander' }],
        });
        assert('⛔ a command result\'s buttons reach the reply, beside its words',
            withButtons?.kind === 'text'
            && (withButtons as { actions?: readonly unknown[] }).actions?.length === 2);
        assert('⚠ no buttons means no empty list on the intent — the shape a channel renders is unchanged',
            !('actions' in (commandReplyIntent({ message: 'Hello' }) ?? {}))
            && !('actions' in (commandReplyIntent({ message: 'Hello', actions: [] }) ?? {})));
    } finally {
        if (savedBase === undefined) delete process.env.BOT_MINIAPP_BASE_URL;
        else process.env.BOT_MINIAPP_BASE_URL = savedBase;
        if (savedStore === undefined) delete process.env.STOREFRONT_URL;
        else process.env.STOREFRONT_URL = savedStore;
    }

    // ═════════════════════════════════════════════════════════════════════════
    section('12 · The checkout adapter — the four protections, and failure after the spend');

    const view = (over: Partial<CheckoutView> = {}): CheckoutView => ({
        lines: [{ title: 'Kettle', variantLabel: 'Size: M', quantity: 2, lineTotalText: '25 000 FCFA', imageUrl: null }],
        totalText: '25 000 FCFA',
        address: { text: 'Akwa, Douala' },
        payment: { phoneMasked: '+2376••••4417' },
        language: 'en',
        ...over,
    });

    const reviewAnswer = toCheckoutScreen(view(), copy);
    assert('a basket with an address → the REVIEW screen',
        reviewAnswer.screen === 'REVIEW');
    assert('⛔ the address is shown VERBATIM — already coarse upstream, never widened here',
        reviewAnswer.data.addressText === 'Akwa, Douala');
    assert('⛔ the payer number is shown VERBATIM — never re-masked a second way',
        reviewAnswer.data.phoneMasked === '+2376••••4417');
    assert('⚠ the basket is one string, one bullet per line, figures verbatim',
        typeof reviewAnswer.data.lines === 'string'
        && String(reviewAnswer.data.lines).startsWith('• Kettle (Size: M)')
        && String(reviewAnswer.data.lines).includes('25 000 FCFA'));
    assert('a digital basket swaps the address label, as the page does',
        toCheckoutScreen(view({ address: { text: 'you@example.com', digital: true } }), copy)
            .data.addressLabel === copy.checkoutDigitalDelivery
        && reviewAnswer.data.addressLabel === copy.checkoutAddress);

    const noAddress = toCheckoutScreen(view({ address: null }), copy);
    assert('⛔ no saved address → the notice screen, which has no pay action at all',
        noAddress.screen === NOTICE_SCREEN && noAddress.data.message === copy.checkoutNoAddress);

    assert('⛔ no number on file + an empty field → refused BEFORE the handle is spent',
        needsTypedNumber(view({ payment: { phoneMasked: null } }), '')
        && needsTypedNumber(view({ payment: { phoneMasked: null } }), '   ')
        && needsTypedNumber(view({ payment: { phoneMasked: null } }), undefined));
    assert('a typed number, or a number on file, goes through',
        !needsTypedNumber(view({ payment: { phoneMasked: null } }), '+237652705926')
        && !needsTypedNumber(view(), ''));

    const err = (statusCode: number, spent: unknown, code = 'X') =>
        Object.assign(new Error('x'), { statusCode, code, category: 'validation', details: spent === undefined ? undefined : { spent } });

    assert('⚠ a typed number that is not a phone (400, spent false) → stay on the screen',
        planCheckoutFailure(err(400, false)).kind === 'stay');
    assert('⚠ a typed number on no recognisable network (422, spent false) → stay',
        planCheckoutFailure(err(422, false, 'PAYMENT_OPERATOR_UNDETERMINED')).kind === 'stay');

    /**
     * ⛔ The same code on the OTHER side of the spend. Deciding on the code would get one of
     * these two wrong.
     */
    assert('⛔ the SAME code with spent true (the account\'s own number) → the chat, never stay',
        planCheckoutFailure(err(422, true, 'PAYMENT_OPERATOR_UNDETERMINED')).kind === 'ask_chat');

    /**
     * ⛔ "Stay unless spent" was the first rule, and it reads a 404 (spent: false, nothing left to
     * spend) as a live screen. Stay is an allowlist.
     */
    assert('⛔ a 404 is spent:false and still NOT stay — the handle is gone → restart',
        planCheckoutFailure(err(404, false)).kind === 'restart');
    assert('a replaced basket → restart, at its old 410 or its new 404',
        planCheckoutFailure(err(410, true)).kind === 'restart' && planCheckoutFailure(err(404, true)).kind === 'restart');

    /**
     * ⚠ The one row keyed on the CODE. No gateway is spent:false, so a retry is honest but
     * futile, and its status is moving 503 → 500, where it would otherwise fall into the last row.
     */
    assert('⚠ no gateway → closes, by CODE, even at its new status 500',
        planCheckoutFailure(err(500, false, 'PAYMENT_GATEWAY_NOT_CONFIGURED')).kind === 'unavailable');
    assert('⚠ no gateway (503, spent false) → closes: a retry can\'t change configuration',
        planCheckoutFailure(err(503, false)).kind === 'unavailable');

    /** ⛔ ABSENT MEANS SPENT. Over HTTP the platform strips `details` from 5xx errors. */
    assert('⛔ a 422 with NO flag → the chat, because absent means spent',
        planCheckoutFailure(err(422, undefined)).kind === 'ask_chat');
    assert('⛔ a 422 with a non-boolean flag → the chat',
        planCheckoutFailure(err(422, 'false')).kind === 'ask_chat');
    assert('⛔ a gateway failure (502) → the chat, never "not placed"',
        planCheckoutFailure(err(502, true)).kind === 'ask_chat');
    assert('⛔ something that isn\'t an AppError at all → the chat',
        planCheckoutFailure(new TypeError('boom')).kind === 'ask_chat'
        && planCheckoutFailure(null).kind === 'ask_chat');

    const checkoutAdapterSource = stripComments(readSrc('screens/checkout.adapter.ts'));
    assert('⛔ the checkout adapter never masks, spends or places anything itself',
        !/maskPhone|maskAddress|\.consume\(|placeCheckout\(|createOrder/.test(checkoutAdapterSource));
    assert('⚠ the stay rule is keyed on an explicit `spent === false`, never a truthiness test',
        /spent === false/.test(checkoutAdapterSource) && !/!\s*e\??\.details\??\.spent/.test(checkoutAdapterSource));

    /** ⛔ ABSENT MEANS SPENT — the one reading both the plan and the endpoint's claim decide on. */
    assert('⛔ handleSurvived is true ONLY for an explicit spent:false',
        handleSurvived(err(400, false))
        && !handleSurvived(err(400, true)) && !handleSurvived(err(400, undefined))
        && !handleSurvived(err(400, 'false')) && !handleSurvived(new TypeError('x')) && !handleSurvived(null));

    // ═════════════════════════════════════════════════════════════════════════
    section('13 · The router — opening a form, every branch driven through fake ports');

    /**
     * ── HOW THIS SECTION WORKS ──────────────────────────────────────────────
     * `flow-screens.ts` takes every dependency as a PORT, because the checkout and purchase cores
     * cannot be imported here (they reach `orders/`/`payments/`, which hang under ts-node). So the
     * router is driven with fakes that behave like the real things in the ways that matter:
     *   - the session store refuses a wrong KIND, as `inAppSurfaceStore.read` does;
     *   - the claim store is `botIdempotencyStore`'s semantics in memory — claim NX, stored answer
     *     replayed, a different fingerprint "reused", release deletes;
     *   - `placeCheckout` DELETES the session it spends, as the real Lua consume does, and refuses
     *     a spent handle with 404 `spent:false`, as `handleGone(false)` does.
     * Section 15 then pins that the production ports ARE the real exports.
     */
    const PID = '66f1a2b3c4d5e6f708192a3b';
    const VID = '66f1a2b3c4d5e6f708192a40';
    const VID2 = '66f1a2b3c4d5e6f708192a41';
    const FORGED_PID = '66f1a2b3c4d5e6f708192aff';
    const owned = {
        owner: 'user-1', customerId: 'cust-1', channel: 'whatsapp' as const,
        externalId: '237652705926', expiresAt: '2999-01-01T00:00:00.000Z',
    };
    const plSession = (language: string | null = 'fr'): InAppSurfaceSession =>
        ({ ...owned, language, kind: 'pl', query: { q: 'kettle', category: null, storeSlug: null, productIds: null } });
    const pdSession = (language: string | null = 'fr'): InAppSurfaceSession =>
        ({ ...owned, language, kind: 'pd', productId: PID });
    const coSession = (language: string | null = 'fr'): InAppSurfaceSession =>
        ({ ...owned, language, kind: 'co', cartId: 'cart-1' });

    const fr = inAppCopy('fr');
    const en = inAppCopy(null);

    type StoredClaim = { state: 'in_progress' | 'done'; fingerprint: string; tool: string; response?: BotIdempotentResponse };

    /** `botIdempotencyStore`, in memory. */
    const memoryClaims = () => {
        const records = new Map<string, StoredClaim>();
        const at = (identity: string, key: string): string => `${identity}|${key}`;
        return {
            records,
            async claim(input: FlowClaim): Promise<BotClaimResult> {
                const existing = records.get(at(input.identity, input.key));
                if (!existing) {
                    records.set(at(input.identity, input.key),
                        { state: 'in_progress', fingerprint: input.fingerprint, tool: input.tool });
                    return { status: 'claimed' };
                }
                if (existing.fingerprint !== input.fingerprint) return { status: 'reused', tool: existing.tool };
                if (existing.state === 'done' && existing.response) return { status: 'replay', response: existing.response };
                return { status: 'in_progress', tool: existing.tool };
            },
            async complete(input: FlowClaim & { response: BotIdempotentResponse }): Promise<void> {
                records.set(at(input.identity, input.key),
                    { state: 'done', fingerprint: input.fingerprint, tool: input.tool, response: input.response });
            },
            async release(identity: string, key: string): Promise<void> {
                records.delete(at(identity, key));
            },
        };
    };

    const listingPageFixture: ListingPage = {
        heading: 'kettle', page: 1, hasMore: false,
        products: [{ productId: PID, variantId: VID, title: 'Kettle', priceText: '12 500 FCFA',
            storeName: 'Chez Awa', inStock: true, imageSourceUrl: null, image: null }],
    };
    const checkoutFixture = (over: Partial<CheckoutView> = {}): CheckoutView => ({
        lines: [{ title: 'Kettle', variantLabel: null, quantity: 1, lineTotalText: '12 500 FCFA', imageUrl: null }],
        totalText: '12 500 FCFA', address: { text: 'Akwa, Douala' },
        payment: { phoneMasked: '+2376••••4417' }, language: 'fr', ...over,
    });
    const gone = () => createAppError(ERROR_CODES.BOT_PRODUCT_LIST_EXPIRED, 404, 'gone', { spent: false });
    /** The words `readBookingPicker` carries, so no form holds a booking string. */
    const bookingWords = {
        pickDay: 'Choisissez un jour', pickTime: 'Choisissez une heure',
        confirm: 'Confirmer', listEmpty: 'Aucun créneau.', movingNotice: 'Déplacement de votre rendez-vous',
    };

    /** A router run's world: sessions, fake ports, and a log of what was called. */
    const harness = (
        sessions: Record<string, InAppSurfaceSession>,
        over: Partial<FlowScreenPorts> = {},
    ) => {
        const claims = memoryClaims();
        const calls = {
            listing: [] as Array<{ page?: number; pageSize?: number }>,
            detail: [] as Array<{ productId: string; language: string | null }>,
            purchase: [] as PurchaseContext[],
            place: [] as Array<{ handle: string; phone: unknown }>,
            extended: [] as string[],
            reported: [] as string[],
            released: [] as string[],
            completed: [] as string[],
            claimedWith: [] as FlowClaim[],
            sequence: [] as string[],
            picker: [] as Array<{ handle: string; date: string | null }>,
            confirmed: [] as Array<{ handle: string; slotId: string }>,
            bookingList: [] as string[],
            sleeps: 0,
        };
        let refs = 0;
        const ports: FlowScreenPorts = {
            readSession: async (kind, handle) => {
                const s = sessions[handle];
                return (s && s.kind === kind ? s : null) as never;
            },
            extendSession: async (kind, handle) => { calls.extended.push(`${kind}:${handle}`); return true; },
            readListingPage: async (_query, options) => { calls.listing.push(options); return listingPageFixture; },
            readProductDetail: async (productId, language) => {
                calls.detail.push({ productId, language });
                return detailView({ productId });
            },
            loadImage: async () => null,
            readCheckoutView: async (handle) => {
                const s = sessions[handle];
                if (!s || s.kind !== 'co') throw gone();
                return checkoutFixture();
            },
            placeCheckout: async (handle, phone) => {
                calls.sequence.push('place');
                calls.place.push({ handle, phone });
                const s = sessions[handle];
                if (!s || s.kind !== 'co') throw gone();
                delete sessions[handle]; // ⚠ the consume
                return { orderCount: 1, transactionId: 'tx-1', status: 'pending' as CheckoutPlaced['status'] };
            },
            /**
             * The booking core, faked at its own boundary: `readBookingPicker` resolves the `bk`
             * session ITSELF and carries the screens' words, and `confirmBooking` CONSUMES the
             * handle — both reproduced here, because the router's behaviour depends on exactly
             * those two properties.
             */
            readBookingPicker: async (bookingHandle, input) => {
                calls.picker.push({ handle: bookingHandle, date: input?.date ?? null });
                const held = sessions[bookingHandle];
                if (!held || held.kind !== 'bk') throw gone();
                return input?.date
                    ? {
                        moving: null, copy: bookingWords, timezone: 'Africa/Douala',
                        date: input.date, label: 'Tuesday 22 September',
                        slots: [
                            /** A capacity service: the read words the count. */
                            { slotId: 'slot_opaque_1', label: '14:00 – 15:00', description: '2 places restantes' },
                            /** ⚠ A one-person appointment: null, meaning "not a class". */
                            { slotId: 'slot_opaque_2', label: '15:00 – 16:00', description: null },
                        ],
                    }
                    : { moving: (held as { bookingId?: string | null }).bookingId ?? null, copy: bookingWords, timezone: 'Africa/Douala', days: [{ date: '2026-09-22', label: 'Tue 22 Sep', description: '6 times free' }] };
            },
            confirmBooking: async (bookingHandle, input) => {
                calls.sequence.push('confirm');
                calls.confirmed.push({ handle: bookingHandle, slotId: input.slotId });
                const held = sessions[bookingHandle];
                if (!held || held.kind !== 'bk') throw gone();
                delete sessions[bookingHandle]; // ⚠ the consume
                return { bookingId: 'bkg-1', productId: PID, moved: false, reference: 'BKG-2026-000123', when: 'Tue 22 Sep 14:00', service: 'Coupe homme', awaitingShop: false };
            },
            readCustomerBookings: async ({ userId }) => {
                calls.bookingList.push(userId);
                return { bookings: [{ bookingId: 'bkg-1', title: 'BKG-2026-000123 · Tue 14:00', description: 'Coupe homme · 5 000 FCFA' }] };
            },
            bookingWords: () => ({ listTitle: 'Vos rendez-vous', listEmpty: 'Aucun rendez-vous.' }),
            bookingReceipt: (confirmed) => `Réservé : ${confirmed.service}, ${confirmed.when}.`,
            executePurchase: async (ctx): Promise<PurchaseResult> => {
                calls.purchase.push(ctx);
                return { verb: 'add', outcome: 'cart', message: 'Ajouté à votre panier.', url: null,
                    productId: ctx.productId, variantId: ctx.variantId, productTitle: 'Kettle' };
            },
            claims: {
                claim: async (input) => { calls.sequence.push('claim'); calls.claimedWith.push(input); return claims.claim(input); },
                complete: async (input) => { calls.completed.push(input.key); return claims.complete(input); },
                release: async (identity, key) => { calls.released.push(key); return claims.release(identity, key); },
            },
            newOpenRef: () => `openref-${String(++refs).padStart(4, '0')}`,
            sleep: async () => { calls.sleeps += 1; },
            reportFailure: (where) => { calls.reported.push(where); },
            ...over,
        };
        return { ports, calls, claims, sessions };
    };

    const request = (
        action: string,
        screen: string | null,
        data: Record<string, unknown>,
        flowToken: string | null,
    ): FlowScreenRequest => ({ kind: 'screen', action, screen, data, flowToken });
    const open = (token: string | null) => request('INIT', null, {}, token);
    const bodyOf = (v: FlowScreenVerdict) => v.body as { screen?: string; data?: Record<string, unknown>; error_msg?: string };

    assert('⛔ no token at all → 427, nothing read',
        (await serveFlowScreen(open(null), harness({}).ports)).status === 427);

    {
        const h = harness({ ia_pl: plSession() });
        const v = await serveFlowScreen(open('ia_pl'), h.ports);
        assert('a listing handle opens the PRODUCTS screen', v.status === 200 && bodyOf(v).screen === 'PRODUCTS');
        const emptyShelf = await serveFlowScreen(open('ia_pl'), harness({ ia_pl: plSession() }, {
            readListingPage: async () => ({ heading: null, page: 1, hasMore: false, products: [] }),
        }).ports);
        assert('⚠ a closing screen where NOTHING happened stamps `notice` — the chat adds nothing',
            bodyOf(emptyShelf).screen === NOTICE_SCREEN && bodyOf(emptyShelf).data?.outcome === 'notice');
        assert('⚠ it asks the shared read for page one of 20 — the radio cap is the caller\'s to pass',
            h.calls.listing.length === 1 && h.calls.listing[0].page === 1 && h.calls.listing[0].pageSize === 20);
        assert('⚠ the words come from the session\'s language — French here',
            bodyOf(v).data?.openLabel === fr.flowOpenProduct);
        assert('opening a listing keeps its session alive, as the Telegram page does',
            JSON.stringify(h.calls.extended) === JSON.stringify(['pl:ia_pl']));
    }

    {
        const h = harness({ ia_pd: pdSession() });
        const v = await serveFlowScreen(open('ia_pd'), h.ports);
        assert('a product handle opens a product screen', v.status === 200 && bodyOf(v).screen === 'PRODUCT_NO_IMAGE');
        assert('⛔ the product read is the SESSION\'s product, in the session\'s language',
            h.calls.detail.length === 1 && h.calls.detail[0].productId === PID && h.calls.detail[0].language === 'fr');
        assert('⚠ each open draws a fresh reference for the footer to send back',
            bodyOf(v).data?.openRef === 'openref-0001');
        const again = await serveFlowScreen(open('ia_pd'), h.ports);
        assert('⚠ … and a second open draws a DIFFERENT one',
            bodyOf(again).data?.openRef === 'openref-0002');
    }

    {
        const h = harness({ ia_co: coSession() });
        const v = await serveFlowScreen(open('ia_co'), h.ports);
        assert('a checkout handle opens the REVIEW screen', v.status === 200 && bodyOf(v).screen === 'REVIEW');
        assert('⛔ opening a checkout NEVER extends it — a checkout credential must not slide',
            h.calls.extended.length === 0);
        assert('⛔ opening a checkout spends nothing', h.calls.place.length === 0);
    }

    {
        const v = await serveFlowScreen(open('ia_unknown'), harness({}).ports);
        assert('an unknown or lapsed handle → 427 with the "ask me again" sentence (English: no session)',
            v.status === 427 && bodyOf(v).error_msg === en.expired);
    }

    {
        const h = harness({ ia_pd: pdSession() }, {
            readProductDetail: async () => { throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404, 'gone'); },
        });
        const v = await serveFlowScreen(open('ia_pd'), h.ports);
        assert('⚠ a product taken off sale → 427, in the SESSION\'s language, and nothing reported',
            v.status === 427 && bodyOf(v).error_msg === fr.expired && h.calls.reported.length === 0);
    }

    {
        const h = harness({ ia_pl: plSession() }, {
            readListingPage: async () => { throw new TypeError('database wobble'); },
        });
        const v = await serveFlowScreen(open('ia_pl'), h.ports);
        assert('⚠ an unexpected failure → the form\'s own "something went wrong", in French …',
            v.status === 200 && bodyOf(v).screen === NOTICE_SCREEN && bodyOf(v).data?.message === fr.failed);
        assert('⛔ … and it is REPORTED, never swallowed — the global handler never sees it',
            h.calls.reported.length === 1);
    }

    {
        const h = harness({}, { readSession: async () => { throw new TypeError('redis down'); } });
        const v = await serveFlowScreen(open('ia_x'), h.ports);
        assert('the session store unreachable → "something went wrong" (English: no session) and reported',
            v.status === 200 && bodyOf(v).data?.message === en.failed && h.calls.reported.length === 1);
    }

    {
        const h = harness({ ia_pd: pdSession() }, { loadImage: async () => { throw new TypeError('sharp'); } });
        const v = await serveFlowScreen(open('ia_pd'), h.ports);
        assert('⚠ a picture that fails costs the picture, never the product screen',
            v.status === 200 && bodyOf(v).screen === 'PRODUCT_NO_IMAGE');
    }

    assert('an unknown action → 427',
        (await serveFlowScreen(request('SOMETHING', null, {}, 'ia_pl'), harness({ ia_pl: plSession() }).ports)).status === 427);
    assert('⚠ an exchange from a screen no form sends it from (the listing CLOSES) → 427',
        (await serveFlowScreen(request('data_exchange', 'PRODUCTS', {}, 'ia_pl'), harness({ ia_pl: plSession() }).ports)).status === 427);

    // ═════════════════════════════════════════════════════════════════════════
    section('14 · The product form\'s button — the purchase core, guarded per open');

    const press = (data: Record<string, unknown>, screen = 'PRODUCT_NO_IMAGE', token = 'ia_pd') =>
        request('data_exchange', screen, data, token);

    {
        const h = harness({ ia_pd: pdSession() });
        const v = await serveFlowScreen(press({ variantId: VID, openRef: 'openref-0001', productId: FORGED_PID }), h.ports);
        assert('a press runs the shared purchase core once and shows its message on the closing screen',
            h.calls.purchase.length === 1 && bodyOf(v).screen === NOTICE_SCREEN
            && bodyOf(v).data?.message === 'Ajouté à votre panier.');
        /**
         * ⛔ The stamp the CHAT reads when the form closes. Without it the basket changes and the
         * WhatsApp thread says nothing — the customer is left with no confirmation and no door.
         */
        assert('⛔ an add stamps the closing screen `added`, so the chat can finish the turn',
            bodyOf(v).data?.outcome === 'added');
        const ctx = h.calls.purchase[0];
        assert('⛔ the PRODUCT comes from the session — a productId in the form is ignored',
            ctx.productId === PID);
        assert('⛔ who is buying comes from the session, never the form',
            ctx.userId === owned.owner && ctx.customerId === owned.customerId
            && ctx.externalId === owned.externalId && ctx.channel === 'whatsapp' && ctx.language === 'fr');
        assert('⚠ the claim is scoped to the session\'s owner, keyed on handle + open + variant',
            h.calls.claimedWith[0].identity === owned.owner
            && h.calls.claimedWith[0].key === `wa-flow:pd:ia_pd:openref-0001:${VID}`);
    }

    {
        /** ⭐ Coordinator's pin (2): a double submit in ONE open is one add. */
        const h = harness({ ia_pd: pdSession() });
        const first = await serveFlowScreen(press({ variantId: VID, openRef: 'openref-0001' }), h.ports);
        const second = await serveFlowScreen(press({ variantId: VID, openRef: 'openref-0001' }), h.ports);
        assert('⛔ a double submit in ONE open → ONE add, the second answer replayed identically',
            h.calls.purchase.length === 1 && JSON.stringify(first) === JSON.stringify(second));

        /** ⭐ …and the same variant in a LATER open is a new add, as two Telegram presses are. */
        await serveFlowScreen(press({ variantId: VID, openRef: 'openref-0002' }), h.ports);
        assert('⛔ the same variant in a LATER open → a SECOND add, as on the Telegram page',
            h.calls.purchase.length === 2);

        await serveFlowScreen(press({ variantId: VID2, openRef: 'openref-0001' }), h.ports);
        assert('a different variant in the same open is its own add', h.calls.purchase.length === 3);
    }

    {
        const h = harness({ ia_pd: pdSession() }, {
            executePurchase: async (ctx) => {
                h.calls.purchase.push(ctx);
                return { verb: 'buy', outcome: 'checkout', message: 'Ajouté. Dites « commander ».',
                    url: 'https://screens.example.com/s/co/ia_secret', productId: ctx.productId,
                    variantId: ctx.variantId, productTitle: 'Kettle' };
            },
        });
        const v = await serveFlowScreen(press({ variantId: VID, openRef: 'openref-0001' }), h.ports);
        assert('⚠ a checkout outcome shows its message and NEVER its url — a Telegram screen address',
            bodyOf(v).data?.message === 'Ajouté. Dites « commander ».' && !JSON.stringify(v).includes('ia_secret'));
        assert('⚠ … and it stamps `added` too: the basket changed, whichever rung it was',
            bodyOf(v).data?.outcome === 'added');
    }

    {
        /**
         * ⛔ The two rungs that WRITE NOTHING. A bargain or a booking is a QUESTION the customer
         * answers by typing — and the agent only wakes on their next message. On WhatsApp the
         * question is visible solely on a screen that closes, so the chat must carry it.
         */
        const h = harness({ ia_pd: pdSession() }, {
            executePurchase: async (ctx) => {
                h.calls.purchase.push(ctx);
                return { verb: 'bargain', outcome: 'chat', message: 'Kettle\n\nFaites-moi une offre…',
                    url: null, productId: ctx.productId, variantId: ctx.variantId, productTitle: 'Kettle' };
            },
        });
        const v = await serveFlowScreen(press({ variantId: VID, openRef: 'openref-0001' }), h.ports);
        assert('⛔ a bargain or booking stamps `asked` — the chat has a question to carry',
            bodyOf(v).data?.outcome === 'asked' && bodyOf(v).data?.message === 'Kettle\n\nFaites-moi une offre…');
    }

    {
        let stock = false;
        const refusal = () => createAppError(ERROR_CODES.CATALOG_VARIANT_INSUFFICIENT_STOCK, 422, 'cannot');
        const h = harness({ ia_pd: pdSession() }, {
            executePurchase: async (ctx) => {
                h.calls.purchase.push(ctx);
                if (!stock) throw refusal();
                return { verb: 'add', outcome: 'cart', message: 'ok', url: null,
                    productId: ctx.productId, variantId: ctx.variantId, productTitle: 'Kettle' };
            },
        });
        const v = await serveFlowScreen(press({ variantId: VID, openRef: 'openref-0001' }), h.ports);
        assert('⚠ a refusal the customer can act on keeps them ON THE FORM, freshly redrawn …',
            v.status === 200 && bodyOf(v).screen === 'PRODUCT_NO_IMAGE' && h.calls.detail.length === 1);
        assert('⚠ … with the refusal as Meta\'s snackbar, from the shared customer-copy table, in French',
            bodyOf(v).data?.error_message === customerMessageFor(refusal().code, refusal().category, 'fr'));
        assert('⚠ … and the SAME open reference, because it is still the same open',
            bodyOf(v).data?.openRef === 'openref-0001');
        stock = true;
        await serveFlowScreen(press({ variantId: VID, openRef: 'openref-0001' }), h.ports);
        assert('⛔ a refusal RELEASES the claim — pressing again once stock returns runs again',
            h.calls.purchase.length === 2);
    }

    {
        const h = harness({ ia_pd: pdSession() }, {
            executePurchase: async () => { throw createAppError(ERROR_CODES.CATALOG_VARIANT_INSUFFICIENT_STOCK, 422, 'x'); },
        });
        const v = await serveFlowScreen(press({ variantId: VID, openRef: 'openref-0001' }, 'PRODUCT'), h.ports);
        assert('⚠ a redraw that would change screen (PRODUCT → no-image is no declared route) → the notice, with the refusal',
            bodyOf(v).screen === NOTICE_SCREEN
            && bodyOf(v).data?.message === customerMessageFor(ERROR_CODES.CATALOG_VARIANT_INSUFFICIENT_STOCK, 'business_rule', 'fr'));
    }

    {
        const h = harness({ ia_pd: pdSession() }, {
            executePurchase: async () => { throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404, 'gone'); },
        });
        const v = await serveFlowScreen(press({ variantId: VID, openRef: 'openref-0001' }), h.ports);
        assert('a product gone by the time of the press → 427, in French',
            v.status === 427 && bodyOf(v).error_msg === fr.expired);
    }

    {
        const h = harness({ ia_pd: pdSession() }, { executePurchase: async () => { throw new TypeError('boom'); } });
        const v = await serveFlowScreen(press({ variantId: VID, openRef: 'openref-0001' }), h.ports);
        assert('⚠ an unexpected failure → "something went wrong", reported, claim released',
            bodyOf(v).data?.message === fr.failed && h.calls.reported.length === 1 && h.calls.released.length === 1);
    }

    {
        const h = harness({ ia_pd: pdSession() });
        await serveFlowScreen(press({ openRef: 'openref-0001' }), h.ports);
        await serveFlowScreen(press({ variantId: VID }), h.ports);
        await serveFlowScreen(press({ variantId: 'not-an-id', openRef: 'openref-0001' }), h.ports);
        assert('⛔ no variant, no open reference or a malformed id → nothing bought, never a default variant',
            h.calls.purchase.length === 0 && h.calls.claimedWith.length === 0);
    }

    {
        const h = harness({ ia_co: coSession() });
        const v = await serveFlowScreen(press({ variantId: VID, openRef: 'openref-0001' }, 'PRODUCT_NO_IMAGE', 'ia_co'), h.ports);
        assert('⛔ a CHECKOUT handle submitted to the product form reads as absent → 427, nothing bought',
            v.status === 427 && h.calls.purchase.length === 0);
    }

    {
        const h = harness({ ia_pd: pdSession() });
        const busy = await h.claims.claim({
            identity: owned.owner, key: `wa-flow:pd:ia_pd:openref-0001:${VID}`,
            fingerprint: `pd:${PID}:${VID}`, tool: 'x',
        });
        const v = await serveFlowScreen(press({ variantId: VID, openRef: 'openref-0001' }), h.ports);
        assert('⚠ an identical press still running → wait, then "still working on it" — never a second add',
            busy.status === 'claimed' && h.calls.purchase.length === 0 && h.calls.sleeps === CLAIM_WAITS
            && bodyOf(v).data?.message === customerMessageFor(ERROR_CODES.BOT_IDEMPOTENCY_IN_PROGRESS, 'conflict', 'fr'));
    }

    {
        const h = harness({ ia_pd: pdSession() });
        const stored: FlowScreenVerdict = { status: 200, body: { screen: NOTICE_SCREEN, data: { message: 'first', closeLabel: 'x' } } };
        const key = `wa-flow:pd:ia_pd:openref-0001:${VID}`;
        await h.claims.claim({ identity: owned.owner, key, fingerprint: `pd:${PID}:${VID}`, tool: 'x' });
        h.ports.sleep = async () => {
            h.calls.sleeps += 1;
            if (h.calls.sleeps === 2) {
                await h.claims.complete({ identity: owned.owner, key, fingerprint: `pd:${PID}:${VID}`, tool: 'x', response: stored });
            }
        };
        const v = await serveFlowScreen(press({ variantId: VID, openRef: 'openref-0001' }), h.ports);
        assert('⚠ … and if the first press finishes during the wait, ITS answer is replayed',
            JSON.stringify(v) === JSON.stringify(stored) && h.calls.purchase.length === 0);
    }

    {
        const h = harness({ ia_pd: pdSession() }, {
            claims: {
                claim: async () => { throw new TypeError('redis down'); },
                complete: async () => undefined,
                release: async () => undefined,
            },
        });
        const v = await serveFlowScreen(press({ variantId: VID, openRef: 'openref-0001' }), h.ports);
        assert('⛔ the claim store unreachable FAILS CLOSED — nothing bought without the guard',
            h.calls.purchase.length === 0
            && bodyOf(v).data?.message === customerMessageFor(ERROR_CODES.BOT_IDEMPOTENCY_STORE_UNAVAILABLE, 'external_service', 'fr')
            && h.calls.reported.length === 1);
    }

    // ═════════════════════════════════════════════════════════════════════════
    section('15 · The checkout form\'s Pay — never a second order, and a retry is told the truth');

    const pay = (phone: unknown, token = 'ia_co') => request('data_exchange', 'REVIEW', { phone }, token);

    {
        const h = harness({ ia_co: coSession() });
        const first = await serveFlowScreen(pay(''), h.ports);
        assert('a Pay press places once and says "approve it on your phone, I will tell you in the chat"',
            h.calls.place.length === 1 && bodyOf(first).screen === NOTICE_SCREEN
            && bodyOf(first).data?.message === fr.checkoutWatchChat);
        assert('⚠ it stamps `placed` — true, and the chat stays quiet on it by design',
            bodyOf(first).data?.outcome === 'placed');

        /** ⭐ Coordinator's pin (1): the claim is taken BEFORE the handle is consumed. */
        assert('⭐ the claim is taken BEFORE the handle is consumed',
            h.calls.sequence.indexOf('claim') > -1 && h.calls.sequence.indexOf('claim') < h.calls.sequence.indexOf('place'));

        const retry = await serveFlowScreen(pay(''), h.ports);
        assert('⛔ a retry after a Pay that went through REPLAYS "approve it on your phone" …',
            JSON.stringify(retry) === JSON.stringify(first));
        assert('⛔ … and never re-executes: still exactly one placement',
            h.calls.place.length === 1);
        assert('⛔ … and is never told "no longer available, ask me again" — the second-order trap',
            retry.status === 200 && bodyOf(retry).error_msg === undefined);
    }

    {
        /** ⭐ Pin (1): a failure after the spend is replayed too — never re-executed. */
        const h = harness({ ia_co: coSession() }, {
            placeCheckout: async (handle, phone) => {
                h.calls.sequence.push('place');
                h.calls.place.push({ handle, phone });
                delete h.sessions[handle];
                throw createAppError(ERROR_CODES.INTERNAL_SERVER_ERROR, 502, 'gateway said no', { spent: true });
            },
        });
        const first = await serveFlowScreen(pay(''), h.ports);
        const retry = await serveFlowScreen(pay(''), h.ports);
        assert('⛔ a failure AFTER the spend → "look in the chat" (never "approve on your phone") …',
            bodyOf(first).data?.message === fr.failed && bodyOf(first).data?.message !== fr.checkoutWatchChat);
        assert('⭐ … REPLAYED to a retry, and the core runs exactly once',
            JSON.stringify(retry) === JSON.stringify(first) && h.calls.place.length === 1);
        assert('… and it is reported', h.calls.reported.length === 1);
    }

    {
        /** ⛔ Absent means spent: a failure with no flag is stored like any post-spend failure. */
        const h = harness({ ia_co: coSession() }, {
            placeCheckout: async (handle, phone) => {
                h.calls.place.push({ handle, phone });
                delete h.sessions[handle];
                throw new TypeError('socket hang up');
            },
        });
        await serveFlowScreen(pay(''), h.ports);
        const retry = await serveFlowScreen(pay(''), h.ports);
        assert('⛔ a failure with NO spent flag is treated as spent — replayed, never re-run',
            h.calls.place.length === 1 && bodyOf(retry).data?.message === fr.failed);
    }

    {
        /**
         * The one refusal that is RELEASED: it provably happened before the spend. Storing it would
         * replay "fix your number" at a customer who has fixed it — and releasing it cannot cost a
         * second order, because nothing was placed and the consume still guards the handle.
         */
        const h = harness({ ia_co: coSession() }, {
            placeCheckout: async (handle, phone) => {
                h.calls.place.push({ handle, phone });
                if (phone === '12') {
                    throw createAppError(ERROR_CODES.VALIDATION_ERROR, 400, 'bad', { spent: false, field: 'phone' });
                }
                delete h.sessions[handle];
                return { orderCount: 1, transactionId: 'tx-1', status: 'pending' as CheckoutPlaced['status'] };
            },
        });
        const bad = await serveFlowScreen(pay('12'), h.ports);
        assert('⚠ a mistyped number keeps them on REVIEW, with the phone field\'s own instruction as the snackbar',
            bodyOf(bad).screen === 'REVIEW' && bodyOf(bad).data?.error_message === fr.flowPhoneHint);
        assert('⚠ … and RELEASES the claim, because the handle survived', h.calls.released.length === 1 && h.calls.completed.length === 0);
        const fixed = await serveFlowScreen(pay('+237652705926'), h.ports);
        assert('⚠ the corrected number then goes through — the same handle, placed once',
            bodyOf(fixed).data?.message === fr.checkoutWatchChat && h.calls.place.length === 2);
    }

    {
        const h = harness({ ia_co: coSession() }, {
            readCheckoutView: async () => checkoutFixture({ payment: { phoneMasked: null } }),
        });
        const v = await serveFlowScreen(pay('  '), h.ports);
        assert('⛔ no number on file and the field left empty → refused BEFORE the spend: nothing placed',
            h.calls.place.length === 0 && h.calls.released.length === 1);
        assert('… on REVIEW, with the payer-number sentence the chat uses, in French',
            bodyOf(v).screen === 'REVIEW'
            && bodyOf(v).data?.error_message === customerMessageFor(ERROR_CODES.PAYMENT_PAYER_NUMBER_REQUIRED, 'business_rule', 'fr'));
    }

    {
        const h = harness({ ia_co: coSession() }, {
            placeCheckout: async (handle, phone) => {
                h.calls.place.push({ handle, phone });
                throw createAppError(ERROR_CODES.PAYMENT_GATEWAY_NOT_SUPPORTED, 503, 'none', { spent: false });
            },
        });
        const v = await serveFlowScreen(pay(''), h.ports);
        assert('no gateway configured → "look in the chat", reported, and released (nothing was spent)',
            bodyOf(v).data?.message === fr.failed && h.calls.reported.length === 1 && h.calls.released.length === 1);
    }

    {
        const h = harness({ ia_co: coSession() }, {
            placeCheckout: async (handle, phone) => {
                h.calls.place.push({ handle, phone });
                delete h.sessions[handle];
                throw createAppError(ERROR_CODES.BOT_PRODUCT_LIST_EXPIRED, 404, 'replaced', { spent: true });
            },
        });
        const first = await serveFlowScreen(pay(''), h.ports);
        const retry = await serveFlowScreen(pay(''), h.ports);
        assert('a basket replaced under the screen → 427 in French, and the retry replays it',
            first.status === 427 && bodyOf(first).error_msg === fr.expired
            && JSON.stringify(retry) === JSON.stringify(first) && h.calls.place.length === 1);
    }

    {
        const h = harness({ ia_co: coSession() });
        const busy = await h.claims.claim({ identity: CHECKOUT_CLAIM_IDENTITY, key: 'wa-flow:co:ia_co', fingerprint: 'co:place', tool: 'x' });
        const v = await serveFlowScreen(pay(''), h.ports);
        assert('⛔ a Pay press arriving while the first is still running NEVER places — it waits, then says so',
            busy.status === 'claimed' && h.calls.place.length === 0 && h.calls.sleeps === CLAIM_WAITS
            && bodyOf(v).data?.message === customerMessageFor(ERROR_CODES.BOT_IDEMPOTENCY_IN_PROGRESS, 'conflict', 'fr'));
    }

    {
        const h = harness({ ia_pd: pdSession() });
        const v = await serveFlowScreen(pay('', 'ia_pd'), h.ports);
        assert('⛔ a PRODUCT handle submitted to the checkout form → 427, nothing placed, claim released',
            v.status === 427 && h.calls.place.length === 0 && h.calls.released.length === 1);
    }

    {
        const h = harness({ ia_co: coSession() }, {
            claims: {
                claim: async () => { throw new TypeError('redis down'); },
                complete: async () => undefined,
                release: async () => undefined,
            },
        });
        await serveFlowScreen(pay(''), h.ports);
        assert('⛔ the claim store unreachable → nothing placed (fails closed)', h.calls.place.length === 0);
    }

    {
        const h = harness({});
        await h.claims.claim({ identity: CHECKOUT_CLAIM_IDENTITY, key: 'wa-flow:co:ia_gone', fingerprint: 'co:place', tool: 'x' });
        await h.claims.complete({ identity: CHECKOUT_CLAIM_IDENTITY, key: 'wa-flow:co:ia_gone', fingerprint: 'co:place', tool: 'x',
            response: { status: 200, body: 'not a screen' } });
        const v = await serveFlowScreen(pay('', 'ia_gone'), h.ports);
        assert('a stored answer we cannot read → "look in the chat", reported — never handed to the cipher as-is',
            bodyOf(v).data?.message === en.failed && h.calls.reported.length === 1);
    }

    /**
     * ⭐ Coordinator's pin (1), second half: the stored answer outlives the handle, so a retry
     * inside the handle's life can never find the record gone and fall through to a fresh place.
     * (The 60-second in-flight claim is covered by the consume: a press outliving it finds the
     * handle spent.)
     */
    assert('⭐ a stored checkout answer lives at least as long as the checkout handle (24 h ≥ 10 min)',
        BOT_IDEMPOTENCY_RECORD_TTL_SECONDS >= TTL_SECONDS.co && TTL_SECONDS.co === 600);

    // ═════════════════════════════════════════════════════════════════════════
    section('16 · The booking forms — the day, the times, and one appointment per press');

    const blSession = (language: string | null = 'fr'): InAppSurfaceSession =>
        ({ ...owned, language, kind: 'bl' } as InAppSurfaceSession);
    const bkSession = (over: Record<string, unknown> = {}): InAppSurfaceSession =>
        ({ ...owned, language: 'fr', kind: 'bk', productId: PID, bookingId: null, ...over } as InAppSurfaceSession);

    {
        const h = harness({ ia_bl: blSession() });
        const v = await serveFlowScreen(open('ia_bl'), h.ports);
        assert('a bookings handle opens the list, with rows the read already worded',
            v.status === 200 && bodyOf(v).screen === 'BOOKINGS'
            && (bodyOf(v).data?.bookings as Array<Record<string, string>>)[0].title === 'BKG-2026-000123 · Tue 14:00');
        assert('⛔ the list is read for the SESSION\'s owner, never for anyone the form names',
            JSON.stringify(h.calls.bookingList) === JSON.stringify([owned.owner]));
        assert('⚠ its heading is the shared booking vocabulary, not a second table',
            bodyOf(v).data?.heading === 'Vos rendez-vous');
    }

    {
        const h = harness({ ia_bl: blSession() }, {
            readCustomerBookings: async () => ({ bookings: [] }),
        });
        const v = await serveFlowScreen(open('ia_bl'), h.ports);
        assert('no appointments → the notice screen, in the customer\'s language',
            bodyOf(v).screen === NOTICE_SCREEN && bodyOf(v).data?.message === 'Aucun rendez-vous.');
    }

    {
        const h = harness({ ia_bk: bkSession() });
        const day = await serveFlowScreen(open('ia_bk'), h.ports);
        assert('a booking handle opens the DAY screen, offering only days that have times',
            bodyOf(day).screen === 'DAY'
            && (bodyOf(day).data?.days as Array<Record<string, string>>)[0].id === '2026-09-22');
        assert('⚠ its words come from the READ, so the page and the form cannot differ',
            bodyOf(day).data?.heading === bookingWords.pickDay);

        const times = await serveFlowScreen(
            request('data_exchange', 'DAY', { day: '2026-09-22' }, 'ia_bk'), h.ports);
        assert('choosing a day asks the SAME read for that day, and draws the times',
            bodyOf(times).screen === 'TIMES'
            && h.calls.picker[1].date === '2026-09-22'
            && bodyOf(times).data?.dayLine === 'Tuesday 22 September');
        assert('⛔ choosing a day writes nothing — no claim, no hold, no appointment',
            h.calls.confirmed.length === 0 && h.calls.claimedWith.length === 0);
        /**
         * ⛔ **`null` means "not a class", never "none left".** A one-person appointment has
         * nothing to say under its time, and a transport coalescing that to a number would tell
         * every haircut customer no seats remain — while an empty string would draw a blank line
         * under every row. So the property is absent entirely.
         */
        const rows = bodyOf(times).data?.times as Array<Record<string, unknown>>;
        assert('⚠ a capacity service shows "2 spots left"; a one-person appointment shows NO line',
            rows[0].description === '2 places restantes' && !('description' in rows[1]));
        assert('⚠ a day that is not a day is refused rather than passed to the read',
            bodyOf(await serveFlowScreen(request('data_exchange', 'DAY', { day: 'tomorrow' }, 'ia_bk'), h.ports))
                .screen === NOTICE_SCREEN && h.calls.picker.length === 2);
    }

    {
        /** ⛔ The press that makes the appointment. */
        const h = harness({ ia_bk: bkSession() });
        const first = await serveFlowScreen(
            request('data_exchange', 'TIMES', { slot: 'slot_opaque_1' }, 'ia_bk'), h.ports);
        assert('confirming makes ONE appointment and shows the full receipt on the closing screen',
            h.calls.confirmed.length === 1 && bodyOf(first).screen === NOTICE_SCREEN
            && String(bodyOf(first).data?.message).startsWith('Réservé : Coupe homme'));
        assert('⛔ … stamped `booked`, so the chat can acknowledge it',
            bodyOf(first).data?.outcome === 'booked');
        /** ⭐ The same split the checkout arrived at: consume makes two impossible, the claim decides what a retry is TOLD. */
        assert('⭐ the claim is taken BEFORE the handle is consumed',
            h.calls.sequence.indexOf('claim') < h.calls.sequence.indexOf('confirm'));
        const retry = await serveFlowScreen(
            request('data_exchange', 'TIMES', { slot: 'slot_opaque_1' }, 'ia_bk'), h.ports);
        assert('⛔ a retry REPLAYS the first answer — never a second appointment, never "start again"',
            JSON.stringify(retry) === JSON.stringify(first) && h.calls.confirmed.length === 1);
    }

    {
        const h = harness({ ia_bk: bkSession({ bookingId: 'bkg-existing' }) }, {
            confirmBooking: async (bookingHandle, input) => {
                h.calls.confirmed.push({ handle: bookingHandle, slotId: input.slotId });
                delete h.sessions[bookingHandle];
                return { bookingId: 'bkg-existing', productId: PID, moved: true, reference: 'BKG-2026-000123', when: 'Wed 23 Sep 10:00', service: 'Coupe homme', awaitingShop: false };
            },
        });
        const moving = await serveFlowScreen(open('ia_bk'), h.ports);
        assert('⚠ a RESCHEDULE says so in the heading — a caption that only sometimes applies cannot be hidden',
            bodyOf(moving).data?.heading === bookingWords.movingNotice);
        const done = await serveFlowScreen(
            request('data_exchange', 'TIMES', { slot: 'slot_opaque_1' }, 'ia_bk'), h.ports);
        assert('⛔ a move stamps `moved`, never `booked` — "booked" would read as a second appointment',
            bodyOf(done).data?.outcome === 'moved');
    }

    {
        const h = harness({ ia_bk: bkSession() }, {
            confirmBooking: async () => {
                throw createAppError(ERROR_CODES.BOOKING_SLOT_LOCKED, 409, 'taken', { spent: true });
            },
        });
        const v = await serveFlowScreen(
            request('data_exchange', 'TIMES', { slot: 'slot_opaque_1' }, 'ia_bk'), h.ports);
        assert('a time taken a moment earlier → the form says so rather than claiming an appointment',
            v.status === 200 && bodyOf(v).screen === NOTICE_SCREEN
            && bodyOf(v).data?.outcome !== 'booked' && h.calls.reported.length === 1);
    }

    {
        const h = harness({ ia_bk: bkSession() });
        await serveFlowScreen(request('data_exchange', 'TIMES', { slot: '' }, 'ia_bk'), h.ports);
        assert('⛔ no slot → nothing confirmed, and no claim taken',
            h.calls.confirmed.length === 0 && h.calls.claimedWith.length === 0);
    }

    {
        /** ⚠ `bp` has a definition and a kind, but nothing reads what is owed — so it is refused. */
        const h = harness({ ia_bp: { ...owned, language: 'fr', kind: 'bp' } as InAppSurfaceSession });
        const v = await serveFlowScreen(open('ia_bp'), h.ports);
        assert('⚠ a booking-payment handle is refused until a read can re-resolve the amount',
            v.status === 427);
    }

    // ═════════════════════════════════════════════════════════════════════════
    section('17 · The router\'s wiring — real exports, types only, no second copy of a rule');

    const routerSource = stripComments(readSrc('flow-screens.ts'));
    const portsSource = stripComments(readSrc('flow-screen-ports.ts'));
    const controllerWiring = stripComments(readSrc('flow-data.controller.ts'));

    /**
     * ⛔ The sixth guard shape: a "must NOT" scan goes vacuously green when the code it guards
     * moves. Both files that make up the router are asserted present before they are scanned.
     */
    assert('both router files are in scope for the scans below (non-empty, and the ports file exports the ports)',
        routerSource.includes('export async function serveFlowScreen')
        && /export const flowScreenPorts/.test(portsSource));

    assert('⛔ the controller hands the router the PRODUCTION ports',
        /serveFlowScreen\(request,\s*flowScreenPorts\)/.test(controllerWiring)
        && /from '\.\/flow-screen-ports'/.test(controllerWiring));

    /**
     * ⛔ Each port IS the shared export, named — so a look-alike with its own rules cannot be
     * slipped in without this going red.
     */
    const realPorts: Array<[string, RegExp]> = [
        ['readSession → inAppSurfaceStore.read', /readSession:[^\n]*=>\s*inAppSurfaceStore\.read\(kind,\s*handle\)/],
        ['extendSession → inAppSurfaceStore.touch', /extendSession:[^\n]*=>\s*inAppSurfaceStore\.touch\(kind,\s*handle\)/],
        ['readListingPage', /^\s*readListingPage,$/m],
        ['readProductDetail', /^\s*readProductDetail,$/m],
        ['loadImage → loadFlowImage', /loadImage:\s*loadFlowImage,/],
        ['readCheckoutView', /^\s*readCheckoutView,$/m],
        ['placeCheckout', /^\s*placeCheckout,$/m],
        ['executePurchase', /^\s*executePurchase,$/m],
        ['claims → botIdempotencyStore', /claims:\s*botIdempotencyStore,/],
    ];
    const notReal = realPorts.filter(([, re]) => !re.test(portsSource)).map(([name]) => name);
    assert('⛔ every production port is the real shared export, passed through', notReal.length === 0, notReal.join(', '));

    const sourcedFrom: Array<[string, string]> = [
        ['executePurchase', 'bot-surface/controllers/bot-purchase.controller'],
        ['placeCheckout, readCheckoutView', 'bot-surface/miniapp/surfaces/checkout.controller'],
        ['readProductDetail', 'bot-surface/miniapp/surfaces/product-detail.read'],
        ['readListingPage', 'bot-surface/miniapp/surfaces/product-listing.read'],
        ['botIdempotencyStore', 'bot-surface/services/bot-idempotency.store'],
        ['inAppSurfaceStore', 'bot-surface/services/inapp-surface.store'],
    ];
    /**
     * ⚠ A literal `includes`, deliberately, and not a built regex: this repository bans
     * `new RegExp()` outright (regex injection + ReDoS), and the check needs no pattern —
     * `flow-screen-ports.ts` sits two levels under `modules/`, so the path is exact.
     */
    const wrongSource = sourcedFrom
        .filter(([names, from]) => !portsSource.includes(`import { ${names} } from '../../${from}';`))
        .map(([names]) => names);
    assert('⛔ … imported from the modules that own them, not from a copy', wrongSource.length === 0, wrongSource.join(', '));

    /**
     * ⚠ The router must stay importable by THIS suite: anything from the two controller files, or
     * from the two Redis stores, is a TYPE import. A value import would either hang the suite or
     * bypass the ports.
     */
    /**
     * Whole import STATEMENTS, not lines: `import type {\n A,\n B,\n} from '…'` spans four lines,
     * and a line-by-line scan cannot see which module a multi-line import names.
     */
    const importsOf = (source: string): Array<{ typeOnly: boolean; from: string }> =>
        [...source.matchAll(/^import\s+(type\s+)?[^;]*?from\s+'([^']+)';/gm)]
            .map((m) => ({ typeOnly: m[1] !== undefined, from: m[2] }));
    const HEAVY = /bot-purchase\.controller$|checkout\.controller$|inapp-surface\.store$|bot-idempotency\.store$/;
    const routerImports = importsOf(routerSource);
    const heavy = routerImports.filter((i) => HEAVY.test(i.from));
    assert('the import scan sees the router\'s imports at all (≥ 4 heavy modules named)',
        heavy.length >= 4, `${heavy.length} found`);
    assert('⚠ the router imports the controllers and the two stores as TYPES only',
        heavy.every((i) => i.typeOnly), heavy.filter((i) => !i.typeOnly).map((i) => i.from).join(', '));
    assert('⚠ the router never imports the image loader (sharp, storage) — it arrives as a port',
        !routerImports.some((i) => /image-bytes$/.test(i.from)));

    const router = routerSource + portsSource;
    assert('⛔ neither router file re-derives a rule: no rung, no price formatting, no mask, no spend, no order',
        !/resolvePurchaseAffordance|formatBotPrice|maskPhone|maskAddress|\.consume\(|addToCart|createOrdersFromCart|toFixed|Intl\.NumberFormat/.test(router));
    assert('⛔ the router never reads a purchase result\'s url — a Telegram screen address',
        !/result\.url|\.url\b/.test(routerSource));
    assert('⛔ the product id reaches the purchase core from the SESSION, never from the form',
        /productId:\s*session\.productId/.test(routerSource) && !/data\.productId/.test(routerSource));
    assert('⚠ a post-spend outcome is stored and a pre-spend one released, decided by handleSurvived alone',
        /spent\s*=\s*!handleSurvived\(error\)/.test(routerSource) && !/spent\s*===\s*false/.test(routerSource));

    // ═════════════════════════════════════════════════════════════════════════
    console.log('\n────────────────────────────────────────────────────────────');
    console.log(`  ${passed} passed, ${failed} failed`);
    console.log('────────────────────────────────────────────────────────────\n');
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
    console.error('\n💥 the suite itself threw:', error);
    process.exit(1);
});
