---
name: complete-story-lifecycle
description: Take one story, or a list of stories, from wherever they are to finished by running the stage skills in turn. Use when the user says "complete story 90", "complete stories 90, 91 and 95", "finish story 90", "take story 90 all the way", "run the whole lifecycle for story 90" or "drive story 90 to done" (or /complete-story-lifecycle 90). Looks the stories up on the DProcess server; a finished or cancelled story needs nothing. With several stories (or a story whose dependencies are unfinished) it first orders them so that dependencies are completed before the stories that need them, and stops on a circular dependency. Otherwise it calls /dprocess:review-story (draft), /dprocess:design-story (review), /dprocess:implement-story (design), /dprocess:test-story (ready_for_testing) and /dprocess:review-pr (pr_review) as the state requires, until the story is finished. It stops and reports as soon as something needs a human: a blocked gate, a question only the user can answer, a failed stage, or a story that keeps coming back.
argument-hint: <story-id or name>
---

# Complete the lifecycle of a DProcess story

The stage skills each move a story one step. This skill chains them. It does no story work itself: it reads the state from the
server, runs the one skill that fits, reads the state again, and repeats. Given several stories it does them one at a time,
dependencies first.

| State | Skill | Normally leaves the story in |
|-------|-------|------------------------------|
| `draft` | `/dprocess:review-story` | `review` |
| `review` | `/dprocess:design-story` | `design` |
| `design` | `/dprocess:implement-story` | `ready_for_testing` |
| `ready_for_testing` | `/dprocess:test-story` | `pr_review` |
| `pr_review` | `/dprocess:review-pr` | `finished` (or back to `design`) |
| `implementation`, `testing` | none: a run is in progress or was interrupted | ask the user |
| `finished`, `cancelled` | none | done |

The input is one or more story ids (or names) from the user's message or `$ARGUMENTS`, separated by spaces, commas or "and";
a name is resolved with `$DP find` (ask the user if it matches several stories).

## The helper

The files of this skill live in `${CLAUDE_SKILL_DIR}`. If the path below still shows a literal `${CLAUDE_SKILL_DIR}`, use the
folder holding this `SKILL.md`. The helper only reads; it never changes a story.

```sh
DP="python3 ${CLAUDE_SKILL_DIR}/scripts/dplifecycle.py"
$DP find "landing"      # find a story by name
$DP plan 90 91 95       # the order to complete them in, dependencies first; detects cycles
$DP next 90             # state, epic, pull requests, dependencies, and NEXT / DONE / STOP
$DP history 90          # state history (look for repeated trips back to design)
```

The server is `DPROCESS_URL`, else the one saved by `/dprocess:init`, else `http://127.0.0.1:8080`. If it is unreachable, tell
the user (suggest `/dprocess:init`) and stop. Never start a server of your own and never edit the database file. This skill
never moves a story itself, never cancels one, and never moves an epic: the stage skills make the moves.

## Steps

0. **Order the stories** (always, even for one story, because its dependencies must finish first). Run `$DP plan ID [ID ...]`.
   It follows `depends_on` transitively through every story that is not finished and prints the order to work in, each line
   with the story's state and what it waits for. Stories you were not asked about appear marked `(not listed: a dependency)`:
   they have to be finished before the listed story can be, so they are part of the run. Tell the user the order once
   (and which extra stories were pulled in), and do not ask for confirmation.
   - `CYCLE:` (exit 2): there is a circular dependency. Report the cycle exactly as printed and **stop before starting any
     story**: not even the stories outside the cycle. The user has to remove a dependency first.
   - `BLOCKED:` (exit 3): a story depends on a cancelled story and can never finish. Report it and stop before starting any story.
   - `DONE:` every story is already finished or cancelled: report that and stop.
   - Otherwise work through the list **in the printed order, one story at a time**: run steps 1 to 5 for the first story to the
     end before starting the next. Never run two stories in parallel (they share the work tree and the branches).
   - A story that is in the list only because another story needs it counts as part of the run.
   - If a story **stops** (see "When to stop"), do not start the stories that still wait for it, directly or indirectly:
     they cannot finish. Stories that do not depend on it may go on. At the end report which were completed, which stopped
     and why, and which were skipped because of whom.

For each story in turn:

1. **Look up.** Run `$DP next ID` and read it. Record the state you start in.
   - `DONE`: report that the story is already finished or cancelled and stop. Nothing changes.
   - `STOP`: report the reason and stop (see "When to stop").
   - `NEXT`: continue.
2. **Say the plan once.** Tell the user the story, its state and the stages that remain, for example
   "Story 90 is in `review`: design, implement, test and review-pr to go." Do not ask for confirmation; the user asked for the
   whole lifecycle. If the story has dependencies that are not finished, mention them: the last step cannot finish until they are.
3. **Run the stage.** Invoke the skill named by `NEXT` with the Skill tool, passing the story id as `args`
   (`skill: "dprocess:design-story", args: "90"`). Follow its instructions fully, as if the user had typed it, including its
   subagents. Do not shortcut or merge stages, and do not do part of a stage yourself.
4. **Check the outcome.** Run `$DP next ID` again and compare with the state the stage was supposed to leave:
   - Moved forward as expected: go to step 3 with the new state (or finish at step 5).
   - `finished` or `cancelled`: go to step 5.
   - Unchanged, or the stage reported that it stopped, refused or needs the user: that is a stop (below). Never run the same
     stage again hoping for a different result, unless the stage's own report says what changed to make it worth retrying.
   - Went backward (for example `pr_review -> design` after a failed review, `testing -> design` after failed tests): this is
     the process working, not an error. Look at `$DP history ID`; the stage left findings on the story and the PR. Continue
     from the new state, which gives the work another pass. Allow **at most 2 trips back** to `design` in one run; the third
     time, stop and report the findings: something is wrong that a loop will not fix.
5. **Finish.** When the state is `finished`, report (for a list, one short block per story, then a summary table): the stages that ran, the path through the states, the pull request and
   merge, and anything notable the stages recorded (warnings, findings that were settled). Then stop.

## When to stop

Stop, report, and leave the story in whatever state the last stage reached when any of these happens. Do not work around them.

- **A gate that is the user's call.** The epic is not in the state the next move needs: `draft -> review` needs the epic in
  `review` or `ready`; `review -> design` and everything after needs it `ready`. Moving an epic is a decision for the user, so
  name the epic and the state it needs and stop. (`$DP next` reports this as `STOP`.) Likewise a story that cannot finish because a
  dependency is not finished: name the dependency and its state.
- **A question only a human can answer.** A stage skill asks the user (an unclear requirement, which PR to review, a dirty work
  tree, a missing branch, a failing `gh auth`). Ask it through the stage as designed; if the user cannot or does not
  answer in this run, stop. Do not answer for them and do not pick a default to keep going.
- **A stage failed or was refused.** The server refused a move, a merge was refused, tests could not be fixed, a subagent
  could not agree and the stage did not resolve it. Report the stage's own message verbatim.
- **A run in progress.** The story is in `implementation` or `testing`: another run (or an interrupted one) holds it. Ask the
  user whether to continue it with the matching skill; do not guess.
- **Too many round trips.** See step 4.
- **A circular dependency** found by `$DP plan`, or a dependency that is cancelled. See step 0.
- **The server or `gh` is unreachable.**

The report when stopping is short: the story and its state now, what was done in this run, what is blocking, and the one
thing the user has to do (or decide) before running `/dprocess:complete-story-lifecycle ID` again. Running it again is safe: it
always starts from the story's current state.
