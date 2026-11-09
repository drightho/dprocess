---
name: test-story
description: Test a story that is ready for testing. Use when the user says "test story 90", "run the tests for story #90" or "test story 90" (or /test-story 90). Runs only on stories in the ready_for_testing state, the state /dprocess:implement-story leaves them in. Switches to the story's branch (scratch/story90), moves the story to testing and has a tester (fresh-eyes, low effort) run the tests. If any fail, a dev (same configuration as you, high effort) and the tester fix them together; if they cannot, the story is updated with the failure details, moved back to design and the user is told. When everything passes the dev commits test and implementation changes, opens a pull request and the story moves to pr_review.
argument-hint: <story-id or name>
---

# Test a DProcess story

`/dprocess:implement-story` leaves a story in `ready_for_testing`, with the tests (from `/dprocess:design-story`) and the
implementation on one scratch branch. This skill runs the tests, gets failures fixed, and opens the pull request. You (the
parent) orchestrate and relay; the subagents cannot message each other.

| Role | Agent | Effort | Does |
|------|-------|--------|------|
| **Tester** | `dprocess:fresh-eyes` (no long-term memory) | `low` | Runs the tests and reports exactly what passed and failed; re-runs after each fix. Changes no files, except tests when the dev and it agree a test is wrong |
| **Dev** | `general-purpose`, no `model` override (same configuration as you) | `high` | Diagnoses failures and fixes the implementation (or a wrong test); after a green run commits, opens the pull request |

Both can reach the DProcess server through the helper below. The story id comes from the user's message (or
`$ARGUMENTS`); if they gave a name, find it with `$DP find`.

## The helper

The files of this skill live in `${CLAUDE_SKILL_DIR}`. If the path below still shows a literal
`${CLAUDE_SKILL_DIR}`, use the folder holding this `SKILL.md`. Give both subagents this exact command line.

```sh
DP="python3 ${CLAUDE_SKILL_DIR}/scripts/dptest.py"
$DP find "landing"                               # find a story by name
$DP show 90                                      # detail and preflight (read it fully)
$DP move 90 testing --reason "..."               # the server enforces the rules and explains refusals
$DP update 90 --description @d.md                # change fields ("@file" reads a file)
$DP comment 90 "text or @file"                   # record a result or decision on the story
$DP link-pr 90 https://github.com/o/r/pull/12    # link the pull request
$DP history 90
```

The server is `DPROCESS_URL`, else the one saved by `/dprocess:init`, else `http://127.0.0.1:8080`. If it is
unreachable, tell the user (suggest `/dprocess:init`) and stop. Never start a server of your own and never edit
the database file. Never cancel the story or skip a state; the only backward move this skill makes is `testing -> design` in step 5.

## Steps

1. **Preflight.** Run `$DP show ID` and read it all. Only a story in `ready_for_testing` can be tested. Any other
   state: stop and say what to do instead (`draft` needs `/dprocess:review-story`, `review` needs
   `/dprocess:design-story`, `design` needs `/dprocess:implement-story`; `testing` may be another run in progress, ask the user;
   later states are already past this step). A `BLOCK` line stops you.
2. **Branch and state.** `git status` must be clean (otherwise stop and ask) and `git fetch` done. The branch is
   `scratch/storyID` (for story 90: `scratch/story90`), local or on `origin`. If neither exists, stop: the story has not
   been through `/dprocess:implement-story`. Then:
   ```sh
   git switch scratch/storyID            # or: git switch -c scratch/storyID --track origin/scratch/storyID
   ```
   and `$DP move ID testing --reason "Testing started on branch scratch/storyID"`. If the server refuses, report its
   message, leave the story where it is and stop.
3. **Tester.** Start the tester (`subagent_type: "dprocess:fresh-eyes"`, `effort: "low"`) with the story id, the helper
   line, the branch and these instructions: read the story (`$DP show ID`), `CLAUDE.md` and the branch's changes
   (`git diff --stat master...HEAD`). **At least run the tests written for this story** (the test files on the branch,
   for example `go test ./... -run <names>` or `npx vitest run <files>`). Use your judgement whether the whole suite is also
   needed: run `make check` when the change touches shared code, the API spec, the schema or the frontend types, or when
   the targeted run is green and the full run is cheap (it is, in this repository, so the default is to run it). Report: the
   commands run, the counts, and for each failure the test name, the assertion message and the relevant output,
   verbatim. Do not fix anything. If every test passes, say so plainly.
   Keep the tester's report; you will need it in steps 4 and 5.
4. **Fix loop** (only if something failed; at most 3 rounds):
   - Start the dev (`subagent_type` omitted so it is `general-purpose`, no `model`, `effort: "high"`) with the story id,
     the helper line, the branch, and the tester's report. Its job: find the root cause of each failure and fix it in the
     checkout on `scratch/storyID`. Fix the implementation by default. A test may be changed only when it is plainly
     wrong against the story's requirements (not because it is inconvenient); the dev must say so in its report, with the
     reasoning, and you tell the user in the final report. The dev does not commit yet and may ask you questions.
   - When the dev reports, send the tester (a new `dprocess:fresh-eyes`, `effort: "low"`, or `SendMessage` to the
     first one) the dev's summary and ask for a fresh full run of the same commands, with the same report format.
   - Back to the dev with whatever still fails. Questions about requirements that neither can settle go to the user
     (AskUserQuestion).
   - Stop the loop when the tester reports a fully green run, or after 3 rounds without one.
5. **Unresolved failures.** If failures remain after the loop: do **not** commit or push anything and leave the working tree
   as the dev left it (report `git status`). Then:
   - Update the story with the details: write a `## Test failures` section (date, branch and commit, the commands run,
     each failing test with its message and output, what the dev tried and what it believes the cause is, what is still
     open) to a file, then append it to the existing description:
     `$DP show ID` for the current description, then `$DP update ID --description @file` with the old text followed by the new section.
     Never drop the old description.
   - `$DP move ID design --reason "Testing failed: <n> test(s) still failing, details in the description"`.
   - Tell the user plainly what failed and why it could not be resolved, and that the story is back in `design`. **End.**
6. **Pull request** (everything is green). Tell the dev to:
   - run `make check` one last time and confirm it passes;
   - commit **both** the test and the implementation changes on `scratch/storyID` (clear messages, attribution trailer from
     the session instructions; skip the commit if there is nothing new to commit, and check `git log master..HEAD`);
   - push the branch (`git push -u origin scratch/storyID`) and open the pull request against `master` with `gh pr create`
     (title naming the story, body with a summary, how it was tested, the test result, and the attribution line from the
     session instructions). Report the URL.
   As soon as the pull request exists, **update the story on the server** (you or the dev, but it must happen before step 7):
   - `$DP link-pr ID <url>` to attach the pull request to the story (a story keeps a list of PR links);
   - `$DP comment ID "<text>"` with the testing result: branch, commit, the commands run and their result, failures found and
     how they were fixed (flag any changed test and why), and the PR URL.
   If `link-pr` is refused, report the server's message. If `gh` is not available or not authenticated, or the push is
   refused, stop: report the problem, leave the story in `testing`, and tell the user what to run.
7. **Hand over.** `$DP move ID pr_review --reason "Tests pass; pull request <url>"`. If the server refuses, report its
   message and leave the story in `testing`.
8. **Report** briefly: the branch and commits, the commands the tester ran and the real result, the failures found and how
   they were fixed (flag every changed test and why), the pull request URL, and the story's new state. Say that
   the review and the merge are separate steps.
