# CLAUDE.md

Guidance for working on DProcess. `README.md` describes what the system does: the hierarchy and states, every transition rule and gate, the freeze, URL formats, warnings, status codes, the `make` targets, the repository layout and the plugin's skills. Read it before changing behaviour. This file adds only what the README does not say: where the rules live in code, and how to work here.

## Commands

- Run `make check` before every commit. The other targets are in README.md ("Running", "Development").

## Domain rules

- The rules themselves are in README.md ("API"); the code that enforces them is in `internal/workflow`, `internal/service` and `internal/store`. The epic transition rules, the story transition rules and the freeze of finished/cancelled stories are **final** (specified by the user): do not change them unless asked.
- **Adding a story state needs a migration that rebuilds `stories`** (SQLite cannot alter a CHECK); copy `0006_story_ready_for_testing.sql`. `state_history` is never rewritten: rows from before a rule change stay as they were.
- **Still unspecified, deliberately not enforced:** cancelling an epic can leave live stories in other epics depending on newly cancelled stories (they must remove the dependency before finishing - allowed).

## Architecture decisions

- SQLite connection: `foreign_keys(1)`, `busy_timeout` and `SetMaxOpenConns(1)` on top of WAL. Don't switch to a cgo driver.
- Layering: `store` (SQL) → `service` (business rules) → `api` (HTTP). Simple CRUD without rules may go api → store directly (projects does); add to `internal/service` when rules appear (transitions, dependency validation). Keep the state machine isolated in `internal/workflow`. Exception: a rule whose check and write must share one transaction lives in `store` (the dependency invariants in `store.AddDependency`).
- Each transition writes a `state_history` row in the same transaction, with an optional free-text `actor`.
- Deleting a parent that has children is `store.ErrInUse`; cancelling is the preferred way to retire things.

## Frontend

- `web/`: Vite + React + TypeScript, React Router, TanStack Query, `openapi-fetch`. All server calls go through `web/src/api/client.ts` (`api` typed from the generated `schema.d.ts`; `unwrap` throws `ApiError` carrying the server's problem document).
- **`api/openapi.yaml` is the contract.** When an endpoint or field changes, update the spec in the same change and run `make gen-api`; `make check-api` fails if the committed types are stale. The spec is hand-written; keep descriptions with a `:` quoted, or the YAML breaks.
- TypeScript is pinned to 5.x on purpose: `openapi-typescript` needs the TS 5 compiler API and crashes on TS 7.
- `web/dist/.gitkeep` is committed so Go compiles before the UI is built (`web/embed.go` embeds `dist`). Never commit other `dist/` files.
- Unknown `/api/` paths must return a JSON 404, never the SPA's HTML fallback (`internal/api/ui.go`).
- **The server owns the rules; the UI never re-implements them.** Offer exactly the `allowed_transitions` the server lists, send input as typed and show the server's problem `detail` verbatim. This covers workflow rules, the freeze, tag and URL validation and `repo_mismatch` warnings. Do not use `type=url` on inputs: the browser's message would hide the server's. Client-side checks are limited to what the server cannot see (e.g. the estimate must parse as a whole number). UI previews of a server effect (which stories a cancel will touch) are informational only.
- What is read-only in the UI follows the server's freeze: a finished/cancelled story's fields, dependencies and pull request links, but not its tags, comments or issue links.
- No optimistic updates: controls show the server's value and refetch after a mutation.
- Keep pure logic (grouping, filtering, candidate lists) in `web/src/lib/` with unit tests, and rendering in `components/`. Filters live in the URL.
- React Query keys are hierarchical (`["project", id, ...]`, `["epic", id, ...]`, `["story", id, ...]`); after a mutation invalidate by prefix, including the parents whose derived data changes (a story change also invalidates its epic and project).
- Browser-only state lives in localStorage behind helpers in `lib/` that must never throw (storage can be blocked, full or corrupt). There is deliberately no server-side visit tracking.
- GitHub links use `target="_blank" rel="noopener noreferrer"`.
- Frontend tests mock `globalThis.fetch` (`vi.stubGlobal`). Use `mockApi({path: body | Response | fn})` and the `epic()`/`story()` builders from `web/src/test/fixtures.ts`; see `web/src/pages/ProjectPage.test.tsx`. Test setup (`src/test/setup.ts`) clears localStorage and restores mocks after every test. Do not use an `<output>` element as a test probe: it has the implicit ARIA role `status`, which the pages also use.
- Verify layout changes in a real browser, not only with vitest: build with `make web`, run the server, and screenshot with `google-chrome --headless=new --no-sandbox --virtual-time-budget=6000 --screenshot=out.png <url>`.

## Skills

- `plugins/dprocess/` is the Claude Code plugin; what each skill does, the server URL precedence, installing and updating are in README.md ("Claude Code plugin"). The `init` skill verifies `GET /api/v1/health` and saves the URL with `skills/init/scripts/dpinit.py`; `dpstory.py` reads the same file inline (skills must not import from each other, so keep the config path and precedence in both in step). `skills/implement-story/scripts/dpstory.py` (also used by the other skills for `find`) is the way implement-story changes status; `design-story` and `review-story` have their own small helpers. Skills must live under `plugins/dprocess/skills/<name>/` (a plugin's skills are one level deep; Claude Code does not scan nested folders in `.claude/skills`), reference their own files through `${CLAUDE_SKILL_DIR}`, run scripts through their interpreter, and use nothing outside the plugin folder (an installed plugin is copied to a cache). Bump `version` in `plugins/dprocess/.claude-plugin/plugin.json` when the plugin changes, and check it with `claude plugin validate ./plugins/dprocess` and `claude plugin validate .`. Keep the skills in step with the workflow rules.

## Conventions

- Schema changes: add a new numbered file in `internal/store/migrations/` (e.g. `0002_*.sql`); never edit an applied migration. Migrations are embedded and run in order at startup, each in a transaction.
- Errors: use `writeError` (RFC 7807-style `application/problem+json`). Map store sentinel errors in `storeError`: not found → 404, in use / illegal transition / dependency cycle → 409, validation → 422, bad JSON or unknown fields → 400.
- JSON bodies are decoded with `DisallowUnknownFields`; PATCH inputs use pointer fields (nil = unchanged).
- Timestamps are stored as UTC ISO-8601 text.
- Routing uses Go 1.22+ `net/http` patterns (`"GET /api/v1/projects/{id}"`), not a third-party router.
- Tests: use real SQLite in a `t.TempDir()` file (see `newTestServer` in `internal/api/projects_test.go`), not mocks. Cover new endpoints with API tests and rules with table tests.
- Keep each story/change small (≤400 LOC where feasible).
- The plan (what is done and what is next) lives as epics and stories on the DProcess server, not in this file.
