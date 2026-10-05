/**
 * test:refund-admin-api — `/api/internal/admin/refunds/*`, offline (REFUND-FLOW-PLAN R7, § 11.7).
 *
 *   1. The mount        — behind `requireAdminCaller`, every § 11.7 verb on the router, guard first
 *   2. Strict bodies    — every validator refuses an unknown key; wi-admin's canonical bodies parse
 *   3. The proof tree   — `refund-proofs` is PRIVATE; the upload never goes through `by-type`
 *   4. The proof read   — refuses (404) any file outside `refund-proofs/`, before touching storage
 *   5. Create, driven   — Support never approves; requested_by.id = X-Actor-Id; the override and
 *                         proof refusals; 201 + the camelCase DTO
 *
 * DB-free and network-free: the controller is driven with stubbed singletons and fake req/res.
 * Run: npm run test:refund-admin-api
 */

process.env.LOG_STDOUT = 'false';

// TYPE-ONLY: the admin-caller middleware uses `req.auth` / `req.requestId`, declared by
// `declare global` blocks in these modules.
import type {} from '../../src/api/middlewares/auth.middleware';
import type {} from '../../src/api/middlewares/request-id.middleware';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Types } from 'mongoose';
import { originalConsole } from '../../src/core/logging/sink-guard';
import { AppError } from '../../src/core/errors';
import { ERROR_CODES } from '../../src/core/error-codes';
import { isPrivateStorageKey, PRIVATE_STORAGE_TREES, STORAGE_TREE_VISIBILITY } from '../../src/core/storage/storage-trees';
import { getRefundProofUploadConfig } from '../../src/core/uploads/upload-config';
import { mayApproveAtCreation } from '../../src/modules/payments/domain/refund-status';
import {
  AdminApproveRefundSchema,
  AdminCreateRefundRequestSchema,
  AdminRefundEligibilityQuerySchema,
  AdminRejectRefundSchema,
  AdminResolveUnknownRefundSchema,
  AdminRetryRefundSchema,
  AdminSettleExternalRefundSchema,
} from '../../src/modules/payments/validators/admin-refund-request.validator';
import { buildAdminRefundRequestRouter } from '../../src/modules/payments/routes/admin-refund-request.routes';
import { AdminRefundRequestController } from '../../src/modules/payments/controllers/admin-refund-request.controller';
import {
  isRefundProofKey,
  REFUND_PROOF_FOLDER,
  RefundProofService,
  refundProofService,
} from '../../src/modules/payments/services/refund-proof.service';
import { refundRequestService } from '../../src/modules/payments/services/refund-request.service';
import { refundEligibilityService, policyOverridesOf } from '../../src/modules/payments/services/refund-eligibility.service';

let passed = 0;
let failed = 0;

function assert(name: string, fn: () => boolean): void {
  let ok: boolean;
  try {
    ok = fn();
  } catch (err) {
    originalConsole.error(`  ❌ THROW: ${name} — ${(err as Error).message}`);
    failed++;
    return;
  }
  if (ok) {
    originalConsole.log(`  ✅ ${name}`);
    passed++;
  } else {
    originalConsole.error(`  ❌ FAIL: ${name}`);
    failed++;
  }
}

async function assertAsync(name: string, fn: () => Promise<boolean>): Promise<void> {
  let ok: boolean;
  try {
    ok = await fn();
  } catch (err) {
    originalConsole.error(`  ❌ THROW: ${name} — ${(err as Error).message}`);
    failed++;
    return;
  }
  if (ok) {
    originalConsole.log(`  ✅ ${name}`);
    passed++;
  } else {
    originalConsole.error(`  ❌ FAIL: ${name}`);
    failed++;
  }
}

const SRC = join(__dirname, '..', '..', 'src');
const src = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
/** Comments explain what was deliberately NOT done; scans must not read them as code. */
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const parses = (schema: { safeParse: (v: unknown) => { success: boolean } }, v: unknown) => schema.safeParse(v).success;

// ── Fake HTTP plumbing ───────────────────────────────────────────────────────

interface Captured {
  status: number;
  body: any;
  error: unknown;
}

function drive(handler: any, req: { body?: unknown; params?: Record<string, string>; query?: Record<string, string>; headers?: Record<string, string> }): Promise<Captured> {
  return new Promise((resolve) => {
    const out: Captured = { status: 200, body: undefined, error: undefined };
    const res: any = {
      status(code: number) {
        out.status = code;
        return res;
      },
      json(body: unknown) {
        out.body = body;
        resolve(out);
        return res;
      },
      setHeader() {
        return res;
      },
    };
    const fullReq: any = {
      body: req.body ?? {},
      params: req.params ?? {},
      query: req.query ?? {},
      headers: { 'x-actor-id': ADMIN_A, 'x-actor-name': 'Alice', ...(req.headers ?? {}) },
    };
    handler(fullReq, res, (error: unknown) => {
      out.error = error;
      resolve(out);
    });
  });
}

const ADMIN_A = new Types.ObjectId().toHexString();
const ORDER_ID = new Types.ObjectId().toHexString();

function fakeRow(overrides: Record<string, unknown> = {}): any {
  const id = new Types.ObjectId();
  return {
    _id: id,
    id: id.toHexString(),
    source_kind: 'order',
    source_id: new Types.ObjectId(ORDER_ID),
    order_number: 'ORD-1',
    vendor_id: null,
    customer_id: null,
    reason_kind: 'cancellation',
    reason: 'x',
    item_defective: null,
    override_policy: false,
    attribution: { goods: 5000, delivery: 0 },
    gross_amount: 5000,
    fee_rate: 2,
    fee_amount: 100,
    net_amount: 4900,
    currency: 'XAF',
    payment_channel: 'mobile_money',
    channel: null,
    destination: { phone: '+237677000000', name: 'C', source: 'payer' },
    destination_proof_file_id: null,
    cod_collection_ids: [],
    status: 'awaiting_approval',
    requested_by: { id: ADMIN_A, role: 'support', name: 'Alice' },
    approved_by: null,
    rejected_by: null,
    rejection_reason: null,
    transfer_reference: null,
    transfer_gateway: null,
    transfer_gateway_ref: null,
    transfer_failure_reason: null,
    transfer_note: null,
    transfer_legs: [],
    external_settlement: null,
    ticket_id: null,
    refund_transaction_ids: [],
    completed_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

async function main(): Promise<void> {
  // ─────────────────────────────────────────────────────────────────────────
  originalConsole.log('\n▶ 1. The mount — behind requireAdminCaller, every § 11.7 verb');

  const mount = stripComments(src('api/routes/internal-admin.routes.ts'));
  assert('`/refunds` is mounted with buildAdminRefundRequestRouter([requireAdminCaller])', () =>
    /router\.use\(\s*'\/refunds'\s*,\s*buildAdminRefundRequestRouter\(\s*\[\s*requireAdminCaller\s*\]\s*\)\s*\)/.test(mount));
  assert('…exactly once (one door)', () => (mount.match(/buildAdminRefundRequestRouter\(/g) ?? []).length === 1);

  const guard = function fakeGuard() { /* marker */ };
  const router: any = buildAdminRefundRequestRouter([guard as any]);
  const layers: any[] = router.stack;
  assert('the guard is the FIRST layer — nothing on the router runs before it', () =>
    !layers[0].route && layers[0].handle === guard);
  const routes = layers
    .filter((l) => l.route)
    .map((l) => `${Object.keys(l.route.methods).map((m) => m.toUpperCase()).join(',')} ${l.route.path}`);
  const expected = [
    'GET /eligibility',
    'POST /',
    'POST /:id/approve',
    'POST /:id/reject',
    'POST /:id/retry',
    'POST /:id/settle-external',
    'POST /:id/resolve-unknown',
    'POST /proofs',
    'GET /proofs/:fileId',
  ];
  for (const r of expected) {
    assert(`router serves ${r}`, () => routes.includes(r));
  }
  assert('…and nothing else (the surface is closed)', () => routes.length === expected.length);
  assert('literals are declared before `/:id/*` routes', () =>
    routes.indexOf('GET /eligibility') < routes.indexOf('POST /:id/approve')
    && routes.indexOf('POST /proofs') < routes.indexOf('POST /:id/approve'));

  // ─────────────────────────────────────────────────────────────────────────
  originalConsole.log('\n▶ 2. Strict bodies — unknown keys refused, wi-admin\'s bodies accepted');

  const canonicalCreate = {
    sourceKind: 'order',
    sourceId: ORDER_ID,
    reasonKind: 'cancellation',
    reason: 'Customer cancelled',
    requestedByRole: 'support',
    approveNow: false,
  };
  assert('create: wi-admin\'s minimal body parses (optional keys omitted)', () => parses(AdminCreateRefundRequestSchema, canonicalCreate));
  assert('create: the full body parses', () =>
    parses(AdminCreateRefundRequestSchema, {
      ...canonicalCreate,
      amount: 5000,
      itemDefective: true,
      overridePolicy: true,
      destination: { phone: '+237677000000', name: 'Jean' },
      destinationProofFileId: new Types.ObjectId().toHexString(),
      requestedByRole: 'admin',
      approveNow: true,
    }));
  assert('create: an unknown key is a 400', () => !parses(AdminCreateRefundRequestSchema, { ...canonicalCreate, aproveNow: true }));
  assert('create: an unknown key INSIDE destination is a 400', () =>
    !parses(AdminCreateRefundRequestSchema, { ...canonicalCreate, destination: { phone: '+237677000000', name: 'J', iban: 'x' } }));
  assert('create: requestedByRole only admin | support (never vendor/system/customer)', () =>
    !parses(AdminCreateRefundRequestSchema, { ...canonicalCreate, requestedByRole: 'system' })
    && !parses(AdminCreateRefundRequestSchema, { ...canonicalCreate, requestedByRole: 'vendor' }));
  assert('create: reason is required', () => {
    const { reason: _r, ...noReason } = canonicalCreate;
    return !parses(AdminCreateRefundRequestSchema, noReason) && !parses(AdminCreateRefundRequestSchema, { ...canonicalCreate, reason: '   ' });
  });
  assert('create: null is not "omitted" (optional keys refuse null)', () =>
    !parses(AdminCreateRefundRequestSchema, { ...canonicalCreate, amount: null }));
  assert('create: a non-integer or non-positive amount is a 400', () =>
    !parses(AdminCreateRefundRequestSchema, { ...canonicalCreate, amount: 10.5 })
    && !parses(AdminCreateRefundRequestSchema, { ...canonicalCreate, amount: 0 }));
  assert('approve / retry: `{}` parses, any key is a 400', () =>
    parses(AdminApproveRefundSchema, {}) && !parses(AdminApproveRefundSchema, { force: true })
    && parses(AdminRetryRefundSchema, {}) && !parses(AdminRetryRefundSchema, { gateway: 'NOTCHPAY' }));
  assert('reject: `{reason}` parses, extra keys and an empty reason refused', () =>
    parses(AdminRejectRefundSchema, { reason: 'dup' })
    && !parses(AdminRejectRefundSchema, { reason: 'dup', x: 1 })
    && !parses(AdminRejectRefundSchema, { reason: '' }));
  const proofId = new Types.ObjectId().toHexString();
  assert('settle-external: `{method, reference?, proofFileId}` parses; proof REQUIRED; extra keys refused', () =>
    parses(AdminSettleExternalRefundSchema, { method: 'cash', proofFileId: proofId })
    && parses(AdminSettleExternalRefundSchema, { method: 'mobile_money', reference: 'TX1', proofFileId: proofId })
    && !parses(AdminSettleExternalRefundSchema, { method: 'cash' })
    && !parses(AdminSettleExternalRefundSchema, { method: 'crypto', proofFileId: proofId })
    && !parses(AdminSettleExternalRefundSchema, { method: 'cash', proofFileId: proofId, amount: 5 }));
  assert('resolve-unknown: `{outcome, note}` parses; extra keys and other outcomes refused', () =>
    parses(AdminResolveUnknownRefundSchema, { outcome: 'arrived', note: 'seen on dashboard' })
    && !parses(AdminResolveUnknownRefundSchema, { outcome: 'maybe', note: 'n' })
    && !parses(AdminResolveUnknownRefundSchema, { outcome: 'failed', note: 'n', force: true }));
  assert('eligibility query: sourceKind + sourceId parse; strings coerced; unknown params refused', () => {
    const ok = AdminRefundEligibilityQuerySchema.safeParse({ sourceKind: 'order', sourceId: ORDER_ID, itemDefective: 'true', amount: '5000' });
    return ok.success && ok.data.itemDefective === true && ok.data.amount === 5000
      && !parses(AdminRefundEligibilityQuerySchema, { sourceKind: 'order', sourceId: ORDER_ID, foo: 'bar' })
      && !parses(AdminRefundEligibilityQuerySchema, { sourceKind: 'invoice', sourceId: ORDER_ID });
  });

  // ─────────────────────────────────────────────────────────────────────────
  originalConsole.log('\n▶ 3. The proof tree — private, and never reached through by-type');

  assert('`refund-proofs` is classified PRIVATE', () =>
    STORAGE_TREE_VISIBILITY['refund-proofs'] === 'private' && PRIVATE_STORAGE_TREES.includes('refund-proofs'));
  assert('a refund-proofs key is private (POSIX and Windows separators)', () =>
    isPrivateStorageKey('refund-proofs/2026/10/x.png') && isPrivateStorageKey('refund-proofs\\2026\\10\\x.png'));
  assert('the service writes into exactly `refund-proofs`', () => REFUND_PROOF_FOLDER === 'refund-proofs');
  const proofSvc = stripComments(src('modules/payments/services/refund-proof.service.ts'));
  const proofRoutes = stripComments(src('modules/payments/routes/admin-refund-request.routes.ts'));
  const proofCtl = stripComments(src('modules/payments/controllers/admin-refund-request.controller.ts'));
  assert('the upload names the folder constant and never `by-type`', () =>
    /folder:\s*REFUND_PROOF_FOLDER/.test(proofSvc) && !/by-type/.test(proofSvc + proofRoutes + proofCtl));
  assert('…and never reuses the public `/files/upload` pipeline', () =>
    !/uploadMultiple|FileUploadController|files\/upload/.test(proofSvc + proofRoutes + proofCtl));
  assert('…goes through the intake pipeline with the factory-resolved scanner', () =>
    /new UploadIntakeService\(/.test(proofSvc) && /resolveVirusScanner\(config\)/.test(proofSvc)
    && /getRefundProofUploadConfig\(\)/.test(proofSvc));
  assert('…and writes a file_references row, so the orphan sweep never deletes a proof', () =>
    /fileReferenceService\.reconcile\(/.test(proofSvc));
  const cfg = getRefundProofUploadConfig();
  assert('the proof policy: one file, images + PDF only, quotas off, duplicates never collapsed', () =>
    cfg.maxFilesPerRequest === 1
    && ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].every((m) => cfg.perMimeType[m]?.allowed === true)
    && Object.keys(cfg.perMimeType).length === 4
    && cfg.userQuotas.enabled === false
    && cfg.duplicateDetection.enabled === false);
  assert('the multer ceiling matches the policy (1 file, 10 MB, field `file`)', () =>
    /files:\s*1/.test(proofRoutes) && /MAX_PROOF_BYTES = 10 \* 1024 \* 1024/.test(proofRoutes) && /\.single\('file'\)/.test(proofRoutes));

  // ─────────────────────────────────────────────────────────────────────────
  originalConsole.log('\n▶ 4. The proof read refuses every other tree');

  assert('isRefundProofKey: only refund-proofs/…', () =>
    isRefundProofKey('refund-proofs/2026/10/a.png')
    && isRefundProofKey('refund-proofs\\2026\\10\\a.png')
    && !isRefundProofKey('kyc/2026/10/id.png')
    && !isRefundProofKey('admin-identity/2026/10/id.png')
    && !isRefundProofKey('images/2026/10/a.png')
    && !isRefundProofKey('refund-proofs-evil/2026/10/a.png')
    && !isRefundProofKey('')
    && !isRefundProofKey(null));

  let streamed: string[] = [];
  const fakeStorage = {
    supportsDownloadStream: () => true,
    getProviderType: () => 'local',
    getDownloadStream: async (key: string) => {
      streamed.push(key);
      return { pipe: () => undefined } as any;
    },
  };
  const files: Record<string, any> = {
    kyc: { id: 'k', key: 'kyc/2026/10/id.png', mimeType: 'image/png', size: 1, originalName: 'id.png' },
    pub: { id: 'p', key: 'images/2026/10/a.png', mimeType: 'image/png', size: 1, originalName: 'a.png' },
    proof: { id: 'r', key: 'refund-proofs/2026/10/msg.png', mimeType: 'image/png', size: 7, originalName: 'msg.png' },
  };
  const svc = new RefundProofService();
  (svc as any).fileRepository = { findManyByIds: async ([id]: string[]) => (files[id] ? [files[id]] : []) };
  Object.defineProperty(svc, 'storageProvider', { get: () => fakeStorage });

  for (const [label, id] of [['a KYC scan', 'kyc'], ['a public by-type image', 'pub'], ['a missing file', 'nope']] as const) {
    await assertAsync(`stream refuses ${label} with 404 — and never opens its bytes`, async () => {
      streamed = [];
      try {
        await svc.stream(id);
        return false;
      } catch (e) {
        return e instanceof AppError && e.statusCode === 404 && e.code === ERROR_CODES.CATALOG_FILE_NOT_FOUND && streamed.length === 0;
      }
    });
  }
  await assertAsync('stream serves a refund-proofs file', async () => {
    streamed = [];
    const out = await svc.stream('proof');
    return streamed[0] === 'refund-proofs/2026/10/msg.png' && out.mimeType === 'image/png' && out.size === 7;
  });
  await assertAsync('isRefundProof answers true only inside the tree', async () =>
    (await svc.isRefundProof('proof')) && !(await svc.isRefundProof('kyc')) && !(await svc.isRefundProof('pub'))
    && !(await svc.isRefundProof(null)));
  assert('the streaming route is not cacheable', () => /Cache-Control', 'private, no-store'/.test(proofCtl));

  // ─────────────────────────────────────────────────────────────────────────
  originalConsole.log('\n▶ 5. Create, driven — Support never approves; the actor is the requester');

  assert('mayApproveAtCreation: support NEVER approves, even with approveNow', () =>
    (['payer', null] as const).every((d) =>
      (['card', 'mobile_money', 'cod', 'billing'] as const).every((c) =>
        !mayApproveAtCreation({ requestedByRole: 'support', approveNow: true, destinationSource: d, overridePolicy: false, paymentChannel: c }))));
  assert('mayApproveAtCreation: admin + typed destination never approves at creation', () =>
    !mayApproveAtCreation({ requestedByRole: 'admin', approveNow: true, destinationSource: 'typed', overridePolicy: false, paymentChannel: 'mobile_money' }));

  // Stub the singletons the controller closes over.
  let captured: any = null;
  let overridesAnswer: string[] = [];
  let proofIsValid = true;
  const realCreate = refundRequestService.create.bind(refundRequestService);
  const realOverrides = refundEligibilityService.policyOverridesFor.bind(refundEligibilityService);
  const realIsProof = refundProofService.isRefundProof.bind(refundProofService);
  (refundRequestService as any).create = async (input: any) => {
    captured = input;
    return fakeRow({ requested_by: input.requestedBy });
  };
  (refundEligibilityService as any).policyOverridesFor = async () => overridesAnswer;
  (refundProofService as any).isRefundProof = async () => proofIsValid;

  try {
    await assertAsync('support + approveNow:true → the service is asked with approveNow:false', async () => {
      captured = null;
      const out = await drive(AdminRefundRequestController.create, { body: { ...canonicalCreate, approveNow: true } });
      return out.status === 201 && captured?.approveNow === false && captured?.requestedBy.role === 'support';
    });
    await assertAsync('requested_by.id is X-Actor-Id and the name is X-Actor-Name', async () => {
      captured = null;
      await drive(AdminRefundRequestController.create, { body: { ...canonicalCreate, requestedByRole: 'admin' } });
      return captured?.requestedBy.id === ADMIN_A && captured?.requestedBy.name === 'Alice';
    });
    await assertAsync('admin + approveNow:true is passed through (the service decides per R-2/R-7)', async () => {
      captured = null;
      await drive(AdminRefundRequestController.create, { body: { ...canonicalCreate, requestedByRole: 'admin', approveNow: true } });
      return captured?.approveNow === true;
    });
    await assertAsync('201 answers the camelCase DTO (id, status, gross/fee/net, channel, destination.source)', async () => {
      const out = await drive(AdminRefundRequestController.create, { body: canonicalCreate });
      const d = out.body?.data;
      return out.status === 201 && out.body?.success === true
        && typeof d?.id === 'string' && d.status === 'awaiting_approval'
        && d.grossAmount === 5000 && d.feeAmount === 100 && d.netAmount === 4900
        && 'channel' in d && d.destination?.source === 'payer';
    });
    await assertAsync('vendor-policy overrides without overridePolicy → 422 REFUND_POLICY_OVERRIDE_REQUIRED, nothing created', async () => {
      captured = null;
      overridesAnswer = ['return_window_expired'];
      const out = await drive(AdminRefundRequestController.create, { body: canonicalCreate });
      overridesAnswer = [];
      const e = out.error as AppError;
      return e instanceof AppError && e.code === ERROR_CODES.REFUND_POLICY_OVERRIDE_REQUIRED && e.statusCode === 422 && captured === null;
    });
    await assertAsync('…and with overridePolicy:true the request is created', async () => {
      captured = null;
      overridesAnswer = ['return_window_expired'];
      const out = await drive(AdminRefundRequestController.create, { body: { ...canonicalCreate, overridePolicy: true } });
      overridesAnswer = [];
      return out.status === 201 && captured?.overridePolicy === true;
    });
    await assertAsync('a typed destination whose proof is NOT a refund proof → 422, nothing created', async () => {
      captured = null;
      proofIsValid = false;
      const out = await drive(AdminRefundRequestController.create, {
        body: { ...canonicalCreate, requestedByRole: 'admin', destination: { phone: '+237677000000', name: 'J' }, destinationProofFileId: proofId },
      });
      proofIsValid = true;
      const e = out.error as AppError;
      return e instanceof AppError && e.code === ERROR_CODES.REFUND_DESTINATION_PROOF_REQUIRED && e.statusCode === 422 && captured === null;
    });
    await assertAsync('an unknown body key never reaches the service (400 ZodError)', async () => {
      captured = null;
      const out = await drive(AdminRefundRequestController.create, { body: { ...canonicalCreate, status: 'approved' } });
      return out.error !== undefined && (out.error as any)?.name === 'ZodError' && captured === null;
    });
    await assertAsync('settle-external with a non-refund-proof → 422 REFUND_EXTERNAL_PROOF_REQUIRED', async () => {
      proofIsValid = false;
      const out = await drive(AdminRefundRequestController.settleExternal, {
        params: { id: new Types.ObjectId().toHexString() },
        body: { method: 'cash', proofFileId: proofId },
      });
      proofIsValid = true;
      const e = out.error as AppError;
      return e instanceof AppError && e.code === ERROR_CODES.REFUND_EXTERNAL_PROOF_REQUIRED && e.statusCode === 422;
    });
  } finally {
    (refundRequestService as any).create = realCreate;
    (refundEligibilityService as any).policyOverridesFor = realOverrides;
    (refundProofService as any).isRefundProof = realIsProof;
  }

  assert('source: the controller forces approveNow false for Support', () =>
    /approveNow:\s*body\.requestedByRole === 'admin' && body\.approveNow === true/.test(proofCtl));
  assert('source: the approver passed to approve() is the caller (X-Actor-Id), never a body field', () =>
    /refundRequestService\.approve\(id,\s*actorOf\(req\)\)/.test(proofCtl));

  // The override rule is the vendor's own pure rule, reused (one definition, three readers).
  const order: any = { payment_status: 'paid', currency: 'XAF', delivered_at: new Date(Date.now() - 30 * 86_400_000) };
  const policy: any = { return_eligible: true, refund_type: 'full', return_window_days: 7, refund_processing_days: 3 };
  assert('policyOverridesOf: a closed return window is reported', () =>
    policyOverridesOf(order, policy, { remaining: 5000, currency: 'XAF' }, 5000).includes('return_window_expired'));
  assert('policyOverridesOf: no policy at all → policy_disabled', () =>
    policyOverridesOf(order, null, { remaining: 5000, currency: 'XAF' }, 5000).includes('policy_disabled'));
  assert('policyOverridesOf: within a partial policy\'s fraction → none; above it → above_policy_maximum', () => {
    const fresh: any = { ...order, delivered_at: new Date() };
    const partial: any = { ...policy, refund_type: 'partial', refund_percentage: 50 };
    return policyOverridesOf(fresh, partial, { remaining: 5000, currency: 'XAF' }, 2500).length === 0
      && policyOverridesOf(fresh, partial, { remaining: 5000, currency: 'XAF' }, 3000).includes('above_policy_maximum');
  });

  originalConsole.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  originalConsole.error(err);
  process.exit(1);
});
