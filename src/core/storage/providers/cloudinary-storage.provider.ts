import * as crypto from 'crypto';
import { v2 as cloudinary, UploadApiResponse } from 'cloudinary';
import { IStorageProvider, StoragePutOptions, StoragePutResult } from '../storage-provider.interface';
import { CloudinaryStorageConfig } from '../storage.config';

/**
 * Cloudinary Storage Provider
 * 
 * Stores files in Cloudinary cloud storage using their official Node.js SDK.
 * 
 * File structure: {folderPrefix}/{folder}/{yyyy}/{mm}/{publicId}
 * 
 * Features:
 * - Automatic folder organization
 * - Public URL generation via Cloudinary CDN
 * - Idempotent deletion
 * - Deterministic public IDs
 */
export class CloudinaryStorageProvider implements IStorageProvider {
  constructor(private readonly config: CloudinaryStorageConfig) {
    // Configure Cloudinary SDK
    cloudinary.config({
      cloud_name: config.cloudName,
      api_key: config.apiKey,
      api_secret: config.apiSecret,
    });
  }

  getSignedUrl?(key: string, expiresInSeconds: number): Promise<string> {
    throw new Error("Method not implemented.");
  }

  getDownloadStream(key: string): Promise<NodeJS.ReadableStream> {
    throw new Error("Method not implemented.");
  }

  getBuffer(key: string): Promise<Buffer> {
    throw new Error("Method not implemented.");
  }

  async put(buffer: Buffer, options: StoragePutOptions): Promise<StoragePutResult> {
    const now = new Date();
    const year = now.getFullYear().toString();
    const month = (now.getMonth() + 1).toString().padStart(2, '0');

    // Generate deterministic but unique public ID
    const uuid = crypto.randomUUID();
    const publicId = options.filename
      ? `${uuid}_${this.sanitizeFilename(options.filename)}`
      : uuid;

    // Construct folder path: {folderPrefix}/{folder}/{yyyy}/{mm}
    const folder = `${this.config.folderPrefix}/${options.folder}/${year}/${month}`;

    return new Promise<StoragePutResult>((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder,
          public_id: publicId,
          resource_type: 'auto',
          invalidate: true, // Invalidate CDN cache on upload
        },
        (error, result: UploadApiResponse | undefined) => {
          if (error) {
            reject(new Error(`Cloudinary upload failed: ${error.message}`));
            return;
          }

          if (!result) {
            reject(new Error('Cloudinary upload failed: no result returned'));
            return;
          }

          // Key is the full public_id (includes folder)
          const key = result.public_id;

          resolve({
            key,
            size: result.bytes,
            mimeType: options.mimeType,
            checksum: result.etag, // Cloudinary provides etag
          });
        }
      );

      // Write buffer to upload stream
      uploadStream.end(buffer);
    });
  }

  async delete(key: string): Promise<void> {
    try {
      await cloudinary.uploader.destroy(key, { invalidate: true });
    } catch (error: any) {
      // Idempotent: if resource doesn't exist, Cloudinary returns success
      // Only throw on actual errors
      if (error.http_code !== 404) {
        throw new Error(`Cloudinary delete failed: ${error.message}`);
      }
    }
  }

  getPublicUrl(key: string): string {
    // Use Cloudinary URL builder for consistent URL generation
    return cloudinary.url(key, {
      secure: true,
      fetch_format: 'auto',
      quality: 'auto',
    });
  }

  /**
   * Sanitize filename for use in public ID
   */
  private sanitizeFilename(filename: string): string {
    // Remove extension (Cloudinary handles it)
    const nameWithoutExt = filename.replace(/\.[^.]+$/, '');

    return nameWithoutExt
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .replace(/\.+/g, '.')
      .replace(/^\./, '')
      .substring(0, 100);
  }

  getProviderType(): 'cloudinary' {
    return 'cloudinary';
  }
}
