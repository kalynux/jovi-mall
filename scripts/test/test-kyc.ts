/**
 * Identity verification — the slot vocabulary, the lock, the role table, and the rule that
 * nothing here grades anything (no DB needed).
 *
 * ── Why the SOURCE SCANS are the spine of this suite ─────────────────────────
 * Two of the three things this module guarantees are invisible to a behavioural test.
 *
 * **"The backend evaluates nothing"** is a NEGATIVE property, and the failure mode is a
 * helpful future author adding a completeness check — at which point the feature still works,
 * every existing assertion still passes, and the administration dashboard silently acquires a
 * second opinion about what a finished submission looks like. The dashboard is where the
 * required/optional rules live by decision (owner, 2026-09-14); a copy here is not a bug until
 * the two disagree, and by then nobody remembers there were two.
 *
 * **"The documents are private"** rests entirely on one row in `STORAGE_TREE_VISIBILITY` and
 * on the upload naming `folder: 'kyc'`. Neither is observable from a response: a
 * misclassification produces a `FileDetail` with a working `url`, which looks like the feature
 * working better. That is the ADR-A01 D-2 failure exactly, on the most disclosing payload this
 * platform holds.
 *
 * Run: npm run test:kyc
 */

import * as fs from 'fs';
import * as path from 'path';
import { ZodError } from 'zod';
import {
    KYC_DOCUMENT_SLOTS,
    KYC_DOCUMENT_SLOT_NAMES,
    KYC_MULTI_SLOT_MAX_FILES,
    KycDocumentSlot,
    kycReferenceField,
    kycSlotField,
    kycSlotParamSchema,
} from '../../src/core/types/kyc-documents.types';
import { KYC_SUBJECTS, kycSubjectFor, KycRole } from '../../src/modules/identity-verification/domain/kyc-subject';
import { UpdateKycDetailsSchema } from '../../src/modules/identity-verification/validators/kyc.validator';
import { KYC_SLOT_DTO_KEYS, toKycAddressDto } from '../../src/modules/identity-verification/dto/kyc.dto';
import { isPrivateStorageKey, STORAGE_TREE_VISIBILITY } from '../../src/core/storage/storage-trees';
import { getKycDocumentUploadConfig } from '../../src/core/uploads/upload-config';
import { ERROR_CODES } from '../../src/core/error-codes';
import { DEFAULT_ERROR_MESSAGES } from '../../src/core/errors';

let passed = 0;
let failed = 0;

function assert(name: string, fn: () => boolean): void {
    let ok: boolean;
    try {
        ok = fn();
    } catch (err) {
        console.error(`  ❌ THROW: ${name} — ${(err as Error).message}`);
        failed++;
        return;
    }
    if (ok) {
        console.log(`  ✅ ${name}`);
        passed++;
    } else {
        console.error(`  ❌ FAIL: ${name}`);
        failed++;
    }
}

const ROOT = path.resolve(__dirname, '../..');
const MODULE = path.join(ROOT, 'src', 'modules', 'identity-verification');

/** Strip comments — a scan must not be satisfied, or defeated, by prose about the code. */
function code(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function read(...parts: string[]): string {
    return fs.readFileSync(path.join(MODULE, ...parts), 'utf8');
}

const SERVICE = read('services', 'kyc-submission.service.ts');
const SERVICE_CODE = code(SERVICE);
const ROUTES_CODE = code(read('routes', 'kyc.routes.ts'));
const DTO_CODE = code(read('dto', 'kyc.dto.ts'));

function main(): void {
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n▶ 1. The slot vocabulary is a closed, self-consistent contract');

    assert('six slots, and the names are the wire names', () =>
        KYC_DOCUMENT_SLOT_NAMES.length === 6
        && KYC_DOCUMENT_SLOT_NAMES.every((s) => /^[a-z][a-z_]*$/.test(s)));

    assert('every slot has a cardinality, and only two exist', () =>
        KYC_DOCUMENT_SLOT_NAMES.every((s) => ['single', 'multi'].includes(KYC_DOCUMENT_SLOTS[s])));

    assert('a multi slot backs an ARRAY field and a single slot a scalar one', () =>
        KYC_DOCUMENT_SLOT_NAMES.every((s) =>
            KYC_DOCUMENT_SLOTS[s] === 'multi'
                ? kycSlotField(s).endsWith('_file_ids')
                : kycSlotField(s).endsWith('_file_id')));

    /**
     * The `kyc_` prefix is not decoration. `file_references` is unique on
     * `(fileId, entityType, entityId, field)`, and an agent's `vehicle_with_agent` shares its
     * entity with the ordinary `vehicle_photo` already attached to that agent. Without the
     * prefix the two would collide on the same row.
     */
    assert('every reference field is prefixed, so none can collide with an existing slot', () =>
        KYC_DOCUMENT_SLOT_NAMES.every((s) => kycReferenceField(s) === `kyc_${s}`));

    assert('every slot has a DTO key, and no DTO key is orphaned', () =>
        KYC_DOCUMENT_SLOT_NAMES.every((s) => !!KYC_SLOT_DTO_KEYS[s])
        && Object.keys(KYC_SLOT_DTO_KEYS).length === KYC_DOCUMENT_SLOT_NAMES.length);

    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n▶ 2. The role table — what each role has, and what it must not');

    assert('all three roles are declared', () =>
        (['vendor', 'agency', 'agent'] as KycRole[]).every((r) => !!kycSubjectFor(r)));

    assert('every role names slots that exist in the vocabulary', () =>
        Object.values(KYC_SUBJECTS).every((s) =>
            s.slots.every((slot) => KYC_DOCUMENT_SLOT_NAMES.includes(slot))));

    assert('all three carry the identity trio — that is the shared core', () =>
        Object.values(KYC_SUBJECTS).every((s) =>
            (['id_card_front', 'id_card_back', 'selfie_with_id'] as KycDocumentSlot[])
                .every((slot) => s.slots.includes(slot))));

    /**
     * ⚠ The vehicle slot is the agent's alone, and the store-sketch slot is not theirs.
     *
     * Getting either backwards is silent: the field simply never appears on the DTO, the
     * upload route 400s on a slot the dashboard offers, and the screen looks like a client
     * bug.
     */
    assert('only the AGENT has the vehicle slot', () =>
        KYC_SUBJECTS.agent.slots.includes('vehicle_with_agent')
        && !KYC_SUBJECTS.vendor.slots.includes('vehicle_with_agent')
        && !KYC_SUBJECTS.agency.slots.includes('vehicle_with_agent'));

    assert('…and only the vendor and the agency have the store sketch', () =>
        KYC_SUBJECTS.vendor.slots.includes('store_address_sketch')
        && KYC_SUBJECTS.agency.slots.includes('store_address_sketch')
        && !KYC_SUBJECTS.agent.slots.includes('store_address_sketch'));

    /**
     * ⚠ `ownerType` stamps the uploaded File and decides whose plan storage cap is charged —
     * and `FileReferenceService.assertAttachable` compares it to the actor on every attach.
     * A role whose ownerType named a different party would bill the wrong account AND fail
     * every attach.
     */
    assert('ownerType tracks the role, so a document is owned by its own applicant', () =>
        (Object.entries(KYC_SUBJECTS) as [KycRole, typeof KYC_SUBJECTS.vendor][])
            .every(([role, s]) => s.ownerType === role && s.entityType === role));

    /**
     * ⚠ The agent's identity NUMBER is not in the KYC block. It has always lived on
     * `legal_identity`, beside the driving-licence number, and moving it would have renamed a
     * field the agent profile DTO already publishes.
     */
    assert('the agent reads its id number from legal_identity, the other two from kyc_details', () =>
        KYC_SUBJECTS.agent.idNumberPath === 'legal_identity.national_id_number'
        && KYC_SUBJECTS.vendor.idNumberPath === 'kyc_details.national_id_number'
        && KYC_SUBJECTS.agency.idNumberPath === 'kyc_details.national_id_number');

    /**
     * ⚠ An agency's premises are on the MAGAZIN, not on its own document — the Store/Magazin
     * split. This is the field that stops the admin read projecting the wrong collection, and
     * it is one of the two reasons that read is delegated rather than performed in wi-admin.
     */
    assert('the agency reads its premises from the magazin, and the agent has none', () =>
        KYC_SUBJECTS.agency.storeAddressSource === 'magazin.headquarters_addresses'
        && KYC_SUBJECTS.vendor.storeAddressSource === 'vendor.business_addresses'
        && KYC_SUBJECTS.agent.storeAddressSource === null);

    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n▶ 3. A slot outside the role is REFUSED, never silently ignored');

    assert('the agent schema rejects store_address_sketch', () => {
        try {
            kycSlotParamSchema(KYC_SUBJECTS.agent.slots).parse({ slot: 'store_address_sketch' });
            return false;
        } catch (err) {
            return err instanceof ZodError;
        }
    });

    assert('…and the vendor schema rejects vehicle_with_agent', () => {
        try {
            kycSlotParamSchema(KYC_SUBJECTS.vendor.slots).parse({ slot: 'vehicle_with_agent' });
            return false;
        } catch (err) {
            return err instanceof ZodError;
        }
    });

    assert('a slot the role DOES have parses', () =>
        kycSlotParamSchema(KYC_SUBJECTS.agent.slots).parse({ slot: 'vehicle_with_agent' }).slot
            === 'vehicle_with_agent');

    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n▶ 4. ⭐ THE BACKEND GRADES NOTHING (owner decision, 2026-09-14)');

    /**
     * The whole point of the module, asserted four ways because it is a negative property and
     * the natural instinct of the next author is to "finish" it by adding a check.
     */
    assert('every field on the details schema is optional — an empty body is legal', () => {
        const parsed = UpdateKycDetailsSchema.parse({});
        return parsed.idNumber === undefined && parsed.homeAddress === undefined;
    });

    assert('…and there is no .refine demanding at least one of them', () =>
        !/\.refine\(/.test(code(read('validators', 'kyc.validator.ts'))));

    /**
     * ⚠ `submit()` must not check completeness. An applicant who cannot submit an incomplete
     * record also cannot be TOLD by a human what is missing — which is the entire remedy the
     * review exists to provide.
     */
    assert('submit() runs no completeness check before stamping submitted_at', () => {
        const body = SERVICE_CODE.slice(SERVICE_CODE.indexOf('async submit('));
        const end = body.indexOf('async streamOwnDocument(');
        const submitBody = body.slice(0, end > 0 ? end : undefined);
        return /submitted_at/.test(submitBody)
            && !/\b(required|complete|isComplete|missing|incomplete)\b/i.test(submitBody);
    });

    /**
     * ⚠ The DTO must carry no verdict and no requirement column. The dashboard computes the
     * estimated-verdict badge and pre-populates the rejection reason; a second copy of those
     * rules here is the same policy in two repositories, and only one of them is owned by the
     * people who change their minds about it.
     */
    assert('the DTO declares no verdict, score or required column', () =>
        !/\b(estimatedVerdict|verdictEstimate|required\s*:|isComplete|completeness|score\s*:)/
            .test(DTO_CODE));

    /**
     * What it DOES carry: the facts the badge is computed FROM. `geocoded` is the one derived
     * field, and it is derivation rather than judgement — "has a `geo` object" and "has usable
     * coordinates" are different tests, and a client checking the first passes a half-written
     * legacy row.
     */
    assert('…but it does carry `geocoded`, which is a fact rather than a judgement', () =>
        /geocoded/.test(DTO_CODE));

    assert('a geocoded address reports geocoded: true with [lng, lat]', () => {
        const dto = toKycAddressDto(
            {
                formatted_address: 'Akwa, Douala, Cameroon',
                coordinates: { type: 'Point', coordinates: [9.7, 4.05] },
                provider: 'locationiq',
                provider_place_id: null,
                components: {} as never,
                raw_input: null,
                resolved_at: new Date(),
            } as never,
            'Home',
        );
        return dto.geocoded === true
            && dto.coordinates?.[0] === 9.7
            && dto.coordinates?.[1] === 4.05
            && dto.provider === 'locationiq';
    });

    assert('a null address reports geocoded: false and null coordinates', () => {
        const dto = toKycAddressDto(null, 'Main Shop', '12 Rue Njo-Njo, Douala');
        return dto.geocoded === false
            && dto.coordinates === null
            && dto.formattedAddress === '12 Rue Njo-Njo, Douala';
    });

    /**
     * ⚠ The case that made this function defensive: a `geo` object whose coordinate array is
     * absent. It is exactly the row that must report `geocoded: false` rather than throwing on
     * the read that was supposed to reveal it.
     */
    assert('a half-written legacy geo reports geocoded: false rather than throwing', () => {
        const dto = toKycAddressDto({ formatted_address: 'Somewhere' } as never, null);
        return dto.geocoded === false && dto.coordinates === null;
    });

    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n▶ 5. ⭐ The documents are PRIVATE, and the tree is the whole mechanism');

    assert('the kyc tree is classified private', () =>
        STORAGE_TREE_VISIBILITY.kyc === 'private');

    assert('…so a kyc key is refused a public URL', () =>
        isPrivateStorageKey('kyc/2026/09/abc_id-front.jpg')
        && isPrivateStorageKey('kyc\\2026\\09\\abc_id-front.jpg'));

    /**
     * ⚠ The classification only helps if the upload actually lands there. `folder: 'kyc'` is
     * the single line that puts it in the tree, and a `'by-type'` upload here would file an
     * identity card in `images/` — beside public product photography, with a working URL.
     */
    assert('the upload names the kyc folder, and nothing else', () =>
        /folder:\s*'kyc'/.test(SERVICE_CODE)
        && !/folder:\s*'by-type'/.test(SERVICE_CODE));

    assert('the service never builds a URL of its own', () =>
        !/getPublicUrl/.test(SERVICE_CODE));

    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n▶ 6. The upload policy accepts a scan in either form it arrives in');

    const config = getKycDocumentUploadConfig();

    /**
     * ⚠ PDF and images together. A scan comes off a phone as a JPEG and out of a scanner app
     * as a PDF; refusing either half pushes applicants into converting files, which is the
     * step at which a legible document becomes an illegible one.
     */
    assert('jpeg, png, webp and pdf are all allowed', () =>
        ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
            .every((m) => config.perMimeType[m]?.allowed === true));

    /** ⚠ A PDF must be stored as received — transforms are an image concept. */
    assert('the PDF policy carries NO transforms', () =>
        config.perMimeType['application/pdf'].transforms === undefined);

    /**
     * ⚠ 3000px rather than the delivery proof's 2048. An identity number and a sketch's street
     * names are small features; a reviewer who cannot read the digits has been handed a file
     * that satisfies the checklist and proves nothing.
     */
    assert('images are resized no smaller than 3000px', () =>
        ['image/jpeg', 'image/png', 'image/webp'].every((m) =>
            (config.perMimeType[m].transforms?.resize?.maxWidth ?? 0) >= 3000));

    /**
     * ⚠ PNG is NOT converted to webp here, unlike the delivery-proof config. This is evidence
     * somebody may have to produce later; re-encoding it through a lossy format to save a few
     * kilobytes is a bad trade at this size.
     */
    assert('…and a PNG is not re-encoded to webp', () =>
        config.perMimeType['image/png'].transforms?.convertTo === undefined);

    /** Two applicants must never share one File record — deleting one would delete both. */
    assert('duplicate collapsing is OFF', () =>
        config.duplicateDetection.enabled === false);

    assert('the applicant’s own plan storage cap is enforced', () =>
        config.userQuotas.enabled === true);

    assert('the request cap matches the multi-slot cap — one slot can arrive at once', () =>
        config.maxFilesPerRequest === KYC_MULTI_SLOT_MAX_FILES);

    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n▶ 7. The lock — what freezes, and what deliberately does not');

    /**
     * ⚠ The load-bearing half is `verified`. Without it an approved applicant swaps the
     * identity card an administrator approved for somebody else's and keeps the verdict.
     */
    assert('a verified record is locked', () => /=== 'verified'\) return true/.test(SERVICE_CODE));

    /**
     * ⚠ `rejected` is deliberately NOT locked. A refusal the applicant cannot respond to is a
     * dead end, and re-submitting is the whole remedy. Tidying this branch away locks out
     * precisely the people the review told to try again.
     */
    assert('…a REJECTED record is not — that is the remedy, not a leak', () =>
        /=== 'rejected'\) return false/.test(SERVICE_CODE));

    assert('…and an unsubmitted draft is not', () =>
        /return Boolean\(block\?\.submitted_at\)/.test(SERVICE_CODE));

    /** Every write path must consult it — a lock one endpoint skips is not a lock. */
    assert('all four writes assert the lock', () =>
        (SERVICE_CODE.match(/this\.assertUnlocked\(/g) ?? []).length >= 4);

    /**
     * ⚠ And the byte read must NOT. An applicant whose record is frozen under review still has
     * to be able to see what they submitted — that is the screen the review is about.
     */
    assert('…and streamOwnDocument does not, so a frozen record is still readable', () => {
        const body = SERVICE_CODE.slice(SERVICE_CODE.indexOf('async streamOwnDocument('));
        const end = body.indexOf('private async loadDocument');
        return !/assertUnlocked/.test(body.slice(0, end > 0 ? end : undefined));
    });

    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n▶ 8. The routes are self-scoped, and ordered');

    /**
     * ⚠ No id in any path. Every handler reads `req.auth.role_entity._id`, so there is no way
     * to address somebody else's documents — which is the authorization, on a surface whose
     * payload is a photograph of a person holding their identity card.
     */
    assert('no route declares an entity id — scoping is the session', () =>
        !/:vendorId|:agencyId|:agentId/.test(ROUTES_CODE));

    assert('both guards are attached', () =>
        /router\.use\(requireAuth\)/.test(ROUTES_CODE)
        && /router\.use\(requireRole\(\[role\]\)\)/.test(ROUTES_CODE));

    /**
     * ⚠ `/documents/:fileId/content` must be declared ABOVE `/documents/:slot`, or Express
     * parses `content` as a slot name. Different segment counts save it today; the ordering is
     * asserted anyway because this service has been bitten by route order twice.
     */
    assert('the content route is declared above the slot routes', () =>
        ROUTES_CODE.indexOf("'/documents/:fileId/content'")
            < ROUTES_CODE.indexOf("'/documents/:slot'"));

    /**
     * ⚠ A FACTORY, never one shared Router. `router.use(requireRole([role]))` would re-run on
     * every mount of a shared instance, so an agent would have to be a vendor as well.
     */
    assert('it is a factory taking the role', () =>
        /export function buildKycRouter\(role: KycRole\)/.test(ROUTES_CODE));

    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n▶ 9. Error codes exist and none renders the generic message');

    const codes = [
        ERROR_CODES.KYC_SUBJECT_NOT_FOUND,
        ERROR_CODES.KYC_SLOT_UNKNOWN,
        ERROR_CODES.KYC_LOCKED,
        ERROR_CODES.KYC_SLOT_FULL,
        ERROR_CODES.KYC_DOCUMENT_NOT_FOUND,
        ERROR_CODES.KYC_FILE_REQUIRED,
    ];

    assert('all six codes are registered', () => codes.every((c) => typeof c === 'string' && !!c));

    /**
     * `test:errors` § 8's rule, applied here at the source: a refusal with no registry default
     * renders "An unexpected error occurred", which tells the applicant nothing and sends an
     * operator looking for an outage that is not happening.
     */
    assert('…and each carries a default message of its own', () =>
        codes.every((c) => {
            const message = DEFAULT_ERROR_MESSAGES[c];
            return typeof message === 'string' && message.length > 0;
        }));

    /**
     * ⚠ There is deliberately NO "your submission is incomplete" code. Its existence would be
     * the first sign the grading rule had migrated here from the dashboard.
     */
    assert('there is no completeness/incomplete error code', () =>
        !Object.keys(ERROR_CODES).some((k) => /^KYC_.*(INCOMPLETE|MISSING|REQUIRED_FIELD)/.test(k)));

    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n════════════════════════════════════════════════════════════');
    console.log(`  ${passed} passed, ${failed} failed`);
    console.log('════════════════════════════════════════════════════════════\n');

    if (failed > 0) process.exit(1);
}

main();
