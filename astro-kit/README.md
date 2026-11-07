# Astro kit — connect any Astro site to an Octypo install

Copy both scripts into the site's `scripts/` folder and add to its package.json:

```json
"sync":    "node scripts/sync-from-octypo.mjs",
"publish": "node scripts/sync-from-octypo.mjs && astro build"
```

`OCTYPO_URL` points the sync at the client's engine (default http://localhost:3000).

The site needs an `articles` content collection with the fields the sync writes:
title, description, summary, published, image, imageAlt, category, readingTime,
optional answerCapsule and faq[].

Images: drop your files into one folder per category, named after a word that
appears in your article tags, categories or titles, plus `general/` as the
fallback. Then run `node scripts/ingest-image-bank.mjs <dir>`. The sync assigns
one per article by category, stable across runs.

Set `OCTYPO_CATEGORY_LABEL` and `OCTYPO_READING_LABEL` to change the two labels
the sync writes (English by default).
