import * as crypto from 'crypto';
import { getApps, initializeApp, cert } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';
import { Bucket } from '@google-cloud/storage';
import { IStorageProvider, StoragePutOptions, StoragePutResult } from '../storage-provider.interface';
import { FirebaseStorageConfig } from '../storage.config';
import { createAppError } from '../../errors';
import { ERROR_CODES } from '../../error-codes';

/**
 * Firebase Storage Provider
 * 
 * Stores files in Firebase Cloud Storage using Firebase Admin SDK.
 * 
 * File structure: {folder}/{yyyy}/{mm}/{uuid}.{ext}
 * 
 * Features:
 * - Public or signed URL generation
 * - Automatic content-type detection
 * - Idempotent deletion
 * - Configurable bucket access
 */
export class FirebaseStorageProvider implements IStorageProvider {
  private bucket!: Bucket;
  private initialized: boolean = false;

  constructor(private readonly config: FirebaseStorageConfig) {
    this.initializeFirebase();
  }

  /**
   * ⚠ **False, and this is a real gap rather than a note about an unused method.**
   *
   * `getDownloadStream` throws below, and it is the mechanism behind BOTH private-file
   * paths on this platform — the digital-product download (`download-execution.service.ts`)
   * and the delivery-proof download (`delivery-proof.service.ts`). So a deployment that
   * switches `STORAGE_PROVIDER` to `firebase` breaks both, immediately, with a 501 that
   * reads as an internal fault rather than as a missing capability.
   *
   * `getSignedUrl` IS implemented here, so the fix when somebody needs it is to serve
   * those routes from a short-lived signed URL minted *inside* them — never one minted in
   * `getPublicUrl`, which has no idea who is asking (see `storage.factory.ts`).
   */
  supportsDownloadStream(): boolean {
    return false;
  }

  getDownloadStream(key: string): Promise<NodeJS.ReadableStream> {
    throw createAppError(ERROR_CODES.INTERNAL_SERVER_ERROR, 501, 'getDownloadStream is not implemented for Firebase Storage provider');
  }

  getBuffer(key: string): Promise<Buffer> {
    throw createAppError(ERROR_CODES.INTERNAL_SERVER_ERROR, 501, 'getBuffer is not implemented for Firebase Storage provider');
  }

  private initializeFirebase(): void {
    if (this.initialized) return;

    // Initialize Firebase Admin SDK
    // Check if already initialized to avoid errors
    if (!getApps().length) {
      initializeApp({
        credential: cert({
          projectId: this.config.projectId,
          clientEmail: this.config.clientEmail,
          privateKey: this.config.privateKey.replace(/\\n/g, '\n'), // Handle escaped newlines
        }),
        storageBucket: this.config.bucket,
      });
    }

    this.bucket = getStorage().bucket(this.config.bucket);
    this.initialized = true;
  }

  async put(buffer: Buffer, options: StoragePutOptions): Promise<StoragePutResult> {
    const now = new Date();
    const year = now.getFullYear().toString();
    const month = (now.getMonth() + 1).toString().padStart(2, '0');

    // Generate unique filename
    const uuid = crypto.randomUUID();
    const extension = this.getExtensionFromMimeType(options.mimeType);
    const filename = options.filename
      ? `${uuid}_${this.sanitizeFilename(options.filename)}`
      : `${uuid}${extension}`;

    // Construct path: {folder}/{yyyy}/{mm}/{filename}
    const key = `${options.folder}/${year}/${month}/${filename}`;

    // Create file reference
    const file = this.bucket.file(key);

    // Upload buffer
    await file.save(buffer, {
      metadata: {
        contentType: options.mimeType,
        metadata: {
          firebaseStorageDownloadTokens: crypto.randomUUID(), // For public URLs
        },
      },
      resumable: false,
    });

    // If public access is enabled, make file public
    if (this.config.public) {
      await file.makePublic();
    }

    // Calculate checksum
    const checksum = crypto.createHash('sha256').update(buffer).digest('hex');

    return {
      key,
      size: buffer.length,
      mimeType: options.mimeType,
      checksum,
    };
  }

  async delete(key: string): Promise<void> {
    try {
      const file = this.bucket.file(key);
      await file.delete();
    } catch (error: any) {
      // Idempotent: ignore if file doesn't exist (404)
      if (error.code !== 404) {
        throw createAppError(ERROR_CODES.STORAGE_DELETE_FAILED, 500, `Firebase Storage delete failed: ${error.message}`);
      }
    }
  }

  getPublicUrl(key: string): string {
    if (this.config.public) {
      // Public bucket: construct public URL
      return `https://storage.googleapis.com/${this.config.bucket}/${key}`;
    } else {
      // Private bucket: return storage URL (would need signed URL in production)
      // Note: For private files, implement getSignedUrl() method
      return `https://firebasestorage.googleapis.com/v0/b/${this.config.bucket}/o/${encodeURIComponent(key)}?alt=media`;
    }
  }

  async getSignedUrl(key: string, expiresInSeconds: number): Promise<string> {
    const file = this.bucket.file(key);
    const [url] = await file.getSignedUrl({
      action: 'read',
      expires: Date.now() + expiresInSeconds * 1000,
    });
    return url;
  }

  /**
   * Sanitize filename
   */
  private sanitizeFilename(filename: string): string {
    return filename
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .replace(/\.+/g, '.')
      .replace(/^\./, '')
      .substring(0, 100);
  }

  /**
   * Get file extension from MIME type
   */
  private getExtensionFromMimeType(mimeType: string): string {
    const mimeMap: Record<string, string> = {
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/gif': '.gif',
      'image/webp': '.webp',
      'image/svg+xml': '.svg',
      'application/pdf': '.pdf',
      'application/zip': '.zip',
      'video/mp4': '.mp4',
      'audio/mpeg': '.mp3',
      'text/plain': '.txt',
    };

    return mimeMap[mimeType] || '';
  }

  getProviderType(): 'firebase' {
    return 'firebase';
  }
}
