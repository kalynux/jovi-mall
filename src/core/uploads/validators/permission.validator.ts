import { IUploadValidator, UploadPipelineContext } from '../upload-policy.types';
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
 */
export class PermissionValidator implements IUploadValidator {
  constructor(private readonly config: UploadPolicyConfig) { }

  async validate(context: UploadPipelineContext): Promise<void> {
    const { role, vendorId } = context.request.context;
    const folder = context.request.folder;

    // System folder - only admins
    if (folder === 'system' && role !== 'admin') {
      context.addViolation({
        code: 'PERMISSION_DENIED',
        message: 'Only admins can upload to system folder',
        metadata: { role, folder },
      });
    }

    // Product/variant/digital folders - only vendors and admins
    if (['products', 'variants', 'digital'].includes(folder)) {
      if (role === 'user') {
        context.addViolation({
          code: 'PERMISSION_DENIED',
          message: `Role '${role}' cannot upload to ${folder} folder`,
          metadata: { role, folder },
        });
      }

      // Vendors must have vendorId
      if (role === 'vendor' && !vendorId) {
        context.addViolation({
          code: 'PERMISSION_DENIED',
          message: 'Vendor uploads require vendorId',
          metadata: { role, folder },
        });
      }
    }

    // Throw if violations found
    if (context.hasViolations()) {
      throw createAppError(
        ERROR_CODES.UPLOAD_POLICY_VIOLATION,
        400,
        'Upload policy permissions violated',
        { violations: context.violations }
      );
    }
  }
}
