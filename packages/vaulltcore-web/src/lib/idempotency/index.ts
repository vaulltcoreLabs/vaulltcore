// Idempotency key management for POST /jobs and POST /automation/runs
// Generate once per logical user action, persist for retry lifecycle

const keyStore = new Map<string, string>();

export function generateIdempotencyKey(actionId: string): string {
  const existing = keyStore.get(actionId);
  if (existing) return existing;

  const key = crypto.randomUUID();
  keyStore.set(actionId, key);
  return key;
}

export function getIdempotencyKey(actionId: string): string | undefined {
  return keyStore.get(actionId);
}

export function clearIdempotencyKey(actionId: string): void {
  keyStore.delete(actionId);
}
