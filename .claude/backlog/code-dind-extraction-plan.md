# code-dind → standalone repo (handover)

**Status: not started.** Written as a handover for whichever session picks this up next —
qwreey wants to keep decomposing code-docker the same way `router/` and
`netinit/netfilter-fix/netshare` just were (2026-08-19 session), and asked for this doc
specifically so a cleared/fresh session has enough context to continue without
re-deriving everything.

## What already happened this decomposition effort (context, not TODO)

Two extractions landed on `dev` in one session (commits `52eab3a..1331bbd`, pushed to
origin), driven by qwreey's observation that router's doc/code volume living inside
code-docker was hurting agent performance, and the same reasoning extending to anything
that's really "router integration plumbing," not code-docker-specific:

1. **`router/` → `qwreey/router-docker`, `envmigrate/` → `qwreey/envmigrate`** — both as
   **git submodules**. router-docker also ships its own `docker-compose.router.yml` that
   code-docker's own `docker-compose.yml` now `include:`s by a fixed path instead of
   defining the service inline. See root `CLAUDE.md`'s "router"/"netshare" sections and
   root `CLAUDE.md`'s envmigrate paragraph for the current state.
2. **`netinit/`, `netfilter-fix/`, `netshare/` → `qwreey/router-docker-client`** — **NOT** a
   submodule this time. Consumed via Docker/Compose's native remote-git support instead
   (`build.context: <git-url>#<ref>:<subdir>` for netinit/netfilter-fix's whole service
   build, `ADD <git-url>#<ref>:<subdir> <dest>` for netshare pulled into code-docker's own
   root `Dockerfile` and `code-dind/Dockerfile`) — deliberately a **floating `#main` ref,
   not pinned**, so no consumer needs a bump-commit when it changes.

**Why the mechanism differed between the two:** submodule vs remote-git-context was a real
design choice, not arbitrary — see `feedback_prefer-remote-git-context-over-submodule` in
Claude's own memory (or re-derive: submodule fits code with real independent
identity/local-edit-ability needs and a small number of consumers, like router-docker
itself or envmigrate; remote-git-context fits small, actively-co-developed code consumed by
*multiple* sibling projects where avoiding a bump-commit per consumer matters more than
offline builds). Also verified (moby/buildkit#2116) that git-context/`ADD` always does a
**full clone**, never sparse — a real reason not to fold small shared code into an
already-large repo just because subdirectory selection is technically possible.

## code-dind's current shape (checked this session — accurate as of `1331bbd`)

Already structurally identical to what `router/` looked like *before* its own extraction —
this should be the easiest of the three to do:

- `code-dind/` is fully self-contained: `Dockerfile`, `script/dind-entrypoint.sh`,
  `dind-authz/` (its own Go module, `go.mod`, `go test ./...` runs directly from there),
  `config/dind-authz/00-base.default.json` (baked-in authz defaults — lives *inside*
  `code-dind/`, not at repo root, confirmed by `find code-dind -type f`), `CLAUDE.md`,
  `.claude/dind-authz-plan.md`.
- `docker-compose.yml`'s `code-docker-dind` service (around line 235) already uses
  `build.context: "${BUILD_CONTEXT:-.}/code-dind"` — the exact same `BUILD_CONTEXT`
  indirection pattern `router/` had before extraction, there specifically for the
  split-directory deploy case. `target: "${DIND_TARGET:-dind-authz}"` picks which Dockerfile
  stage (`dind`/`dind-authz`/`dind-authz-remap`) to build.
- `script/dind-entrypoint.sh` already fetches `netshare/` via the new `ADD
  https://github.com/qwreey/router-docker-client.git#main:netshare /netshare` (done this
  session) — no local netshare dependency left to worry about.
- Nothing in code-dind's own tree reaches *outside* `code-dind/` except that one `ADD` (to
  router-docker-client) — confirmed clean, same as router/ was.

## Open question for the next session to resolve with qwreey (don't just pick one)

**Submodule (router-docker pattern) vs remote-git-context (router-docker-client pattern)?**
Leaning toward **submodule**, but ask first:
- code-dind isn't consumed by multiple sibling repos the way netshare was (single
  consumer: code-docker itself) — the "avoid bump-commit across N consumers" argument for
  remote-git doesn't really apply here.
- It has real, independently-meaningful source (`dind-authz/`'s Go authz plugin,
  `go test ./...`) that benefits from local edit-ability/offline builds — same profile as
  router-docker itself, not the "few small shell files" profile of netinit/netshare.
- If qwreey wants remote-git anyway (e.g. for the same reasons as netinit last time),
  that's fine too — just confirm rather than assume, and re-read
  `feedback_prefer-remote-git-context-over-submodule` (memory) for the deciding criteria to
  walk through together.

## Playbook to follow (from what actually worked this session)

1. Confirm repo name/visibility with qwreey and have them create the empty GitHub repo
   first (matches this session's pattern — qwreey created `router-docker`/`envmigrate`/
   `router-docker-client` themselves each time before extraction started).
2. If submodule: `git subtree split --prefix=code-dind -b code-dind-split` to preserve
   history, push that branch to the new repo's `main` from a **plain scratch clone/worktree
   with an explicit remote URL** — do NOT `git remote add origin` inside a `git worktree
   add` of code-docker itself, that shares the worktree's `origin` and will push to
   `qwreey/code-docker` by accident (this actually happened this session, caught and fixed
   immediately, see commit history / memory for the full story). Then `git rm -r --cached
   code-dind && rm -rf code-dind && git submodule add <url> code-dind`.
3. If remote-git-context: swap `docker-compose.yml`'s `build.context` for
   `code-docker-dind` to the new repo's git URL, delete the local `code-dind/` directory,
   done in one step (no submodule dance).
4. Either way — **verify before committing to the design being "done"**:
   - `docker compose config` diff (stash the compose change, dump config, restore, dump
     again, diff) to confirm the resolved service definition is unchanged.
   - `docker compose build code-docker-dind` succeeds.
   - Full `docker compose up -d`, confirm `docker exec code-docker-dind ip route show
     default` resolves via router, `docker exec code-docker docker info` (or similar)
     confirms the DOCKER_HOST tcp://dind:2375 connection still works, dind-authz still
     denies a privileged container creation attempt if you want to be thorough.
   - **Fresh-clone test** (`git clone --recurse-submodules --branch dev
     /home/yaeji/Projects/code-docker <scratch-dir>`, `cp example-env .env`, `touch
     empty-extra-include.yml`, `docker compose build && up -d`) — this caught nothing this
     session but is the actual gold-standard check, do it before calling this done.
5. Update root `CLAUDE.md`'s code-dind mentions (currently describes it as a plain
   self-contained subtree, same as router/netinit were described before their own
   extractions) and `code-dind/CLAUDE.md` itself (currently written assuming it's a
   subtree of code-docker, not a standalone repo — mirror the rewrite `router/CLAUDE.md`
   got this session if going the submodule route).
6. **Gotcha**: `docker run --rm <image> <cmd>` does NOT override a Dockerfile's
   `ENTRYPOINT` — `<cmd>` is appended as args to it. dind's entrypoint (like netinit's) is
   long-running, so a naive `docker run --rm dind-image cat /something` will hang forever.
   Use `--entrypoint` to actually override when spot-checking.
