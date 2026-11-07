/**
 * Astro Content Layer loader — the static-output half of the blog.
 *
 * Self-hosters who want `prerender: true` get exactly the same data, through
 * exactly the same client and the same zod schemas, as the SSR routes. That is
 * the point: one codebase, two output modes, and no chance of the hosted and
 * self-hosted paths disagreeing about what a valid article is.
 *
 * Tombstones are honoured here too — a build that keeps generating a page for a
 * deleted article is the static equivalent of never purging it.
 */

import { EngineClient, isTombstone, type Article } from './engine-client';

export interface LoaderContext {
  store: {
    clear(): void;
    set(entry: { id: string; data: Record<string, unknown> }): void;
    delete(id: string): void;
  };
  logger?: { info(message: string): void; warn(message: string): void };
}

export interface OctypoLoaderOptions {
  engineUrl: string;
  siteKey: string;
  tenantHost?: string;
}

export function octypoLoader(options: OctypoLoaderOptions) {
  return {
    name: 'octypo',
    async load(context: LoaderContext): Promise<void> {
      // Astro runs `sync` on every build, including the hosted Worker build that
      // never uses this collection. Without engine credentials the client
      // constructor throws and the whole build aborts, so an unconfigured loader
      // must yield an empty collection rather than fail.
      if (!options.engineUrl || !options.siteKey) {
        context.logger?.info(
          'Octypo loader idle — OCTYPO_ENGINE_URL/OCTYPO_SITE_KEY not set, skipping content sync'
        );
        context.store.clear();
        return;
      }

      const client = new EngineClient({
        baseUrl: options.engineUrl,
        siteKey: options.siteKey,
        tenantHost: options.tenantHost,
      });

      const items = await client.listAllArticles({ limit: 200 });
      context.store.clear();

      for (const item of items) {
        if (isTombstone(item)) {
          context.store.delete(item.slug);
          continue;
        }
        // The list endpoint returns summaries; a static build needs bodies.
        const article: Article | null = await client.getArticle(item.slug);
        if (!article) continue;
        context.store.set({ id: article.slug, data: article as unknown as Record<string, unknown> });
      }

      context.logger?.info(`[octypo] loaded ${items.length} entries`);
    },
  };
}
