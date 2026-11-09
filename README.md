# DProcess

DProcess tracks the activities of a software development process. Software requirements are organized in three levels:

- **Project** - top-level container of requirements.
- **Epic** - a group of related stories. States: `draft`, `review`, `ready`, `finished`, `cancelled`.
- **Story** - a deliverable, verifiable piece of software, estimated at no more than 400 lines of code. States: `draft`, `review`, `design`, `implementation`, `ready_for_testing`, `testing`, `pr_review`, `finished`, `cancelled`. A story may only depend on stories in the same project.

GitHub issues are tracked as a separate concept: DProcess stores references to issues (URL, repo, number), optionally linked to a story. By default it does not call GitHub; an optional, read-only sync (see below) can cache the status of linked issues and pull requests.

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
| GitHub status sync | `--github-sync`, `--github-sync-interval` | `DPROCESS_GITHUB_SYNC=1`, `DPROCESS_GITHUB_TOKEN` | off, 15m |

**GitHub status sync (optional, off by default).** With `--github-sync` the server reads (GET only, never writes) the title and open/closed/merged state of every linked issue and pull request and caches it; `remote_status` on issues and pull requests shows it (the UI shows an open/closed/merged/unknown badge beside each link while the sync is on), and `GET /api/v1/github-sync` reports whether the sync runs and how the last run went. `DPROCESS_GITHUB_TOKEN` is optional (public repositories work without one, at GitHub's low anonymous rate limit). A missing, invalid or rate-limited token never fails the server: the run stops, `last_error` says why, and status stays `unknown`. Status older than 24 hours, or for an item GitHub no longer shows, is `unknown` too.

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

# GitHub issue references (GitHub is only read when the optional status sync is on)
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

**Story rules:** a story starts in `draft` and normally moves forward: `draft`, `review`, `design`, `implementation`, `ready_for_testing`, `testing`, `pr_review`, `finished`. It can also step back from `implementation` to `design`, from `ready_for_testing` to `implementation`, from `testing` to `implementation` or `design`, and from `pr_review` to `design` (the pull request review failed). It can be `cancelled` from any state except `finished`; `finished` and `cancelled` are final. Two rules involve other records (both answer 409 with an explanatory message):

- A story can move to `review` only while its epic is `review` or `ready`, and to `design` only while its epic is `ready`. (Because an epic can leave `ready` only by finishing or being cancelled, which needs or forces its stories to be final, this also covers `implementation`, `ready_for_testing`, `testing` and `pr_review`.) Cancelling is never gated.
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

## Claude Code plugin

DProcess ships a [Claude Code](https://code.claude.com) plugin, `dprocess`: a suite of skills for working with a DProcess project plan from Claude Code. The skills are meant to run from a clone of this repository, against a running DProcess server.

| Skill | You say | What it does |
|-------|---------|--------------|
| `/dprocess:init` | "set up dprocess" | Asks for your DProcess server's URL, checks that a server answers there and saves it; every other skill of the plugin then uses it. |
| `/dprocess:implement-story` | "implement story 80" | Only for stories in `design`. Switches to the design branch and renames it to `scratch/story80`, moves the story to `implementation`, and has a dev (who cannot see the tests) implement it while the tester who wrote the tests answers its questions; then the story moves to `ready_for_testing`. |
| `/dprocess:review-story` | "review story 27" | Only for draft stories. An interviewee subagent (your configuration, high reasoning effort) and a fresh-eyes interviewer question each other until both are clear about the scope and requirements; the interviewee then updates the story on the server and moves it to `review`. |
| `/dprocess:design-story` | "design story 50" | Only for stories in `review`. On a scratch branch (`scratch/story50-design`) a dev (fresh-eyes), a tester and a requirements engineer acting as the customer's voice agree on the design by writing the tests first; the dev and the requirements engineer review them, and the story then moves to `design`. |

More skills will be added to the same plugin.

### Install

Requirements:

- Claude Code 2.1.275 or newer.
- A running DProcess server (`make run`, which listens on `127.0.0.1:8080` by default). After installing, run `/dprocess:init` once to tell the plugin its URL; it is saved in `~/.config/dprocess/config.json` (or `$XDG_CONFIG_HOME/dprocess/config.json`). Without it the plugin uses `http://127.0.0.1:8080`, and the environment variable `DPROCESS_URL`, if set, overrides both.
- Python 3, `git`, `make`, Go and Node.js, as for the project itself, and the GitHub CLI `gh`, signed in, for pull requests.
- For the browser checks the skill runs on UI stories: `google-chrome`, `sqlite3` and Node.js 22 or newer.

Clone the repository first, then install the plugin from the local clone (the marketplace is read from the clone's `.claude-plugin/marketplace.json`, so no GitHub access from Claude Code is needed):

```sh
git clone https://github.com/drightho/dprocess.git
cd dprocess
```

Then, in a Claude Code session (use the path to your clone; `.` is the current directory):

```
/plugin marketplace add ./
/plugin install dprocess@dprocess-marketplace
```

From a shell the same is `claude plugin marketplace add ./` and `claude plugin install dprocess@dprocess-marketplace`, with `--scope user` (all your projects, the default), `--scope project` (everyone who works in a repository; collaborators still install it themselves) or `--scope local` (only you, in one repository). Then run `/reload-plugins` or start a new session; `/plugin` lists what is installed.

To try it from a clone without installing, start Claude Code with `claude --plugin-dir ./plugins/dprocess` (and `/reload-plugins` after editing the plugin). `claude plugin validate ./plugins/dprocess` checks the manifest.

Update with `git pull`, then `claude plugin marketplace update dprocess-marketplace` and `claude plugin update dprocess@dprocess-marketplace` (users stay on a plugin version until `version` in `plugins/dprocess/.claude-plugin/plugin.json` changes, so bump it when you change the plugin). Remove with `claude plugin uninstall dprocess@dprocess-marketplace`.

### Use

Open Claude Code in your clone of DProcess and say what you want, one stage at a time:

```
review story 80       # draft -> review
design story 80       # review -> design, tests written on scratch/story80-design
implement story 80    # design -> implementation -> ready_for_testing, on scratch/story80
```

`implement-story` checks that the story is in `design` and its epic `ready`, switches to `scratch/story80-design` and renames it `scratch/story80`, then runs a dev and a tester. The dev works in a separate worktree from which the test files have been removed, so it implements from the story alone; when it has a question the tester, who wrote the tests, answers it in words (never with test code), and you are asked if neither can settle it. The dev's commits are brought back onto the branch, the project's checks are run and reported (test failures do not stop the hand-over, they are what testing is for), and the story moves to `ready_for_testing`. Nothing is pushed.

Status changes always go to the server configured with `/dprocess:init` (or `DPROCESS_URL`), recorded with the actor `claude` (`DPROCESS_ACTOR` changes that). Claude never starts a server of its own for this and never edits the database file.

The implement-story helper can also be used by hand:

```sh
DP="python3 plugins/dprocess/skills/implement-story/scripts/dpstory.py"
$DP find "landing"                          # look a story up by name
$DP show 80                                 # detail and preflight
$DP move 80 implementation --reason "..."   # the server enforces the workflow rules
```

## Layout

```
cmd/dprocess/            main: flags, wiring, graceful shutdown
api/                     openapi.yaml and the Go package that embeds it
web/                     React + TypeScript + Vite app (src/), embed.go embeds the built dist/
internal/store/          SQLite access, embedded migrations (migrations/*.sql)
internal/service/        business rules (state transitions)
internal/workflow/       epic and story state machines
internal/api/            HTTP handlers, JSON and error helpers, UI/SPA serving
plugins/dprocess/        the Claude Code plugin (skills/ and their scripts)
.claude-plugin/          marketplace.json: makes this repository an installable plugin marketplace
```

## License

MIT, see [LICENSE](LICENSE).
