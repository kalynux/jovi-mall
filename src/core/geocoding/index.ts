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

// The entity decoder (2026-08-26). Exported for the same reason the cache is: its pure half
// is worth pinning directly against the real provider strings that prompted it, and
// `test:geocoding-sanitize` does exactly that. Application code should NOT wrap with it —
// `createGeocodingProvider` already does, and a second wrap would decode twice, turning a
// literal `&amp;apos;` somebody typed into an apostrophe.
export * from './geocoding.sanitize';

// Centralized singleton instance (RECOMMENDED way to access geocoding)
export * from './geocoding.instance';

// NOTE: Provider implementations are NOT exported — they are internal and
// accessed only through the factory / singleton, exactly like core/storage.
