# Contributing

## Setup

```bash
npm install
cp .env.example .env
docker compose up -d db
npm run dev
```

## Before opening a pull request

```bash
npm run check
npm test
npm run build
```

## Adding language support

The engine writes in any ISO 639-1 language. Each language uses the English
instruction pack in `src/i18n/language-pack.ts`, which names the target language.
Word-list gates run only for languages that have a curated list. A language
without one records a skipped marker instead of holding the article. To add a
list, extend the pack for that language and add a test beside it.

Use Unicode property escapes for text matching, and do not hard-code a language
in shared code.
