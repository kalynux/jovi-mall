import sharp from 'sharp';
import { IUploadProcessor, UploadPipelineContext } from '../upload-policy.types';
import { UploadPolicyConfig } from '../upload-config';

/**
 * Image Resize Processor
 * 
 * Resizes images to configured maximum dimensions.
 * Preserves aspect ratio and only processes if image exceeds limits.
 */
export class ImageResizeProcessor implements IUploadProcessor {
  constructor(private readonly config: UploadPolicyConfig) {}

  async process(context: UploadPipelineContext): Promise<void> {
    context.addProcessingStep('ImageResize');

    for (const fileContext of context.files) {
      // Only process image files
      if (!fileContext.mimeType.startsWith('image/')) {
        continue;
      }

      // Check if this MIME type has resize config
      const mimeConfig = this.config.perMimeType[fileContext.mimeType];
      if (!mimeConfig?.transforms?.resize) {
        continue;
      }

      const { maxWidth, maxHeight } = mimeConfig.transforms.resize;

      try {
        const image = sharp(fileContext.buffer);
        const metadata = await image.metadata();

        // Store original dimensions if not already set
        if (!fileContext.dimensions && metadata.width && metadata.height) {
          fileContext.dimensions = {
            width: metadata.width,
            height: metadata.height,
          };
        }

        // Only resize if image exceeds max dimensions
        if (
          metadata.width &&
          metadata.height &&
          (metadata.width > maxWidth || metadata.height > maxHeight)
        ) {
          const resizedBuffer = await image
            .resize(maxWidth, maxHeight, {
              fit: 'inside', // Preserve aspect ratio
              withoutEnlargement: true,
            })
            .toBuffer();

          // Update file context with resized image
          fileContext.buffer = resizedBuffer;
          fileContext.size = resizedBuffer.length;
          fileContext.wasResized = true;

          // Update dimensions
          const resizedMetadata = await sharp(resizedBuffer).metadata();
          if (resizedMetadata.width && resizedMetadata.height) {
            fileContext.dimensions = {
              width: resizedMetadata.width,
              height: resizedMetadata.height,
            };
          }
        }

      } catch (error: any) {
        // Gracefully handle sharp errors (might not be installed or image corrupt)
        console.warn(`Image resize failed for ${fileContext.originalName}:`, error.message);
      }
    }
  }
}
