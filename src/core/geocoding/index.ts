// Core interfaces and types
export * from './geocoding-provider.interface';
export * from './geocoding.config';

// Factory (ONLY way to create providers)
export * from './geocoding.factory';

// Centralized singleton instance (RECOMMENDED way to access geocoding)
export * from './geocoding.instance';

// NOTE: Provider implementations are NOT exported — they are internal and
// accessed only through the factory / singleton, exactly like core/storage.
