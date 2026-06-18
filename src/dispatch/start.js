/**
 * QuantumClaw — claude-code-dispatcher PM2 entry point.
 *
 * PM2's ESM fork launch makes `process.argv[1]` its own wrapper (not the script),
 * so the dispatcher's own `import.meta.url`-based isMain guard never fires and
 * mainLoop is silently skipped. This entry has NO guard — its top-level always runs
 * when loaded — so PM2 reliably starts the loop.
 *
 *   pm2 start src/dispatch/start.js --name claude-code-dispatcher && pm2 save
 *
 * (Direct `node src/dispatch/claude-code-dispatcher.js` still works for foreground /
 * one-shot runs via the dispatcher's own isMain block.)
 */
import { mainLoop, loadEnv } from './claude-code-dispatcher.js';

if (process.env.QCLAW_CC_DISPATCHER_ENABLED === '0') {
  console.warn('[dispatcher] QCLAW_CC_DISPATCHER_ENABLED=0 — not starting');
  process.exit(0);
}
mainLoop(loadEnv()).catch((err) => {
  console.error(`[dispatcher] fatal: ${err?.message || err}`);
  process.exit(1);
});
