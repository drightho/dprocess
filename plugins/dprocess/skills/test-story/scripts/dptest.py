#!/usr/bin/env python3
"""Talk to a DProcess server about a story under test (helper for the dprocess plugin's test-story skill).

  dptest.py show ID [--json]            story detail plus a preflight check (can it be tested now?)
  dptest.py move ID STATE [--reason R]  move the story to STATE (the server enforces the rules)
  dptest.py update ID [--description D] [--acceptance-criteria A]
                                        change fields (only the ones given; "@file" reads a file)
  dptest.py comment ID TEXT             add a comment to the story (TEXT or @file): test results, failures
  dptest.py link-pr ID URL              link a GitHub pull request to the story
  dptest.py history ID                  the story's state history
  dptest.py find TEXT                   stories whose name contains TEXT (case-insensitive); "" lists all

The server is the one saved by the init skill (see server_url), unless DPROCESS_URL is set; with
neither it is http://127.0.0.1:8080. Moves and comments are recorded with the actor "claude"
unless DPROCESS_ACTOR is set. Only the standard library is used.

The preflight in `show` is advice that mirrors the workflow rules; the server is the
authority and refuses anything the rules do not allow, with an explanation.
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request

DEFAULT_URL = "http://127.0.0.1:8080"


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
ACTOR = os.environ.get("DPROCESS_ACTOR", "claude")
TERMINAL = ("finished", "cancelled")


class ApiError(Exception):
    def __init__(self, status, detail):
        super().__init__(detail)
        self.status = status
        self.detail = detail


def call(method, path, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(API + path, data=data, method=method, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else None
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
            "Do not start a server of your own to update story status: the user's server is the one that counts."
        )


def story_ref(r):
    return f"#{r['id']} {r['name']} [{r['state']}]"


def preflight(s, epic):
    """Lines describing whether the story can be tested now: (kind, text) with kind OK, WARN or BLOCK."""
    out = []
    state = s["state"]
    if state in TERMINAL:
        out.append(("BLOCK", f"the story is {state}: finished and cancelled stories are read-only, there is nothing to test"))
    elif state == "ready_for_testing":
        out.append(("OK", "the story is in ready_for_testing: it can move to testing"))
    elif state == "testing":
        out.append(("BLOCK", "the story is already in testing: another run may be in progress; ask the user before continuing"))
    elif state == "pr_review":
        out.append(("BLOCK", "the story is already past testing (pr_review)"))
    else:
        out.append(("BLOCK", f"the story is in {state}: only a story in ready_for_testing can be tested "
                             "(draft: /dprocess:review-story, review: /dprocess:design-story, design: /dprocess:implement-story)"))
    if not s["acceptance_criteria"].strip():
        out.append(("WARN", "the story has no acceptance criteria"))
    return out


def cmd_show(args):
    s = call("GET", f"/stories/{args.id}")
    epic = call("GET", f"/epics/{s['epic_id']}")
    project = call("GET", f"/projects/{s['project_id']}")
    checks = preflight(s, epic)
    if args.json:
        print(json.dumps({"story": s, "epic": epic, "project": project, "preflight": checks}, indent=2))
        return
    print(f"Story #{s['id']}: {s['name']}  [{s['state']}]")
    print(f"Project: {project['name']} (#{project['id']})   Epic: {epic['name']} (#{epic['id']}) [{epic['state']}]")
    est = "none" if s["estimate_loc"] is None else f"{s['estimate_loc']} LOC"
    print(f"Estimate: {est}   Assignee: {s['assignee'] or 'unassigned'}   Tags: {', '.join(s['tags']) or 'none'}")
    print(f"Allowed moves now: {', '.join(s['allowed_transitions']) or 'none'}")
    print("\nDescription:\n" + (s["description"].strip() or "(none)"))
    print("\nAcceptance criteria:\n" + (s["acceptance_criteria"].strip() or "(none)"))
    print("\nDepends on: " + ("; ".join(story_ref(d) for d in s["depends_on"]) or "nothing"))
    print("Required by: " + ("; ".join(story_ref(d) for d in s["dependents"]) or "nothing"))
    print("Pull requests: " + (", ".join(p["github_url"] for p in s["pull_requests"]) or "none"))
    print("Issues: " + (", ".join(i["github_url"] for i in s["issues"]) or "none"))
    print("\nPreflight:")
    for kind, text in checks:
        print(f"  {kind:5} {text}")
    if any(k == "BLOCK" for k, _ in checks):
        print("\nResult: BLOCKED - do not start; tell the user why.")
    elif any(k == "WARN" for k, _ in checks):
        print("\nResult: can proceed, but read the warnings and decide (ask the user where it says so).")
    else:
        print("\nResult: ready.")


def cmd_move(args):
    body = {"to": args.state, "actor": ACTOR}
    if args.reason:
        body["reason"] = args.reason
    try:
        s = call("POST", f"/stories/{args.id}/transition", body)
    except ApiError as e:
        print(f"REFUSED ({e.status}): {e.detail}")
        sys.exit(1)
    print(f"story #{s['id']} -> {s['state']}   (next possible: {', '.join(s['allowed_transitions']) or 'none'})")


def cmd_link_pr(args):
    try:
        p = call("POST", f"/stories/{args.id}/pull-requests", {"github_url": args.url})
    except ApiError as e:
        print(f"REFUSED ({e.status}): {e.detail}")
        sys.exit(1)
    print(f"linked {p['github_url']} to story #{args.id}")


def text(v):
    """A value, or the contents of the file when it starts with "@"."""
    if v is not None and v.startswith("@"):
        with open(v[1:]) as f:
            return f.read()
    return v


def cmd_update(args):
    s = call("GET", f"/stories/{args.id}")
    if s["state"] in TERMINAL:
        sys.exit(f"Story #{args.id} is {s['state']}: finished and cancelled stories are read-only.")
    body = {}
    for key in ("description", "acceptance_criteria"):
        v = text(getattr(args, key))
        if v is not None:
            body[key] = v
    if not body:
        sys.exit("Nothing to update: give at least one field.")
    call("PATCH", f"/stories/{args.id}", body)
    print(f"updated story #{args.id}: {', '.join(body)}")


def cmd_comment(args):
    call("POST", f"/stories/{args.id}/comments", {"author": ACTOR, "body": text(args.text)})
    print(f"comment added to story #{args.id}")


def cmd_history(args):
    for h in call("GET", f"/stories/{args.id}/history"):
        print(f"{h['at']}  {h['from_state']:>14} -> {h['to_state']:<14} {h['actor'] or '-'}: {h['reason']}")


def cmd_find(args):
    needle = args.text.lower()
    found = 0
    for project in call("GET", "/projects"):
        epics = {e["id"]: e for e in call("GET", f"/projects/{project['id']}/epics")}
        for s in call("GET", f"/projects/{project['id']}/stories"):
            if needle in s["name"].lower():
                found += 1
                e = epics.get(s["epic_id"], {"name": "?", "state": "?"})
                print(f"#{s['id']:<4} {s['state']:<14} {s['name']}   (epic: {e['name']} [{e['state']}], project: {project['name']})")
    if not found:
        print("no story matches")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("show"); a.add_argument("id", type=int); a.add_argument("--json", action="store_true"); a.set_defaults(fn=cmd_show)
    a = sub.add_parser("move"); a.add_argument("id", type=int); a.add_argument("state"); a.add_argument("--reason"); a.set_defaults(fn=cmd_move)
    a = sub.add_parser("link-pr"); a.add_argument("id", type=int); a.add_argument("url"); a.set_defaults(fn=cmd_link_pr)
    a = sub.add_parser("comment"); a.add_argument("id", type=int); a.add_argument("text"); a.set_defaults(fn=cmd_comment)
    a = sub.add_parser("history"); a.add_argument("id", type=int); a.set_defaults(fn=cmd_history)
    a = sub.add_parser("find"); a.add_argument("text"); a.set_defaults(fn=cmd_find)
    a = sub.add_parser("update"); a.add_argument("id", type=int)
    a.add_argument("--description"); a.add_argument("--acceptance-criteria", dest="acceptance_criteria"); a.set_defaults(fn=cmd_update)
    args = p.parse_args()
    try:
        args.fn(args)
    except ApiError as e:
        sys.exit(f"DProcess answered {e.status}: {e.detail}")


if __name__ == "__main__":
    main()
