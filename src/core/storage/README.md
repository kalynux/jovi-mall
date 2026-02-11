# Production Storage Engine - Multi-Provider Implementation

## 📦 Package Dependencies Required

To use all three storage providers, install the following packages:

```bash
# Firebase Admin SDK (for Firebase Storage)
npm install firebase-admin

# Cloudinary SDK (for Cloudinary)
npm install cloudinary

# Already included in Node.js (no install needed):
# - fs/promises (Local storage)
# - crypto (checksums)
# - path (file paths)
```

---

## 🔧 Configuration Example

### Environment Variables

```env
# Storage provider selection
STORAGE_PROVIDER=local  # or 'firebase' or 'cloudinary'

# Local Storage Config
LOCAL_STORAGE_BASE_PATH=./storage
LOCAL_STORAGE_BASE_URL=http://localhost:3000/storage

# Firebase Storage Config
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_CLIENT_EMAIL=your-service-account@project.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
FIREBASE_BUCKET=your-project.appspot.com
FIREBASE_PUBLIC=true

# Cloudinary Config
CLOUDINARY_CLOUD_NAME=your-cloud-name
CLOUDINARY_API_KEY=your-api-key
CLOUDINARY_API_SECRET=your-api-secret
CLOUDINARY_FOLDER_PREFIX=jovi
```

### Application Configuration

```typescript
import { StorageConfig } from './core/storage';

export const storageConfig: StorageConfig = {
  provider: process.env.STORAGE_PROVIDER as 'local' | 'firebase' | 'cloudinary',
  
  local: {
    basePath: process.env.LOCAL_STORAGE_BASE_PATH || './storage',
    baseUrl: process.env.LOCAL_STORAGE_BASE_URL || 'http://localhost:3000/storage',
  },
  
  firebase: {
    projectId: process.env.FIREBASE_PROJECT_ID!,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL!,
    privateKey: process.env.FIREBASE_PRIVATE_KEY!,
    bucket: process.env.FIREBASE_BUCKET!,
    public: process.env.FIREBASE_PUBLIC === 'true',
  },
  
  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME!,
    apiKey: process.env.CLOUDINARY_API_KEY!,
    apiSecret: process.env.CLOUDINARY_API_SECRET!,
    folderPrefix: process.env.CLOUDINARY_FOLDER_PREFIX || 'jovi',
  },
};
```

---

## 🎯 Usage Example

### Using the Factory

```typescript
import { createStorageProvider } from './core/storage';
import { storageConfig } from './config';

// Create provider based on configuration
const storageProvider = createStorageProvider(storageConfig);

// Upload file (provider-agnostic)
const result = await storageProvider.put(fileBuffer, {
  mimeType: 'image/png',
  folder: 'products',
  filename: 'logo.png',
});

console.log('File uploaded:', result.key);

// Get public URL (provider-agnostic)
const url = storageProvider.getPublicUrl(result.key);
console.log('Access file at:', url);

// Delete file (provider-agnostic)
await storageProvider.delete(result.key);
```

### Integration with FileUploadService

```typescript
import { FileUploadService } from './modules/catalog/domain/services/media';
import { FileRepositoryMongo } from './modules/catalog/repositories/mongo';
import { createStorageProvider } from './core/storage';
import { storageConfig } from './config';

// Create provider
const storageProvider = createStorageProvider(storageConfig);

// Create service
const fileRepository = new FileRepositoryMongo();
const fileUploadService = new FileUploadService(storageProvider, fileRepository);

// Upload file
const file = await fileUploadService.execute({
  buffer: fileBuffer,
  mimeType: 'image/png',
  originalName: 'product.png',
  folder: 'products',
  vendorId: 'vendor123',
});

// File.key contains provider-specific key
// URL is computed at runtime:
const url = storageProvider.getPublicUrl(file.key);
```

---

## 🗂️ File Organization by Provider

### Local Storage
```
storage/
  products/
    2026/
      01/
        uuid1_filename.png
        uuid2_filename.jpg
  variants/
    2026/
      01/
        uuid3_filename.webp
```

### Firebase Storage
```
products/2026/01/uuid1_filename.png
products/2026/01/uuid2_filename.jpg
variants/2026/01/uuid3_filename.webp
```

### Cloudinary
```
jovi/products/2026/01/uuid1_filename
jovi/products/2026/01/uuid2_filename
jovi/variants/2026/01/uuid3_filename
```

---

## 🔄 Switching Providers

To switch from local to Cloudinary:

1. Update `.env`:
   ```env
   STORAGE_PROVIDER=cloudinary
   ```

2. **No code changes needed** ✅

3. Restart application

All new uploads go to Cloudinary. Old files remain in local storage with their keys intact.

---

## 🛡️ Provider-Specific Features

### Local Storage
- ✅ Simplest setup (no external dependencies)
- ✅ SHA-256 checksums
- ✅ Automatic directory creation
- ❌ No CDN
- ❌ Single server only

### Firebase Storage
- ✅ Google Cloud Platform integration
- ✅ Public or signed URLs
- ✅ Global CDN
- ✅ Signed URL support for private files
- ✅ Automatic content-type handling

### Cloudinary
- ✅ Purpose-built media CDN
- ✅ Automatic format optimization (`f_auto`)
- ✅ Quality optimization (`q_auto`)
- ✅ Image transformations (future-ready)
- ✅ ETags for checksums

---

## 🧪 Testing Provider Swapping

```typescript
// Test 1: Upload with Local
process.env.STORAGE_PROVIDER = 'local';
const provider1 = createStorageProvider(storageConfig);
const result1 = await provider1.put(buffer, { mimeType: 'image/png', folder: 'test' });
const url1 = provider1.getPublicUrl(result1.key);
console.log('Local URL:', url1);
// → http://localhost:3000/storage/test/2026/01/uuid.png

// Test 2: Same code, different provider
process.env.STORAGE_PROVIDER = 'cloudinary';
const provider2 = createStorageProvider(storageConfig);
const result2 = await provider2.put(buffer, { mimeType: 'image/png', folder: 'test' });
const url2 = provider2.getPublicUrl(result2.key);
console.log('Cloudinary URL:', url2);
// → https://res.cloudinary.com/your-cloud/image/upload/jovi/test/2026/01/uuid

// Test 3: Firebase
process.env.STORAGE_PROVIDER = 'firebase';
const provider3 = createStorageProvider(storageConfig);
const result3 = await provider3.put(buffer, { mimeType: 'image/png', folder: 'test' });
const url3 = provider3.getPublicUrl(result3.key);
console.log('Firebase URL:', url3);
// → https://storage.googleapis.com/your-bucket/test/2026/01/uuid.png
```

---

## ✅ Architecture Guarantees

### ✅ Domain Layer Isolation
```typescript
// ❌ NEVER import providers directly
import { LocalStorageProvider } from './core/storage/providers/local-storage.provider'; // NO!

// ✅ ALWAYS use factory
import { createStorageProvider } from './core/storage'; // YES!
```

### ✅ URL Computation
```typescript
// ❌ NEVER store URLs in database
{
  fileId: '123',
  url: 'https://cloudinary.com/...' // NO!
}

// ✅ ALWAYS store key and compute URL at runtime
{
  fileId: '123',
  key: 'products/2026/01/uuid.png',
  provider: 'cloudinary'
}

const url = storageProvider.getPublicUrl(file.key); // YES!
```

### ✅ Provider Swapping
- Change `.env` → Application restarts → All new uploads use new provider
- Old files remain accessible via their original provider
- No business logic changes required

---

## 🚀 Future Enhancements Ready

The architecture supports future additions **without changing business logic**:

1. **Image Resizing**: Add to provider `put()` method
2. **Virus Scanning**: Add before `put()` call in service
3. **CDN**: Add wrapper provider that proxies to actual provider
4. **R2/S3**: Implement new provider, add to factory
5. **Background Jobs**: Queue `put()` calls asynchronously

---

## 📋 Summary

| Provider | Setup Complexity | Cost | CDN | Transformations | Best For |
|----------|-----------------|------|-----|-----------------|----------|
| **Local** | ⭐ Easy | Free | ❌ | ❌ | Development |
| **Firebase** | ⭐⭐ Medium | Pay-as-you-go | ✅ | ❌ | Google Cloud apps |
| **Cloudinary** | ⭐⭐ Medium | Freemium | ✅ | ✅ | Media-heavy apps |

**All providers work identically from the application's perspective.**
