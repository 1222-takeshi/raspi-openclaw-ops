import { describe, expect, it } from 'vitest';
import { constantTimeEqual, getProvidedToken, verifyToken } from '../src/auth.js';

describe('auth', () => {
  it('reads token from query', () => {
    expect(getProvidedToken({ query: { token: ' abc ' }, headers: {} })).toBe('abc');
  });

  it('reads token from Authorization: Bearer', () => {
    expect(getProvidedToken({ headers: { authorization: 'Bearer t123' } })).toBe('t123');
    expect(getProvidedToken({ headers: { authorization: 'bearer t123' } })).toBe('t123');
  });

  it('reads token from X-Status-Token', () => {
    expect(getProvidedToken({ headers: { 'x-status-token': 'zzz' } })).toBe('zzz');
  });

  it('constantTimeEqual works for equal / not equal', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'ab')).toBe(false);
  });

  it('verifyToken matches expected token', () => {
    expect(verifyToken({ query: { token: 't' } }, 't')).toBe(true);
    expect(verifyToken({ query: { token: 't' } }, 'x')).toBe(false);
    expect(verifyToken({ headers: { authorization: 'Bearer t' } }, 't')).toBe(true);
  });
});
