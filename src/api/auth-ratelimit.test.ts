import { describe, it, expect } from 'vitest';

import { isLoginBlocked, recordLoginFailure, clearLoginFailures } from './auth.js';

/**
 * The admin token derives from one password, so the password IS the account.
 * Ten guesses buys fifteen minutes of silence.
 */
describe('login brute-force gate', () => {
  it('lets normal failures through and blocks the eleventh', () => {
    const ip = '10.0.0.1';
    clearLoginFailures(ip);
    for (let i = 0; i < 10; i++) {
      expect(isLoginBlocked(ip)).toBe(false);
      recordLoginFailure(ip);
    }
    expect(isLoginBlocked(ip)).toBe(true);
  });

  it('forgets failures older than the window', () => {
    const ip = '10.0.0.2';
    clearLoginFailures(ip);
    const past = Date.now() - 16 * 60 * 1000;
    for (let i = 0; i < 10; i++) recordLoginFailure(ip, past);
    expect(isLoginBlocked(ip)).toBe(false);
  });

  it('a successful login clears the slate', () => {
    const ip = '10.0.0.3';
    for (let i = 0; i < 10; i++) recordLoginFailure(ip);
    clearLoginFailures(ip);
    expect(isLoginBlocked(ip)).toBe(false);
  });

  it('one address cannot lock out another', () => {
    const attacker = '10.0.0.4';
    const operator = '10.0.0.5';
    clearLoginFailures(attacker);
    clearLoginFailures(operator);
    for (let i = 0; i < 10; i++) recordLoginFailure(attacker);
    expect(isLoginBlocked(attacker)).toBe(true);
    expect(isLoginBlocked(operator)).toBe(false);
  });
});
