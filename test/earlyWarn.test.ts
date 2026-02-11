import { describe, expect, it } from 'vitest';
import { detectDmesgErrors, parseDfInodesRoot } from '../src/earlyWarn.js';

describe('parseDfInodesRoot', () => {
  it('parses df -Pi / output', () => {
    const out = `Filesystem Inodes IUsed IFree IUse% Mounted on\n/dev/root 100 10 90 10% /\n`;
    const r = parseDfInodesRoot(out);
    expect(r).not.toBeNull();
    expect(r!.usedPct).toBe(10);
    expect(r!.mount).toBe('/');
  });
});

describe('detectDmesgErrors', () => {
  it('detects storage related errors', () => {
    const lines = [
      'EXT4-fs error (device mmcblk0p2): ext4_find_entry:1450: inode #2: comm systemd: reading directory lblock 0',
      'some other line',
    ];
    const r = detectDmesgErrors(lines);
    expect(r.found).toBe(true);
    expect(r.lines.length).toBe(1);
    expect(r.reason).toMatch(/EXT4/i);
  });

  it('returns not found when clean', () => {
    const r = detectDmesgErrors(['hello']);
    expect(r.found).toBe(false);
  });
});
