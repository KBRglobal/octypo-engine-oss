# Octypo — Autonomous Content Engine

Point it at RSS feeds. It selects what's worth writing about, writes full articles
with specialized AI writer personas, fact-gates the result, and publishes — fully
autonomously, in **your** content domain.

```
RSS feeds ──► Gate 1 (LLM selection)──► Writer agents ──► Gate 2 (LLM approval) ──► Published article
                 │  scoring: SEO 40% /       │  8 personas,        │  quality + AEO        │  status=published
                 │  AEO 35% / Virality 25%   │  multi-model        │  review, revise        │  + JSON-LD schema
                 │  + MinHash/LSH dedup      │  fallback chain     │  loop (max 2)          │  + IndexNow ping
                 ▼                           ▼                     ▼                        ▼
               skip / queue              in_review              reject / revise          GET /api/articles
```

## What's inside

- **Gate 1 selector** — scores every feed item (SEO / AEO / virality), tiers it S1–S3, dedupes with MinHash + LSH fingerprints, and assigns the best writer persona. Falls back to heuristics when no LLM is reachable.
- **Writer agents** — 8 domain-neutral personas (News Reporter, Analyst, How-To Writer, Reviewer, Trends Writer, Storyteller, Listicle Writer, Deep-Dive Researcher) producing structured JSON articles with answer capsules, FAQs and meta fields.
- **Gate 2 approver** — LLM editorial review (quality + AEO rubric) with approve / revise / reject decisions and a bounded revision loop.
- **Multi-model LLM routing** — Anthropic, OpenAI, Gemini, Groq (plus OpenRouter / Mistral / DeepSeek / Together / Perplexity if keys exist) with round-robin, health tracking, quota suspension and automatic fallback.
- **Quality 108 scoring**, internal-linking engine, plagiarism detector, persistent Postgres-backed job queue.
- **Domain steering** — set `CONTENT_DOMAIN` (e.g. `"fintech news"`) and configure topics in `src/config/topics.ts`; every prompt adapts.

## Quick start

You need Node 20 or newer, and Docker for the bundled Postgres.

```bash
git clone https://github.com/KBRglobal/octypo-engine-oss.git
cd octypo-engine-oss
npm install && npm run build && npm link
cd .. && mkdir my-site && cd my-site
octypo init        # creates .env and docker-compose.yml
# add one LLM key to .env
octypo db          # starts Postgres
octypo start       # applies migrations and runs the engine
```

`octypo doctor` checks the setup. The admin panel is at `http://localhost:3000/admin`.

## Languages

Articles can be written in any ISO 639-1 language. Set the language and country
per site or per cluster. The default is English (`en`, `US`). The admin panel and
reports are in English.

### Connect a model for one language

Articles in a language can be written by a model that specializes in it. Any
OpenAI-compatible endpoint works, hosted or local:

```sh
LANGUAGE_ENGINES_JSON='{"ja":{"baseURL":"https://host.example/v1","model":"model-name","apiKeyEnv":"JA_MODEL_KEY"}}'
JA_MODEL_KEY=your-key
```

Each entry is keyed by ISO 639-1 code and takes `baseURL`, `model`, and optionally
`apiKeyEnv` (the name of the variable holding the key), `maxTokens` and `jsonMode`.
`octypo doctor` checks the entries.

A general provider key is still required: it runs the helper steps, and it takes
over if the language model fails. The spend ceiling does not count these models,
because their prices are unknown.

## From source

```bash
git clone https://github.com/KBRglobal/octypo-engine-oss.git
cd octypo-engine-oss
npm install
cp .env.example .env        # set an LLM key
docker compose up -d db
npm run db:migrate
npm run dev
```

Add a feed and let it run:

```bash
TOKEN=$(curl -s -X POST localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d "{\"password\": \"$(grep '^ADMIN_PASSWORD=' .env | cut -d= -f2-)\"}" | jq -r .token)

curl -X POST localhost:3000/api/feeds \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name": "Hacker News", "url": "https://hnrss.org/frontpage", "category": "news"}'
```

The scheduler fetches feeds every `RSS_INTERVAL_MINUTES`, runs new items through
Gate 1, queues writing jobs, and Gate 2 publishes approved articles automatically.

## API

| Method | Path                   | Description                                  |
| ------ | ---------------------- | -------------------------------------------- |
| GET    | `/health`              | Liveness check                               |
| GET    | `/api/feeds`           | List RSS feeds                               |
| POST   | `/api/feeds`           | Add a feed `{name, url, category?, topicId?}` |
| GET    | `/api/articles`        | Latest published articles                    |
| GET    | `/api/pipeline/status` | Scheduler state, RSS/job counts, daily quota |
| POST   | `/api/pipeline/trigger`| Force a pipeline run `{maxItems?}`           |

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | — | Postgres connection string (required) |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` / `GROQ_API_KEY` | — | LLM providers (set at least one) |
| `LANGUAGE_ENGINES_JSON` | — | A specialist model per language (see [Languages](#languages)) |
| `CONTENT_DOMAIN` | `general news and analysis` | Steers all prompts to your domain |
| `SITE_URL` | — | Enables IndexNow pings + canonical URLs |
| `SITE_NAME` | `Octypo` | Brand used in meta titles / schema |
| `RSS_INTERVAL_MINUTES` | `30` | Scheduler cycle interval |
| `RSS_GLOBAL_DAILY_LIMIT` | `20` | Max articles per day |
| `RSS_DAILY_LIMIT_PER_TOPIC` | `5` | Max articles per topic per day |
| `ENABLE_RSS_SCHEDULER` | `true` | Toggle the scheduler |
| `ENABLE_GATEKEEPER_PIPELINE` | `true` | Toggle the job queue |

Topics (used for tagging, internal links and keyword steering) live in
`src/config/topics.ts`. Hero/body images are off by default (`NullImageProvider`);
plug in your own provider via `setImageProvider()` in `src/lib/image-provider.ts`.
