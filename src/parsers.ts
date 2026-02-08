export type DiskUsage = {
  totalBytes: number;
  usedBytes: number;
  availBytes: number;
  usedPct: number;
  mount: string;
};

export function parseDfRoot(stdout: string): DiskUsage | null {
  const lines = stdout.trim().split(/\r?\n/);
  if (lines.length < 2) return null;
  const cols = lines[1].split(/\s+/);
  // Filesystem 1024-blocks Used Available Capacity Mounted on
  const totalKiB = Number(cols[1]);
  const usedKiB = Number(cols[2]);
  const availKiB = Number(cols[3]);
  const cap = cols[4];
  const usedPct = Number(String(cap).replace('%', ''));
  if (![totalKiB, usedKiB, availKiB, usedPct].every((n) => Number.isFinite(n))) return null;
  return {
    totalBytes: totalKiB * 1024,
    usedBytes: usedKiB * 1024,
    availBytes: availKiB * 1024,
    usedPct,
    mount: '/',
  };
}
