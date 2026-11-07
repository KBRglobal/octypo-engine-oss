import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Article attribution context.
 *
 * WHY this exists: the model call happens in `src/services/engine-registry.ts`,
 * several layers below whatever decided to write an article. Threading an
 * `articleId` parameter through every agent, gate and prompt helper would touch
 * dozens of call sites and would be silently forgotten by the next one added.
 * An AsyncLocalStorage carries the id down the call stack instead — including
 * across `await` — so attribution is opt-in at ONE place (wrap the article run)
 * and automatic everywhere below it.
 *
 * Nothing breaks when the context is absent: the call is still metered, it is
 * just recorded as unattributed.
 */
const articleStore = new AsyncLocalStorage<{ articleId: string }>();

/** Run `fn` with every cost recorded inside it attributed to `articleId`. */
export function withArticleCost<T>(articleId: string, fn: () => T): T {
  return articleStore.run({ articleId }, fn);
}

/** The article being generated on this async call stack, if any. */
export function currentArticleId(): string | undefined {
  return articleStore.getStore()?.articleId;
}
