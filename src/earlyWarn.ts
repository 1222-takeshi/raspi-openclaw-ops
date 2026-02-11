import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type InodeUsage = {
  usedPct: number;
  inodes: number;
  iused: number;
  ifree: number;
  mount: string;
};

export function parseDfInodesRoot(stdout: string): InodeUsage | null {
  const lines = stdout.trim().split(/\r?\n/);
  if (lines.length < 2) return null;
  const cols = lines[1].split(/\s+/);
  // Filesystem Inodes IUsed IFree IUse% Mounted on
  const inodes = Number(cols[1]);
  const iused = Number(cols[2]);
  const ifree = Number(cols[3]);
  const usedPct = Number(String(cols[4]).replace('%', ''));
  const mount = cols[5] ?? '/';
  if (![inodes, iused, ifree, usedPct].every((n) => Number.isFinite(n))) return null;
  return { usedPct, inodes, iused, ifree, mount };
}

export async function getInodeUsageRoot(): Promise<InodeUsage | null> {
  try {
    const { stdout } = await execFileAsync('df', ['-Pi', '/'], { timeout: 3000 });
    return parseDfInodesRoot(stdout);
  } catch {
    return null;
  }
}

export type DmesgScanResult = {
  found: boolean;
  lines: string[];
  reason: string | null;
};

export function detectDmesgErrors(lines: string[]): DmesgScanResult {
  const patterns: Array<[RegExp, string]> = [
    [/\bI\/O error\b/i, 'I/O error'],
    [/\bBuffer I\/O error\b/i, 'Buffer I/O error'],
    [/\bEXT4-fs error\b/i, 'EXT4 fs error'],
    [/\bmmc\d+: Timeout\b/i, 'mmc timeout'],
    [/\bread-only file system\b/i, 'read-only filesystem'],
  ];

  const matched: string[] = [];
  for (const ln of lines) {
    for (const [re] of patterns) {
      if (re.test(ln)) {
        matched.push(ln);
        break;
      }
    }
  }

  if (!matched.length) return { found: false, lines: [], reason: null };

  // Provide a short reason label
  let reason = 'kernel/storage error';
  for (const [re, label] of patterns) {
    if (matched.some((m) => re.test(m))) {
      reason = label;
      break;
    }
  }

  return { found: true, lines: matched, reason };
}

export async function scanDmesgErrors(maxLines = 200): Promise<DmesgScanResult | null> {
  try {
    const { stdout } = await execFileAsync(
      'dmesg',
      ['--level=err,crit,alert,emerg', '--color=never'],
      { timeout: 5000 },
    );
    const all = stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    const tail = all.slice(Math.max(0, all.length - maxLines));
    return detectDmesgErrors(tail);
  } catch {
    // permission denied / command missing etc.
    return null;
  }
}
