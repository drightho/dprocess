# DProcess

DProcess tracks the activities of a software development process. Software requirements are organized in three levels:

- **Project** - top-level container of requirements.
- **Epic** - a group of related stories. States: `draft`, `review`, `ready`, `finished`, `cancelled`.
- **Story** - a deliverable, verifiable piece of software, estimated at no more than 400 lines of code. States: `draft`, `review`, `design`, `implementation`, `testing`, `finished`, `cancelled`. A story may only depend on stories in the same project.

GitHub issues are tracked as a separate concept: DProcess stores references to issues (URL, repo, number), optionally linked to a story. It does not call GitHub.

## Status

Work in progress. Implemented so far:

- Server scaffold, embedded SQLite with migrations, health endpoint
- Projects CRUD (`/api/v1/projects`)
- Epics CRUD, state transitions and history (provisional transition rules)
- Stories CRUD, state transitions, history and the 400 LOC warning
- Story dependencies with same-project and cycle checks
- Tags and comments on epics and stories; GitHub issue references
- OpenAPI spec (`api/openapi.yaml`, also served at `/api/v1/openapi.yaml`)
- Web UI scaffold (React + TypeScript + Vite) embedded in the binary; it currently lists and creates projects

Planned: the full web UI for projects, epics and stories. The detailed state-transition rules are not defined yet; see `CLAUDE.md`.

## Architecture

- Single Go binary: REST API under `/api/v1`, with the built web UI embedded and served by the same process.
- In-process database: SQLite (pure-Go `modernc.org/sqlite`, no cgo), persisted on disk in WAL mode.
- No authentication in v1 (intended for a single user or trusted network).

## Requirements

- Go 1.22 or newer (developed with Go 1.26)
- Node.js and npm (to build the web UI; not needed for Go-only work)

## Running

```sh
make build && ./dprocess     # builds the web UI, embeds it, builds the server
# or, without the UI build step:
make run                     # go run ./cmd/dprocess
```

Open http://127.0.0.1:8080/ for the web UI. Without `make web` the server still runs, but `/` answers with a "UI has not been built" message; the API works either way.

| Setting  | Flag     | Environment      | Default           |
|----------|----------|------------------|-------------------|
| Database | `--db`   | `DPROCESS_DB`    | `./dprocess.db`   |
| Listen   | `--addr` | `DPROCESS_ADDR`  | `127.0.0.1:8080`  |

The database path is relative to the directory the server is started from. WAL mode also creates `-wal` and `-shm` files next to it. `make clean` removes the binary and database files.

## API

```sh
curl -s localhost:8080/api/v1/health
curl -s -X POST  localhost:8080/api/v1/projects -d '{"name":"Demo","description":"first project"}'
curl -s          localhost:8080/api/v1/projects
curl -s          localhost:8080/api/v1/projects/1
curl -s -X PATCH localhost:8080/api/v1/projects/1 -d '{"name":"Renamed"}'
curl -s -X DELETE localhost:8080/api/v1/projects/1

# epics
curl -s -X POST localhost:8080/api/v1/projects/1/epics -d '{"name":"Login"}'
curl -s          localhost:8080/api/v1/projects/1/epics?state=draft
curl -s          localhost:8080/api/v1/epics/1          # includes allowed_transitions
curl -s -X PATCH localhost:8080/api/v1/epics/1 -d '{"description":"..."}'
curl -s -X POST  localhost:8080/api/v1/epics/1/transition -d '{"to":"review","reason":"ready","actor":"ann"}'
curl -s          localhost:8080/api/v1/epics/1/history
curl -s -X DELETE localhost:8080/api/v1/epics/1         # 409 while it has stories

# stories
curl -s -X POST localhost:8080/api/v1/epics/1/stories -d '{"name":"Login form","acceptance_criteria":"...","estimate_loc":150,"assignee":"bob"}'
curl -s          localhost:8080/api/v1/epics/1/stories
curl -s          'localhost:8080/api/v1/projects/1/stories?state=draft&epic=1&assignee=bob'
curl -s          localhost:8080/api/v1/stories/1        # includes warnings and allowed_transitions
curl -s -X PATCH localhost:8080/api/v1/stories/1 -d '{"estimate_loc":null}'   # null clears the estimate
curl -s -X POST  localhost:8080/api/v1/stories/1/transition -d '{"to":"review"}'
curl -s          localhost:8080/api/v1/stories/1/history
curl -s -X DELETE localhost:8080/api/v1/stories/1

# dependencies: story 1 depends on story 2
curl -s -X PUT    localhost:8080/api/v1/stories/1/dependencies/2   # idempotent; returns the story with depends_on/dependents
curl -s -X DELETE localhost:8080/api/v1/stories/1/dependencies/2   # 404 if the dependency does not exist

# tags and comments (the same routes exist under /epics/{id}/...)
curl -s -X PUT    localhost:8080/api/v1/stories/1/tags/backend      # idempotent; tags are lower-cased
curl -s -X DELETE localhost:8080/api/v1/stories/1/tags/backend      # 404 if not tagged
curl -s          'localhost:8080/api/v1/projects/1/stories?tag=backend'   # epics support ?tag= too
curl -s -X POST  localhost:8080/api/v1/stories/1/comments -d '{"body":"Needs a design review","author":"ann"}'
curl -s          localhost:8080/api/v1/stories/1/comments

# GitHub issue references (DProcess never calls GitHub)
curl -s -X POST  localhost:8080/api/v1/projects/1/issues -d '{"github_url":"https://github.com/acme/widgets/issues/42","title":"Crash on save","kind":"bug","story_id":1}'
curl -s          'localhost:8080/api/v1/projects/1/issues?story=1'
curl -s -X PATCH localhost:8080/api/v1/issues/1 -d '{"story_id":null}'   # unlink from the story
curl -s -X DELETE localhost:8080/api/v1/issues/1
```

Tags match `^[a-z0-9][a-z0-9._:-]{0,49}$` after trimming and lower-casing (422 otherwise). Comments cannot be edited or deleted.

Issues accept only URLs of the form `https://github.com/{owner}/{repo}/issues/{number}` (optional trailing slash; no query string or fragment; pull request URLs are rejected) with 422 otherwise. The URL is stored in canonical lower-case form and cannot be changed afterwards (delete and recreate instead). Referencing the same issue twice in a project returns 409. A `story_id` must belong to the same project as the issue (422). Deleting a story unlinks its issues; deleting a project that still has issues returns 409.

`GET /stories/{id}`, the dependency `PUT` and the tag `PUT` return `depends_on`, `dependents` and linked `issues` lists (dependency entries have id, epic_id, name, state). A dependency must connect two different stories of the same project (422 otherwise) and must not create a cycle, direct or transitive (409).

An `estimate_loc` above 400 is accepted, and the story response then carries `"warnings": ["estimate_exceeds_400_loc"]`. A story's epic cannot be changed after creation, and deleting a story that other stories depend on returns 409.

An epic's or story's state cannot be changed with PATCH, only through `transition`. An illegal transition returns 409 and an unknown state returns 422. The transition rules are currently provisional: one step forward along the state order (epics: `draft, review, ready, finished`; stories: `draft, review, design, implementation, testing, finished`), or `cancelled` from any non-terminal state.

Errors are returned as `application/problem+json` documents (`title`, `status`, `detail`):

| Status | Meaning                                                       |
|--------|---------------------------------------------------------------|
| 400    | Malformed JSON or unknown fields                              |
| 404    | Resource not found                                            |
| 409    | Conflict (e.g. deleting a project that still has epics)       |
| 422    | Validation failure (e.g. empty name)                          |

## Development

```sh
make test       # Go: go vet + go test
make web-test   # web: typecheck + vitest
make check      # everything, plus a check that the generated API types match the spec
make dev-web    # Vite dev server with hot reload; proxies /api to a server on 127.0.0.1:8080
make gen-api    # regenerate web/src/api/schema.d.ts after editing api/openapi.yaml
```

For UI work, run the server in one terminal (`make run`) and `make dev-web` in another, then open the URL Vite prints.

The API is described by `api/openapi.yaml`. The web client types (`web/src/api/schema.d.ts`) are generated from it and committed; edit the spec, run `make gen-api`, and commit both.

## Layout

```
cmd/dprocess/            main: flags, wiring, graceful shutdown
api/                     openapi.yaml and the Go package that embeds it
web/                     React + TypeScript + Vite app (src/), embed.go embeds the built dist/
internal/store/          SQLite access, embedded migrations (migrations/*.sql)
internal/service/        business rules (state transitions)
internal/workflow/       epic and story state machines (provisional rules)
internal/api/            HTTP handlers, JSON and error helpers, UI/SPA serving
```
