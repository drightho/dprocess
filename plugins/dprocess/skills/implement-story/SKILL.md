---
name: implement-story
description: Implement a story from the DProcess project plan end to end. Use when the user says "implement story 27", "work on story #27", "do story 27" or "implement the dependency picker story" (or /implement-story 27). Reads the story from the DProcess server, checks it can be started, moves it through the workflow (implementation, testing, finished), implements it on a branch with tests, opens a pull request, merges it when every check passes, and keeps the story's status on the server in step.
argument-hint: <story-id or name> [don't merge]
---

# Implement a DProcess story

The user names a story ("implement story 27", "#27", or by name). You read it from the DProcess
server, implement it in this repository, ship it through a pull request, and move the story through
its workflow on the server so the plan always shows the truth.

The story id comes from the user's message (or `$ARGUMENTS`). If they gave a name, find the id first.

## Ground rules

- **The user's server is the source of truth for status**: the URL saved by `/dprocess:init`
  (`http://127.0.0.1:8080` if none; `DPROCESS_URL` overrides both). Use the helper below for every status change. If the server is unreachable, say so, suggest
  `/dprocess:init` (it sets the address), and stop; do not start a server of your own to change status, and never edit the database file.
- **Default is the full cycle**: implement, verify, open a PR, merge it **only if every check passes**,
  finish the story. The user can narrow it: "don't merge" / "stop at the PR" means stop with the PR open and
  the story in `testing`; "just check" / "dry run" means run the preflight and report, change nothing.
- **Never** skip or weaken a check, use `--no-verify` or `--force`, push to `master`, merge with failing
  checks, move a story backwards, or cancel one unless the user asks. The user's instructions win.
- **Ask, don't guess**, when requirements are unclear or an approval is needed (see step 1).

## The helper

This skill's files live in `${CLAUDE_SKILL_DIR}` (scripts, and `references/` with the detailed guides). Run the
scripts through their interpreter (`python3`, `sh`, `node`); do not rely on executable bits. If the path below
still shows a literal `${CLAUDE_SKILL_DIR}`, find the skill's directory (the folder holding this `SKILL.md`) and
use that instead. Run everything from the root of the DProcess repository you are working in.

```sh
DP="python3 ${CLAUDE_SKILL_DIR}/scripts/dpstory.py"
$DP find "landing"                         # find a story by name
$DP show 27                                # detail + preflight (read it fully)
$DP move 27 implementation --reason "..."  # the server enforces the rules and explains refusals
$DP link-pr 27 https://github.com/OWNER/REPO/pull/12
$DP history 27
$DP epic-status 27                         # is the story's epic now eligible to be finished?
```

## The workflow rules (enforced by the server; you must plan around them)

Story states: `draft -> review -> design -> implementation -> testing -> finished`. Allowed backward moves:
`implementation -> design`, `testing -> implementation`, `testing -> design`. `cancelled` from any state except
`finished`. `finished` and `cancelled` are final and **read-only** (fields, dependencies, pull request links);
tags, comments and issue links stay open.

- A story can move to `review` only while its epic is `review` or `ready`, and to `design` (and everything
  after) only while its epic is `ready`.
- A story can move to `finished` only when **every story it depends on is `finished`** (cancelled does not
  count).
- **Link the pull request before finishing**: a finished story can no longer be changed, its PR list included.
- Finishing an epic is a separate, final step (see step 9).

## Steps

1. **Preflight.** Run `$DP show ID` and read the whole output: description, acceptance criteria (the definition
   of done), dependencies, the epic's state, the preflight lines.
   - `BLOCK` (finished/cancelled story, or the epic is too early): do not start; tell the user why and what
     would unblock it. Never move the epic yourself.
   - Story in `draft` or `review`: it has not been cleared for work. Ask the user (AskUserQuestion) whether to
     move it to `design` first; that is their plan approval. Do it only after a yes, and only if the epic is `ready`.
   - Unfinished dependencies: you can build the story but not finish it. Tell the user and ask whether to
     proceed (finish later) or do the dependencies first.
   - Over 400 lines estimated, or no acceptance criteria: say so; proceed with a sensible reading and state it
     in the PR.
2. **Understand.** Read `CLAUDE.md` and `README.md` (conventions, architecture, rules), then the code the
   story touches. Check `git status`: it must be clean and on `master`, in sync with `origin`
   (`git fetch`). If not, stop and ask. If the story is already in `implementation` or `testing`, look for an
   existing branch/PR (`git branch`, `gh pr list`) and resume it.
3. **Start.** Move the story: `$DP move ID implementation --reason "Implementation started on branch story-ID-slug"`,
   then `git switch -c story-ID-slug` (slug: a few lowercase words from the name).
4. **Implement** what the story and its acceptance criteria say, following the repo's conventions. Keep the
   change focused and about the size the estimate suggests; write tests with the code. For API changes update
   `api/openapi.yaml` and run `make gen-api`; schema changes are new numbered migrations. Do not add features
   beyond the story.
5. **Verify.** "Everything checks" means all of `${CLAUDE_SKILL_DIR}/references/verification.md` (read it): `make check`, tests for every
   acceptance criterion, deliberate-breakage checks, and a real run (browser harness for UI, real server on a
   database copy for backend). Review screenshots and fix what they reveal. After the last code change, run it all
   again. If something fails and you cannot fix it within the story, **stop**: leave the story in
   `implementation`, open no PR, and report exactly what failed.
6. **Docs.** Update `README.md` and `CLAUDE.md` where behavior or conventions changed (and the roadmap line).
7. **Commit, push, pull request**, following `${CLAUDE_SKILL_DIR}/references/shipping.md` (message and PR templates, attribution
   line). Then record it: `$DP link-pr ID <PR url>` and
   `$DP move ID testing --reason "Implemented; <n> tests and <m> browser checks pass; pull request opened"`.
8. **Merge** (unless told not to), following `${CLAUDE_SKILL_DIR}/references/shipping.md`: wait until the PR is `MERGEABLE CLEAN`,
   squash-merge and delete the branch, then verify the merge landed, `master` is in sync, and `make check`
   passes on the merged `master`. If any of that fails, do not mark the story finished; report.
9. **Finish.** `$DP move ID finished --reason "Delivered in commit <sha> (PR #<n>)"`. If the server refuses
   (for example an unfinished dependency), report its message and leave the story in `testing`. Then run
   `$DP epic-status ID`: if the epic can now be finished, **tell the user** and offer; do not finish it yourself,
   because a finished epic is final and accepts no new stories.
10. **Report** briefly: what was built, the PR link and merge commit, the checks with real numbers, decisions and
    assumptions, the story's status history, and what is unblocked next (`Required by` in `$DP show`).

## If you must stop part-way

Say where you stopped and why. The story stays in the state that is true: `implementation` while work is
unfinished, `testing` with an open PR. Do not move it forward to look tidy.
