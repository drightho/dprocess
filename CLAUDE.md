# CLAUDE.md

Guidance for working on DProcess. See `README.md` for the project overview and usage.

## Commands

- `make test` - `go vet ./...` and `go test ./...` (run before every commit)
- `make run` - start the server (`./dprocess.db`, `127.0.0.1:8080`)
- `make build` - build `./dprocess`
- `make clean` - remove binary and DB files

## Domain rules

- Hierarchy: Project → Epic → Story.
- Epic states: `draft, review, ready, finished, cancelled`.
- Story states: `draft, review, design, implementation, testing, finished, cancelled`.
- A story may depend only on stories in the **same project**; reject self-dependencies and cycles.
- Stories should be estimated at ≤400 LOC. This is **warn-only**: accept larger estimates and return a `warnings` entry (`estimate_exceeds_400_loc`), never reject.
- GitHub issues are a **separate entity** that stores references to issues living on GitHub (optionally linked to a story). v1 makes no GitHub API calls.
- **The detailed state-transition rules have not been supplied yet.** Ask the user for them before implementing or changing real transition logic. Until then use provisional defaults (forward along the listed order, any non-terminal state → `cancelled`, `finished`/`cancelled` terminal), clearly marked provisional in code.

## Architecture decisions

- Go single binary; REST under `/api/v1`; the React + TypeScript SPA (Vite, in `web/`) will be embedded with `go:embed web/dist`.
- SQLite via `modernc.org/sqlite` (pure Go, no cgo). Connection uses WAL, `foreign_keys(1)`, `busy_timeout`, and `SetMaxOpenConns(1)`. Don't switch to a cgo driver.
- Layering: `store` (SQL) → `service` (business rules) → `api` (HTTP). Simple CRUD without rules may go api → store directly (projects does); add `internal/service` when rules appear (transitions, dependency validation). Keep the state machine isolated in `internal/workflow`.
- No authentication in v1. Transitions record an optional free-text `actor`.
- State changes happen only through `POST .../transition`, never through PATCH. Each transition writes a `state_history` row in the same transaction.
- Deleting a parent that has children is rejected with 409 (`store.ErrInUse`); cancelling is the preferred way to retire things.

## Conventions

- Schema changes: add a new numbered file in `internal/store/migrations/` (e.g. `0002_*.sql`); never edit an applied migration. Migrations are embedded and run in order at startup, each in a transaction.
- Errors: use `writeError` (RFC 7807-style `application/problem+json`). Map store sentinel errors in `storeError`: not found → 404, in use / illegal transition / dependency cycle → 409, validation → 422, bad JSON or unknown fields → 400.
- JSON bodies are decoded with `DisallowUnknownFields`; PATCH inputs use pointer fields (nil = unchanged).
- Timestamps are stored as UTC ISO-8601 text.
- Routing uses Go 1.22+ `net/http` patterns (`"GET /api/v1/projects/{id}"`), not a third-party router.
- Tests: use real SQLite in a `t.TempDir()` file (see `newTestServer` in `internal/api/projects_test.go`), not mocks. Cover new endpoints with API tests and rules with table tests.
- Keep each story/change small (≤400 LOC where feasible).

## Roadmap

Done: scaffold + migrations + health; projects CRUD.
Next: epics + workflow package + transition endpoint + history; stories + LOC warning; dependencies; comments/tags/issues; OpenAPI (`api/openapi.yaml`) + frontend scaffold; UI; real transition rules.
