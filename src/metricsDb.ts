import Database from 'better-sqlite3';

export type MetricsRawRow = {
  timeMs: number;
  cpuUsagePctInstant: number | null;
  cpuUsagePctAvg10s: number | null;
  cpuTempC: number | null;
  diskUsedPct: number | null;
  memUsedPct: number;
};

export type Metrics1mRow = {
  bucketStartMs: number;
  cpuUsagePctAvg10s: number | null;
  cpuTempC: number | null;
  diskUsedPct: number | null;
  memUsedPct: number;
};

export type DbConfig = {
  path: string;
};

export function openDb(cfg: DbConfig) {
  const db = new Database(cfg.path);
  // Better durability without killing SD cards too hard.
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('temp_store = MEMORY');

  db.exec(`
    CREATE TABLE IF NOT EXISTS metrics_raw (
      time_ms INTEGER PRIMARY KEY,
      cpu_usage_pct_instant REAL,
      cpu_usage_pct_avg10s REAL,
      cpu_temp_c REAL,
      disk_used_pct REAL,
      mem_used_pct REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS metrics_1m (
      bucket_start_ms INTEGER PRIMARY KEY,
      cpu_usage_pct_avg10s REAL,
      cpu_temp_c REAL,
      disk_used_pct REAL,
      mem_used_pct REAL NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_metrics_raw_time ON metrics_raw(time_ms);
    CREATE INDEX IF NOT EXISTS idx_metrics_1m_time ON metrics_1m(bucket_start_ms);
  `);

  const insertRaw = db.prepare(`
    INSERT OR REPLACE INTO metrics_raw (
      time_ms, cpu_usage_pct_instant, cpu_usage_pct_avg10s, cpu_temp_c, disk_used_pct, mem_used_pct
    ) VALUES (
      @timeMs, @cpuUsagePctInstant, @cpuUsagePctAvg10s, @cpuTempC, @diskUsedPct, @memUsedPct
    )
  `);

  const insert1m = db.prepare(`
    INSERT OR REPLACE INTO metrics_1m (
      bucket_start_ms, cpu_usage_pct_avg10s, cpu_temp_c, disk_used_pct, mem_used_pct
    ) VALUES (
      @bucketStartMs, @cpuUsagePctAvg10s, @cpuTempC, @diskUsedPct, @memUsedPct
    )
  `);

  const selectRawRange = db.prepare(`
    SELECT
      time_ms as timeMs,
      cpu_usage_pct_instant as cpuUsagePctInstant,
      cpu_usage_pct_avg10s as cpuUsagePctAvg10s,
      cpu_temp_c as cpuTempC,
      disk_used_pct as diskUsedPct,
      mem_used_pct as memUsedPct
    FROM metrics_raw
    WHERE time_ms BETWEEN ? AND ?
    ORDER BY time_ms ASC
  `);

  const select1mRange = db.prepare(`
    SELECT
      bucket_start_ms as bucketStartMs,
      cpu_usage_pct_avg10s as cpuUsagePctAvg10s,
      cpu_temp_c as cpuTempC,
      disk_used_pct as diskUsedPct,
      mem_used_pct as memUsedPct
    FROM metrics_1m
    WHERE bucket_start_ms BETWEEN ? AND ?
    ORDER BY bucket_start_ms ASC
  `);

  const deleteRawOlderThan = db.prepare('DELETE FROM metrics_raw WHERE time_ms < ?');
  const delete1mOlderThan = db.prepare('DELETE FROM metrics_1m WHERE bucket_start_ms < ?');

  const txnInsertRawMany = db.transaction((rows: MetricsRawRow[]) => {
    for (const r of rows) insertRaw.run(r);
  });

  return {
    db,
    insertRawRow: (row: MetricsRawRow) => insertRaw.run(row),
    insertRawMany: (rows: MetricsRawRow[]) => txnInsertRawMany(rows),
    insert1mRow: (row: Metrics1mRow) => insert1m.run(row),
    selectRawRange: (fromMs: number, toMs: number) => selectRawRange.all(fromMs, toMs) as MetricsRawRow[],
    select1mRange: (fromMs: number, toMs: number) => select1mRange.all(fromMs, toMs) as Metrics1mRow[],
    pruneRaw: (olderThanMs: number) => deleteRawOlderThan.run(olderThanMs).changes,
    prune1m: (olderThanMs: number) => delete1mOlderThan.run(olderThanMs).changes,
    close: () => db.close(),
  };
}

export function floorToMinute(ms: number) {
  return Math.floor(ms / 60_000) * 60_000;
}

export function compute1mRollup(bucketStartMs: number, raws: MetricsRawRow[]): Metrics1mRow {
  // average over values that are not null.
  const avg = (xs: Array<number | null>) => {
    const vals = xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
    if (!vals.length) return null;
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  };

  return {
    bucketStartMs,
    cpuUsagePctAvg10s: avg(raws.map((r) => r.cpuUsagePctAvg10s ?? null)),
    cpuTempC: avg(raws.map((r) => r.cpuTempC ?? null)),
    diskUsedPct: avg(raws.map((r) => r.diskUsedPct ?? null)),
    memUsedPct: (avg(raws.map((r) => r.memUsedPct)) ?? 0),
  };
}
