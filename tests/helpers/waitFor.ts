// domainEvents.publish() (src/lib/events.ts) does not await async listeners
// -- EventEmitter.emit() is synchronous and fire-and-forget by design (see
// CLAUDE.md's Low Stock Alert section for why that's an accepted tradeoff).
// Tests asserting on a listener's async side effects (DB writes, notification
// sends) must poll for eventual consistency instead of asserting immediately
// after the triggering HTTP call resolves. A short retry-poll, not a fixed
// sleep, keeps this fast on the common case and non-flaky on a slow one.
export async function waitFor(condition: () => Promise<boolean>, options: { timeoutMs?: number; intervalMs?: number } = {}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const intervalMs = options.intervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  if (await condition()) return;
  throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
}
