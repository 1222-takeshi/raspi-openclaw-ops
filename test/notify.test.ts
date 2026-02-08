import { describe, expect, it } from 'vitest';
import { decideNotify } from '../src/notify.js';

describe('decideNotify', () => {
  it('skips initial when configured', () => {
    const d = decideNotify({
      prevHealth: null,
      nextHealth: 'ok',
      nowMs: 1000,
      lastNotifiedAtMs: null,
      minIntervalMs: 0,
      skipInitial: true,
    });
    expect(d.shouldNotify).toBe(false);
    expect(d.reason).toBe('initial-skip');
  });

  it('notifies on change', () => {
    const d = decideNotify({
      prevHealth: 'ok',
      nextHealth: 'degraded',
      nowMs: 1000,
      lastNotifiedAtMs: null,
      minIntervalMs: 0,
      skipInitial: true,
    });
    expect(d.shouldNotify).toBe(true);
  });

  it('rate-limits', () => {
    const d = decideNotify({
      prevHealth: 'ok',
      nextHealth: 'degraded',
      nowMs: 10_000,
      lastNotifiedAtMs: 9_000,
      minIntervalMs: 5_000,
      skipInitial: false,
    });
    expect(d.shouldNotify).toBe(false);
    expect(d.reason).toBe('rate-limited');
  });
});
