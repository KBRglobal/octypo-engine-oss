/// <reference types="astro/client" />

import type { EngineClient, TenantConfig } from './lib/engine-client';
import type { RuntimeConfig } from './lib/runtime';

declare global {
  namespace App {
    interface Locals {
      /** Resolved from the request Host by src/middleware.ts. Never module state. */
      tenant: TenantConfig;
      config: RuntimeConfig;
      engine: EngineClient;
    }
  }
}

export {};
