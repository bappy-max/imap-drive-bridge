const port = Number.parseInt(process.env.SMTP_GATEWAY_PORT || '3000', 10);

try {
  const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(5_000) });
  process.exit(response.ok ? 0 : 1);
} catch {
  process.exit(1);
}
