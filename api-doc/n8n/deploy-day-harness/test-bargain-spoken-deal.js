// THE SPOKEN DEAL — offline proof (no n8n, no network, no database).
// Run: node test-bargain-spoken-deal.js     Exit code = number of failures.
//
// Owner, 2026-09-22: "a deal agreed in words must do exactly what the lock-in button does" — the item
// in the basket at the locked price, the same line and the same three buttons. Executions 1914 → 1934:
// the gate approved `lock: true` at 6 000 XAF, and the customer got a plain sentence asking for their
// address, an empty basket, and no button. The backend now closes the loop; this file proves the n8n
// side carries it to the customer, and proves the one node that must change.
//
// ⭐ Rule 3 of this harness, at full strength: the gate's body is built by the REAL backend modules
// (TypeScript, loaded through ts-node — never a hand-written copy of what they would return) and fed
// to the LIVE n8n node code from the snapshots. Two systems, one run, no claim in between.
//
// § A  the `traits` tool-schema failure (exec 1914's first call) — the one node change
// § B  the close reaches the customer through the LIVE send path, unchanged
// § C  a refused basket, Telegram, and the rules every new body obeys
const path = require('path');
const { runCode, evalExpr, check, j } = require('./n8n-sim');
const B = require('./build-bargain-spoken-deal');

// ── The backend, as it will run ────────────────────────────────────────────────────────────────
const ROOT = path.resolve(__dirname, '..', '..', '..');
require(path.join(ROOT, 'node_modules', 'ts-node')).register({
  transpileOnly: true,
  project: path.join(ROOT, 'tsconfig.json'),
});
const src = (p) => require(path.join(ROOT, 'src', p));
const { dealInBasketIntent, dealRefusedIntent } = src('modules/negotiation/domain/deal-in-basket');
const { renderBotReply } = src('modules/bot-surface/domain/channel-reply');
const { botChrome } = src('modules/bot-surface/domain/bot-chrome-copy');
const { customerMessageFor } = src('modules/bot-surface/domain/bot-error-copy');
const { addedToCartActions } = src('modules/bot-surface/domain/purchase-chat-copy');
const { NegotiationRecordSchema } = src('modules/negotiation/validators/negotiation.validator');
const { ERROR_CODES } = src('core/error-codes');
const { ERROR_CATEGORIES } = src('core/error-category');

const S_A = 'spoken deal § A · the traits tool schema (exec 1914, first call)';
const S_B = 'spoken deal § B · a close reaches the customer through the LIVE send path';
const S_C = 'spoken deal § C · refusals, Telegram, and body hygiene';

// Made-up identities — never a real customer's number (the repository is public).
const WA_ID = '237600000001';
const TG_ID = '600000001';
const SESSION = '6ab1d07283f6cd84f70c7d58';
const LOCK_REF = 'nlk_00000000000000000000000000000001';
const REPLY = 'Va pour 6 000, merci à toi 🤝';
const TRAITS = {
  commitment: 'same_day', intent: 'buying', negotiation_style: 'firm_ceiling_no_bargain',
  price_sensitivity: 'high', tone: 'direct', trust_level: 'new', walkaway_confidence: 'high',
};
const inbound = (channel, externalId) => ({
  mode: 'turn', channel, externalId, messageId: 'wamid.FIXTURE-1', text: 'ok 6000 je prends',
  language: 'fr', variantId: '6ab1cf6ec274b2697c8ee105', productId: '6ab1cf6ec274b2697c8ee0f6',
  quantity: 1, customerOffer: 6000,
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// § A — the tool schema n8n builds from `$fromAI`
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Every `$fromAI('name', 'description', 'type')` in an expression, in order. */
function fromAiCalls(expr) {
  return [...String(expr).matchAll(/\$fromAI\('([^']*)',\s*'([^']*)',\s*'([^']*)'\)/g)]
    .map((m) => ({ name: m[1], description: m[2], type: m[3] }));
}

/**
 * n8n's tool-input check, per `$fromAI` type — modelled on what exec 1914 MEASURED, not on a guess:
 * a `json` argument handed a string failed with exactly "Value must be a non-empty object or a
 * non-empty array". § A's first check proves this model reproduces that failure before anything
 * else leans on it.
 */
function n8nRefusal(type, value) {
  switch (type) {
    case 'string': return typeof value === 'string' ? null : 'Expected string';
    case 'number': return typeof value === 'number' ? null : 'Expected number';
    case 'boolean': return typeof value === 'boolean' ? null : 'Expected boolean';
    case 'json': {
      const ok = value !== null && typeof value === 'object'
        && (Array.isArray(value) ? value.length > 0 : Object.keys(value).length > 0);
      return ok ? null : 'Value must be a non-empty object or a non-empty array';
    }
    default: return `unknown $fromAI type ${type}`;
  }
}
function toolSchemaErrors(expr, input) {
  return fromAiCalls(expr)
    .filter((c) => input[c.name] !== undefined)
    .map((c) => ({ at: c.name, error: n8nRefusal(c.type, input[c.name]) }))
    .filter((e) => e.error !== null);
}

/** Evaluate the tool node's `args` expression as n8n does once the model has supplied its values. */
function evalArgs(expr, values) {
  const m = /^=\{\{([\s\S]*)\}\}$/.exec(String(expr).trim());
  if (!m) throw new Error('args is not a single {{ }} expression');
  return new Function('$fromAI', `return (${m[1]});`)((key) => values[key]);
}

/** The LIVE `build request` of UP-wi-mall-bargain-tools, on what the tool node hands it. */
function buildRequest(args, code = B.liveTools['build request'].parameters.jsCode) {
  const toolCall = { tool: 'negotiation_record', channel: 'whatsapp', externalId: WA_ID, messageId: 'wamid.FIXTURE-1', args };
  return runCode(code, { input: [j(toolCall)] })[0].json;
}

// Exec 1914's first call, as the model sent it: every argument right, `traits` a JSON STRING.
const FIRST_CALL = {
  sessionId: SESSION, reply: REPLY, agentProposedPrice: 6000, lock: true, customerOffer: 6000,
  traits: JSON.stringify(TRAITS),
};
const RETRY_CALL = { ...FIRST_CALL, traits: TRAITS };
const NEW_ARGS = B.NEW['negotiation_record.args'];

{
  const live = toolSchemaErrors(B.LIVE_ARGS, FIRST_CALL);
  check(S_A, '⭐ the model of n8n\'s schema REPRODUCES exec 1914: live `traits` (json) refuses the JSON string',
    live.length === 1 && live[0].at === 'traits' && live[0].error === 'Value must be a non-empty object or a non-empty array',
    JSON.stringify(live));
  check(S_A, 'and accepts the retry that succeeded (traits as an object) — the model agrees with both halves',
    toolSchemaErrors(B.LIVE_ARGS, RETRY_CALL).length === 0);

  const fixed = toolSchemaErrors(NEW_ARGS, FIRST_CALL);
  check(S_A, '⭐ NEW `traits` (string) ACCEPTS the call the model actually makes — the first call no longer fails',
    fixed.length === 0, JSON.stringify(fixed));

  const liveCalls = fromAiCalls(B.LIVE_ARGS);
  const newCalls = fromAiCalls(NEW_ARGS);
  const onlyTraitsMoved = liveCalls.length === 6 && newCalls.length === 6
    && liveCalls.every((c, i) => c.name === newCalls[i].name
      && (c.name === 'traits' ? newCalls[i].type === 'string' && c.type === 'json'
        : c.type === newCalls[i].type && c.description === newCalls[i].description));
  check(S_A, 'only `traits` changed — the other five arguments keep their exact names, order, types and wording',
    onlyTraitsMoved, JSON.stringify(newCalls.map((c) => `${c.name}:${c.type}`)));

  const traitsCall = newCalls.find((c) => c.name === 'traits');
  check(S_A, 'the description names the shape the schema now demands — ONE JSON object written as a string',
    !!traitsCall && /JSON object written as a string/.test(traitsCall.description));
  check(S_A, '⚠ the trade, stated: an OBJECT is now the refused shape (never observed; the description prevents it)',
    toolSchemaErrors(NEW_ARGS, RETRY_CALL).some((e) => e.at === 'traits' && e.error === 'Expected string'));

  // Feed what the NEW node hands on to the LIVE `build request`, then to the backend's REAL validator.
  const body = buildRequest(evalArgs(NEW_ARGS, FIRST_CALL)).body;
  check(S_A, '⭐ the LIVE `build request` turns the string back into an OBJECT (its obj() — measured on exec 1916)',
    body && JSON.stringify(body.traits) === JSON.stringify(TRAITS), JSON.stringify(body && body.traits));
  const parsed = NegotiationRecordSchema.safeParse(body);
  check(S_A, '⭐ and the backend\'s own NegotiationRecordSchema accepts the result — traits and all',
    parsed.success === true && JSON.stringify(parsed.data.traits) === JSON.stringify(TRAITS),
    parsed.success ? '' : JSON.stringify(parsed.error.issues));

  // MUTANT — without obj() the string would reach the backend and be refused there instead.
  const noObj = B.patch('mutant build request', B.liveTools['build request'].parameters.jsCode,
    [['traits: obj(args.traits),', 'traits: args.traits,']]);
  const mutantBody = buildRequest(evalArgs(NEW_ARGS, FIRST_CALL), noObj).body;
  check(S_A, 'MUTANT — a `build request` without obj() sends the string on, and the backend REFUSES it (the check bites)',
    NegotiationRecordSchema.safeParse(mutantBody).success === false);

  check(S_A, 'the patch is anchored — a missing anchor throws instead of leaving the live body in place', (() => {
    try { B.patch('probe', B.LIVE_ARGS, [['no such anchor anywhere', 'x']]); return false; } catch (e) { return true; }
  })());
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// § B — the gate's close, through the LIVE `echo verdict` → `decide send` → send path
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** What `/negotiation/record` answers for a close: `outbound` rendered by the REAL backend modules. */
function gateClose(channel, externalId, language, { refusal = null, outbound } = {}) {
  const intent = refusal ? dealRefusedIntent(refusal, language, REPLY) : dealInBasketIntent(language, REPLY);
  return {
    success: true,
    data: {
      verdict: 'approved', sessionId: SESSION, round: 3, reply: REPLY, agreedPrice: 6000,
      lock: { ref: LOCK_REF, unitPrice: 6000, expiresAt: '2026-09-22T01:10:59.192Z' },
      outbound: outbound !== undefined ? outbound : renderBotReply(intent, channel, externalId),
      basket: refusal ? { placed: false, code: refusal.code } : { placed: true },
    },
  };
}

/** The LIVE bargain path for one gate response. Returns every value the customer's message depends on. */
function runSendPath(channel, externalId, response) {
  const nodes = { Inbound: [j(inbound(channel, externalId))] };
  // bargain-tools' LIVE `echo verdict` writes the echo; the parent's LIVE `decide send` reads it back.
  const echo = evalExpr(B.liveTools['echo verdict'].parameters.value, {
    nodes: { 'Tool Call': [j({ messageId: 'wamid.FIXTURE-1' })] }, json: response,
  });
  nodes['read gate echo'] = [j({ gateEcho: echo })];
  nodes['Bargain Agent'] = [j({ output: 'model final answer — never sent' })];
  const decided = runCode(B.liveBargain['decide send'].parameters.jsCode, { nodes })[0].json;
  nodes['decide send'] = [j(decided)];

  const cond = (node) => evalExpr(B.liveBargain[node].parameters.conditions.conditions[0].leftValue, { nodes, json: decided });
  const sendNode = channel === 'telegram' ? 'send telegram' : 'send whatsapp';
  return {
    decided,
    close: cond('close bargain?'),
    lockIssued: cond('lock issued?'),
    sendGuard: cond('send guard'),
    isTelegram: cond('is telegram?'),
    sentBody: JSON.parse(evalExpr(B.liveBargain[sendNode].parameters.jsonBody, { nodes })),
    storedLock: JSON.parse(evalExpr(B.liveBargain['store price lock'].parameters.value, { nodes })),
    toCore: runCode(B.liveBargain['return to core'].parameters.jsCode, { nodes })[0].json,
  };
}

const BASKET_IDS = addedToCartActions('fr').map((a) => a.id);

/** ⭐ The claim, as one function: ONE WhatsApp message, the gate's sentence, the press's line, three basket buttons. */
function assertBasketMessage(body, language) {
  const interactive = body && body.interactive;
  if (!body || body.type !== 'interactive' || !interactive || interactive.type !== 'button') {
    throw new Error(`not a button message (type ${body && body.type})`);
  }
  const ids = interactive.action.buttons.map((b) => b.reply.id);
  if (JSON.stringify(ids) !== JSON.stringify(BASKET_IDS)) throw new Error(`buttons ${JSON.stringify(ids)}`);
  const text = interactive.body.text;
  if (!text.startsWith(REPLY)) throw new Error('the gate-approved sentence does not lead (D-4)');
  if (!text.endsWith(botChrome('dealLockedPrompt', language))) throw new Error('the press\'s basket line is missing');
}
const holds = (fn) => { try { fn(); return true; } catch (e) { return false; } };

{
  const run = runSendPath('whatsapp', WA_ID, gateClose('whatsapp', WA_ID, 'fr'));

  check(S_B, '⭐ the LIVE `decide send` sends the backend\'s body — the gate\'s sentence, the basket line, three buttons',
    holds(() => assertBasketMessage(run.decided.reply.body, 'fr')), JSON.stringify(run.decided.reply).slice(0, 300));
  check(S_B, 'it is the body verbatim: what `send whatsapp` posts equals `data.outbound.body`',
    JSON.stringify(run.sentBody) === JSON.stringify(gateClose('whatsapp', WA_ID, 'fr').data.outbound.body));
  check(S_B, 'the three buttons are View basket · Checkout · Keep shopping — the SAME ids as any other add',
    JSON.stringify(run.sentBody.interactive.action.buttons.map((b) => b.reply.id)) === JSON.stringify(['cart:view', 'open:co', 'open:pl']));
  check(S_B, 'every button title fits WhatsApp\'s 20 characters',
    run.sentBody.interactive.action.buttons.every((b) => b.reply.title.length <= 20));
  check(S_B, 'the haggle closes: `close bargain?` true — the customer\'s next message goes back to the assistant',
    run.close === true && run.decided.closeSession === true);
  check(S_B, '`lock issued?` true, and `store price lock` still keeps the ref for the assistant',
    run.lockIssued === true && run.storedLock.ref === LOCK_REF && run.storedLock.quantity === 1
      && run.storedLock.variantId === '6ab1cf6ec274b2697c8ee105' && run.storedLock.unitPrice === 6000);
  check(S_B, '`send guard` passes and it goes to WhatsApp, not Telegram', run.sendGuard === true && run.isTelegram === false);
  check(S_B, '`return to core` says handled — wi-mall-core ends the turn instead of answering a second time',
    run.toCore.handled === true && run.toCore.lockIssued === true && run.toCore.verdict === 'approved');
  check(S_B, '⛔ nothing the customer is sent carries the lock\'s ref', !JSON.stringify(run.sentBody).includes(LOCK_REF));

  // MUTANT — the incident itself: the backend as it was, returning `outbound: null` on a close.
  const before = runSendPath('whatsapp', WA_ID, gateClose('whatsapp', WA_ID, 'fr', { outbound: null }));
  check(S_B, '⭐ MUTANT (exec 1914) — with `outbound: null` the LIVE node sends a plain sentence and NO buttons; the claim fails',
    before.sentBody.type === 'text' && !holds(() => assertBasketMessage(before.sentBody, 'fr')),
    JSON.stringify(before.sentBody).slice(0, 200));
}

for (const language of ['en', 'fr', 'pt', 'es', 'ar']) {
  const run = runSendPath('whatsapp', WA_ID, gateClose('whatsapp', WA_ID, language));
  check(S_B, `[${language}] the close reads in the customer's language, with the same three buttons`,
    holds(() => assertBasketMessage(run.sentBody, language)));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// § C — a refused basket, Telegram, and hygiene
// ─────────────────────────────────────────────────────────────────────────────────────────────

{
  const refusal = { code: ERROR_CODES.CART_MIXED_PRODUCT_TYPES, category: ERROR_CATEGORIES.CONFLICT };
  const run = runSendPath('whatsapp', WA_ID, gateClose('whatsapp', WA_ID, 'fr', { refusal }));
  const text = run.sentBody.type === 'text' ? run.sentBody.text.body : run.sentBody.interactive.body.text;

  check(S_C, '⛔ a REFUSED basket never tells the customer the item is in it', !text.includes(botChrome('dealLockedPrompt', 'fr')));
  check(S_C, 'it says why, in the cart\'s own words — the same sentence a Lock it in press gets for this refusal',
    text === `${REPLY}\n\n${customerMessageFor(refusal.code, refusal.category, 'fr')}`, text);
  check(S_C, 'the deal still stands: sent, closed, and the ref kept so the assistant can add it once the basket allows',
    run.sendGuard === true && run.close === true && run.storedLock.ref === LOCK_REF);
}

{
  const run = runSendPath('telegram', TG_ID, gateClose('telegram', TG_ID, 'fr'));
  const keyboard = (run.sentBody.reply_markup && run.sentBody.reply_markup.inline_keyboard) || [];
  check(S_C, 'Telegram: `is telegram?` true, and `send telegram` posts the three basket buttons as callbacks',
    run.isTelegram === true && JSON.stringify(keyboard.flat().map((b) => b.callback_data)) === JSON.stringify(BASKET_IDS));
  check(S_C, 'Telegram: the text is the gate\'s sentence, then the press\'s line',
    run.sentBody.text === `${REPLY}\n\n${botChrome('dealLockedPrompt', 'fr')}`);
}

{
  const hasBackslash = (s) => String(s).includes('\\');
  check(S_C, 'the new `negotiation_record.args` is backslash-free (a backslash is what gets lost carried by hand)',
    !hasBackslash(NEW_ARGS));
  check(S_C, 'MUTANT — the backslash check bites on a body that has one', hasBackslash(`${NEW_ARGS}\\n`));
  check(S_C, 'the new body is the live one with exactly two edits — nothing else moved',
    NEW_ARGS.replace(B.TRAITS_NEW_HEAD, B.TRAITS_OLD_HEAD).replace("then.', 'string')", "then.', 'json')") === B.LIVE_ARGS);
}

if (require.main === module) process.exitCode = require('./n8n-sim').report();
