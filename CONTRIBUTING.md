# Contributing

Thanks for helping with Octypo. Bug reports, language fixes, documentation and code
are all welcome. Everyone taking part agrees to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Report a problem

Open an [issue](https://github.com/KBRglobal/octypo-engine-oss/issues/new/choose) with
the steps to reproduce it. Report security problems privately, as described in
[SECURITY.md](SECURITY.md).

For a large change, open an issue first so we can agree on the approach.

## Set up

You need Node 20 or newer, and Docker for the bundled Postgres.

```bash
git clone https://github.com/KBRglobal/octypo-engine-oss.git
cd octypo-engine-oss
npm install
npm --prefix blog install
cp .env.example .env        # set an LLM key and ADMIN_PASSWORD
docker compose up -d db
npm run db:migrate
npm run dev
```

The admin panel has its own dev server: `npm run dev:admin`.

## Before opening a pull request

```bash
npm run check
npm test
npm run build
```

Add a test for any change in behavior. Tests must not call a paid API. Keep each
pull request to one change, and explain why it is needed.

## Adding language support

The engine writes in any ISO 639-1 language. Each language uses the English
instruction pack in `src/i18n/language-pack.ts`, which names the target language.
Word-list gates run only for languages that have a curated list. A language
without one records a skipped marker instead of holding the article. To add a
list, extend the pack for that language and add a test beside it.

Use Unicode property escapes for text matching, and do not hard-code a language
in shared code.

## License

By contributing, you agree that your work is released under the [MIT License](LICENSE).
