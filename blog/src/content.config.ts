import { defineCollection } from 'astro:content';

import { octypoLoader } from './lib/octypo-loader';
import { articleSchema } from './lib/engine-client';

/**
 * Only used by self-hosters building statically (`prerender: true`). The hosted
 * Worker never touches this file — but it shares `engine-client.ts` with the SSR
 * routes, so the two output modes cannot disagree about what a valid article is.
 */
const articles = defineCollection({
  loader: octypoLoader({
    engineUrl: process.env.OCTYPO_ENGINE_URL ?? '',
    siteKey: process.env.OCTYPO_SITE_KEY ?? '',
  }),
  schema: articleSchema,
});

export const collections = { articles };
