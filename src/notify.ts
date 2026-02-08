export type Health = 'ok' | 'degraded' | 'down';

export type NotifyDecisionInput = {
  prevHealth: Health | null;
  nextHealth: Health;
  nowMs: number;
  lastNotifiedAtMs: number | null;
  minIntervalMs: number;
  // If true, we never notify when prevHealth is null (boot).
  skipInitial: boolean;
};

export type NotifyDecision = {
  shouldNotify: boolean;
  reason: string;
};

export function decideNotify(input: NotifyDecisionInput): NotifyDecision {
  const { prevHealth, nextHealth, nowMs, lastNotifiedAtMs, minIntervalMs, skipInitial } = input;

  if (skipInitial && prevHealth == null) {
    return { shouldNotify: false, reason: 'initial-skip' };
  }

  if (prevHealth === nextHealth) {
    return { shouldNotify: false, reason: 'no-change' };
  }

  if (lastNotifiedAtMs != null && nowMs - lastNotifiedAtMs < minIntervalMs) {
    return { shouldNotify: false, reason: 'rate-limited' };
  }

  return { shouldNotify: true, reason: 'state-changed' };
}

export async function postDiscordWebhook(webhookUrl: string, content: string) {
  const r = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`Discord webhook failed: ${r.status} ${r.statusText} ${text}`);
  }
}
