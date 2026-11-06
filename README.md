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
- Epics CRUD, state transitions and history
- Stories CRUD, state transitions, history and the 400 LOC warning
- Story dependencies with same-project and cycle checks
- Tags and comments on epics and stories; GitHub issue references; GitHub pull request links on stories
- OpenAPI spec (`api/openapi.yaml`, also served at `/api/v1/openapi.yaml`)
- Web UI (React + TypeScript + Vite) embedded in the binary: a landing page at `/` (find a project by exact name, the 10 most recently visited projects, create a project), the list of all projects at `/projects`, a project overview page at `/projects/{id}` (epics with state and progress, and a story board with one column per state, filterable by epic, assignee and tag), forms to create and edit epics and stories (a "New epic" form on the project page; "Edit epic", "New story" and per-story "Edit" on the epic page; the size estimate warns live above 400 lines, server validation messages appear inside the form, and finished or cancelled stories are shown read-only), a story page at `/stories/{id}` (fields and warnings, edit in place, the moves the server allows including the backward ones, with its explanation when a move is refused; dependencies in both directions, which can be added from a picker limited to the story's project and removed one by one (a cancelled dependency is flagged because it keeps the story from finishing; refusals such as cycles are explained by the server); tags; comments; pull request links (added and removed there; a finished or cancelled story shows them read-only); the issues linked to it; history; finished and cancelled stories are read-only except that their tags and comments stay open), and an epic page at `/epics/{id}` (tags and comments, its stories and state history, and buttons for the moves the server allows; a refused move shows the server's explanation, and cancelling asks for confirmation because it also cancels the epic's unfinished stories)

An issues page at `/projects/{id}/issues` lists the project's references to GitHub issues (newest first, filterable by story or "not linked"); issues can be added, edited, linked to or unlinked from any story (finished and cancelled ones included) and removed. Only canonical `github.com` issue URLs are accepted for issues and pull request URLs for pull requests; the server checks that and its message is shown. DProcess stores the link only and never contacts GitHub. Links to GitHub open in a new tab.

Tags are edited on the epic and story pages (the server trims, lower-cases and validates them and its message is shown); a tag chip links to the project board filtered by that tag. Comments are listed oldest first with their author, which is remembered in the browser; they cannot be edited or deleted.

Planned: the remaining work is in the "Quality and release" epic (a browser smoke test, CI) and packaging ( tags, comments, issues and pull requests). All state-transition rules for epics and stories are defined and enforced.

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

# GitHub pull requests linked to a story
curl -s -X POST   localhost:8080/api/v1/stories/1/pull-requests -d '{"github_url":"https://github.com/acme/widgets/pull/57"}'
curl -s           localhost:8080/api/v1/stories/1/pull-requests        # also listed in GET /stories/1 as pull_requests
curl -s -X DELETE localhost:8080/api/v1/stories/1/pull-requests/1

# GitHub issue references (DProcess never calls GitHub)
curl -s -X POST  localhost:8080/api/v1/projects/1/issues -d '{"github_url":"https://github.com/acme/widgets/issues/42","title":"Crash on save","kind":"bug","story_id":1}'
curl -s          'localhost:8080/api/v1/projects/1/issues?story=1'
curl -s -X PATCH localhost:8080/api/v1/issues/1 -d '{"story_id":null}'   # unlink from the story
curl -s -X DELETE localhost:8080/api/v1/issues/1
```

Tags match `^[a-z0-9][a-z0-9._:-]{0,49}$` after trimming and lower-casing (422 otherwise). Comments cannot be edited or deleted.

Pull request links accept only URLs of the form `https://github.com/{owner}/{repo}/pull/{number}` (same strict rules as issues: optional trailing slash, no query string, fragment or extra path such as `/files`; issue URLs are rejected, 422). The URL is stored in canonical lower-case form; linking the same pull request twice to a story returns 409. The list is part of the story record, so it is frozen with it: adding or removing a link on a `finished` or `cancelled` story returns 409. Deleting a story deletes its links.

Issues accept only URLs of the form `https://github.com/{owner}/{repo}/issues/{number}` (optional trailing slash; no query string or fragment; pull request URLs are rejected) with 422 otherwise. The URL is stored in canonical lower-case form and cannot be changed afterwards (delete and recreate instead). Referencing the same issue twice in a project returns 409. A `story_id` must belong to the same project as the issue (422). Deleting a story unlinks its issues; deleting a project that still has issues returns 409.

`GET /stories/{id}`, the dependency `PUT` and the tag `PUT` return `depends_on`, `dependents` and linked `issues` lists (dependency entries have id, epic_id, name, state). A dependency must connect two different stories of the same project (422 otherwise) and must not create a cycle, direct or transitive (409).

An `estimate_loc` above 400 is accepted, and the story response then carries `"warnings": ["estimate_exceeds_400_loc"]`. A story's epic cannot be changed after creation, and deleting a story that other stories depend on returns 409.

An epic's or story's state cannot be changed with PATCH, only through `transition`. An illegal transition returns 409 and an unknown state returns 422.

**Epic rules:** an epic starts in `draft` and moves forward only: `draft` to `review` to `ready` to `finished`. It can be `cancelled` from `draft`, `review` or `ready`; `finished` and `cancelled` are final. Two rules involve its stories:

- To finish, every story must be `finished` or `cancelled` and at least one must be `finished` (409 otherwise; the message names the blocking stories).
- Cancelling an epic cancels all of its stories that are not already `finished` or `cancelled`, in the same transaction. Each cancelled story gets a history entry with the reason `epic N cancelled: ...`. Finished stories stay finished.
- A `finished` or `cancelled` epic accepts no new stories (409).

**Story rules:** a story starts in `draft` and normally moves forward: `draft`, `review`, `design`, `implementation`, `testing`, `finished`. It can also step back from `implementation` to `design`, and from `testing` to `implementation` or `design`. It can be `cancelled` from any state except `finished`; `finished` and `cancelled` are final. Two rules involve other records (both answer 409 with an explanatory message):

- A story can move to `review` only while its epic is `review` or `ready`, and to `design` only while its epic is `ready`. (Because an epic can leave `ready` only by finishing or being cancelled, which needs or forces its stories to be final, this also covers `implementation` and `testing`.) Cancelling is never gated.
- A story can move to `finished` only when every story it depends on is `finished`. A cancelled dependency does not count; remove the dependency or cancel the story instead.

**Finished and cancelled stories are frozen.** They cannot be modified (409):

- Editing a story's fields (`PATCH`) is rejected.
- Adding a dependency to such a story, or removing one from it, is rejected. A live story may still depend on a finished or cancelled story, and a live story may always drop a dependency, including one on a cancelled story.
- A `finished` story cannot be deleted. A `cancelled` story can be (unless other stories still depend on it).
- Tags, comments and GitHub issue links are not part of the freeze and stay open on finished and cancelled stories.

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
internal/workflow/       epic and story state machines
internal/api/            HTTP handlers, JSON and error helpers, UI/SPA serving
```

## License

MIT, see [LICENSE](LICENSE).
