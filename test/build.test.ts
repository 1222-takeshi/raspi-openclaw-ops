import { describe, expect, it } from 'vitest';
import { getBuildInfo } from '../src/build.js';

describe('getBuildInfo', () => {
  it('uses package version when env not set', () => {
    const b = getBuildInfo({}, '0.2.0');
    expect(b.version).toBe('0.2.0');
    expect(b.gitRef).toBeNull();
  });

  it('prefers APP_VERSION when set', () => {
    const b = getBuildInfo({ APP_VERSION: '0.2.1' }, '0.2.0');
    expect(b.version).toBe('0.2.1');
  });

  it('reads git fields', () => {
    const b = getBuildInfo({ GIT_REF: 'v0.2.0', GIT_SHA: 'abc', BUILD_TIME: 't' }, '0.0.0');
    expect(b.gitRef).toBe('v0.2.0');
    expect(b.gitSha).toBe('abc');
    expect(b.buildTime).toBe('t');
  });
});
