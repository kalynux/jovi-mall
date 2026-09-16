/**
 * test:whatsapp-flows — the encrypted Flows data endpoint. **No DB, no network, no Redis.**
 *
 * ── WHY THIS SUITE CARRIES MORE WEIGHT THAN MOST ────────────────────────────
 * Every other integration here can be checked against the live thing when in doubt. This one
 * cannot, twice over:
 *
 *  1. **The platform cannot send a WhatsApp message at all.** The sending number's display
 *     name has never been approved (`name_status: NON_EXISTS`, error `131037`) and the
 *     10-changes-per-month quota is spent, so nothing reaches a handset regardless of this
 *     code.
 *  2. **A Flow must be PUBLISHED before it can be exercised**, and Meta refuses to publish
 *     against an endpoint whose health check it cannot complete. So the handshake has to be
 *     right *before* anyone can observe it being right.
 *
 * That makes this suite the only evidence the protocol is implemented correctly until both
 * clear. It therefore plays **both sides**: it generates a real RSA pair, does what Meta's
 * client does — RSA-OAEP/SHA-256 wrap an AES key, AES-GCM the body, append the tag — and
 * then decrypts our response with the *inverted* IV exactly as their client would. Nothing
 * is stubbed; the ciphertext is real.
 *
 * ── THE THREE MISTAKES IT EXISTS TO CATCH ───────────────────────────────────
 * Each of these produces an endpoint that is correct in every visible respect and works for
 * nobody, and none of them throws:
 *
 *  - **`oaepHash` omitted.** Node defaults RSA-OAEP to SHA-1. The key unwrap then fails on
 *    every genuine request and the symptom is identical to holding the wrong key — which
 *    sends the next person to rotate a key that was never wrong.
 *  - **The response IV not inverted.** Meta derives the flipped IV on its side. A random or
 *    re-used-unflipped IV produces a response their client silently cannot read: the Flow
 *    opens, then shows a generic error, with nothing wrong on this side to find.
 *  - **The ping answered in this service's own envelope.** `{success, data:{…}}` instead of
 *    the bare `{version, data:{status:'active'}}` makes the endpoint unpublishable, and Meta
 *    does not say which field was wrong.
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
    FLOW_TERMINAL_SCREEN,
} from '../../src/modules/whatsapp/flows/domain/flow-protocol';
import { verifyFlowSignature } from '../../src/modules/whatsapp/flows/domain/flow-signature';
import { PRODUCT_LISTING_FLOW } from '../../src/modules/whatsapp/flows/definitions/product-listing.flow';
import { handler as flowCompleteHandler } from '../../src/modules/whatsapp/flows/commands/flow-complete.command';

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

    const ping = classifyFlowRequest({ version: '3.0', action: 'ping' });
    assert('a ping is classified as a ping', ping.kind === 'ping');

    const pingBody = pingResponse('3.0');
    assert('⚠ the ping answer is EXACTLY {version, data:{status:"active"}}',
        JSON.stringify(pingBody) === JSON.stringify({ version: '3.0', data: { status: 'active' } }),
        JSON.stringify(pingBody));

    assert('⚠ it carries no `success` key — this service\'s envelope would fail the check',
        !('success' in pingBody) && !('requestId' in pingBody));

    /**
     * ⚠ A ping carries no meaningful flow_token. Requiring one would fail every health check
     * while looking like correct authentication — and the endpoint would be unpublishable.
     */
    assert('⚠ a ping needs no flow_token to classify',
        classifyFlowRequest({ version: '3.0', action: 'ping' }).kind === 'ping');

    // ═════════════════════════════════════════════════════════════════════════
    section('4 · Classification of the remaining actions');

    const err = classifyFlowRequest({
        version: '3.0', action: 'error', data: { error_key: 'SOMETHING' },
    });
    assert('an error action is classified as an error',
        err.kind === 'error' && err.errorKey === 'SOMETHING');

    assert('⚠ it is ACKNOWLEDGED, not refused — anything else makes Meta retry bad news',
        JSON.stringify(errorAcknowledgement('3.0'))
        === JSON.stringify({ version: '3.0', data: { acknowledged: true } }));

    const exchange = classifyFlowRequest({
        version: '3.0', action: 'data_exchange', screen: 'CART', flow_token: 'ia_x',
        data: { quantity: 2 },
    });
    assert('a data_exchange is classified as a screen request',
        exchange.kind === 'screen');
    if (exchange.kind === 'screen') {
        assert('it carries the screen, the action and the token',
            exchange.screen === 'CART' && exchange.action === 'data_exchange'
            && exchange.flowToken === 'ia_x');
    }

    /**
     * ⚠ INIT under data_exchange carries NO screen — Meta is asking us which comes first.
     * A handler that requires one refuses exactly the mode checkout is built on.
     */
    const init = classifyFlowRequest({ version: '3.0', action: 'INIT', flow_token: 'ia_y' });
    assert('⚠ an INIT with no screen is still a screen request, with screen null',
        init.kind === 'screen' && init.screen === null);

    assert('a payload with no action at all is malformed',
        classifyFlowRequest({ version: '3.0' }).kind === 'malformed');

    /**
     * ⚠ The version is ECHOED, never asserted. Meta bumps the data-API version, and an
     * endpoint that refuses an unfamiliar one breaks every live Flow the day they do.
     */
    const future = classifyFlowRequest({ version: '99.0', action: 'ping' });
    assert('⚠ an unknown version is accepted and echoed, never refused',
        future.kind === 'ping' && future.version === '99.0');

    assert('a missing version falls back rather than failing',
        classifyFlowRequest({ action: 'ping' }).kind === 'ping');

    // ═════════════════════════════════════════════════════════════════════════
    section('5 · The completion answer — the only part that reaches the conversation');

    const done = completionResponse('3.0', 'ia_token', { orderId: 'o1' });
    assert('a completion names the terminal screen',
        done.screen === FLOW_TERMINAL_SCREEN);

    const params = (done.data.extension_message_response as {
        params: Record<string, unknown>;
    }).params;
    assert('⚠ the flow_token is echoed into it — the only thread back to the session',
        params.flow_token === 'ia_token' && params.orderId === 'o1');

    const screen = screenResponse('3.0', 'ADDRESS', { city: 'Douala' });
    assert('an ordinary screen answer names the next screen and its data',
        screen.screen === 'ADDRESS' && (screen.data as { city: string }).city === 'Douala');

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
    section('8 · The published Flow definition — what Meta validates at publish time');

    const flow = PRODUCT_LISTING_FLOW;

    assert('it declares a data_api_version — without one the Flow is static',
        typeof flow.data_api_version === 'string' && flow.data_api_version !== '');

    /**
     * ⚠ A screen absent from the routing model is UNREACHABLE, and Meta validates the map
     * rather than the intent — so it publishes happily and renders nothing.
     */
    for (const s of flow.screens) {
        assert(`⚠ screen '${s.id}' appears in the routing model — absent means unreachable`,
            Object.prototype.hasOwnProperty.call(flow.routing_model, s.id));
    }

    assert('exactly one terminal screen',
        flow.screens.filter((s) => s.terminal).length === 1);

    /**
     * ⚠ Every declared data field needs an `__example__`: the Builder previews from it AND
     * Meta validates the endpoint's real response against the declared types at publish.
     */
    const fieldsWithoutExample = flow.screens.flatMap((s) =>
        Object.entries(s.data ?? {})
            .filter(([, f]) => f.__example__ === undefined)
            .map(([name]) => `${s.id}.${name}`));
    assert('⚠ every declared data field carries an __example__',
        fieldsWithoutExample.length === 0, fieldsWithoutExample.join(', '));

    /**
     * ⚠ The field names are the seam with the Telegram screen. `pl.html` reads `data.heading`
     * and `data.products`, and both channels are served from one projection — so a rename on
     * either side that is not made on the other is a screen that renders blank.
     */
    const listing = flow.screens.find((s) => s.id === 'PRODUCTS');
    assert('⚠ its data contract mirrors the Telegram screen: heading + products',
        !!listing?.data?.heading && !!listing?.data?.products);

    const footer = listing?.layout.children.find((c) => c.type === 'Footer') as
        | { 'on-click-action'?: { name?: string; payload?: Record<string, unknown> } }
        | undefined;

    assert('the footer completes the Flow rather than exchanging data',
        footer?.['on-click-action']?.name === 'complete');

    /**
     * ⚠ Meta echoes `flow_token` into the completion on its own. Naming it in the payload puts
     * a second copy in, and two copies can disagree the moment anything rewrites one.
     */
    assert('⚠ the completion payload does NOT restate flow_token — Meta adds it',
        footer?.['on-click-action']?.payload !== undefined
        && !('flow_token' in (footer['on-click-action'].payload as Record<string, unknown>)));

    /**
     * ⚠ A listing row carries the PRODUCT id. Sending a variant id would mean choosing a size
     * before the customer has seen the sizes.
     */
    assert('⚠ it hands back a productId, never a variantId',
        'productId' in (footer?.['on-click-action']?.payload as Record<string, unknown>));

    const definitionSource = stripComments(
        readSrc('definitions/product-listing.flow.ts'),
    );
    assert('⚠ no money maths in a definition — prices arrive already formatted',
        !/toFixed|parseFloat|Intl\.NumberFormat/.test(definitionSource));

    // ═════════════════════════════════════════════════════════════════════════
    section('9 · The completion command — the rule that inverts into a bug');

    /**
     * ⛔ THE LOAD-BEARING ONE. The checkout handle is CONSUMED by the write that places the
     * order, so by the time Meta sends the completion it is gone — correctly. Refusing an
     * unresolved token here, which is the obvious hardening, would tell every customer whose
     * order succeeded that it failed.
     */
    const spent = await flowCompleteHandler(
        { flow_token: 'ia_definitely-not-in-redis', screen: 'co', orderCount: 1 } as never,
        {},
    );
    assert('⛔ a SPENT token still reports the completion — this is success, not failure',
        typeof spent.message === 'string' && spent.message.length > 0);
    assert('⚠ and the screen comes from the Flow\'s own stamp, which survives a spent token',
        spent.screen === 'co');
    assert('the params are passed through, minus the token',
        (spent.params as { orderCount?: number }).orderCount === 1
        && !('flow_token' in spent.params));

    const noToken = await flowCompleteHandler({ screen: 'pl', productId: 'p1' } as never, {});
    assert('a completion with no token at all is still reported, never refused',
        noToken.screen === 'pl'
        && (noToken.params as { productId?: string }).productId === 'p1');

    const unknownScreen = await flowCompleteHandler(
        { screen: 'not-a-kind', a: 1 } as never, {},
    );
    assert('an unrecognised screen stamp yields null rather than being trusted',
        unknownScreen.screen === null);

    const commandSource = stripComments(
        readSrc('commands/flow-complete.command.ts'),
    );
    assert('⚠ the completion handler performs NO write — it reports, it does not act',
        !/\.consume\(/.test(commandSource)
        && !/\.mint\(/.test(commandSource)
        && !/createOrder|placeOrder/i.test(commandSource));

    /**
     * ⚠ The kind check on `read` is what stops a forwarded listing handle being replayed
     * against checkout. Asking each kind in turn preserves it; a kind-agnostic read would
     * not.
     */
    assert('⚠ it resolves by asking each kind, never by reading kind-agnostically',
        /inAppSurfaceStore\.read\(kind,/.test(commandSource));

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
