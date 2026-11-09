---
name: review-story
description: Review a draft story from the DProcess project plan until its scope and requirements are clear, then sharpen it and move it to review. Use when the user says "review story 27", "refine story 27", "is story 27 clear enough" or "interview me about story 27" (or /review-story 27). Runs only on stories in the draft state. Starts an interviewee subagent (same configuration as you, high reasoning effort) and an interviewer subagent (fresh-eyes) that question each other until both are clear; the interviewee then updates the story on the DProcess server and moves it to review.
argument-hint: <story-id or name>
---

# Review a draft DProcess story

A draft story is only a sketch. This skill tests whether a reader with no project memory can
tell what to build, and fixes the story where they cannot. Two subagents do the work and you
(the parent) orchestrate:

- **Interviewee**: same configuration as you (same model, tools and memory), only the reasoning
  effort is `high`. It knows the project and answers the questions. It is the only one that writes to the story.
- **Interviewer**: the `dprocess:fresh-eyes` agent (no long-term memory). It reads the story with fresh eyes
  and asks about whatever is unclear.

Both can reach the DProcess server through the helper below. The story id comes from the user's message
(or `$ARGUMENTS`); if they gave a name, find the id first with `dpstory.py find` from the
implement-story skill, or ask.

## The helper

The files of this skill live in `${CLAUDE_SKILL_DIR}`. If the path below still shows a literal
`${CLAUDE_SKILL_DIR}`, use the folder holding this `SKILL.md`. Give both subagents this exact command line.

```sh
DP="python3 ${CLAUDE_SKILL_DIR}/scripts/dpreview.py"
$DP show 27                                   # fields, epic, dependencies
$DP update 27 --description @/tmp/d.md --acceptance-criteria @/tmp/ac.md   # draft only; "@file" reads a file
$DP move-to-review 27 --reason "..."          # draft -> review
```

The server is `DPROCESS_URL`, else the one saved by `/dprocess:init`, else `http://127.0.0.1:8080`. If it is
unreachable, tell the user (suggest `/dprocess:init`) and stop. Never start a server of your own and never
edit the database file.

## Steps

1. **Check.** Run `$DP show ID`. If the story is not in `draft`, stop and say so: this skill only reviews drafts
   (a story already in review or later has been cleared, and finished/cancelled ones are read-only). Change nothing.
2. **Start the interviewee** with the Agent tool: `subagent_type: "general-purpose"`, `effort: "high"`, **no `model`
   override** (so it inherits yours). Its prompt: the story id and the helper command line; its role (answer the
   interviewer's questions from what it knows about this project: the repository, `CLAUDE.md`, `README.md`, the OpenAPI
   spec, the other stories and epics on the server, its memory; where it does not know, say so instead of inventing
   an answer, and mark the point as an open question for the user); and the rule **not to change the story yet**.
   Ask it to reply "ready" once it has read the story.
3. **Start the interviewer** with the Agent tool: `subagent_type: "dprocess:fresh-eyes"`, `effort: "low"`, **no `model`
   override** (so it inherits yours). Its prompt: the story id
   and helper command line; its role (read the story and, where it helps, the repository docs; judge whether scope and
   requirements are clear enough to implement without guessing: what is in and out of scope, behavior, edge
   cases and errors, acceptance criteria that can be tested, dependencies, a realistic size of at most 400 lines;
   it must **not** change the story); and the reply format: either `QUESTIONS:` with a numbered list, or
   `CLEAR:` with a one-paragraph summary of the scope as it now understands it. Ask only questions the story
   or the repository cannot answer; no padding.
4. **Run the interview.** Subagents cannot message each other, so you relay (SendMessage to the agent ids you got back):
   - The interviewer answers with `QUESTIONS:` or `CLEAR:`.
   - Pass the questions verbatim to the interviewee; pass its answers verbatim back to the interviewer, and ask
     whether it is now clear (`QUESTIONS:` again, or `CLEAR:`).
   - When the interviewer says `CLEAR:`, send its summary to the interviewee and ask whether it agrees that this
     is the scope and the requirements, or what is missing. If it names a gap or disagrees, relay that to the
     interviewer and continue. The interview ends only when **both** say they are clear.
   - Stop after 6 rounds that do not converge, or when the interviewee reports questions only the user can answer.
     Then ask the user those questions (AskUserQuestion), feed the answers back and continue; if the user cannot
     settle them, leave the story in `draft` and report the open points. Do not paper over a gap.
5. **Update the story.** Tell the interviewee to write the outcome to the server: improve the description (scope,
   out of scope, decisions taken in the discussion), rewrite the acceptance criteria as testable statements, correct
   the estimate if the discussion changed it, and keep the name unless it is misleading. It should not drop
   information already in the story, and it must not invent requirements that nobody confirmed. Then it moves the story:
   `$DP move-to-review ID --reason "Reviewed: <one line>"`. It reports what changed.
   If the server refuses the move (the epic must be `review` or `ready` for a story to enter `review`), the
   story stays `draft` with its improved text. Report the server's message; never move the epic yourself.
6. **Verify and report.** Run `$DP show ID` yourself and confirm the text is saved and the state is what you
   expect. Report briefly: the number of rounds, the main questions and what was decided, what changed in the story,
   its new state, and anything left open for the user.
