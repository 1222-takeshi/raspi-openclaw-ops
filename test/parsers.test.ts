import { describe, expect, it } from 'vitest';
import { parseDfRoot } from '../src/parsers.js';

describe('parseDfRoot', () => {
  it('parses df -P / output', () => {
    const out = `Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/root 30000000 12000000 18000000 40% /\n`;
    const r = parseDfRoot(out);
    expect(r).not.toBeNull();
    expect(r!.usedPct).toBe(40);
    expect(r!.mount).toBe('/');
    expect(r!.totalBytes).toBe(30000000 * 1024);
  });

  it('returns null for invalid input', () => {
    expect(parseDfRoot('')).toBeNull();
    expect(parseDfRoot('Filesystem\n')).toBeNull();
  });
});
