import { stat } from 'node:fs/promises';

const file = process.env.HEARTBEAT_FILE || '/tmp/bridge-heartbeat';
const pollSeconds = Number.parseInt(process.env.POLL_INTERVAL_SECONDS || '900', 10);
const maxAgeMs = Math.max(300, pollSeconds * 3) * 1000;

try {
  const info = await stat(file);
  if (Date.now() - info.mtimeMs > maxAgeMs) process.exit(1);
  process.exit(0);
} catch {
  process.exit(1);
}
