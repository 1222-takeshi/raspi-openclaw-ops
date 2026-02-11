import { describe, expect, it } from 'vitest';
import { compute1mRollup, floorToMinute, openDb } from '../src/metricsDb.js';

describe('metricsDb', () => {
  it('floorToMinute', () => {
    expect(floorToMinute(0)).toBe(0);
    expect(floorToMinute(59_999)).toBe(0);
    expect(floorToMinute(60_000)).toBe(60_000);
    expect(floorToMinute(61_234)).toBe(60_000);
  });

  it('compute1mRollup averages non-null', () => {
    const r = compute1mRollup(0, [
      { timeMs: 0, cpuUsagePctInstant: null, cpuUsagePctAvg10s: 10, cpuTempC: 40, diskUsedPct: 50, memUsedPct: 20 },
      { timeMs: 1, cpuUsagePctInstant: null, cpuUsagePctAvg10s: 30, cpuTempC: null, diskUsedPct: 70, memUsedPct: 40 },
    ]);
    expect(r.bucketStartMs).toBe(0);
    expect(r.cpuUsagePctAvg10s).toBe(20);
    expect(r.cpuTempC).toBe(40);
    expect(r.diskUsedPct).toBe(60);
    expect(r.memUsedPct).toBe(30);
  });

  it('db insert/select/prune works', () => {
    const m = openDb({ path: ':memory:' });
    m.insertRawMany([
      { timeMs: 1000, cpuUsagePctInstant: 1, cpuUsagePctAvg10s: 2, cpuTempC: 3, diskUsedPct: 4, memUsedPct: 5 },
      { timeMs: 2000, cpuUsagePctInstant: 10, cpuUsagePctAvg10s: 20, cpuTempC: 30, diskUsedPct: 40, memUsedPct: 50 },
    ]);
    const rows = m.selectRawRange(0, 10_000);
    expect(rows.length).toBe(2);
    expect(rows[0].timeMs).toBe(1000);
    expect(m.pruneRaw(1500)).toBe(1);
    expect(m.selectRawRange(0, 10_000).length).toBe(1);
    m.close();
  });
});
