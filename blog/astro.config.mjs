import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

// No UI framework integration, deliberately. The zero-JS baseline is the entire
// Core Web Vitals case for putting this product on Astro; adding React or Vue
// here would ship a hydration runtime to every article and give it away.
export default defineConfig({
  output: 'server',
  adapter: cloudflare({ imageService: 'passthrough' }),
  // Per-tenant hosts are resolved at request time in src/middleware.ts. This is
  // only the fallback used by `astro build` for a self-hosted static build.
  site: process.env.OCTYPO_SITE_URL || 'https://example.com',
  // A customer can mount the blog under the main domain instead of giving it
  // a separate hostname. With /insights, the Worker owns only that path while
  // the rest of the domain continues to be served by the main site.
  base: process.env.OCTYPO_BASE_PATH || '/',
  prefetch: { defaultStrategy: 'viewport', prefetchAll: false },
  compressHTML: true,
  build: { inlineStylesheets: 'always' },
  vite: {
    build: {
      // A stray dependency that pulls in a client bundle should fail loudly,
      // not quietly cost every customer their LCP.
      chunkSizeWarningLimit: 10,
    },
  },
});
