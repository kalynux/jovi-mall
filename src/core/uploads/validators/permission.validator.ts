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
 * - Validates vendorId matches context
 *
 * These rules attach to a folder's PURPOSE. A `'by-type'` request has no
 * purpose — it is general media intake, open to every authenticated role — so
 * there is nothing here to enforce; see `UploadFolderStrategy`.
 */
export class PermissionValidator implements IUploadValidator {
  constructor(private readonly config: UploadPolicyConfig) { }

  async validate(context: UploadPipelineContext): Promise<void> {
    const { role, vendorId } = context.request.context;
    const folder = context.request.folder;

    const denials: UploadPolicyViolation[] = [];

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
