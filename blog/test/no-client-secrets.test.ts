import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BLOG_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(BLOG_ROOT, 'src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(entry => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return walk(path);
    return [path];
  });
}

const files = walk(SRC).filter(path => !path.endsWith('.test.ts'));
const read = (path: string) => readFileSync(path, 'utf8');

const ALLOWED_HOSTS = /(^|\.)(schema\.org|w3\.org|sitemaps\.org|purl\.org|api\.cloudflare\.com|example\.(com|org|net)|[a-z0-9-]+\.example)$/;

describe('no secret can reach the client bundle', () => {
  // Anything Astro sees under PUBLIC_* is compiled into the browser bundle.
  // A hardcoded customer domain compiled into an admin bundle is the same class
  // of mistake, so this is a proven failure mode, not a theoretical one.
  it('no source file reads a PUBLIC_ environment variable', () => {
    for (const path of files) {
      expect(read(path), `${path} reads a PUBLIC_ env var`).not.toMatch(/import\.meta\.env\.PUBLIC_/);
      expect(read(path), `${path} names a PUBLIC_OCTYPO var`).not.toContain('PUBLIC_OCTYPO');
    }
  });

  it('no .astro template names the site key or the purge secret', () => {
    for (const path of files.filter(p => extname(p) === '.astro')) {
      const source = read(path);
      expect(source, `${path} mentions the site key`).not.toContain('siteKey');
      expect(source, `${path} mentions the purge secret`).not.toContain('purgeSecret');
      expect(source, `${path} mentions a site key literal`).not.toContain('octy_site_');
    }
  });

  it('the wrangler config keeps secrets out of [vars]', () => {
    const wrangler = readFileSync(join(BLOG_ROOT, 'wrangler.toml'), 'utf8');
    const vars = wrangler.slice(wrangler.indexOf('[vars]'), wrangler.indexOf('[env.reconcile]'));
    expect(vars).not.toContain('OCTYPO_SITE_KEY');
    expect(vars).not.toContain('OCTYPO_PURGE_SECRET');
    expect(vars).not.toContain('CLOUDFLARE_PURGE_TOKEN');
  });

  // A compiled-in default once shipped one customer's domain inside every other
  // customer's bundle. Nothing here may hardcode a host in code: the only hosts
  // a source file may name are public standards and reserved example domains.
  it('no source file hardcodes a customer domain outside a comment', () => {
    for (const path of files) {
      const code = read(path)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      const hosts = [...code.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)].map(m => m[1].toLowerCase());
      const foreign = hosts.filter(host => !ALLOWED_HOSTS.test(host));
      expect(foreign, `${path} hardcodes a customer domain`).toEqual([]);
    }
  });

  it('no source file ships a client-side script tag or a framework import', () => {
    for (const path of files.filter(p => extname(p) === '.astro')) {
      const source = read(path);
      // `set:html` on a <script type="application/ld+json"> is data, not code.
      const clientScripts = source.match(/<script(?![^>]*application\/ld\+json)/g) ?? [];
      expect(clientScripts, `${path} ships a client script`).toHaveLength(0);
      expect(source, `${path} imports a UI framework`).not.toMatch(/from ['"](react|vue|svelte|preact)/);
    }
  });
});
