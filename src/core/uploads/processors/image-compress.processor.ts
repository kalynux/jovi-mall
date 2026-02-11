import sharp from 'sharp';
import { IUploadProcessor, UploadPipelineContext } from '../upload-policy.types';
import { UploadPolicyConfig } from '../upload-config';

/**
 * Image Compress Processor
 * 
 * Compresses images using sharp quality settings.
 * Only processes if compress flag is enabled in config.
 */
export class ImageCompressProcessor implements IUploadProcessor {
  constructor(private readonly config: UploadPolicyConfig) {}

  async process(context: UploadPipelineContext): Promise<void> {
    context.addProcessingStep('ImageCompress');

    for (const fileContext of context.files) {
      // Only process image files
      if (!fileContext.mimeType.startsWith('image/')) {
        continue;
      }

      // Check if this MIME type has compress config
      const mimeConfig = this.config.perMimeType[fileContext.mimeType];
      if (!mimeConfig?.transforms?.compress) {
        continue;
      }

      try {
        const image = sharp(fileContext.buffer);
        let compressedBuffer: Buffer;

        // Apply compression based on current MIME type
        switch (fileContext.mimeType) {
          case 'image/jpeg':
            compressedBuffer = await image.jpeg({ quality: 85, progressive: true }).toBuffer();
            break;

          case 'image/webp':
            compressedBuffer = await image.webp({ quality: 80 }).toBuffer();
            break;

          case 'image/png':
            compressedBuffer = await image.png({ compressionLevel: 8, progressive: true }).toBuffer();
            break;

          default:
            // Unsupported format for compression
            continue;
        }

        // Only update if compression actually reduced size
        if (compressedBuffer.length < fileContext.buffer.length) {
          fileContext.buffer = compressedBuffer;
          fileContext.size = compressedBuffer.length;
          fileContext.wasCompressed = true;
        }

      } catch (error: any) {
        // Gracefully handle compression errors
        console.warn(`Image compression failed for ${fileContext.originalName}:`, error.message);
      }
    }
  }
}
