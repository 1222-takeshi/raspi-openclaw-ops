import Fastify from 'fastify';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { getBuildInfo } from './build.js';
import { compute1mRollup, floorToMinute, openDb, type MetricsRawRow } from './metricsDb.js';
import { getInodeUsageRoot, scanDmesgErrors } from './earlyWarn.js';

const execFileAsync = promisify(execFile);

type Health = 'ok' | 'degraded' | 'down';

type MetricsSample = {
  time: string; // ISO
  timeMs: number;
  cpuUsagePctInstant: number | null;
  cpuUsagePctAvg10s: number | null;
  cpuTempC: number | null;
  diskUsedPct: number | null;
  memUsedPct: number;
};

function fmtBytes(n: number) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let x = n;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i++;
  }
  return `${x.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

let cachedPkgVersion: string | null = null;
async function getPackageVersion(): Promise<string> {
  if (cachedPkgVersion) return cachedPkgVersion;
  try {
    const url = new URL('../package.json', import.meta.url);
    const txt = await readFile(url, 'utf8');
    const j = JSON.parse(txt);
    const v = typeof j?.version === 'string' ? j.version : 'unknown';
    cachedPkgVersion = v;
    return v;
  } catch {
    return 'unknown';
  }
}

async function systemctlIsActive(service: string) {
  try {
    const { stdout } = await execFileAsync('systemctl', ['is-active', service], { timeout: 3000 });
    return stdout.trim(); // active/inactive/failed/unknown
  } catch (e: any) {
    // systemctl returns non-zero for inactive/failed
    const out = (e?.stdout ?? '').toString().trim();
    return out || 'unknown';
  }
}

async function pgrepCount(pattern: string) {
  // Use `pgrep -f` so we can match command line, not only the process name.
  // Returns number of matching PIDs.
  try {
    const { stdout } = await execFileAsync('pgrep', ['-f', pattern], { timeout: 3000 });
    const pids = stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    return pids.length;
  } catch {
    // pgrep exits non-zero when no processes matched
    return 0;
  }
}

async function getCpuTempC(): Promise<number | null> {
  // Prefer vcgencmd on Raspberry Pi, fallback to thermal_zone.
  try {
    const { stdout } = await execFileAsync('vcgencmd', ['measure_temp'], { timeout: 2000 });
    // temp=42.0'C
    const m = stdout.match(/temp=([0-9.]+)/);
    if (m) return Number(m[1]);
  } catch {
    // ignore
  }

  try {
    const s = (await readFile('/sys/class/thermal/thermal_zone0/temp', 'utf8')).trim();
    const milli = Number(s);
    if (!Number.isFinite(milli)) return null;
    // Usually millidegree C
    if (milli > 1000) return milli / 1000;
    return milli;
  } catch {
    return null;
  }
}

async function getDiskUsageRoot() {
  // POSIX output (-P) is easier to parse.
  try {
    const { stdout } = await execFileAsync('df', ['-P', '/'], { timeout: 3000 });
    const lines = stdout.trim().split(/\r?\n/);
    if (lines.length < 2) return null;
    const cols = lines[1].split(/\s+/);
    // Filesystem 1024-blocks Used Available Capacity Mounted on
    const totalKiB = Number(cols[1]);
    const usedKiB = Number(cols[2]);
    const availKiB = Number(cols[3]);
    const cap = cols[4]; // e.g. 42%
    const usedPct = Number(cap.replace('%', ''));
    if (![totalKiB, usedKiB, availKiB, usedPct].every((n) => Number.isFinite(n))) return null;
    return {
      totalBytes: totalKiB * 1024,
      usedBytes: usedKiB * 1024,
      availBytes: availKiB * 1024,
      usedPct,
      mount: '/',
    };
  } catch {
    return null;
  }
}

let lastProcStat: { timeMs: number; total: number; idle: number } | null = null;
let cpuUsageSamples: Array<{ timeMs: number; usagePct: number }> = [];

let metricsHistory: MetricsSample[] = [];
const METRICS_MAX_SAMPLES = 12 * 60; // 12 samples/min * 60 min = 1 hour at 5s interval
const METRICS_INTERVAL_MS = Number(process.env.METRICS_INTERVAL_MS ?? 5000);

const METRICS_DB_PATH = (process.env.METRICS_DB_PATH ?? '/opt/raspi-openclaw-ops/data/metrics.db').trim();
const METRICS_RAW_RETENTION_HOURS = Number(process.env.METRICS_RAW_RETENTION_HOURS ?? 24);
const METRICS_1M_RETENTION_DAYS = Number(process.env.METRICS_1M_RETENTION_DAYS ?? 30);
const METRICS_DEFAULT_RANGE_HOURS = Number(process.env.METRICS_DEFAULT_RANGE_HOURS ?? 6);

async function ensureDbDir(dbPath: string) {
  if (dbPath === ':memory:') return;
  // If path has no dir (e.g. "metrics.db"), dirname returns "." which is fine.
  const dir = path.dirname(dbPath);
  if (dir && dir !== '.') {
    await mkdir(dir, { recursive: true });
  }
}

await ensureDbDir(METRICS_DB_PATH);
const metricsDb = openDb({ path: METRICS_DB_PATH });
let pendingRawBatch: MetricsRawRow[] = [];
let lastRollupBucketStartMs: number | null = null;
let lastPruneAtMs: number | null = null;

async function getCpuUsagePctInstant(): Promise<number | null> {
  // Linux-only: compute usage from /proc/stat deltas.
  // Returns percent (0-100). First call returns null.
  let s: string;
  try {
    s = await readFile('/proc/stat', 'utf8');
  } catch {
    return null;
  }

  const line = s.split(/\r?\n/).find((l) => l.startsWith('cpu '));
  if (!line) return null;

  const parts = line.trim().split(/\s+/).slice(1).map(Number);
  if (parts.length < 4 || parts.some((n) => !Number.isFinite(n))) return null;

  const [user, nice, system, idle, iowait = 0, irq = 0, softirq = 0, steal = 0] = parts;
  const idleAll = idle + iowait;
  const nonIdle = user + nice + system + irq + softirq + steal;
  const total = idleAll + nonIdle;

  const nowMs = Date.now();
  const prev = lastProcStat;
  lastProcStat = { timeMs: nowMs, total, idle: idleAll };

  if (!prev) return null;
  const dt = nowMs - prev.timeMs;
  if (dt < 250) return null; // too soon; avoid noisy spikes

  const totald = total - prev.total;
  const idled = idleAll - prev.idle;
  if (totald <= 0) return null;

  const usage = ((totald - idled) / totald) * 100;
  return Math.max(0, Math.min(100, usage));
}

function recordCpuUsageSample(timeMs: number, usagePct: number) {
  cpuUsageSamples.push({ timeMs, usagePct });
  // keep last 60s of samples
  const cutoff = timeMs - 60_000;
  cpuUsageSamples = cpuUsageSamples.filter((s) => s.timeMs >= cutoff);
}

function cpuUsageAvg(windowMs: number, nowMs: number) {
  const from = nowMs - windowMs;
  const samples = cpuUsageSamples.filter((s) => s.timeMs >= from && s.timeMs <= nowMs);
  if (!samples.length) return null;
  const sum = samples.reduce((a, s) => a + s.usagePct, 0);
  return sum / samples.length;
}

function formatLocalTime(date: Date, timeZone: string) {
  // Example: 2026/02/08 10:37:12 (JST)
  const fmt = new Intl.DateTimeFormat('ja-JP', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  return fmt.format(date);
}

async function collectStatus() {
  const nowDate = new Date();
  const now = nowDate.toISOString();

  const pkgVersion = await getPackageVersion();
  const build = getBuildInfo(process.env as any, pkgVersion);
  const uptimeSec = os.uptime();
  const load = os.loadavg();
  const memTotal = os.totalmem();
  const memFree = os.freemem();

  const cpuTempC = await getCpuTempC();

  const nowMs = Date.now();
  const cpuUsagePctInstant = await getCpuUsagePctInstant();
  if (cpuUsagePctInstant != null) recordCpuUsageSample(nowMs, cpuUsagePctInstant);
  const cpuUsagePctAvg10s = cpuUsageAvg(10_000, nowMs);

  const diskRoot = await getDiskUsageRoot();
  const inodeRoot = await getInodeUsageRoot();

  const clawdbotService = (process.env.CLAWDBOT_SERVICE ?? '').trim();
  const clawdbotProcPatternsRaw = (process.env.CLAWDBOT_PROCESS_PATTERNS ?? '').trim();

  const clawdbotState = clawdbotService ? await systemctlIsActive(clawdbotService) : null;

  const procPatterns = clawdbotProcPatternsRaw
    ? clawdbotProcPatternsRaw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  const procChecks = procPatterns.length
    ? await Promise.all(
        procPatterns.map(async (pattern) => {
          const count = await pgrepCount(pattern);
          return { pattern, count, running: count > 0 };
        }),
      )
    : null;

  let health: Health = 'ok';
  const notes: string[] = [];

  // Health checks are optional; enable via env vars.
  if (clawdbotService) {
    if (clawdbotState !== 'active') {
      health = 'degraded';
      notes.push(`systemd: ${clawdbotService} is ${clawdbotState}`);
    }
  } else if (procChecks) {
    const down = procChecks.filter((c) => !c.running);
    if (down.length) {
      health = 'degraded';
      for (const d of down) notes.push(`process: "${d.pattern}" not running`);
    }
  }

  // crude memory pressure heuristic
  const memUsed = memTotal - memFree;
  const memUsedPct = (memUsed / memTotal) * 100;
  if (memUsedPct > 90) {
    health = health === 'ok' ? 'degraded' : health;
    notes.push(`memory usage high: ${memUsedPct.toFixed(1)}%`);
  }

  // thresholds (default: temp >= 80C, disk used >= 90%)
  const tempWarnC = Number(process.env.CPU_TEMP_WARN_C ?? 80);
  if (cpuTempC != null && Number.isFinite(tempWarnC) && cpuTempC >= tempWarnC) {
    health = health === 'ok' ? 'degraded' : health;
    notes.push(`cpu temp high: ${cpuTempC.toFixed(1)}°C (>= ${tempWarnC}°C)`);
  }

  const diskWarnPct = Number(process.env.DISK_USED_WARN_PCT ?? 90);
  if (diskRoot && Number.isFinite(diskWarnPct) && diskRoot.usedPct >= diskWarnPct) {
    health = health === 'ok' ? 'degraded' : health;
    notes.push(`disk usage high: ${diskRoot.usedPct}% (>= ${diskWarnPct}%)`);
  }

  const inodeWarnPct = Number(process.env.INODE_USED_WARN_PCT ?? 90);
  if (inodeRoot && Number.isFinite(inodeWarnPct) && inodeRoot.usedPct >= inodeWarnPct) {
    health = health === 'ok' ? 'degraded' : health;
    notes.push(`inode usage high: ${inodeRoot.usedPct}% (>= ${inodeWarnPct}%)`);
  }

  // Early warning: dmesg error summary (best-effort)
  if (lastDmesgErrorSummary && Date.now() - lastDmesgErrorSummary.atMs < 15 * 60_000) {
    health = health === 'ok' ? 'degraded' : health;
    notes.push(`dmesg: ${lastDmesgErrorSummary.reason} (${lastDmesgErrorSummary.count} lines)`);
  }

  const timeZone = (process.env.TIME_ZONE ?? 'Asia/Tokyo').trim() || 'Asia/Tokyo';
  const timeLocal = formatLocalTime(nowDate, timeZone);

  return {
    time: now,
    timeZone,
    timeLocal,
    build,
    health,
    notes,
    host: {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      cpus: os.cpus().length,
      uptimeSec,
      load1: load[0],
      load5: load[1],
      load15: load[2],
      memTotalBytes: memTotal,
      memFreeBytes: memFree,
      memUsedBytes: memUsed,
      memUsedPct,
      cpuTempC,
      cpuUsagePctInstant,
      cpuUsagePctAvg10s,
      diskRoot,
      inodeRoot,
      ips: Object.values(os.networkInterfaces())
        .flat()
        .filter((x) => x && x.family === 'IPv4' && !x.internal)
        .map((x) => x!.address),
    },
    checks: {
      systemd: clawdbotService
        ? {
            unit: clawdbotService,
            state: clawdbotState,
          }
        : null,
      process: procChecks,
    },
  };
}

function addMetricsSampleFromStatus(status: Awaited<ReturnType<typeof collectStatus>>): MetricsSample {
  const timeMs = Date.parse(status.time);
  const diskUsedPct = status.host.diskRoot ? status.host.diskRoot.usedPct : null;
  const s: MetricsSample = {
    time: status.time,
    timeMs,
    cpuUsagePctInstant: status.host.cpuUsagePctInstant ?? null,
    cpuUsagePctAvg10s: status.host.cpuUsagePctAvg10s ?? null,
    cpuTempC: status.host.cpuTempC ?? null,
    diskUsedPct,
    memUsedPct: status.host.memUsedPct,
  };

  // in-memory history (for quick charts)
  metricsHistory.push(s);
  if (metricsHistory.length > METRICS_MAX_SAMPLES) {
    metricsHistory = metricsHistory.slice(metricsHistory.length - METRICS_MAX_SAMPLES);
  }

  // persistent raw batch
  pendingRawBatch.push({
    timeMs,
    cpuUsagePctInstant: s.cpuUsagePctInstant,
    cpuUsagePctAvg10s: s.cpuUsagePctAvg10s,
    cpuTempC: s.cpuTempC,
    diskUsedPct: s.diskUsedPct,
    memUsedPct: s.memUsedPct,
  });

  return s;
}

let metricsSamplerStarted = false;
let lastDmesgErrorSummary: { atMs: number; reason: string; count: number } | null = null;
function startMetricsSampler() {
  if (metricsSamplerStarted) return;
  metricsSamplerStarted = true;

  const interval = Number.isFinite(METRICS_INTERVAL_MS) && METRICS_INTERVAL_MS >= 1000 ? METRICS_INTERVAL_MS : 5000;
  setInterval(async () => {
    try {
      const status = await collectStatus();
      addMetricsSampleFromStatus(status);

      // Flush raw batch (reduce write frequency)
      if (pendingRawBatch.length) {
        const batch = pendingRawBatch;
        pendingRawBatch = [];
        metricsDb.insertRawMany(batch);
      }

      // Rollup: once we cross a new minute bucket, roll up the previous full minute.
      const nowMs = Date.now();
      const bucket = floorToMinute(nowMs - 60_000);
      if (lastRollupBucketStartMs == null || bucket > lastRollupBucketStartMs) {
        const raws = metricsDb.selectRawRange(bucket, bucket + 60_000 - 1);
        metricsDb.insert1mRow(compute1mRollup(bucket, raws));
        lastRollupBucketStartMs = bucket;
      }

      // Prune occasionally (every 10 minutes)
      if (lastPruneAtMs == null || nowMs - lastPruneAtMs > 10 * 60_000) {
        const rawCutoff = nowMs - Math.max(1, METRICS_RAW_RETENTION_HOURS) * 3600_000;
        const m1Cutoff = nowMs - Math.max(1, METRICS_1M_RETENTION_DAYS) * 24 * 3600_000;
        metricsDb.pruneRaw(rawCutoff);
        metricsDb.prune1m(m1Cutoff);
        lastPruneAtMs = nowMs;

        // Early warning: best-effort dmesg scan (do not crash if unavailable)
        const enabled = String(process.env.DMESG_SCAN_ENABLED ?? '1') !== '0';
        if (enabled) {
          const maxLines = Number(process.env.DMESG_MAX_LINES ?? 200);
          const r = await scanDmesgErrors(Number.isFinite(maxLines) ? maxLines : 200);
          if (r?.found) {
            lastDmesgErrorSummary = { atMs: nowMs, reason: r.reason ?? 'error', count: r.lines.length };
          }
        }
      }
    } catch {
      // ignore
    }
  }, interval).unref?.();
}

function htmlPage(data: Awaited<ReturnType<typeof collectStatus>>) {
  const healthColor = data.health === 'ok' ? '#16a34a' : data.health === 'degraded' ? '#f59e0b' : '#dc2626';
  const title = `raspi-openclaw-ops • ${data.health.toUpperCase()}`;

  const metricsSection = `
      <div class="card">
        <div style="display:flex; align-items:flex-end; justify-content:space-between; gap:12px; flex-wrap:wrap">
          <div>
            <p class="k">CPU usage（avg10s）</p>
            <p class="v" style="font-size:28px; font-weight:900; margin-top:2px">
              ${data.host.cpuUsagePctAvg10s == null ? '<span style="color:var(--muted)">n/a</span>' : `${data.host.cpuUsagePctAvg10s.toFixed(0)}%`}
            </p>
            <div class="sub">now: ${data.host.cpuUsagePctInstant == null ? 'n/a' : `${data.host.cpuUsagePctInstant.toFixed(0)}%`} ・ source: <code>/proc/stat</code></div>
          </div>
          <div class="sub">Last updated: ${data.timeLocal} (${data.timeZone})</div>
        </div>
        <div style="margin-top:12px">
          <canvas id="cpuChart" height="120" style="width:100%; background: rgba(255,255,255,0.02); border:1px solid var(--border); border-radius:14px"></canvas>
          <div class="sub" style="margin-top:6px">直近の推移（メモリ内保持）。更新は約5秒ごと。</div>
        </div>
      </div>

      <div class="card">
        <p class="k">メトリクス</p>
        <div class="sub">
          <div>CPU temp: <b>${data.host.cpuTempC == null ? 'n/a' : `${data.host.cpuTempC.toFixed(1)}°C`}</b></div>
          <div>Disk (/): <b>${data.host.diskRoot ? `${data.host.diskRoot.usedPct}%` : 'n/a'}</b></div>
          <div>Memory used: <b>${data.host.memUsedPct.toFixed(1)}%</b></div>
        </div>
      </div>
  `;

  const summarySection = `
      <div class="card half">
        <p class="k">Host</p>
        <p class="v">${data.host.hostname} <span style="color:var(--muted);font-size:12px">(${data.host.platform}/${data.host.arch})</span></p>
        <div class="sub">IPs: ${data.host.ips.length ? data.host.ips.map((ip) => `<code>${ip}</code>`).join(' ') : '<span style="color:var(--muted)">none</span>'}</div>
      </div>

      <div class="card half">
        <p class="k">Clawdbot プロセス</p>
        ${data.checks.systemd
          ? `<div class="sub">systemd unit: <code>${data.checks.systemd.unit}</code> = <span style="font-weight:700">${data.checks.systemd.state}</span></div>`
          : data.checks.process
          ? `<div style="display:grid;gap:6px">
              ${data.checks.process
                .map((c) => {
                  const color = c.running ? '#16a34a' : '#dc2626';
                  const label = c.running ? 'RUNNING' : 'NOT RUNNING';
                  return `<div class="sub"><span style="display:inline-block;width:10px;height:10px;border-radius:999px;background:${color};margin-right:8px"></span><code>${c.pattern}</code>: <span style="font-weight:800;color:${color}">${label}</span> <span style="color:var(--muted)">(match: ${c.count})</span></div>`;
                })
                .join('')}
            </div>`
          : `<p class="v"><span style="color:var(--muted)">未設定</span></p>`}
        <div class="sub">設定: <code>CLAWDBOT_SERVICE</code>（systemd）または <code>CLAWDBOT_PROCESS_PATTERNS</code>（例: <code>clawdbot-gateway,clawdbot</code>）</div>
      </div>

      <div class="card half">
        <p class="k">Load average</p>
        <p class="v">${data.host.load1.toFixed(2)} / ${data.host.load5.toFixed(2)} / ${data.host.load15.toFixed(2)}</p>
        <div class="sub">1 / 5 / 15 min</div>
      </div>

      <div class="card half">
        <p class="k">Memory</p>
        <p class="v">Used ${fmtBytes(data.host.memUsedBytes)} / ${fmtBytes(data.host.memTotalBytes)} (${data.host.memUsedPct.toFixed(1)}%)</p>
      </div>

      <div class="card half">
        <p class="k">CPU temperature</p>
        <p class="v">${data.host.cpuTempC == null ? '<span style="color:var(--muted)">n/a</span>' : `${data.host.cpuTempC.toFixed(1)}°C`}</p>
        <div class="sub">Warn if >= <code>${Number(process.env.CPU_TEMP_WARN_C ?? 80)}°C</code> (env: <code>CPU_TEMP_WARN_C</code>)</div>
      </div>

      <div class="card half">
        <p class="k">Disk (/)</p>
        <p class="v">${data.host.diskRoot ? `Used ${fmtBytes(data.host.diskRoot.usedBytes)} / ${fmtBytes(data.host.diskRoot.totalBytes)} (${data.host.diskRoot.usedPct}%)` : '<span style="color:var(--muted)">n/a</span>'}</p>
        <div class="sub">Warn if >= <code>${Number(process.env.DISK_USED_WARN_PCT ?? 90)}%</code> (env: <code>DISK_USED_WARN_PCT</code>)</div>
      </div>

      <div class="card">
        <p class="k">Notes</p>
        ${data.notes.length ? `<ul>${data.notes.map((n) => `<li>${n}</li>`).join('')}</ul>` : `<div class="sub">No issues detected.</div>`}
      </div>

      <div class="card">
        <p class="k">Endpoints</p>
        <div class="sub">
          <div><a href="/health.json">/health.json</a> (machine readable)</div>
          <div><a href="/status.json">/status.json</a> (full status)</div>
          <div><a href="/metrics.json">/metrics.json</a> (metrics history)</div>
        </div>
      </div>
  `;

  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    :root{--bg:#0b1020;--panel:#0f172a;--muted:#94a3b8;--text:#e2e8f0;--border:#1f2a44;}
    *{box-sizing:border-box;font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;}
    body{margin:0;background:linear-gradient(180deg,#070a14,#0b1020);color:var(--text);}
    .wrap{max-width:980px;margin:0 auto;padding:24px;}
    .top{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap;}
    .badge{display:inline-flex;align-items:center;gap:10px;padding:10px 14px;border-radius:999px;background:rgba(255,255,255,0.04);border:1px solid var(--border);}
    .dot{width:10px;height:10px;border-radius:999px;background:${healthColor};box-shadow:0 0 18px ${healthColor};}
    h1{font-size:18px;margin:0;letter-spacing:0.2px;}
    .sub{color:var(--muted);font-size:12px;margin-top:4px;}
    .tabs{display:flex;gap:8px;margin-top:14px}
    .tab{padding:8px 12px;border-radius:999px;border:1px solid var(--border);background:rgba(255,255,255,0.03);color:var(--text);cursor:pointer;font-size:12px}
    .tab[aria-selected="true"]{background:rgba(96,165,250,0.16);border-color:rgba(96,165,250,0.35)}
    .grid{display:grid;grid-template-columns:repeat(12,1fr);gap:12px;margin-top:16px;}
    .card{grid-column:span 12;background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:16px;padding:16px;}
    @media(min-width:860px){.card.half{grid-column:span 6;}}
    .k{color:var(--muted);font-size:12px;margin:0 0 6px;}
    .v{font-size:16px;margin:0;}
    ul{margin:8px 0 0 18px;color:var(--text);} 
    a{color:#60a5fa;text-decoration:none;} a:hover{text-decoration:underline;}
    code{background:rgba(255,255,255,0.06);padding:2px 6px;border-radius:8px;border:1px solid var(--border)}
    .footer{margin-top:14px;color:var(--muted);font-size:12px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div>
        <h1>raspi-openclaw-ops</h1>
        <div class="sub">Last updated: ${data.timeLocal} <span style="color:var(--muted)">(${data.timeZone})</span> ・ v${data.build.version}${data.build.gitRef ? ` (${data.build.gitRef}${data.build.gitSha ? ` @ ${data.build.gitSha}` : ''})` : ''}</div>
      </div>
      <div class="badge" aria-label="health">
        <span class="dot"></span>
        <div>
          <div style="font-size:12px;color:var(--muted)">Health</div>
          <div style="font-weight:700">${data.health.toUpperCase()}</div>
        </div>
      </div>
    </div>

    <div class="tabs" role="tablist" aria-label="views">
      <button class="tab" role="tab" aria-selected="true" data-tab="summary">Summary</button>
      <button class="tab" role="tab" aria-selected="false" data-tab="metrics">Metrics</button>
    </div>

    <div id="view-summary" class="grid">
      ${summarySection}
    </div>

    <div id="view-metrics" class="grid" style="display:none">
      ${metricsSection}
    </div>

    <div class="footer">
      <div>Tip: restrict LAN access via firewall + token if exposing beyond LAN.</div>
      <div><a href="/status.json">JSON</a></div>
    </div>
  </div>

<script>
(function(){
  const tabs = Array.from(document.querySelectorAll('.tab'));
  function setTab(name){
    for (const t of tabs) t.setAttribute('aria-selected', t.dataset.tab === name ? 'true' : 'false');
    document.getElementById('view-summary').style.display = name==='summary' ? 'grid' : 'none';
    document.getElementById('view-metrics').style.display = name==='metrics' ? 'grid' : 'none';
    if (name==='metrics') renderChart();
  }
  for (const t of tabs) t.addEventListener('click', ()=>setTab(t.dataset.tab));

  async function fetchMetrics(){
    const r = await fetch('/metrics.json', {cache:'no-store'});
    return await r.json();
  }

  function drawLine(ctx, points, w, h){
    ctx.clearRect(0,0,w,h);
    ctx.strokeStyle = 'rgba(96,165,250,0.9)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    points.forEach((p,i)=>{ if(i===0) ctx.moveTo(p.x,p.y); else ctx.lineTo(p.x,p.y); });
    ctx.stroke();
  }

  async function renderChart(){
    const canvas = document.getElementById('cpuChart');
    if(!canvas) return;
    const ctx = canvas.getContext('2d');
    const cssW = canvas.getBoundingClientRect().width;
    const cssH = canvas.getBoundingClientRect().height;
    canvas.width = Math.floor(cssW * devicePixelRatio);
    canvas.height = Math.floor(cssH * devicePixelRatio);
    ctx.scale(devicePixelRatio, devicePixelRatio);

    let data;
    try{ data = await fetchMetrics(); }catch(e){ return; }
    const samples = (data.samples||[]).filter(s=> typeof s.cpuUsagePctAvg10s === 'number');
    if(samples.length<2) return;

    const w = cssW, h = cssH;
    const minX = samples[0].timeMs, maxX = samples[samples.length-1].timeMs;
    const ys = samples.map(s=>s.cpuUsagePctAvg10s);
    const minY = 0, maxY = Math.max(100, ...ys);

    const points = samples.map(s=>({
      x: ((s.timeMs - minX) / (maxX - minX)) * (w-8) + 4,
      y: h - (((s.cpuUsagePctAvg10s - minY) / (maxY - minY)) * (h-8) + 4)
    }));

    // grid
    ctx.strokeStyle = 'rgba(148,163,184,0.18)';
    ctx.lineWidth = 1;
    for(let i=0;i<=4;i++){
      const y = (h/4)*i;
      ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(w,y); ctx.stroke();
    }
    drawLine(ctx, points, w, h);
  }

  // refresh when metrics tab visible
  setInterval(()=>{
    const selected = tabs.find(t=>t.getAttribute('aria-selected')==='true');
    if(selected && selected.dataset.tab==='metrics') renderChart();
  }, 5000);
})();
</script>

</body>
</html>`;
}

const app = Fastify({ logger: true });

function getProvidedToken(req: any): string | null {
  const q = (req.query?.token ?? '') as string;
  if (typeof q === 'string' && q.trim()) return q.trim();

  const auth = (req.headers?.authorization ?? '') as string;
  if (typeof auth === 'string') {
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m?.[1]?.trim()) return m[1].trim();
  }

  const x = (req.headers?.['x-status-token'] ?? '') as string;
  if (typeof x === 'string' && x.trim()) return x.trim();

  return null;
}

function statusTokenEnabled() {
  const t = (process.env.STATUS_TOKEN ?? '').trim();
  return t.length > 0 ? t : null;
}

function constantTimeEqual(a: string, b: string) {
  // best-effort constant time compare
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

app.addHook('onRequest', async (req, reply) => {
  const expected = statusTokenEnabled();
  if (!expected) return;

  const provided = getProvidedToken(req);
  if (!provided || !constantTimeEqual(provided, expected)) {
    const wantsHtml = String(req.headers?.accept ?? '').includes('text/html');
    reply.code(401);
    if (wantsHtml) {
      reply.type('text/html; charset=utf-8').send('<h1>401 Unauthorized</h1><p>Token is required.</p>');
    } else {
      reply.send({ error: 'unauthorized' });
    }
  }
});

// Start background sampler to provide metrics history for graphs.
startMetricsSampler();

app.get('/', async (_req, reply) => {
  const data = await collectStatus();
  reply.type('text/html; charset=utf-8').send(htmlPage(data));
});

app.get('/health.json', async (_req, reply) => {
  const data = await collectStatus();
  reply.send({ time: data.time, health: data.health, notes: data.notes, build: data.build, checks: data.checks });
});

app.get('/status.json', async (_req, reply) => {
  const data = await collectStatus();
  reply.send(data);
});

app.get('/metrics.json', async (req, reply) => {
  // Query params:
  // - rangeHours (default from env)
  const rangeHours = Number((req.query as any)?.rangeHours ?? METRICS_DEFAULT_RANGE_HOURS);
  const hours = Number.isFinite(rangeHours) ? Math.max(0.25, Math.min(24 * 30, rangeHours)) : METRICS_DEFAULT_RANGE_HOURS;

  const nowMs = Date.now();
  const fromMs = nowMs - hours * 3600_000;

  // Strategy:
  // - last 24h: raw
  // - older: 1m rollups
  const rawFromMs = Math.max(fromMs, nowMs - Math.max(1, METRICS_RAW_RETENTION_HOURS) * 3600_000);
  const rawRows = metricsDb.selectRawRange(rawFromMs, nowMs);

  const rollupRows = fromMs < rawFromMs ? metricsDb.select1mRange(fromMs, rawFromMs) : [];

  const samples: MetricsSample[] = [];
  for (const r of rollupRows) {
    samples.push({
      time: new Date(r.bucketStartMs).toISOString(),
      timeMs: r.bucketStartMs,
      cpuUsagePctInstant: null,
      cpuUsagePctAvg10s: r.cpuUsagePctAvg10s ?? null,
      cpuTempC: r.cpuTempC ?? null,
      diskUsedPct: r.diskUsedPct ?? null,
      memUsedPct: r.memUsedPct,
    });
  }
  for (const r of rawRows) {
    samples.push({
      time: new Date(r.timeMs).toISOString(),
      timeMs: r.timeMs,
      cpuUsagePctInstant: r.cpuUsagePctInstant ?? null,
      cpuUsagePctAvg10s: r.cpuUsagePctAvg10s ?? null,
      cpuTempC: r.cpuTempC ?? null,
      diskUsedPct: r.diskUsedPct ?? null,
      memUsedPct: r.memUsedPct,
    });
  }

  reply.send({
    intervalMs: Number.isFinite(METRICS_INTERVAL_MS) ? METRICS_INTERVAL_MS : 5000,
    rangeHours: hours,
    dbPath: METRICS_DB_PATH,
    samples,
  });
});

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? '0.0.0.0';

app.listen({ port, host }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
