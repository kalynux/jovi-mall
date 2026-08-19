import { IUploadValidator, UploadPipelineContext, UploadPolicyViolation } from '../upload-policy.types';
import { createAppError } from '../../errors';
import { ERROR_CODES } from '../../error-codes';
import { UploadPolicyConfig } from '../upload-config';

/**
 * Permission Validator
 *
 * Enforces role-based access control for file uploads.
 *
 * Rules:
 * - Only vendors can upload to products, variants, digital folders
 * - Only admins can upload to system folder
 * - A policy-document folder must match the owner it is stamped for
 * - Validates vendorId matches context
 *
 * These rules attach to a folder's PURPOSE. A `'by-type'` request has no
 * purpose — it is general media intake, open to every authenticated role — so
 * there is nothing here to enforce; see `UploadFolderStrategy`.
 */
export class PermissionValidator implements IUploadValidator {
  constructor(private readonly config: UploadPolicyConfig) { }

  async validate(context: UploadPipelineContext): Promise<void> {
    const { role, vendorId, ownerType } = context.request.context;
    const folder = context.request.folder;

    const denials: UploadPolicyViolation[] = [];

    /**
     * Policy documents: the tree must match the owner it is being stamped for.
     *
     * ⚠ This rule is keyed on `ownerType`, NOT on `role`, and that is forced rather than
     * chosen: the pipeline's `UserRole` is only `admin | vendor | user`, so it cannot tell an
     * agency from a customer — every non-vendor caller arrives as `'user'`. `ownerType` is
     * the identity the File is actually stamped with, so it is both the meaningful thing to
     * check and the one the tree has to agree with.
     *
     * Without it these two folders would join the "not named here, therefore allowed"
     * bucket, which is a denylist's default and is how a purpose folder ends up with no
     * purpose rule. The HTTP routes are role-guarded either way; this is the layer that
     * catches a caller writing a vendor's document into the agency's tree.
     */
    const POLICY_DOCUMENT_OWNERS: Record<string, string> = {
      'vendor-policy-documents': 'vendor',
      'agency-policy-documents': 'agency',
    };
    const requiredOwner = POLICY_DOCUMENT_OWNERS[folder];
    if (requiredOwner && ownerType !== requiredOwner) {
      denials.push({
        code: 'PERMISSION_DENIED',
        message: `The ${folder} folder is for ${requiredOwner} uploads`,
        metadata: { role, folder, ownerType: ownerType ?? null },
      });
    }

    // System folder - only admins
    if (folder === 'system' && role !== 'admin') {
      denials.push({
        code: 'PERMISSION_DENIED',
        message: 'Only admins can upload to system folder',
        metadata: { role, folder },
      });
    }

    // Product/variant/digital folders - only vendors and admins
    if (['products', 'variants', 'digital'].includes(folder)) {
      if (role === 'user') {
        denials.push({
          code: 'PERMISSION_DENIED',
          message: `Role '${role}' cannot upload to ${folder} folder`,
          metadata: { role, folder },
        });
      }

      // Vendors must have vendorId
      if (role === 'vendor' && !vendorId) {
        denials.push({
          code: 'PERMISSION_DENIED',
          message: 'Vendor uploads require vendorId',
          metadata: { role, folder },
        });
      }
    }

    // Throw only on OUR OWN denials. Violations already in the context come from
    // the sniffing processor (mismatched/undetectable type) — reporting those as
    // "permissions violated" pointed every diagnosis at the wrong rule; they are
    // raised by the engine's final check instead, under their own codes.
    if (denials.length > 0) {
      context.addViolations(denials);
      throw createAppError(
        ERROR_CODES.UPLOAD_POLICY_VIOLATION,
        400,
        'Upload policy permissions violated',
        { violations: context.violations }
      );
    }
  }
}
