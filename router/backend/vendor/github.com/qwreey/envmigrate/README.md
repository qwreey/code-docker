# envmigrate

Reconciles a `.env`-style file against a versioned template: adds new keys, flags
`#!important`/`#!` marker lines, archives dead keys with a `#~` prefix. Extracted from
[code-docker](https://github.com/qwreey/code-docker) — used by code-docker's `webmanager`
and [router-docker](https://github.com/qwreey/router-docker) backends.

Nothing in this package hardcodes a version-key name or file name — callers pass those in
via `Options`.
