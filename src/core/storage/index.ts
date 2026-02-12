// Core interfaces and types
export * from './storage-provider.interface';
export * from './storage.config';

// Factory (ONLY way to create providers)
export * from './storage.factory';

// Centralized storage instance (RECOMMENDED way to access storage)
export * from './storage.instance';

// NOTE: Provider implementations are NOT exported
// They are internal and accessed only through the factory
