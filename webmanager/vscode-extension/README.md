# webmanager (code-docker built-in extension)

Shows code-docker's webmanager inside code-server: terminal sessions (and any
other webmanager tab) as editor tabs, and up to four terminals plus two other
pages side by side in the bottom panel's "webmanager" tab.

Not published anywhere. It is built into the code-docker image and synced to
that image's build on every code-server start
(`config/code/code-extensions.default.sh`); set
`CODE_WEBMANAGER_EXTENSION=false` to remove it. See
`webmanager/.claude/qa-request/code-server-embed-plan-done.md` for the design and
`docs/webmanager.md` for the user-facing description.
