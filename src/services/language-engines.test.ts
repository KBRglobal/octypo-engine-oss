import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLanguageEngines } from "./language-engines.js";

const entry = { baseURL: "https://host.example/v1", model: "ja-model" };

describe("parseLanguageEngines", () => {
  it("is empty when nothing is configured", () => {
    expect(parseLanguageEngines(undefined)).toEqual({ specs: [], problems: [] });
  });

  it("reads the key from the named variable", () => {
    const raw = JSON.stringify({ ja: { ...entry, apiKeyEnv: "JA_KEY" } });
    const { specs, problems } = parseLanguageEngines(raw, { JA_KEY: "secret" });
    expect(problems).toEqual([]);
    expect(specs[0]).toMatchObject({ language: "ja", languageName: "Japanese", apiKey: "secret" });
  });

  it("accepts a local server with no key", () => {
    const raw = JSON.stringify({ ar: { baseURL: "http://localhost:11434/v1", model: "local" } });
    expect(parseLanguageEngines(raw, {}).specs).toHaveLength(1);
  });

  it("skips a bad entry and keeps the good one", () => {
    const raw = JSON.stringify({
      ja: entry,
      klingon: entry,
      fr: { model: "no-url" },
      de: { ...entry, baseURL: "file:///etc/passwd" },
      es: { ...entry, apiKeyEnv: "MISSING_KEY" },
      it: { ...entry, maxTokens: -1 },
    });
    const { specs, problems } = parseLanguageEngines(raw, {});
    expect(specs.map(s => s.language)).toEqual(["ja"]);
    expect(problems).toHaveLength(5);
  });

  it("never repeats a key in a problem", () => {
    const raw = JSON.stringify({ ja: { model: "x", apiKeyEnv: "JA_KEY" } });
    const { problems } = parseLanguageEngines(raw, { JA_KEY: "secret" });
    expect(problems.join(" ")).not.toContain("secret");
  });

  it.each(["not json", "[]", "null"])("reports a bad document: %s", raw => {
    const { specs, problems } = parseLanguageEngines(raw, {});
    expect(specs).toEqual([]);
    expect(problems).toHaveLength(1);
  });
});

describe("routing through a real endpoint", () => {
  interface Seen {
    url?: string;
    auth?: string;
    model?: string;
  }
  const calls: Seen[] = [];
  let failing = false;
  let server: Server;
  let baseURL: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", chunk => (body += chunk));
      req.on("end", () => {
        const model = JSON.parse(body).model as string;
        calls.push({ url: req.url, auth: req.headers.authorization, model });
        if (failing && model === "ja-model") {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "bad key" } }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: `from ${model}` }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          })
        );
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });

  afterAll(() => {
    server.close();
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    calls.length = 0;
    failing = false;
    vi.resetModules();
    for (const name of ["ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GROQ_API_KEY", "OPENROUTER_API_KEY"]) {
      vi.stubEnv(name, "");
    }
    for (const name of ["MISTRAL_API_KEY", "TOGETHER_API_KEY", "PERPLEXITY_API_KEY"]) {
      vi.stubEnv(name, "");
    }
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("DEEPSEEK_API_KEY", "general-key");
    vi.stubEnv("JA_KEY", "ja-secret");
    vi.stubEnv(
      "LANGUAGE_ENGINES_JSON",
      JSON.stringify({ ja: { baseURL, model: "ja-model", apiKeyEnv: "JA_KEY" } })
    );
  });

  async function loadRegistry() {
    const registry = await import("./engine-registry.js");
    // The general engine answers from the same fake endpoint.
    for (const engine of registry.EngineRegistry.getAllEngines()) engine.baseURL = baseURL;
    return registry;
  }

  it("sends a Japanese article to the Japanese model with its key", async () => {
    const { createLanguageWriter } = await loadRegistry();
    const write = createLanguageWriter("ja");
    await expect(write?.("system", "user")).resolves.toBe("from ja-model");
    expect(calls[0]).toMatchObject({
      url: "/v1/chat/completions",
      auth: "Bearer ja-secret",
      model: "ja-model",
    });
  });

  it("keeps other languages on the general models", async () => {
    const { createLanguageWriter, EngineRegistry } = await loadRegistry();
    await expect(createLanguageWriter("fr")?.("system", "user")).resolves.toBe("from deepseek-chat");
    expect(EngineRegistry.getAllEngines().map(e => e.id)).not.toContain("language-ja");
  });

  it("moves the article to a general model when the language model fails", async () => {
    failing = true;
    const { createLanguageWriter, EngineRegistry } = await loadRegistry();
    const write = createLanguageWriter("ja");
    await expect(write?.("system", "first")).resolves.toBe("from deepseek-chat");
    await expect(write?.("system", "second")).resolves.toBe("from deepseek-chat");
    expect(calls.filter(c => c.model === "ja-model")).toHaveLength(1);
    expect(EngineRegistry.getLanguageEngine("ja")).toBeNull();
  });

  it("tries the language model again after the cool-off", async () => {
    failing = true;
    const { createLanguageWriter, EngineRegistry } = await loadRegistry();
    await createLanguageWriter("ja")?.("system", "user");
    const engine = [...EngineRegistry["languageEngines"].values()][0];
    engine.lastErrorAt = new Date(Date.now() - 61_000);
    expect(EngineRegistry.getLanguageEngine("ja")?.id).toBe("language-ja");
  });

  it("fails when the language model fails and nothing else is connected", async () => {
    failing = true;
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    const { createLanguageWriter } = await loadRegistry();
    await expect(createLanguageWriter("ja")?.("system", "user")).rejects.toThrow();
  });
});
