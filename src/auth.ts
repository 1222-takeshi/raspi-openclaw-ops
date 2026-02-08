export type MinimalRequest = {
  query?: Record<string, unknown>;
  headers?: Record<string, unknown>;
};

export function getProvidedToken(req: MinimalRequest): string | null {
  const q = req.query?.token;
  if (typeof q === 'string' && q.trim()) return q.trim();

  const auth = req.headers?.authorization;
  if (typeof auth === 'string') {
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m?.[1]?.trim()) return m[1].trim();
  }

  const x = (req.headers?.['x-status-token'] ?? req.headers?.['X-Status-Token']) as unknown;
  if (typeof x === 'string' && x.trim()) return x.trim();

  return null;
}

export function constantTimeEqual(a: string, b: string) {
  // best-effort constant-time compare
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

export function verifyToken(req: MinimalRequest, expectedToken: string): boolean {
  const provided = getProvidedToken(req);
  if (!provided) return false;
  return constantTimeEqual(provided, expectedToken);
}
