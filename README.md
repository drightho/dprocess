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

Planned: story dependencies, comments/tags, issue references, and a React + TypeScript web UI. The detailed state-transition rules are not defined yet; see `CLAUDE.md`.

## Architecture

- Single Go binary: REST API under `/api/v1`, with the web UI to be embedded and served by the same process.
- In-process database: SQLite (pure-Go `modernc.org/sqlite`, no cgo), persisted on disk in WAL mode.
- No authentication in v1 (intended for a single user or trusted network).

## Requirements

- Go 1.22 or newer (developed with Go 1.26)
- Node.js and npm (only once the web UI exists)

## Running

```sh
make run            # go run ./cmd/dprocess
# or
make build && ./dprocess
```

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
```

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
make test    # go vet ./... && go test ./...
```

## Layout

```
cmd/dprocess/            main: flags, wiring, graceful shutdown
internal/store/          SQLite access, embedded migrations (migrations/*.sql)
internal/service/        business rules (state transitions)
internal/workflow/       epic and story state machines (provisional rules)
internal/api/            HTTP handlers, JSON and error helpers
```
