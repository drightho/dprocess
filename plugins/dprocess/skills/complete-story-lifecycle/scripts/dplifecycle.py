#!/usr/bin/env python3
"""Look up a story on a DProcess server and say which skill moves it on (helper for the dprocess plugin's complete-story-lifecycle skill).

  dplifecycle.py next ID [--json]   the story's state, its epic, and the skill to run next (or why to stop)
  dplifecycle.py plan ID [ID ...]   the order to complete several stories in: unfinished dependencies first (also ones not
                                    listed); exits 2 on a circular dependency, 3 on a cancelled dependency
  dplifecycle.py history ID         the story's state history
  dplifecycle.py find TEXT          stories whose name contains TEXT (case-insensitive); "" lists all

The server is the one saved by the init skill, unless DPROCESS_URL is set; with neither it is
http://127.0.0.1:8080. It only reads: the stage skills change the story. Standard library only.

`next` is advice that mirrors the workflow rules; the server is the authority.
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request

DEFAULT_URL = "http://127.0.0.1:8080"
TERMINAL = ("finished", "cancelled")
# state -> (skill that moves the story on, state it normally leaves it in)
STAGES = {
    "draft": ("review-story", "review"),
    "review": ("design-story", "design"),
    "design": ("implement-story", "ready_for_testing"),
    "ready_for_testing": ("test-story", "pr_review"),
    "pr_review": ("review-pr", "finished"),
}
# states that a skill run is in the middle of: do not start another run without the user
BUSY = ("implementation", "testing")


def server_url():
    """DPROCESS_URL, else the URL saved by `/dprocess:init` (same file as the init skill's dpinit.py), else the default."""
    if os.environ.get("DPROCESS_URL"):
        return os.environ["DPROCESS_URL"].rstrip("/")
    path = os.environ.get("DPROCESS_CONFIG") or os.path.join(
        os.environ.get("XDG_CONFIG_HOME") or os.path.join(os.path.expanduser("~"), ".config"), "dprocess", "config.json")
    try:
        with open(path) as f:
            saved = str(json.load(f).get("url", "")).strip()
        if saved:
            return saved.rstrip("/")
    except (OSError, ValueError, AttributeError):
        pass
    return DEFAULT_URL


BASE = server_url()
API = BASE + "/api/v1"


class ApiError(Exception):
    def __init__(self, status, detail):
        super().__init__(detail)
        self.status = status
        self.detail = detail


def call(path):
    try:
        with urllib.request.urlopen(urllib.request.Request(API + path), timeout=15) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        raw = e.read().decode(errors="replace")
        try:
            detail = json.loads(raw).get("detail") or raw
        except ValueError:
            detail = raw
        raise ApiError(e.code, detail)
    except urllib.error.URLError as e:
        sys.exit(
            f"Cannot reach the DProcess server at {BASE} ({e.reason}).\n"
            "Ask the user to start it, or to run /dprocess:init to give you its address. "
            "Do not start a server of your own: the user's server is the one that counts."
        )


def decide(s, epic):
    """(verdict, text): verdict is RUN (text = skill), DONE, or STOP (text = why)."""
    state = s["state"]
    if state in TERMINAL:
        return "DONE", f"the story is {state}"
    if state in BUSY:
        return "STOP", f"the story is in {state}: a skill run may be in progress or was interrupted; ask the user how to continue"
    skill, _ = STAGES[state]
    if state in ("review", "design", "ready_for_testing", "pr_review") and epic["state"] != "ready":
        # review -> design needs the epic ready; the later stages only exist once it was
        return "STOP", f"epic #{epic['id']} is {epic['state']}, not ready: the story cannot leave {state} until the user moves the epic"
    if state == "draft" and epic["state"] not in ("review", "ready"):
        return "STOP", f"epic #{epic['id']} is {epic['state']}: the story cannot move to review until the epic is in review or ready (the user decides that)"
    if state == "pr_review" and not s["pull_requests"]:
        return "STOP", "the story is in pr_review without a pull request link; ask the user"
    return "RUN", skill


def cmd_next(args):
    s = call(f"/stories/{args.id}")
    epic = call(f"/epics/{s['epic_id']}")
    verdict, text = decide(s, epic)
    if args.json:
        print(json.dumps({"id": s["id"], "name": s["name"], "state": s["state"], "epic": {"id": epic["id"], "state": epic["state"]},
                          "verdict": verdict, "detail": text}))
        return
    print(f"Story #{s['id']}: {s['name']}  [{s['state']}]   Epic #{epic['id']} {epic['name']} [{epic['state']}]")
    print(f"Pull requests: {', '.join(p['github_url'] for p in s['pull_requests']) or 'none'}")
    print(f"Depends on: {'; '.join(f'#{d['id']} [{d['state']}]' for d in s['depends_on']) or 'nothing'}")
    if verdict == "RUN":
        print(f"NEXT: /dprocess:{text}  (normally leaves the story in {STAGES[s['state']][1]})")
    elif verdict == "DONE":
        print(f"DONE: {text}; nothing to do")
    else:
        print(f"STOP: {text}")


def cmd_plan(args):
    """Depth-first topological sort over `depends_on`, following only unfinished stories."""
    stories, order, state = {}, [], {}  # state: 1 = on the current path, 2 = done
    listed = set(args.ids)

    def get(i):
        if i not in stories:
            stories[i] = call(f"/stories/{i}")
        return stories[i]

    def visit(i, path):
        if state.get(i) == 2:
            return
        if state.get(i) == 1:
            cycle = path[path.index(i):] + [i]
            print("CYCLE: circular dependency " + " -> ".join(f"#{n}" for n in cycle) + "; stop and ask the user")
            sys.exit(2)
        state[i] = 1
        s = get(i)
        for d in sorted(s["depends_on"], key=lambda d: d["id"]):
            if d["state"] == "cancelled":
                print(f"BLOCKED: #{i} depends on #{d['id']} {d['name']}, which is cancelled: it can never finish "
                      "until the dependency is removed; stop and ask the user")
                sys.exit(3)
            if d["state"] != "finished":
                visit(d["id"], path + [i])
        state[i] = 2
        if s["state"] not in TERMINAL:
            order.append(i)

    for i in args.ids:
        visit(i, [])
    for i in order:
        s = stories[i]
        deps = ", ".join(f"#{d['id']}" for d in s["depends_on"] if d["state"] != "finished") or "-"
        extra = "" if i in listed else "   (not listed: a dependency)"
        print(f"#{i:<4} {s['state']:<17} waits for {deps:<12} {s['name']}{extra}")
    if not order:
        print("DONE: every listed story is already finished or cancelled")


def cmd_history(args):
    for h in call(f"/stories/{args.id}/history"):
        print(f"{h['at']}  {h['from_state']:>14} -> {h['to_state']:<14} {h['actor'] or '-'}: {h['reason']}")


def cmd_find(args):
    needle = args.text.lower()
    found = 0
    for project in call("/projects"):
        epics = {e["id"]: e for e in call(f"/projects/{project['id']}/epics")}
        for s in call(f"/projects/{project['id']}/stories"):
            if needle in s["name"].lower():
                found += 1
                e = epics.get(s["epic_id"], {"name": "?", "state": "?"})
                print(f"#{s['id']:<4} {s['state']:<14} {s['name']}   (epic: {e['name']} [{e['state']}], project: {project['name']})")
    if not found:
        print("no story matches")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("next"); a.add_argument("id", type=int); a.add_argument("--json", action="store_true"); a.set_defaults(fn=cmd_next)
    a = sub.add_parser("plan"); a.add_argument("ids", type=int, nargs="+"); a.set_defaults(fn=cmd_plan)
    a = sub.add_parser("history"); a.add_argument("id", type=int); a.set_defaults(fn=cmd_history)
    a = sub.add_parser("find"); a.add_argument("text"); a.set_defaults(fn=cmd_find)
    args = p.parse_args()
    try:
        args.fn(args)
    except ApiError as e:
        sys.exit(f"DProcess answered {e.status}: {e.detail}")


if __name__ == "__main__":
    main()
