---
name: review-pr
description: Review the pull request of a story that is in pr_review, merge it if it implements the story, otherwise send the story back to design. Use when the user says "review the PR of story 90", "review pr for story 90" or "merge story 90" (or /review-pr 90). Runs only on stories in the pr_review state that have a pull request link. Starts an interviewee subagent (same configuration as you, high reasoning effort) and an interviewer subagent (fresh-eyes, low effort). The interviewer compares the PR with the story on the DProcess server and questions the interviewee about every conflict. If both approve, the PR is merged and the story moves to finished; if they cannot agree, the interviewee documents the findings on the PR and the story moves back to design.
argument-hint: <story-id or name>
---

# Review the pull request of a DProcess story

`/dprocess:test-story` leaves a story in `pr_review` with a pull request linked to it. This skill decides whether that
pull request really implements the story. You (the parent) orchestrate and relay; the subagents cannot message each other.

| Role | Agent | Effort | Does |
|------|-------|--------|------|
| **Interviewee** | `general-purpose`, no `model` override (same configuration as you) | `high` | Knows the project and the design decisions. Answers the interviewer's questions as well as it can, checks the PR itself, and says whether it approves. On a failed review it documents the findings on the PR |
| **Interviewer** | `dprocess:fresh-eyes` (no long-term memory) | `low` | Reads the story on the server, then the PR (description, diff, checks), and asks the interviewee about everything in the PR that conflicts with the story. Changes nothing |

Both can reach the DProcess server through the helper below, and `gh` for the pull request. The story id comes from the
user's message (or `$ARGUMENTS`); if they gave a name, find it with `$DP find`.

## The helper

The files of this skill live in `${CLAUDE_SKILL_DIR}`. If the path below still shows a literal
`${CLAUDE_SKILL_DIR}`, use the folder holding this `SKILL.md`. Give both subagents this exact command line.

```sh
DP="python3 ${CLAUDE_SKILL_DIR}/scripts/dprpreview.py"
$DP find "landing"                     # find a story by name
$DP show 90                            # detail, pull request links and preflight (read it fully)
$DP comment 90 "text or @file"         # record the review result on the story
$DP move 90 finished --reason "..."    # the server enforces the rules and explains refusals
$DP history 90
```

The server is `DPROCESS_URL`, else the one saved by `/dprocess:init`, else `http://127.0.0.1:8080`. If it is
unreachable, tell the user (suggest `/dprocess:init`) and stop. Never start a server of your own and never edit
the database file. Never cancel the story or skip a state; the only moves this skill makes are `pr_review -> finished`
(step 6) and `pr_review -> design` (step 7).

## Steps

1. **Preflight.** Run `$DP show ID` and read it all. A `BLOCK` line stops you: the story must be in `pr_review` and have
   a pull request link (any other state: say which skill to run instead; no link: `/dprocess:test-story` links it).
   With several pull requests, ask the user which one (AskUserQuestion). Check `gh auth status` and that
   `gh pr view <url> --json state,mergeable,baseRefName,headRefName` shows the PR `OPEN`. A closed or already merged PR
   is not reviewed: stop and tell the user. Change nothing so far.
2. **Scratch branch.** The work directory must be on the story's branch `scratch/storyID` (for story 80:
   `scratch/story80`), so that the agents read the code as the PR has it. `git status` must be clean (otherwise stop and
   ask) and `git fetch` done. The branch is local or on `origin`; if neither exists, stop and tell the user. Then:
   ```sh
   git switch scratch/storyID            # or: git switch -c scratch/storyID --track origin/scratch/storyID
   git pull --ff-only                    # only when it tracks origin
   ```
   Confirm that `git branch --show-current` prints it and that it is the PR's head branch (`headRefName` from step 1).
   If the PR comes from another branch, stop and ask the user which to review. Remember the branch you came from.
3. **Start the interviewee** with the Agent tool: `subagent_type: "general-purpose"`, `effort: "high"`, **no `model`
   override**. Its prompt: the story id, the PR URL and the helper line; its role (it speaks for the design and the
   implementation: answer the interviewer's questions from the story, the repository, `CLAUDE.md`, `README.md`, the
   OpenAPI spec, the PR and its memory; where it does not know or the PR really does not do what the story asks, say so
   plainly instead of defending it); and the rules: **do not merge, comment on the PR or change the story yet**, and
   do not check the PR out in the user's working tree (use `gh pr diff` / `gh pr view`, or a separate worktree).
   Ask it to reply "ready" once it has read the story and the PR.
4. **Start the interviewer** with the Agent tool: `subagent_type: "dprocess:fresh-eyes"`, `effort: "low"`, **no `model`
   override**. Its prompt: the story id, the PR URL and the helper line; its role: read the story first (description,
   acceptance criteria, dependencies; `$DP show ID`), then the PR (`gh pr view --comments`, `gh pr diff`,
   `gh pr checks`) and compare them. Look for: acceptance criteria the PR does not cover, behavior the story does not ask
   for (scope creep), conflicts with the story's wording or with the rules in `CLAUDE.md`, spec/types out of step,
   missing tests, failing checks. It changes nothing (no comments, no merge, no story changes). Reply format: either
   `QUESTIONS:` with a numbered list (each naming the story text and the PR code that conflict), or `APPROVE:` with a
   short summary of what it verified. Ask only what the story, the PR or the repository cannot answer by itself; no padding.
5. **Run the interview.** Relay with SendMessage to the agent ids you got back:
   - Pass the interviewer's questions verbatim to the interviewee and its answers verbatim back to the interviewer,
     asking whether the answers settle each point (`QUESTIONS:` again, or `APPROVE:`).
   - When the interviewer says `APPROVE:`, send its summary to the interviewee and ask for its own verdict:
     `APPROVE:` or `REJECT:` with the findings. The interviewee must have checked the PR against the story itself, not
     just agreed. If it rejects, relay the findings to the interviewer and continue.
   - A point that is settled by an answer must be settled by evidence (a file and line in the PR, a test, a rule), not by assertion.
   - The review ends when **both** have said `APPROVE:`, or when they cannot agree: after 5 rounds without
     convergence, or when one holds a `REJECT:` after the other has seen its reasons. A question only the user can
     answer (an unclear requirement) goes to the user (AskUserQuestion) and the answer back to both; if the user cannot
     settle it, treat it as not agreed.
6. **Both approve: approve and merge.** In this order:
   1. **Re-check** `gh pr view <url> --json state,mergeable,statusCheckRollup`. If checks fail or the PR is not
      mergeable, that is a finding: go to step 7 without approving (conflicts to resolve are the implementer's job,
      not this skill's).
   2. **Approve the PR on GitHub** with a summary built from both sides: what the interviewee (the reviewee) confirmed it
      checked and the evidence it gave, what the interviewer (the reviewer) verified, and the questions raised and how
      they were settled. Write it to a file and run `gh pr review <url> --approve --body-file <file>`. If GitHub refuses
      the approval (for example you cannot approve your own PR), post the same text with
      `gh pr comment <url> --body-file <file>` and say so in the report. If even that fails, report the message and
      stop with the story in `pr_review`.
   3. **Merge** it, using the repository's style (the history shows squash merges): `gh pr merge <url> --squash`. Do
      not use `--admin` and do not bypass protections. If the merge is refused, report the message, leave the story in
      `pr_review` and stop.
   4. **After a successful merge:**
      - `$DP comment ID "<text>"`: the PR URL, the merge commit, and the review result (rounds, questions raised, how they were settled).
      - `$DP move ID finished --reason "Pull request <url> reviewed and merged"`. If the server refuses (for example a
        dependency is not finished), report its message, leave the story in `pr_review` and tell the user the PR is
        already merged.
      - Switch back to the branch you came from (usually `master`) and, if the tree is clean, `git pull --ff-only`.
7. **No agreement: send it back.** Do **not** merge. Tell the interviewee to document the findings:
   - Post them on the pull request with `gh pr review <url> --request-changes --body-file <file>` (or `gh pr comment`
     when `--request-changes` is not allowed, for example on your own PR). The text lists, per finding: the story
     requirement (quote it), what the PR does instead (file and line), what the interviewer and the interviewee each concluded,
     and what has to change. It ends with what was settled in the interview so nobody redoes it.
   - Record the same on the story: `$DP comment ID @file` (include the PR URL).
   Then `$DP move ID design --reason "PR review failed: <one line>, findings on <url>"`. If the server refuses, report its
   message and leave the story in `pr_review`. Stay on `scratch/storyID` (the implementer continues there); never close the PR or delete the branch.
8. **Report** briefly: the PR and story, the number of rounds, the main questions and how they were settled, the verdict
   of each side, and the outcome: merged and `finished` (with the merge commit), or findings posted and the story back in
   `design`, or stopped (and why). When the story went back to design, say that `/dprocess:design-story` has already run
   for it and the next step is `/dprocess:implement-story` once the findings are addressed.
