# Production Storage Engine - Multi-Provider Implementation

## 📦 Package Dependencies Required

To use all three storage providers, install the following packages:

```bash
# Firebase Admin SDK (for Firebase Storage)
npm install firebase-admin

# Cloudinary SDK (for Cloudinary)
npm install cloudinary

# AWS SDK v3 (for Cloudflare R2 — S3-compatible)
npm install @aws-sdk/client-s3 @aws-sdk/lib-storage @aws-sdk/s3-request-presigner

# Already included in Node.js (no install needed):
# - fs/promises (Local storage)
# - crypto (checksums)
# - path (file paths)
```

---

## 🔧 Configuration Example

### Environment Variables

⚠ **The `LOCAL_STORAGE_*` names below were WRONG** — read by nothing, so uploads silently went to
disk. Corrected 2026-09-09 to the `STORAGE_LOCAL_*` names `storage.instance.ts` actually reads;
the boot validator now refuses to start on the old spellings. `.env.example` § 7 is the authority.

```env
# Storage provider selection
STORAGE_PROVIDER=local  # local | firebase | cloudinary | r2

# Local Storage Config
STORAGE_LOCAL_PATH=./storage
STORAGE_LOCAL_URL=http://localhost:8022/api/files

# Cloudflare R2 Config (the production provider — TWO buckets, see above)
STORAGE_R2_ACCOUNT_ID=your-account-id
STORAGE_R2_ACCESS_KEY_ID=your-access-key-id
STORAGE_R2_SECRET_ACCESS_KEY=your-secret
STORAGE_R2_BUCKET=wi-mall-public          # has the Cloudflare custom domain
STORAGE_R2_PRIVATE_BUCKET=wi-mall-private # NO public binding. Must differ.
STORAGE_R2_PUBLIC_URL=https://cdn.yourdomain.com   # no trailing slash

# Firebase Storage Config
STORAGE_FIREBASE_PROJECT_ID=your-project-id
STORAGE_FIREBASE_CLIENT_EMAIL=your-service-account@project.iam.gserviceaccount.com
STORAGE_FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
STORAGE_FIREBASE_BUCKET=your-project.appspot.com
STORAGE_FIREBASE_PUBLIC=true

# Cloudinary Config
STORAGE_CLOUDINARY_CLOUD_NAME=your-cloud-name
STORAGE_CLOUDINARY_API_KEY=your-api-key
STORAGE_CLOUDINARY_API_SECRET=your-api-secret
STORAGE_CLOUDINARY_FOLDER_PREFIX=jovi
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
    projectId: process.env.STORAGE_FIREBASE_PROJECT_ID!,
    clientEmail: process.env.STORAGE_FIREBASE_CLIENT_EMAIL!,
    privateKey: process.env.STORAGE_FIREBASE_PRIVATE_KEY!,
    bucket: process.env.STORAGE_FIREBASE_BUCKET!,
    public: process.env.STORAGE_FIREBASE_PUBLIC === 'true',
  },
  
  cloudinary: {
    cloudName: process.env.STORAGE_CLOUDINARY_CLOUD_NAME!,
    apiKey: process.env.STORAGE_CLOUDINARY_API_KEY!,
    apiSecret: process.env.STORAGE_CLOUDINARY_API_SECRET!,
    folderPrefix: process.env.STORAGE_CLOUDINARY_FOLDER_PREFIX || 'jovi',
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

## 🛡️ Provider capabilities

⚠ **This section used to be INVERTED** — it praised Firebase and Cloudinary and dinged `local`,
which is the opposite of what the code does, and `docs/DEPLOY-VPS.md` repeated the mistake into a
production recommendation. Corrected 2026-09-09. The load-bearing row is `getDownloadStream`:
it is the mechanism behind **both** private-file routes (`GET /api/digital/download/:token` and
`GET /api/{agent,agency}/shipments/:id/delivery-proof/file`), and **neither route guards the call**
with `supportsDownloadStream()`. A provider that cannot stream breaks a paid feature and an
operational one, with a 501 that reads as an internal fault.

| Capability | `local` | `firebase` | `cloudinary` | `r2` |
|---|---|---|---|---|
| `put` / `delete` / `getPublicUrl` | ✅ | ✅ | ✅ | ✅ |
| **`getDownloadStream`** | ✅ | ❌ **501** | ❌ **501** | ✅ |
| `getBuffer` | ✅ | ❌ 501 | ❌ 501 | ✅ |
| `getSignedUrl` | n/a | ✅ | ❌ 501 | ✅ |
| wi-admin can rebuild the URL | ✅ | ✅ | ❌ every url `null` | ✅ |
| CDN | ❌ | ✅ | ✅ + `f_auto,q_auto` | ✅ on a custom domain |
| Egress cost | — | $0.12/GB after 100 GB | burns plan credits | **$0** |
| Survives a redeploy | ❌ volume only | ✅ | ✅ | ✅ |

**`r2` is the production choice**, and the only one that gets media off the container volume
without costing you the two private routes. **`local` is the development default** and remains the
only other provider with a working byte path. `firebase` has `getSignedUrl`, so serving the private
routes from a short-lived signed URL minted *inside* them is the bounded work that would make it
viable; `cloudinary` has no byte path at all.

### `r2` — two buckets, and that is the security mechanism
R2 has **no per-object ACL** (`ACL: 'public-read'` is accepted and silently discarded), so an
object is reachable iff its *bucket* carries a public binding. The three private trees stay off the
CDN by living in `STORAGE_R2_PRIVATE_BUCKET`, which has no custom domain and no r2.dev URL. Equal
bucket names refuse the boot, in `config/env.ts` and again in the provider constructor.
`getPublicUrl` **throws** on a private key rather than returning a string.

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

| Provider | Setup | Cost | CDN | Private files work? | Best for |
|---|---|---|---|---|---|
| **local** | ⭐ Easy | Free (VPS disk) | ❌ | ✅ | Development |
| **r2** | ⭐⭐ Medium | 10 GB free, then $0.015/GB, **$0 egress** | ✅ | ✅ | **Production** |
| **firebase** | ⭐⭐ Medium | 5 GB free (US only), $0.12/GB egress | ✅ | ❌ 501 | Google Cloud shops |
| **cloudinary** | ⭐⭐ Medium | 25 credits, then $99/mo | ✅ + transforms | ❌ 501 | Not viable here |

⚠ **"All providers work identically from the application's perspective" is FALSE**, and used to be
the closing line of this file. Two of the four cannot serve a private file at all. Ask
`supportsDownloadStream()` on any path where the absence is a state to report rather than a fault.
