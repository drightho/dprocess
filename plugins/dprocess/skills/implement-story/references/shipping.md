# Shipping a story: commit, pull request, merge

Use the exact attribution lines given in the session instructions for commit messages and PR descriptions
(a `Co-Authored-By:` trailer on commits, the "Generated with Claude Code" line at the end of a PR body).

## Commit

One commit on the story branch. Stage everything intended (`git add -A`, then check `git status` for strays)
and write the message to a file:

```
<Story name> (story <id>)

<Paragraph: what the user can now do, in terms of behavior, not files.>
<Paragraph: notable decisions, what the server decides vs the UI.>

- <structure: new components/modules, refactors>
- <tests and how it was verified>
- <docs updated>

<attribution trailer>
```

## Push and open the PR

```sh
git push -u origin story-<id>-<slug>
gh pr create --base master --head story-<id>-<slug> \
  --title "<Story name> (story <id>)" --body-file pr.md
```

PR body (`pr.md`):

```
## Summary
Implements story <id>, *<name>*, from the <epic> epic. <What it does, concretely, by acceptance criterion.>
<Decisions and assumptions. Anything beyond the story, and why. "No backend or API changes." if true.>

## Structure
<Where the code lives; any refactor and what protects it.>

## Test plan
- [x] `make check`: <what it covers>, <n> vitest tests, generated API types up to date
- [x] <k> deliberate breakages (<what>) were each caught by the tests. <Any that were not, and what was added.>
- [x] <m> end-to-end checks in headless Chrome against a copy of the real database: <what they cover>
<Found while reviewing screenshots / during verification: ... and how it was fixed.>

## Out of scope
<Separate stories.>

<"Generated with Claude Code" line>
```

Then record it on the server (before finishing, because finished stories freeze their PR list):

```sh
$DP link-pr <id> <pr-url>
$DP move <id> testing --reason "Implemented; <n> tests and <m> browser checks pass; pull request opened"
$DP move <id> pr_review --reason "Pull request opened for review"
```

## Merge

Wait until GitHub has computed mergeability (it reports `UNKNOWN` for a moment):

```sh
gh pr view <n> --json mergeable,mergeStateStatus --jq '.mergeable+" "+.mergeStateStatus'   # want: MERGEABLE CLEAN
```

If it is not `MERGEABLE CLEAN` (conflicts, failing required checks, blocked), stop and report; do not force it.

```sh
gh pr merge <n> --squash --delete-branch --subject "<Story name> (story <id>) (#<n>)" --body-file merge.txt
gh pr view <n> --json state,mergeCommit --jq '.state+" "+.mergeCommit.oid[0:7]'   # want: MERGED <sha>
git status -sb            # master, in sync with origin/master
make check                # on the merged master
```

`merge.txt` is a short version of the commit message body plus the attribution trailer. Squash keeps one
commit per story on `master`.

## Finish

```sh
$DP move <id> finished --reason "Delivered in commit <sha> (PR #<n>)"
$DP epic-status <id>
```

If the epic can now be finished, tell the user and ask. Do not do it yourself (final, and it stops new stories).
