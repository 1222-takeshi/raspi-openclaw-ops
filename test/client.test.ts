import { describe, expect, it } from 'vitest';
import { buildMetricsUrl } from '../src/client.js';

describe('buildMetricsUrl', () => {
  it('adds token when present', () => {
    expect(buildMetricsUrl('/metrics.json', '?token=abc')).toBe('/metrics.json?token=abc');
  });

  it('does not add token when absent', () => {
    expect(buildMetricsUrl('/metrics.json', '')).toBe('/metrics.json');
  });

  it('handles other params', () => {
    expect(buildMetricsUrl('/metrics.json', '?token=abc&x=1')).toBe('/metrics.json?token=abc');
  });
});
