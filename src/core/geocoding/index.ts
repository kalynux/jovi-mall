// Core interfaces and types
export * from './geocoding-provider.interface';
export * from './geocoding.config';

// Factory (ONLY way to create providers)
export * from './geocoding.factory';

// The result cache (ADR-A04 D-1). Exported because `test:geocoding-cache` asserts the key
// derivation directly — the "same address, different spacing → one key" property is the whole
// value of the cache and is worth pinning without a Redis. Application code should NOT construct
// this: `getGeocodingProvider()` wraps it already, and a second wrap would double-cache.
export * from './geocoding.cache';

// Centralized singleton instance (RECOMMENDED way to access geocoding)
export * from './geocoding.instance';

// NOTE: Provider implementations are NOT exported — they are internal and
// accessed only through the factory / singleton, exactly like core/storage.
