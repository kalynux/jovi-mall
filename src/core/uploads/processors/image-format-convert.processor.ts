import sharp from 'sharp';
import { IUploadProcessor, UploadPipelineContext } from '../upload-policy.types';
import { UploadPolicyConfig } from '../upload-config';

/**
 * Image Format Convert Processor
 * 
 * Converts images to specified format (webp, jpeg, png).
 * Updates mimeType after conversion.
 */
export class ImageFormatConvertProcessor implements IUploadProcessor {
  constructor(private readonly config: UploadPolicyConfig) {}

  async process(context: UploadPipelineContext): Promise<void> {
    context.addProcessingStep('ImageFormatConvert');

    for (const fileContext of context.files) {
      // Only process image files
      if (!fileContext.mimeType.startsWith('image/')) {
        continue;
      }

      // Check if this MIME type has conversion config
      const mimeConfig = this.config.perMimeType[fileContext.mimeType];
      const targetFormat = mimeConfig?.transforms?.convertTo;
      
      if (!targetFormat) {
        continue;
      }

      try {
        let convertedBuffer: Buffer;
        let newMimeType: string;

        const image = sharp(fileContext.buffer);

        switch (targetFormat) {
          case 'webp':
            convertedBuffer = await image.webp({ quality: 80 }).toBuffer();
            newMimeType = 'image/webp';
            break;

          case 'jpeg':
            convertedBuffer = await image.jpeg({ quality: 85 }).toBuffer();
            newMimeType = 'image/jpeg';
            break;

          case 'png':
            convertedBuffer = await image.png({ compressionLevel: 8 }).toBuffer();
            newMimeType = 'image/png';
            break;

          default:
            // Unknown format, skip
            continue;
        }

        // Update file context with converted image
        fileContext.buffer = convertedBuffer;
        fileContext.size = convertedBuffer.length;
        fileContext.mimeType = newMimeType;
        fileContext.wasConverted = true;

      } catch (error: any) {
        // Gracefully handle conversion errors
        console.warn(`Image format conversion failed for ${fileContext.originalName}:`, error.message);
      }
    }
  }
}
