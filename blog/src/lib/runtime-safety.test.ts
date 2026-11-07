import { describe, it, expect, vi } from 'vitest';
import { EngineClient } from './engine-client';
import { renderThemeStyle } from './theme';

/**
 * Every case here is a bug that shipped and was only caught by running the blog
 * for real. The original 328 tests all passed because they injected a plain
 * `fetch` function and ran in Node — the failures only appear on workerd, or
 * depend on CSS ordering the tests never rendered.
 */
describe('engine client runtime safety', () => {
  it('does not call fetch as a method of the client', async () => {
    // On workerd, `this.fetchImpl(...)` invokes globalThis.fetch with the wrong
    // receiver and throws "Illegal invocation" — every page 500s. Simulating it
    // here: a fetch that rejects unless `this` is undefined or globalThis.
    const strictFetch = function (this: unknown) {
      if (this !== undefined && this !== globalThis) {
        throw new TypeError('Illegal invocation');
      }
      return Promise.resolve(
        new Response(JSON.stringify({ items: [], nextCursor: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    } as unknown as typeof fetch;

    const client = new EngineClient({
      baseUrl: 'https://engine.test',
      siteKey: 'k',
      fetch: strictFetch,
    });

    await expect(client.listAllArticles({ limit: 1 })).resolves.toBeDefined();
  });

  it('never asks for a redirect mode workerd rejects', async () => {
    // workerd accepts only "follow" or "manual"; "error" throws before the
    // request is even made.
    const seen: RequestInit[] = [];
    const spy = vi.fn((_url: string, init: RequestInit) => {
      seen.push(init);
      return Promise.resolve(
        new Response(JSON.stringify({ items: [], nextCursor: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as unknown as typeof fetch;

    const client = new EngineClient({ baseUrl: 'https://engine.test', siteKey: 'k', fetch: spy });
    await client.listAllArticles({ limit: 1 });

    expect(seen.length).toBeGreaterThan(0);
    for (const init of seen) {
      expect(['follow', 'manual']).toContain(init.redirect);
    }
  });
});

describe('tenant brand styling', () => {
  it('outranks the default stylesheet regardless of emission order', () => {
    // Both blocks used to target `:root`, so the winner depended on which the
    // bundler emitted last — and it was the defaults, silently discarding every
    // customer's brand.
    const style = renderThemeStyle({ accent: '#ff0000' } as never);
    expect(style).toContain('--octypo-accent');
    expect(style).toMatch(/:root:root\s*\{/);
  });

  it('emits nothing when the customer has set no brand', () => {
    expect(renderThemeStyle(null)).toBe('');
    expect(renderThemeStyle(undefined)).toBe('');
  });
});
