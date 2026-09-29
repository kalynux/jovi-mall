/**
 * test:payment-settings — STUB, created by W0 of the payment-routing restructure (ADR-A08).
 *
 * Owned by W1 (the settings store and resolver), which replaces this file with the real suite. It exits 0 so the
 * package.json script exists from the start and no session has to edit that shared file.
 *
 * Run: npm run test:payment-settings
 */
import { originalConsole } from '../../src/core/logging/sink-guard';

originalConsole.log('test:payment-settings — stub (owned by W1, ADR-A08); nothing to assert yet');
process.exit(0);
