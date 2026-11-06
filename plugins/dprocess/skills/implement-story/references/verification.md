# Verifying a story ("everything checks")

A story is verified only when **all** of this holds. Report real numbers, never "tests pass" in general.

## 1. The repository checks

`make check` runs Go vet and tests, the frontend typecheck and tests, and verifies the generated TypeScript
API types match `api/openapi.yaml` (which compares against what is **staged**, so `git add -A` first if the
spec or types changed). It must pass at the end, after your last code change.

## 2. Tests that mirror the acceptance criteria

Every acceptance criterion needs a test that would fail without the behavior. Conventions in this repo:

- Backend: real SQLite in a temp dir (see `internal/api/*_test.go`), not mocks. Rules get table tests.
- Frontend: `mockApi({path: body | Response | fn})` and the builders in `web/src/test/fixtures.ts`; a small
  **stateful fake server** per page so a write changes what the next GET returns (see
  `web/src/pages/EpicPage.test.tsx`, `StoryPage.test.tsx`).
- The server decides rules and wording. The UI shows the server's message verbatim; do not re-implement rules.
  When a fake server mimics a server message, check the real handler for the exact wording first.
- Cover empty, loading, error and read-only states, and "the server refused" paths, not just the happy path.
- Cache refreshes matter: assert which query keys are invalidated (spy on `queryClient.invalidateQueries`).

## 3. Deliberate-breakage checks

Passing on the first run proves little. For each behavior that matters, break the code on purpose and confirm
a test fails, then restore the file. Pattern (one breakage at a time; `$TMP` is any scratch directory):

```sh
mutate() { # file, old text, new text, label
  cp "$1" "$TMP/mut.bak"
  python3 - "$1" "$2" "$3" <<'EOF'
import sys
p, old, new = sys.argv[1:4]
s = open(p).read()
if old not in s: print("   (pattern not found!)"); sys.exit(0)
open(p, 'w').write(s.replace(old, new, 1))
EOF
  r=$(npm test 2>&1 | grep -E '^ +Tests ' | sed 's/^ *//'); cp "$TMP/mut.bak" "$1"
  echo "BREAKAGE [$4]: $r"; }
```

Break things like: a rule's threshold or condition, an error message being hidden, a refresh being skipped, a
read-only guard being removed, a filter being inverted. **A breakage that no test catches means a missing or
weak test: add one**, then re-run it. A "(pattern not found!)" line means the breakage did not apply: fix the
pattern. Finish by confirming the full suite is green again and `git status` shows only your intended changes.

## 4. A real run

Unit tests use fakes. Run the real thing too, on a **copy** of the database, never the user's data or server.

**UI or anything user-visible**: write a browser-check script and run it with the harness:

```sh
sh "${CLAUDE_SKILL_DIR}/scripts/e2e-run.sh" /path/to/your-check.mjs   # run from the repository root
```

(`${CLAUDE_SKILL_DIR}` is this skill's directory, see SKILL.md; the harness finds the repository from the
current directory.)

It builds the UI and server, starts the server on a copy of `dprocess.db`, and runs your script, which imports
`<skill dir>/scripts/cdp.mjs` by absolute path (headless Chrome over the DevTools protocol; read its header comment for the helpers
`launch`, `go`, `until`, `fill`, `click`, `text`, `shot`, and the API setup helpers `mkEpic`, `mkStory`, `move`,
`readyEpic`, `finishStory`). Set up the data you need through the API, drive the page like a user, check what
the page shows **and** what the server stored. Exercise: the happy path, each refusal the server can give (real
messages), empty/read-only states, navigation, and a reload of a deep link.

Look at the screenshots you take (open the PNG): layout flaws show up here and nowhere else (a stale error
message left after the field was fixed, an input too narrow for its placeholder, a missing heading that made a
form look like part of the previous list). Fix them, add a test where it is a behavior, and re-run.

**Backend or API only**: build the server, run it on a copy of the database on another port
(`sqlite3 -readonly dprocess.db ".backup /tmp/copy.db"`), and exercise the endpoints with `curl`, including
refusals and edge cases, alongside the Go tests.

## 5. Pitfalls seen in this repo

- zsh aborts a whole `&&` chain when a glob matches nothing (`rm -f file*`): name files explicitly. Never use
  `path` as a shell variable name in zsh (it is tied to `PATH`).
- An `<output>` element has the implicit ARIA role `status`; do not use it as a test probe.
- A DOM node cannot be returned by value from a DevTools evaluation: coerce with `!!(...)` (the harness does).
- `type="url"` inputs hide the server's validation message behind the browser's; use plain text inputs.
- Dependencies can only be added to live stories, and a story can finish only after its dependencies: set data
  up in that order in browser checks.
- Finished/cancelled stories and finished/cancelled epics reject changes (409): set up data **before** finishing.
