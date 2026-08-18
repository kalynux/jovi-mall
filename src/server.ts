// Must run before any app module is imported so env-driven config read at import
// time (e.g. credit pricing in the billing module) sees the .env values. This is why the
// entrypoint is a separate file from `lifecycle.ts` at all: an import of `./lifecycle` pulls
// in the whole module graph, so `dotenv/config` has to be evaluated above it.
import 'dotenv/config';
import { startServer, registerShutdownHandlers } from './lifecycle';

// Registered BEFORE the boot begins, so a signal arriving mid-startup is handled rather than
// killing a process halfway through opening connections.
registerShutdownHandlers();

startServer().catch((error) => {
    console.error('Failed to start server:', error);
    process.exit(1);
});
