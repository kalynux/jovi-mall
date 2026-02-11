# Upload Security Layer

**Policy-driven, bank-grade file intake security system** with MIME type detection, fingerprinting, virus scanning, quotas, and image processing.

## 🛡️ Security Architecture

This module implements **defense in depth** with 6 security layers:

1. **MIME Type Detection** - Detects real file type from buffer magic bytes (prevents spoofing)
2. **Fingerprinting** - SHA256 hash computation for duplicate detection
3. **Permission Validation** - Role-based access control
4. **Policy Validation** - File count, size, and type limits
5. **Virus Scanning** - Pluggable scanner architecture
6. **Quota Enforcement** - User/vendor storage limits

## 🚫 Critical Security Rule

**NEVER call `storageProvider.put()` directly.**

All file uploads **MUST** go through `UploadIntakeService`. This is enforced by architecture, not convention.

---

## 📦 Quick Start

### Installation

```bash
npm install sharp file-type
```

### Basic Usage

```typescript
import { UploadIntakeService, getDefaultUploadConfig, LoggingObserver, MockScanner } from '@/core/uploads';
import { storageProvider } from '@/core/storage';
import { fileRepository } from '@/modules/catalog/repositories';

// Initialize service
const config = getDefaultUploadConfig();
const observer = new LoggingObserver('info');
const virusScanner = new MockScanner();

const uploadIntakeService = new UploadIntakeService(
  config,
  storageProvider,
  fileRepository,
  observer,
  virusScanner
);

// Upload files
const files = await uploadIntakeService.execute({
  context: {
    userId: 'user123',
    vendorId: 'vendor456',
    role: 'vendor',
  },
  files: [
    {
      buffer: imageBuffer,
      mimeType: 'image/jpeg',  // Client-provided (will be verified)
      originalName: 'product.jpg',
    },
  ],
  folder: 'products',
});
```

---

## 🔧 Configuration

### Default Config

```typescript
import { get DefaultUploadConfig } from '@/core/uploads';

const config = getDefaultUploadConfig();
// Returns config with sensible defaults:
// - Max 10 files per request
// - Max 100MB total per request
// - Image size limits: 10MB, auto-resize to 2048x2048
// - SHA256 fingerprinting enabled
// - Duplicate detection enabled
// - Mock virus scanner
```

### Custom Config

```typescript
const customConfig: UploadPolicyConfig = {
  maxFilesPerRequest: 5,
  maxTotalSizeBytes: 50 * 1024 * 1024, // 50MB

  perMimeType: {
    'image/jpeg': {
      allowed: true,
      maxSizeBytes: 5 * 1024 * 1024,
      transforms: {
        resize: { maxWidth: 1024, maxHeight: 1024 },
        compress: true,
      },
    },
    'application/pdf': {
      allowed: true,
      maxSizeBytes: 10 * 1024 * 1024,
    },
  },

  virusScan: {
    enabled: true,
    provider: 'clamav', // or 'mock'
    blockOnFailure: true,
  },

  userQuotas: {
    enabled: true,
    maxFilesTotal: 500,
    maxStorageBytes: 2 * 1024 * 1024 * 1024, // 2GB
  },

  fingerprinting: {
    algorithm: 'sha256',
    enabled: true,
  },

  duplicateDetection: {
    enabled: true,
    blockDuplicates: false, // Return existing file reference
  },

  observability: {
    enabled: true,
    logLevel: 'info',
  },
};
```

### Environment Variables

```bash
UPLOAD_MAX_FILES_PER_REQUEST=10
UPLOAD_MAX_TOTAL_SIZE_BYTES=104857600
UPLOAD_VIRUS_SCAN_ENABLED=true
UPLOAD_VIRUS_SCAN_PROVIDER=mock
UPLOAD_USER_QUOTAS_ENABLED=true
UPLOAD_FINGERPRINTING_ENABLED=true
UPLOAD_DUPLICATE_DETECTION_ENABLED=true
UPLOAD_OBSERVABILITY_ENABLED=true
UPLOAD_LOG_LEVEL=info
```

---

## 🔍 Pipeline Flow

```
[Request] 
    ↓
[UploadIntakeService]
    ↓
[Create PipelineContext]
    ↓
┌─────────────────────────────┐
│   VALIDATION PHASE          │
├─────────────────────────────┤
│ 1. FileSniffingProcessor    │ ← Detect real MIME type (SECURITY CRITICAL)
│ 2. FileFingerprintProcessor  │ ← Compute SHA256 hash
│ 3. PermissionValidator       │ ← Check role-based access
│ 4. FileCountValidator        │ ← Enforce max files limit
│ 5. MimeTypeValidator         │ ← Validate against detected MIME
│ 6. FileSizeValidator         │ ← Enforce size limits
│ 7. TotalSizeValidator        │ ← Enforce total size limit
│ 8. VirusScanValidator        │ ← Scan for malware
│ 9. DuplicateFileValidator    │ ← Check for duplicates
│ 10. UserQuotaValidator       │ ← Enforce quotas
└─────────────────────────────┘
    ↓
┌─────────────────────────────┐
│   PROCESSING PHASE          │
├─────────────────────────────┤
│ 1. ImageResizeProcessor      │ ← Resize to max dimensions
│ 2. ImageFormatConvertProcessor│ ← Convert format (e.g., PNG → WebP)
│ 3. ImageCompressProcessor    │ ← Compress images
└─────────────────────────────┘
    ↓
┌─────────────────────────────┐
│   STORAGE PHASE             │
├─────────────────────────────┤
│ Upload to IStorageProvider   │
│ Create File records          │
└─────────────────────────────┘
    ↓
[Return File entities]
```

---

## 🔐 Security Features

### MIME Type Sniffing (Critical)

**Never trust client-provided MIME types.**

```typescript
// Client claims: image/jpeg
// Actual file: application/x-executable
// Result: Upload REJECTED with MIME_TYPE_MISMATCH

const files = await uploadIntakeService.execute({
  context: { userId, role: 'user' },
  files: [
    {
      buffer: maliciousBuffer,
      mimeType: 'image/jpeg',  // ← Lie
      originalName: 'totally-safe.jpg',
    },
  ],
  folder: 'products',
});
// Throws UploadPolicyViolationError with MIME_TYPE_MISMATCH
```

### File Fingerprinting

```typescript
// Upload same file twice
const [file1] = await uploadIntakeService.execute({
  context: { userId, role: 'vendor', vendorId },
  files: [{ buffer: imageBuffer, mimeType: 'image/jpeg' }],
  folder: 'products',
});

const [file2] = await uploadIntakeService.execute({
  context: { userId, role: 'vendor', vendorId },
  files: [{ buffer: imageBuffer,  mimeType: 'image/jpeg' }],
  folder: 'products',
});

// If config.duplicateDetection.blockDuplicates = true:
//   Throws UploadPolicyViolationError with DUPLICATE_FILE
//
// If config.duplicateDetection.blockDuplicates = false:
//   Returns reference to existing file (file2.id === file1.id)
```

### Virus Scanning

```typescript
// Production: Use ClamAV
const virusScanner = new ClamAVScanner();

// Development: Use mock
const virusScanner = new MockScanner();

// Testing: Simulate virus
const virusScanner = new MockScanner(true);

const uploadIntakeService = new UploadIntakeService(
  config,
  storageProvider,
  fileRepository,
  observer,
  virusScanner  // ← Pluggable
);
```

---

## 📊 Observability

### Logging

```typescript
import { LoggingObserver } from '@/core/uploads';

const observer = new LoggingObserver('info');

// Logs all lifecycle events:
// - Validation started/failed/passed
// - Processing started
// - File processed
// - Virus scan completed
// - Storage started
// - Upload completed/failed
```

### Custom Observer

```typescript
import { IUploadObserver } from '@/core/uploads';

class AuditTrailObserver implements IUploadObserver {
  async onUploadCompleted(context, fileIds) {
    await auditLog.create({
      userId: context.getUserId(),
      action: 'FILE_UPLOAD',
      fileCount: fileIds.length,
      folder: context.getFolder(),
      timestamp: new Date(),
    });
  }

  async onValidationFailed(context, violations) {
    await securityLog.create({
      userId: context.getUserId(),
      event: 'UPLOAD_BLOCKED',
      violations: violations.map(v => v.code),
      timestamp: new Date(),
    });
  }
}
```

---

## 🖼️ Image Processing

### Auto-Resize

```typescript
// Config
perMimeType: {
  'image/jpeg': {
    allowed: true,
    maxSizeBytes: 10 * 1024 * 1024,
    transforms: {
      resize: { maxWidth: 2048, maxHeight: 2048 },  // ← Auto-resize
    },
  },
}

// Upload 5000x5000 image
// Result: Resized to 2048x2048 (preserving aspect ratio)
```

### Format Conversion

```typescript
perMimeType: {
  'image/png': {
    allowed: true,
    maxSizeBytes: 10 * 1024 * 1024,
    transforms: {
      convertTo: 'webp',  // ← Auto-convert PNG to WebP
    },
  },
}
```

### Compression

```typescript
perMimeType: {
  'image/jpeg': {
    allowed: true,
    maxSizeBytes: 10 * 1024 * 1024,
    transforms: {
      compress: true,  // ← Compress with quality 85
    },
  },
}
```

---

## ⚠️ Error Handling

### Validation Errors

```typescript
import { UploadPolicyViolationError } from '@/core/uploads';

try {
  await uploadIntakeService.execute(request);
} catch (error) {
  if (error instanceof UploadPolicyViolationError) {
    // error.violations is an array of: violations: [
      {
        code: 'FILE_TOO_LARGE',
        message: 'File exceeds size limit...',
        fileIndex: 0,
        metadata: { fileSize: 15728640, maxSize: 10485760 },
      },
      {
        code: 'MIME_NOT_ALLOWED',
        message: 'MIME type not allowed: application/exe',
        fileIndex: 1,
      },
    ];
  }
}
```

### Error Codes

- `FILE_TOO_LARGE` - File exceeds size limit
- `MIME_NOT_ALLOWED` - MIME type not in allowlist
- `TOO_MANY_FILES` - Too many files in request
- `QUOTA_EXCEEDED` - User/vendor quota exceeded
- `VIRUS_DETECTED` - Virus found in file
- `PERMISSION_DENIED` - User lacks permission
- `TOTAL_SIZE_EXCEEDED` - Total size exceeds limit
- `DUPLICATE_FILE` - Duplicate file detected
- `MIME_TYPE_MISMATCH` - Claimed vs detected MIME mismatch
- `POLYGLOT_DETECTED` - File valid as multiple formats
- `UNDETECTABLE_TYPE` - Could not detect file type

---

## 🧩 Extending the System

### Custom Validator

```typescript
import { IUploadValidator, UploadPipelineContext } from '@/core/uploads';

class CustomDimensionValidator implements IUploadValidator {
  async validate(context: UploadPipelineContext): Promise<void> {
    for (const file of context.files) {
      if (file.dimensions &&
          file.dimensions.width >  4096 &&
          file.dimensions.height > 4096) {
        context.addViolation({
          code: 'FILE_TOO_LARGE',
          message: 'Image dimensions too large',
        });
      }
    }
  }
}
```

### Custom Processor

```typescript
import { IUploadProcessor, UploadPipelineContext } from '@/core/uploads';

class WatermarkProcessor implements IUploadProcessor {
  async process(context: UploadPipelineContext): Promise<void> {
    for (const file of context.files) {
      if (file.mimeType.startsWith('image/')) {
        file.buffer = await addWatermark(file.buffer);
        file.size = file.buffer.length;
      }
    }
  }
}
```

---

## 📝 Migration from FileUploadService

```typescript
// ❌ Old way (DEPRECATED)
const file = await fileUploadService.execute({
  buffer,
  mimeType,
  originalName,
  folder,
  vendorId,
});

// ✅ New way (RECOMMENDED)
const [file] = await uploadIntakeService.execute({
  context: {
    userId: currentUser.id,
    vendorId: currentUser.vendorId,
    role: currentUser.role,
  },
  files: [{ buffer, mimeType, originalName }],
  folder,
});
```

---

## 🏗️ Architecture Principles

1. **Never trust client input** - All MIME types detected from buffer
2. **Defense in depth** - Multiple validation layers
3. **Fail atomic** - All files pass or all fail
4. **Observable** - Full lifecycle hooks for monitoring
5. **Pluggable** - Easy to swap validators, processors, scanners
6. **Config-driven** - No hardcoded limits
7. **Explicit errors** - Structured violation codes

---

## 🚀 Production Recommendations

### Quota Performance

V1 implementation queries file repository on each upload. For production:

```typescript
// TODO: Implement cached counter system
class RedisQuotaCache {
  async getCurrentUsage(userId: string) {
    return redis.hgetall(`quota:${userId}`);
  }

  async incrementUsage(userId: string, size: number) {
    await redis.hincrby(`quota:${userId}`, 'fileCount', 1);
    await redis.hincrby(`quota:${userId}`, 'totalSize', size);
  }
}
```

### Virus Scanning

Replace MockScanner with ClamAV:

```bash
npm install clamscan
```

```typescript
import { ClamAVScanner } from '@/core/uploads';

const virusScanner = new ClamAVScanner();
```

### Observability

Integrate with logging/monitoring systems:

```typescript
class DatadogObserver implements IUploadObserver {
  async onUploadCompleted(context, fileIds) {
    statsd.increment('upload.success', 1, {
      folder: context.getFolder(),
      fileCount: fileIds.length,
    });
  }
}
```

---

## 📚 Related Documentation

- [Storage Provider Interface](../storage/README.md)
- [File Repository](../../modules/catalog/repositories/README.md)
- [Domain Services](../../modules/catalog/domain/services/README.md)

---

## 🔒 License

Internal use only. Do not distribute.
