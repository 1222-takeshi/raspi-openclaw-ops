import Fastify from 'fastify';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';

const execFileAsync = promisify(execFile);

type Health = 'ok' | 'degraded' | 'down';

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

  const timeZone = (process.env.TIME_ZONE ?? 'Asia/Tokyo').trim() || 'Asia/Tokyo';
  const timeLocal = formatLocalTime(nowDate, timeZone);

  return {
    time: now,
    timeZone,
    timeLocal,
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

function htmlPage(data: Awaited<ReturnType<typeof collectStatus>>) {
  const healthColor = data.health === 'ok' ? '#16a34a' : data.health === 'degraded' ? '#f59e0b' : '#dc2626';
  const title = `raspi-openclaw-ops • ${data.health.toUpperCase()}`;

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
        <div class="sub">Last updated: ${data.timeLocal} <span style="color:var(--muted)">(${data.timeZone})</span></div>
      </div>
      <div class="badge" aria-label="health">
        <span class="dot"></span>
        <div>
          <div style="font-size:12px;color:var(--muted)">Health</div>
          <div style="font-weight:700">${data.health.toUpperCase()}</div>
        </div>
      </div>
    </div>

    <div class="grid">
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
        <p class="k">CPU usage</p>
        <p class="v">
          <span style="font-weight:800">avg10s:</span>
          ${data.host.cpuUsagePctAvg10s == null
            ? '<span style="color:var(--muted)">n/a</span>'
            : `${data.host.cpuUsagePctAvg10s.toFixed(0)}%`}
        </p>
        <div class="sub">
          now: ${data.host.cpuUsagePctInstant == null ? 'n/a' : `${data.host.cpuUsagePctInstant.toFixed(0)}%`}
          ・ calculated from <code>/proc/stat</code> deltas (first request may be n/a)
        </div>
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
        </div>
      </div>
    </div>

    <div class="footer">
      <div>Tip: restrict LAN access via firewall + token if exposing beyond LAN.</div>
      <div><a href="/status.json">JSON</a></div>
    </div>
  </div>
</body>
</html>`;
}

const app = Fastify({ logger: true });

app.get('/', async (_req, reply) => {
  const data = await collectStatus();
  reply.type('text/html; charset=utf-8').send(htmlPage(data));
});

app.get('/health.json', async (_req, reply) => {
  const data = await collectStatus();
  reply.send({ time: data.time, health: data.health, notes: data.notes, checks: data.checks });
});

app.get('/status.json', async (_req, reply) => {
  const data = await collectStatus();
  reply.send(data);
});

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? '0.0.0.0';

app.listen({ port, host }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
