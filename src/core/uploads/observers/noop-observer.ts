import { IUploadObserver } from '../upload-policy.types';

/**
 * Noop Observer
 * 
 * No-op implementation for when observability is disabled.
 * All methods are empty stubs.
 */
export class NoopObserver implements IUploadObserver {
  // All methods are optional in the interface, so this is a valid implementation
}
