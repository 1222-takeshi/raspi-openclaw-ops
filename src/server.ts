import Fastify from 'fastify';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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

async function collectStatus() {
  const now = new Date().toISOString();
  const uptimeSec = os.uptime();
  const load = os.loadavg();
  const memTotal = os.totalmem();
  const memFree = os.freemem();

  const clawdbotService = process.env.CLAWDBOT_SERVICE ?? 'clawdbot-gateway';
  const clawdbotState = await systemctlIsActive(clawdbotService);

  let health: Health = 'ok';
  const notes: string[] = [];

  if (clawdbotState !== 'active') {
    health = 'degraded';
    notes.push(`systemd: ${clawdbotService} is ${clawdbotState}`);
  }

  // crude memory pressure heuristic
  const memUsed = memTotal - memFree;
  const memUsedPct = (memUsed / memTotal) * 100;
  if (memUsedPct > 90) {
    health = health === 'ok' ? 'degraded' : health;
    notes.push(`memory usage high: ${memUsedPct.toFixed(1)}%`);
  }

  return {
    time: now,
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
      ips: Object.values(os.networkInterfaces())
        .flat()
        .filter((x) => x && x.family === 'IPv4' && !x.internal)
        .map((x) => x!.address),
    },
    services: {
      [clawdbotService]: clawdbotState,
    },
  };
}

function htmlPage(data: Awaited<ReturnType<typeof collectStatus>>) {
  const healthColor = data.health === 'ok' ? '#16a34a' : data.health === 'degraded' ? '#f59e0b' : '#dc2626';
  const title = `raspi-clawdbot-ops • ${data.health.toUpperCase()}`;

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
        <h1>raspi-clawdbot-ops</h1>
        <div class="sub">Last updated: ${data.time}</div>
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
        <p class="k">Clawdbot service</p>
        <p class="v"><code>${Object.keys(data.services)[0]}</code> = <span style="font-weight:700">${Object.values(data.services)[0]}</span></p>
        <div class="sub">Set env <code>CLAWDBOT_SERVICE</code> to match your systemd unit name.</div>
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
  reply.send({ time: data.time, health: data.health, notes: data.notes, services: data.services });
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
