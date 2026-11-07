# Changelog

Notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [1.0.1] - 2026-11-08

### Fixed

- "Run a pipeline pass" now fetches feeds first, so a feed added in the admin
  panel produces articles right away instead of after the next scheduled cycle.
- An article about the outlet it was read on (GitHub, read on github.blog) is no
  longer held because its slug names that outlet.

### Changed

- The package description says articles are checked against their sources.

## [1.0.0] - 2026-11-07

First public release.

### Added

- Feed-to-article pipeline with selection, writing, review and publishing.
- Articles in any ISO 639-1 language.
- A specialist model per language through `LANGUAGE_ENGINES_JSON`.
- Admin panel, Astro blog front end, and the `octypo` command.
