---
name: implement-story
description: Implement a story whose design is done. Use when the user says "implement story 80", "work on story #80" or "do story 80" (or /implement-story 80). Runs only on stories in the design state, the state /dprocess:design-story leaves them in. Switches to the story's design branch (scratch/story80-design), renames it to scratch/story80, moves the story to implementation, and runs two subagents, a dev who writes the implementation without seeing the tests and a tester who wrote them and answers the dev's questions. When the code is committed the story moves to ready_for_testing.
argument-hint: <story-id or name>
---

# Implement a DProcess story

`/dprocess:design-story` leaves a story in `design`, with its tests committed on a scratch branch. This skill
implements the story against those tests, **without letting the implementer see them**: the dev works only from the
story, and the tester, who knows the tests, answers the dev's questions about the requirements. You (the parent)
orchestrate and relay.

| Role | Agent | Effort | Does |
|------|-------|--------|------|
| **Dev** | `dprocess:fresh-eyes` (no long-term memory) | `medium` | Writes the implementation in a separate worktree from which the test files are removed; commits; moves the story to `ready_for_testing` |
| **Tester** | `general-purpose`, no `model` override (same configuration as you) | `medium` | Wrote the tests; answers the dev's questions from the story and the tests, in words, without showing test code |

Both can reach the DProcess server through the helper below. The story id comes from the user's message (or
`$ARGUMENTS`); if they gave a name, find it with `$DP find`.

## The helper

The files of this skill live in `${CLAUDE_SKILL_DIR}`. If the path below still shows a literal
`${CLAUDE_SKILL_DIR}`, use the folder holding this `SKILL.md`. Give both subagents this exact command line.

```sh
DP="python3 ${CLAUDE_SKILL_DIR}/scripts/dpstory.py"
$DP find "landing"                          # find a story by name
$DP show 80                                 # detail and preflight (read it fully)
$DP move 80 implementation --reason "..."   # the server enforces the rules and explains refusals
$DP comment 80 "text"                      # record a decision on the story
$DP history 80
```

The server is `DPROCESS_URL`, else the one saved by `/dprocess:init`, else `http://127.0.0.1:8080`. If it is
unreachable, tell the user (suggest `/dprocess:init`) and stop. Never start a server of your own and never edit
the database file. Never move a story backwards, cancel it, or skip a state.

## Steps

1. **Preflight.** Run `$DP show ID` and read it all. Only a story in `design` can be implemented. Any other state:
   stop and say what to do instead (`draft` needs `/dprocess:review-story`, `review` needs `/dprocess:design-story`,
   later states are already past this step). A `BLOCK` line (for example the epic is not `ready`) also stops you;
   never move the epic yourself. Unfinished dependencies do not stop the work but the story cannot finish until
   they do; mention that to the user.
2. **Branch.** `git status` must be clean (otherwise stop and ask) and `git fetch` done. The design branch is
   `scratch/storyID-design` (for story 80: `scratch/story80-design`), local or on `origin`. If neither exists, stop:
   the story has not been through `/dprocess:design-story`. If `scratch/storyID` already exists, stop and ask.
   Then:
   ```sh
   git switch scratch/storyID-design            # or: git switch -c scratch/storyID-design --track origin/scratch/storyID-design
   git branch -m scratch/storyID-design scratch/storyID
   ```
   Write down the files the design branch adds: `git diff --name-only master...HEAD` (call them the **test files**).
   A remote branch of the old name is left alone; do not push anything. Then
   `$DP move ID implementation --reason "Implementation started on branch scratch/storyID"`.
3. **Hide the tests from the dev.** Create a worktree on a temporary branch and remove the test files there:
   ```sh
   WT=$(mktemp -d)/dev
   git worktree add -b scratch/storyID-dev "$WT" scratch/storyID
   git -C "$WT" rm -q -r -- <the test files>
   git -C "$WT" commit -q -m "Hide the design tests from the dev"        # remember this commit as HIDE
   ```
   The dev works **only** in `$WT`. It is a separate checkout, so the test files are not on its disk; the dev may
   not read the main checkout, other branches, `git show`, `git log -p` or any other way to see them. The tester's tests live in the main checkout.
4. **Start the roles** with the Agent tool (they cannot message each other; you relay):
   - **Tester** (`general-purpose`, `effort: "medium"`, no `model` override): you wrote the tests for this story on this
     branch in the main checkout (read them again). Answer the dev's questions about the requirements from the story
     and your tests, **in prose**: what behavior, status code, name or edge case is expected. Never paste or quote test
     code or give file and line positions of assertions. If you do not know, say so. You change no files.
   - **Dev** (`subagent_type: "dprocess:fresh-eyes"`, `effort: "medium"`): implement the story in `$WT` on branch
     `scratch/storyID-dev`. Read the story (`$DP show ID`), `CLAUDE.md`, `README.md` and the code you need. You do
     not have the tests and must not look for them (see step 3). Follow the repository conventions; for API changes
     update `api/openapi.yaml` and run `make gen-api`; schema changes are new numbered migrations. Do not add features
     beyond the story. Check your work as far as you can without the tests (build, `go vet`, `make check` for the
     existing suite, your own quick checks). Do not write the story's tests. If anything in the story is unclear, **stop
     and send me the question** instead of guessing. When done, commit in `$WT` (clear message, attribution trailer
     from the session instructions) and report what you built and what you assumed.
5. **Questions.** A question from the dev goes to the tester (relay it; relay the answer back, verbatim apart from
   removing any test code that slipped in). If the tester cannot answer, or the two disagree, **ask the user**
   (AskUserQuestion) with the question and the options as the roles put them, and relay the answer. If the user cannot
   settle it, stop with the story in `implementation` and report the open points. Record decisions that matter on the story as a comment
   (`$DP comment ID "..."`) so the testing stage sees them.
6. **Check the dev's commit.** Let HIDE be the hide commit. In the main checkout:
   - `git diff --name-only HIDE scratch/storyID-dev` must not list any test file; if it does, send the dev back.
   - Bring the commits over: `git switch scratch/storyID` (already there) and `git cherry-pick HIDE..scratch/storyID-dev`.
   - Remove the temporary worktree and branch: `git worktree remove "$WT"` and `git branch -D scratch/storyID-dev`.
   - Build it: `go build ./...` (and the web build or typecheck if the web changed). A build failure goes back to the dev
     (recreate the worktree if needed). Then run `make check` with the tests and keep the output: failures are
     **not** a reason to stop, finding them is what testing is for, but report them exactly.
7. **Hand over.** Tell the dev to run `$DP move ID ready_for_testing --reason "Implemented on scratch/storyID; commit <sha>"`.
   If the server refuses, report its message and leave the story in `implementation`.
8. **Report** briefly: the branch and commits, what the dev built and assumed, the questions asked (and who answered,
   including the ones you put to the user), the real `make check` result with the failing tests if any, and the story's
   new state. Say that the branch is local and nothing was pushed, and that testing, the pull request and the merge are separate steps.
