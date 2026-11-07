/**
 * The Worker's bindings and variables. Outside a Worker, as in unit tests,
 * there are none, and readRuntimeConfig reports what is missing.
 */
export async function workerEnv(): Promise<Record<string, unknown>> {
  try {
    // @ts-ignore: provided by the Workers runtime, not by a package.
    const { env } = await import('cloudflare:workers');
    return env as unknown as Record<string, unknown>;
  } catch {
    return {};
  }
}
