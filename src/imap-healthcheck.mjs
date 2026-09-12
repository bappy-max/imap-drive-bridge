const port = Number(process.env.IMAP_GATEWAY_PORT || 3100);

try {
  const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) process.exit(1);
} catch {
  process.exit(1);
}
