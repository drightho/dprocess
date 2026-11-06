# CLAUDE.md

Guidance for working on DProcess. See `README.md` for the project overview and usage.

## Commands

- `make check` - everything below plus the spec/types drift check (run before every commit)
- `make test` - `go vet ./...` and `go test ./...`
- `make web-test` - frontend typecheck and vitest
- `make gen-api` - regenerate `web/src/api/schema.d.ts` from `api/openapi.yaml`
- `make run` - start the server (`./dprocess.db`, `127.0.0.1:8080`)
- `make dev-web` - Vite dev server, proxies `/api` to `127.0.0.1:8080`
- `make build` - build the web UI, then `./dprocess` with the UI embedded
- `make clean` - remove binary and DB files

## Domain rules

- Hierarchy: Project → Epic → Story.
- Epic states: `draft, review, ready, finished, cancelled`.
- Story states: `draft, review, design, implementation, testing, finished, cancelled`.
- A story may depend only on stories in the **same project**; reject self-dependencies and cycles.
- Stories should be estimated at ≤400 LOC. This is **warn-only**: accept larger estimates and return a `warnings` entry (`estimate_exceeds_400_loc`), never reject.
- Stories carry a list of GitHub **pull request links** (`story_pull_requests`, migration `0003`): only canonical `https://github.com/{owner}/{repo}/pull/{n}` URLs, validated by `service.ParsePullRequestURL` (shares `parseGitHubURL` with issues). The list is part of the story, so it freezes with finished/cancelled stories (`store.AddPullRequest`/`RemovePullRequest` return `ErrStoryLocked`) - unlike tags, comments and issue links, which stay open. Deleting a story cascades to its links.
- GitHub issues are a **separate entity** (only canonical github.com issue URLs are accepted) that stores references to issues living on GitHub (optionally linked to a story). v1 makes no GitHub API calls.
- **Epic transition rules are final** (specified by the user): forward only `draft -> review -> ready -> finished`; `cancelled` from draft/review/ready; `finished` and `cancelled` are final. Finishing needs all stories finished or cancelled and at least one finished. Cancelling cancels every story that is not already finished/cancelled (finished stories are kept) with history rows, atomically. Finished/cancelled epics accept no new stories (`store.ErrEpicClosed`, 409). The rules live in `service.EpicTransitionEffects` (pure, table-tested) and run inside the `store.TransitionEpic` transaction via an `EpicPolicy` callback.
- **Story transition rules are final** (specified by the user): initial `draft`; forward `draft -> review -> design -> implementation -> testing -> finished`; backward only `implementation -> design`, `testing -> implementation`, `testing -> design`; `cancelled` from any state except `finished`; `finished`/`cancelled` final. Gates: move to `review` needs the epic in review or ready; move to `design` (and implementation/testing, which are only reachable via design) needs the epic ready; move to `finished` needs every dependency (the stories it depends on) `finished` - cancelled dependencies block it. The table is in `internal/workflow`; the data-dependent rules are in `service.StoryTransitionCheck` (pure, table-tested) and run inside the `store.TransitionStory` transaction via a `StoryPolicy` callback.
- **Finished and cancelled stories are frozen** (specified by the user): `PATCH` and adding/removing dependencies *of* such a story return 409 (`store.ErrStoryLocked`); a finished story cannot be deleted, a cancelled one can (still 409 while others depend on it). Exception by design: a live story may remove a dependency on a cancelled story (that is how it escapes one); pointing a live story at a finished/cancelled story is allowed. Tags, comments and issue links are deliberately NOT frozen. The checks are atomic SQL/transactions in `store` (`UpdateStory`, `AddDependency`, `RemoveDependency`, `DeleteStory`).
- **Still unspecified, deliberately not enforced:** cancelling an epic can leave live stories in other epics depending on newly cancelled stories (they must remove the dependency before finishing - allowed).

## Architecture decisions

- Go single binary; REST under `/api/v1`; the React + TypeScript SPA (Vite, in `web/`) will be embedded with `go:embed web/dist`.
- SQLite via `modernc.org/sqlite` (pure Go, no cgo). Connection uses WAL, `foreign_keys(1)`, `busy_timeout`, and `SetMaxOpenConns(1)`. Don't switch to a cgo driver.
- Layering: `store` (SQL) → `service` (business rules) → `api` (HTTP). Simple CRUD without rules may go api → store directly (projects does); add `internal/service` when rules appear (transitions, dependency validation). Keep the state machine isolated in `internal/workflow`.
- No authentication in v1. Transitions record an optional free-text `actor`.
- State changes happen only through `POST .../transition`, never through PATCH. Each transition writes a `state_history` row in the same transaction.
- Deleting a parent that has children is rejected with 409 (`store.ErrInUse`); cancelling is the preferred way to retire things.

## Frontend

- `web/`: Vite + React + TypeScript, React Router, TanStack Query, `openapi-fetch`. All server calls go through `web/src/api/client.ts` (`api` typed from the generated `schema.d.ts`; `unwrap` throws `ApiError` carrying the server's problem document).
- **`api/openapi.yaml` is the contract.** When an endpoint or field changes, update the spec in the same change and run `make gen-api`; `make check-api` fails if the committed types are stale. The spec is hand-written; keep descriptions with a `:` quoted, or the YAML breaks.
- TypeScript is pinned to 5.x on purpose: `openapi-typescript` needs the TS 5 compiler API and crashes on TS 7.
- `web/embed.go` embeds `web/dist` (`//go:embed all:dist`). `web/dist/.gitkeep` is committed so Go compiles before the UI is built; the Vite config re-creates it after each build because Vite empties `dist/`. Never commit other `dist/` files.
- The server (`internal/api/ui.go`) serves the UI at `/` with fallback to `index.html` for extension-less paths; unknown `/api/` paths return a JSON 404, never HTML.
- Frontend tests mock `globalThis.fetch` (`vi.stubGlobal`). Use `mockApi({path: body | Response | fn})` and the `epic()`/`story()` builders from `web/src/test/fixtures.ts`; see `web/src/pages/ProjectPage.test.tsx`. `make check` runs them.
- Routes: `/` (landing: project search by exact name, recently visited projects, new-project form), `/projects` (all projects), `/projects/:projectId` (overview: epic list + story board). The overview loads a project's epics and stories once and filters in the browser; filters live in the URL (`?epic=&assignee=&tag=`, parsed by `lib/board.ts`, which ignores values that match nothing). Keep grouping/filtering logic in `lib/board.ts` (pure, unit-tested) and rendering in `components/`.
- "Recently visited projects" is browser-only state in localStorage (`dprocess.recentProjects`, `[{id, name, visitedAt}]`, newest first, max 10), owned by `lib/recent.ts`, which must never throw (storage can be blocked, full or corrupt). `ProjectPage` records a visit once the project has loaded; the landing page shows the server's current name for each entry and drops/prunes deleted projects. There is deliberately no server-side visit tracking.
- Test setup (`src/test/setup.ts`) clears localStorage and restores mocks after every test. Do not use an `<output>` element as a test probe: it has the implicit ARIA role `status`, which the pages also use.
- Verify layout changes in a real browser, not only with vitest: build with `make web`, run the server, and screenshot with `google-chrome --headless=new --no-sandbox --virtual-time-budget=6000 --screenshot=out.png <url>`.

## Conventions

- Schema changes: add a new numbered file in `internal/store/migrations/` (e.g. `0002_*.sql`); never edit an applied migration. Migrations are embedded and run in order at startup, each in a transaction.
- Errors: use `writeError` (RFC 7807-style `application/problem+json`). Map store sentinel errors in `storeError`: not found → 404, in use / illegal transition / dependency cycle → 409, validation → 422, bad JSON or unknown fields → 400.
- JSON bodies are decoded with `DisallowUnknownFields`; PATCH inputs use pointer fields (nil = unchanged).
- Timestamps are stored as UTC ISO-8601 text.
- Routing uses Go 1.22+ `net/http` patterns (`"GET /api/v1/projects/{id}"`), not a third-party router.
- Tests: use real SQLite in a `t.TempDir()` file (see `newTestServer` in `internal/api/projects_test.go`), not mocks. Cover new endpoints with API tests and rules with table tests.
- Keep each story/change small (≤400 LOC where feasible).

## Roadmap

Done: scaffold + migrations + health; projects CRUD; epics CRUD + `internal/workflow` + epic transition endpoint + history (`store.transition` is shared with stories).
Also done: stories CRUD, transitions, history, LOC warning (`service.StoryWarnings`). A story's epic cannot be changed after creation; deleting a story that others depend on returns 409.
Also done: story dependencies. Their invariants (same project, no self-dependency, no cycle via a recursive CTE) live in `store.AddDependency` rather than `service` because the check and insert must share one transaction.
Also done: tags, comments, GitHub issue references. Tag rules live in `service.NormalizeTag`; issue URL rules in `service.ParseIssueURL` (only `https://github.com/{owner}/{repo}/issues/{n}` is accepted, stored canonical/lower-case, unique per project via migration `0002`).
Also done: OpenAPI spec + generated types, frontend scaffold (projects list/create page, health badge), UI embedded in the binary, project overview page (story 26), landing page with recent projects and search (story 37).
Also done: final epic transition rules (finish guard, cancel cascade, no stories in closed epics) and final story transition rules (epic gates, backward moves, finish needs finished dependencies).
Next: rest of the UI (create/edit forms, epic page, story detail, dependency picker, tags/comments, issues/PRs - tracked as stories in the DProcess project in dprocess.db); real transition rules; packaging and hardening.
