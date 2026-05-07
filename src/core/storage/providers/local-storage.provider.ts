import * as path from 'path';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import { IStorageProvider, StoragePutOptions, StoragePutResult } from '../storage-provider.interface';
import { LocalStorageConfig } from '../storage.config';
import { createAppError } from '../../errors';
import { ERROR_CODES } from '../../error-codes';

/**
 * Local Filesystem Storage Provider
 * 
 * Stores files on local disk in a structured folder hierarchy.
 * Suitable for development and single-server deployments.
 * 
 * File structure: {basePath}/{folder}/{yyyy}/{mm}/{uuid}.{ext}
 * 
 * Features:
 * - Automatic directory creation
 * - SHA-256 checksums
 * - Idempotent deletion
 * - Deterministic file paths
 */
export class LocalStorageProvider implements IStorageProvider {
  constructor(private readonly config: LocalStorageConfig) { }

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
    const relativePath = path.join(options.folder, year, month, filename);
    const fullPath = path.join(this.config.basePath, relativePath);

    // Ensure directory exists
    const directory = path.dirname(fullPath);
    await fs.mkdir(directory, { recursive: true });

    // Write file
    await fs.writeFile(fullPath, buffer);

    // Calculate SHA-256 checksum
    const checksum = crypto.createHash('sha256').update(buffer).digest('hex');

    // Normalize key to forward slashes for cross-platform consistency
    const key = relativePath.replace(/\\/g, '/');

    return {
      key,
      size: buffer.length,
      mimeType: options.mimeType,
      checksum,
    };
  }

  async delete(key: string): Promise<void> {
    const filePath = path.join(this.config.basePath, key);
    try {
      await fs.unlink(filePath);
    } catch (error: any) {
      // Idempotent: ignore if file doesn't exist
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  }


  getPublicUrl(key: string): string {
    // Normalize key to forward slashes and construct URL
    const normalizedKey = key.replace(/\\/g, '/');
    return `${this.config.baseUrl}/${normalizedKey}`;
  }

  async getDownloadStream(key: string): Promise<NodeJS.ReadableStream> {
    const filePath = path.join(this.config.basePath, key);
    const fs = await import('fs');

    // Check if file exists
    try {
      await import('fs/promises').then(fsp => fsp.access(filePath));
    } catch (error) {
      throw createAppError(ERROR_CODES.STORAGE_FILE_NOT_FOUND, 404, `File not found: ${key}`);
    }

    return fs.createReadStream(filePath);
  }

  async getBuffer(key: string): Promise<Buffer> {
    const filePath = path.join(this.config.basePath, key);
    try {
      return await fs.readFile(filePath);
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        throw createAppError(ERROR_CODES.STORAGE_FILE_NOT_FOUND, 404, `File not found: ${key}`);
      }
      throw error;
    }
  }

  /**
   * Sanitize filename to prevent directory traversal and invalid characters
   */
  private sanitizeFilename(filename: string): string {
    return filename
      .replace(/[^a-zA-Z0-9._-]/g, '_') // replace invalid chars
      .replace(/\.+/g, '.')             // collapse multiple dots
      .replace(/^\./, '')                // remove leading dot
      .substring(0, 100);                // limit length
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

  getProviderType(): 'local' {
    return 'local';
  }
}
