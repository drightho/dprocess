---
name: design-story
description: Design a story that is in review by writing its tests first. Use when the user says "design story 50", "do the design for story 50" or "write the tests for story 50 first" (or /design-story 50). Runs only on stories in the review state. Creates a scratch branch (scratch/story50-design) and runs three subagents, a dev (fresh-eyes, medium effort), a tester (same configuration as you, medium effort) and a requirements engineer who speaks for the customer (same configuration as you, high effort). The tester writes the test code, the dev and the requirements engineer review it, and when all three agree the story moves to design.
argument-hint: <story-id or name>
---

# Design a DProcess story

The design of a story is its tests: they pin down what "done" means before anyone writes the feature. Three
subagents do the work, you (the parent) orchestrate and relay messages, and the user is the last resort for questions.

| Role | Agent | Effort | Does |
|------|-------|--------|------|
| **Dev** | `dprocess:fresh-eyes` (no long-term memory) | `medium` | Judges feasibility, agrees or rejects the tester's assumptions, reviews the tests, updates the story from the discussion with the tester |
| **Tester** | `general-purpose`, no `model` override (same configuration as you) | `medium` | Writes the test code, the only role that edits files |
| **Req engineer** | `general-purpose`, no `model` override (same configuration as you) | `high` | Customer voice: answers questions about the requirements from what it knows of the project, reviews the tests |

All three can use the DProcess server through the helper below. The story id comes from the user's message
(or `$ARGUMENTS`); if they gave a name, find it first (`dpstory.py find` of the implement-story skill) or ask.

## The helper

The files of this skill live in `${CLAUDE_SKILL_DIR}`. If the path below still shows a literal
`${CLAUDE_SKILL_DIR}`, use the folder holding this `SKILL.md`. Give all three subagents this exact command line.

```sh
DP="python3 ${CLAUDE_SKILL_DIR}/scripts/dpdesign.py"
$DP show 50                                   # fields, epic, dependencies
$DP update 50 --description @d.md --acceptance-criteria @ac.md   # the dev's story update ("@file" reads a file)
$DP comment 50 "text or @file"                # record a decision or open point on the story
$DP move-to-design 50 --reason "..."          # review -> design (only you call this)
```

The server is `DPROCESS_URL`, else the one saved by `/dprocess:init`, else `http://127.0.0.1:8080`. If it is
unreachable, tell the user (suggest `/dprocess:init`) and stop. Never start a server of your own and never edit
the database file. The roles may also read other stories and epics through the REST API (`/api/v1`).

## Steps

1. **Check.** Run `$DP show ID`. If the story is not in `review`, stop and say so (a draft needs
   `/dprocess:review-story` first; later states are already past design). Also check that the epic is `ready`:
   the story can enter `design` only then. If it is not, tell the user now and ask whether to
   go on anyway (the tests would be written, but the story would stay in `review`); never move the epic yourself.
2. **Scratch branch.** `git status` must be clean and the branch `master`, in sync with `origin` (`git fetch`);
   otherwise stop and ask. Then `git switch -c scratch/storyID-design` (for story 50: `scratch/story50-design`).
   If that branch already exists, ask the user whether to resume it. Do not push it, and never work on `master`.
   All three agents share this working tree; only the tester edits files.
3. **Start the roles** with the Agent tool, in this order, each prompt naming the story id, the helper command line,
   the scratch branch and the other two roles (you relay between them; they cannot message each other):
   - **Req engineer** (`general-purpose`, `effort: "high"`): you are the customer's voice. Read the story and the
     project (`CLAUDE.md`, `README.md`, the OpenAPI spec, related stories/epics, your memory). Answer questions as best
     you can from that knowledge; say plainly "I don't know" instead of inventing a requirement, and mark it as
     open. You do not edit files.
   - **Dev** (`subagent_type: "dprocess:fresh-eyes"`, `effort: "medium"`): you are the developer who will implement
     this story. Read the story and the code it touches. Judge assumptions and tests for feasibility and fit with
     the repository's architecture and conventions. You do not edit files; your one write is the story update in step 6.
   - **Tester** (`general-purpose`, `effort: "medium"`): write the test code for the story on the scratch branch,
     following the repository's test conventions (CLAUDE.md: real SQLite in `t.TempDir()` for Go API tests, table
     tests for rules, vitest with the fixtures for the frontend). Cover every acceptance criterion and the failure cases the story
     implies. The tests must compile or typecheck and should fail only because the feature is missing; do not
     implement the feature itself (small test helpers and fixtures are fine). Commit locally when done.
   Ask each to reply "ready" once they have read the story; the tester starts writing only after you say so.
4. **Write the tests.** Tell the tester to start. Two rules apply throughout:
   - **Assumptions.** If the tester must assume something to write a test (a name, a status code, a behavior the story
     leaves open), it first sends the assumption to you, and you relay it to the dev for agreement. If the dev
     agrees, the tester goes ahead. If the dev does not, relay the objection to the tester and keep both talking
     (through you) until they find a version the tester can write the tests against.
   - **Questions.** Any question from dev or tester about the story's requirements goes to the req engineer
     (relay it, and relay the answer back). The req engineer's answer settles it, unless it says "I don't know".
   Record each decision that matters on the story with `$DP comment`, so the implementer sees it later.
5. **Ask the user** when a question stays unanswered: the req engineer does not know, or dev and tester cannot agree.
   Use AskUserQuestion with the question and the options as the roles put them. Relay the answer and continue.
   If the user cannot settle it, stop with the story still in `review` and report the open points; the committed tests
   stay on the scratch branch.
6. **Update the story.** When the tester reports the tests done and committed, the dev and the tester talk about
   them (through you): what the tests pin down that the story does not say, the assumptions made and agreed, the
   answers of the req engineer, anything the tests showed to be missing or wrong in the story. Then tell the dev to
   update the story on the server with `$DP update` from that discussion: the description (decisions and
   clarifications, out of scope), acceptance criteria that match what the tests check, and the estimate if the
   design changed it. It keeps what is already there unless the discussion replaced it and invents nothing nobody
   confirmed. The dev reports what changed; the story's text and the tests must now say the same thing.
7. **Review the tests.** Run the tests yourself (they should
   build and fail for the missing feature only; if they fail for another reason, send them back). Then ask the dev and the req engineer to review
   the test code (`git diff master...HEAD`) and the updated story (`$DP show ID`): the dev for feasibility and conventions, the req engineer for whether both
   match the customer's intent and cover every acceptance criterion. Relay their findings to the tester, let it
   fix them, and repeat the review. Each of them replies `APPROVED` or `CHANGES:` with a list. This ends only when
   **all three** (tester included) say they are fine with the tests. Stop after 5 review rounds that do not
   converge and ask the user.
8. **Move the story.** Run `$DP move-to-design ID --reason "Design agreed: tests on scratch/storyID-design"`.
   It goes `review -> design`, recorded in the history. Moving on to `implementation` is the job of `/dprocess:implement-story`, which picks up this branch. If the server refuses
   (for example the epic is not `ready`), report its message and leave the story in `review`.
9. **Report** briefly: the branch name and commit(s), the tests written (files, how many, what they cover), how the dev changed the story, the
   assumptions made and who agreed, the questions the req engineer answered and the ones the user did, the review
   rounds, and the story's new state. Remind the user that the branch is local and unpushed and that
   `/dprocess:implement-story` starts from it (it renames the branch to `scratch/storyID`).
