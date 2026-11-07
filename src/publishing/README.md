# Publishing targets — adding a new CMS

Octypo publishes to whatever a customer already runs. "Publish this article" is
independent of where it lands: the pipeline builds one **normalised article** and
hands it to every configured **target**. A new CMS is a new file in this folder
and nothing else — no pipeline change, no schema change, no branch in
`publish.ts`.

Two targets ship today, deliberately unalike:

| | `wordpress.ts` | `webhook.ts` |
|---|---|---|
| transport | WordPress core REST API, Application Password over HTTP Basic | one signed `POST` |
| media | uploads bytes into the media library, sets `featured_media` | sends the image **URL**; the receiver pulls it |
| taxonomy | looks up / creates term ids | sends slugs and names |
| body | HTML | HTML **and** blocks |
| identity | numeric post id, plus a slug lookup as a fallback | the article id, plus whatever id the receiver returns |

If a change to the interface only makes sense for one of those two, it does not
belong in the interface.

---

## What you must implement

One class implementing `PublishingTarget` (see `types.ts`):

```ts
export class GhostTarget implements PublishingTarget {
  readonly id = "ghost:blog.acme.com";   // stable — it namespaces the ref store
  readonly kind = "ghost";
  readonly capabilities = capabilities({ /* what you cannot do */ });

  check(): Promise<TargetCheck>;                        // probe, write nothing
  publish(article: NormalisedArticle): Promise<PublishOutcome>;
  unpublish(a: Pick<NormalisedArticle, "id" | "slug">): Promise<PublishOutcome>;
}
```

### 1. Declare your capabilities honestly

`TargetCapabilities` is not documentation, it is the mechanism that stops data
loss being silent. Set to `false` anything the target genuinely cannot take, then
call `describeDegradation(this.capabilities, article)` and put the result on
every outcome you return. The caller logs it, and a customer running with
`PUBLISH_STRICT_DEGRADATION=true` gets a failed publish instead of a quietly
incomplete one.

`hostsMedia: false` is not a degradation — the hero image URL still travels in
the payload; the target just does not copy the bytes.

### 2. Be idempotent, twice over

The engine's job queue retries. A duplicate article on a customer's live site is
the most visible way this system fails, so:

1. Read `RemoteRefStore.get(this.id, article.id)` before anything else and update
   what it points at.
2. Have a **second** way to find an existing item — WordPress looks the slug up
   over the API. The reference store is a cache, not the truth: a restored
   database or a first run against a site the engine already fed must not create
   second copies of everything.
3. Write the reference (and `contentHash`) **only after** the target confirmed
   the write.

`article.contentHash` covers every field a target writes. If the stored hash
matches *and* the remote item still exists, return `{ status: "unchanged" }` and
make no write at all. Skipping the existence check is how "unchanged" becomes a
lie about a post the customer deleted.

### 3. Return, never throw

`PublishOutcome` has four meanings and each drives a different behaviour:

| outcome | means | queue |
|---|---|---|
| `written` (`created` / `updated`) | it is live | done |
| `unchanged` | already correct, nothing sent | done |
| `failed`, `retryable: true` | the target is having a bad moment | retried with backoff |
| `failed`, `retryable: false` | the target will never accept this | give up, alert a human |

Use `failed(code, message)` — retryability is derived from the code by `RETRYABLE`
so two adapters cannot disagree about what a 401 means. Use `request()` from
`http.ts` and you get the timeout, the 4xx/5xx classification and the
never-throws guarantee for free.

An adapter that throws is a publish nobody classified. `deliver()` catches it
anyway, but only as a backstop.

### 4. Handle a half-finished write

If your target needs two calls to land one article (upload, then post),
persist what succeeded **before** attempting the second, so the retry reuses it.
`RemoteRef.remoteId` is nullable exactly for this. And prefer failing the whole
publish over publishing something incomplete — a post that is live but wrong is
harder to notice, and harder to fix, than a job that failed loudly.

### 5. Register it

Add a block to `resolveTargets()` in `registry.ts`, gated on **all** of its
config being present. A half-configured target looks connected and publishes
nothing, which is worse than no target at all.

### 6. Test it against a fake, never a live site

`wordpress.test.ts` builds a fake CMS out of a routing function and injects it as
`fetchImpl`. Copy that shape. The suite must cover, at minimum: create, update
(not duplicate), unchanged, wrong credentials, unreachable host, a rejected
payload, a partially-completed write, and an item deleted on the target's side.

---

## Configuration

| variable | target |
|---|---|
| `WORDPRESS_URL`, `WORDPRESS_USER`, `WORDPRESS_APP_PASSWORD` | WordPress (all three required) |
| `WORDPRESS_LINK_BASE` | origin to resolve the engine's `/topics/…` links against |
| `WORDPRESS_TIMEOUT_MS` | per-request timeout |
| `PUBLISH_WEBHOOK_URL`, `PUBLISH_WEBHOOK_SECRET` | generic webhook (both required) |
| `PUBLISH_WEBHOOK_NAME` | label, when two webhooks share a host |
| `PUBLISH_STRICT_DEGRADATION` | `true` to fail a publish that could not carry everything |

With none of these set the engine behaves exactly as it did before this layer
existed: status in the database, article on the read API.

## Known gaps

- **JSON-LD on WordPress.** Core strips `<script>` from post content for any
  author without `unfiltered_html`. The adapter injects it, reads the stored
  content back and reports a `structuredData` degradation when it did not
  survive. Getting it to survive on a locked-down install needs a plugin or a
  theme hook on the customer's side.
- **`publishing_target_refs`** is created by idempotent DDL from
  `PostgresRemoteRefStore` rather than by a migration, because the shared schema
  file is owned elsewhere. The table definition is exported from
  `remote-ref-store.ts` and should move into `src/schema/index.ts`.
- **The admin publish route** maps every failure to HTTP 404, so a target
  failure currently reads as "Article not found" to an operator. Fixing that is a
  one-line change in `src/api/admin.ts`.
