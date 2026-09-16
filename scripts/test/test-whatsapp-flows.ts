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
import { FLOW_SCREEN_TITLE, NOTICE_SCREEN } from '../../src/modules/whatsapp/flows/definitions/notice.screen';
import { FLOW_LISTING_PAGE_SIZE, toListingScreen } from '../../src/modules/whatsapp/flows/screens/listing.adapter';
import { toDetailScreen } from '../../src/modules/whatsapp/flows/screens/detail.adapter';
import { mayShowImageToCustomer, FLOW_IMAGE_MAX_SOURCE_BYTES } from '../../src/modules/whatsapp/flows/screens/image-policy';
import { FLOW_CAPS, fitText } from '../../src/modules/whatsapp/flows/screens/flow-text';
import type { FlowCopy } from '../../src/modules/whatsapp/flows/screens/flow-copy';
import type { ListingPage } from '../../src/modules/bot-surface/miniapp/surfaces/product-listing.read';
import type { ProductDetailView } from '../../src/modules/bot-surface/miniapp/surfaces/product-detail.read';
import {
    handler as flowCompleteHandler,
    planCompletion,
} from '../../src/modules/whatsapp/flows/commands/flow-complete.command';
import { commandReplyIntent, screenReplyIntent } from '../../src/modules/command-bus/command-reply';
import { botChrome } from '../../src/modules/bot-surface/domain/bot-chrome-copy';
import {
    needsTypedNumber,
    planCheckoutFailure,
    toCheckoutScreen,
} from '../../src/modules/whatsapp/flows/screens/checkout.adapter';
import type { CheckoutView } from '../../src/modules/bot-surface/miniapp/surfaces/checkout.controller';

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

const readSrc = (relative: string): string =>
    fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'modules', 'whatsapp', 'flows', relative),
        'utf8',
    );

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

    const ALL_FLOWS = [
        ['product-listing', PRODUCT_LISTING_FLOW],
        ['product-detail', PRODUCT_DETAIL_FLOW],
        ['checkout', CHECKOUT_FLOW],
    ] as const;

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

    for (const [label, definition] of ALL_FLOWS) {
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

        const source = stripComments(readSrc(`definitions/${label}.flow.ts`));
        assert(`${label}: no money maths in a definition — prices arrive formatted`,
            !/toFixed|parseFloat|Intl\.NumberFormat/.test(source));

        assert(`${label}: every screen that ends the Flow can reach the conversation (a NOTICE)`,
            definition.screens.some((s) => s.id === NOTICE_SCREEN && s.terminal));
    }

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
     * so by the time Meta sends the completion it is gone, correctly. The handler must neither
     * refuse nor even look it up: the Flow's own stamp says which form finished.
     */
    const spent = await flowCompleteHandler(
        { flow_token: 'ia_definitely-not-in-redis', screen: 'co', orderCount: 1 } as never,
        {},
    );
    assert('⛔ a SPENT checkout token is not an error — the completion is handled normally',
        spent.completedScreen === 'co' && spent.message === '');
    assert('the params pass through, minus the token',
        (spent.params as { orderCount?: number }).orderCount === 1 && !('flow_token' in spent.params));

    assert('an unrecognised screen stamp yields null rather than being trusted',
        (await flowCompleteHandler({ screen: 'not-a-kind' } as never, {})).completedScreen === null);

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
     * ⚠ Detail and checkout say their outcome on a closing screen before they close. A second
     * message here would talk over the one the customer is actually waiting for.
     */
    for (const done of ['pd', 'co'] as const) {
        assert(`a finished ${done} form adds nothing to the chat`,
            plan({ completedScreen: done }).kind === 'silent');
    }
    assert('a notice screen closing adds nothing to the chat',
        plan({ params: { screen: 'pl', outcome: 'notice' } }).kind === 'silent');
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
    assert('⚠ it reads the listing session by naming its kind — a pd or co handle is refused',
        /inAppSurfaceStore\.read\('pl',/.test(commandSource));

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

    const plain = toDetailScreen(detailView(), copy, null);
    const withImage = toDetailScreen(detailView(), copy, 'aGVsbG8=');
    assert('no picture → the no-image screen; a picture → the image screen with the bytes',
        plain.screen === 'PRODUCT_NO_IMAGE' && !('image' in plain.data)
        && withImage.screen === 'PRODUCT' && withImage.data.image === 'aGVsbG8=');

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
    }), copy, null);
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
