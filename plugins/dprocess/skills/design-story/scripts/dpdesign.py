#!/usr/bin/env python3
"""Talk to a DProcess server about a story being designed (helper for the dprocess plugin's design-story skill).

  dpdesign.py show ID                    the story: fields, epic, dependencies, state
  dpdesign.py update ID [--description D] [--acceptance-criteria A] [--estimate-loc N]
                                         change fields (only the ones given; "@file" reads a file); not for finished/cancelled
  dpdesign.py comment ID TEXT            add a comment to the story (TEXT or @file); open questions and decisions
  dpdesign.py move-to-design ID [--reason R]
                                         review -> design (the server enforces the rules)

The server is DPROCESS_URL, else the one saved by the init skill, else http://127.0.0.1:8080
(same precedence as the other dprocess helpers). Moves and comments are recorded with the actor
"claude" unless DPROCESS_ACTOR is set. Only the standard library is used.
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request

DEFAULT_URL = "http://127.0.0.1:8080"


def server_url():
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
        sys.exit(f"The server refused ({e.code}): {detail}")
    except urllib.error.URLError as e:
        sys.exit(
            f"Cannot reach the DProcess server at {BASE} ({e.reason}).\n"
            "Ask the user to start it, or to run /dprocess:init to give you its address. "
            "Do not start a server of your own: the user's server is the one that counts."
        )


def text(value):
    if value is not None and value.startswith("@"):
        with open(value[1:]) as f:
            return f.read().rstrip("\n")
    return value


def cmd_show(args):
    s = call("GET", f"/stories/{args.id}")
    epic = call("GET", f"/epics/{s['epic_id']}")
    print(f"Story #{s['id']}: {s['name']}  [{s['state']}]")
    print(f"Epic #{epic['id']}: {epic['name']}  [{epic['state']}]   project #{s['project_id']}")
    print(f"Assignee: {s['assignee'] or '-'}   Estimate: {s['estimate_loc'] if s['estimate_loc'] is not None else '-'} lines")
    print(f"Tags: {', '.join(s.get('tags') or []) or '-'}")
    print("\nDescription:\n" + (s["description"].strip() or "(empty)"))
    print("\nAcceptance criteria:\n" + (s["acceptance_criteria"].strip() or "(empty)"))
    for label, key in (("Depends on", "depends_on"), ("Required by", "dependents")):
        rows = s.get(key) or []
        print(f"\n{label}: " + ("; ".join(f"#{r['id']} {r['name']} [{r['state']}]" for r in rows) or "-"))


def cmd_update(args):
    s = call("GET", f"/stories/{args.id}")
    if s["state"] in ("finished", "cancelled"):
        sys.exit(f"Story #{args.id} is {s['state']}: finished and cancelled stories are read-only.")
    body = {}
    for key in ("description", "acceptance_criteria"):
        v = text(getattr(args, key))
        if v is not None:
            body[key] = v
    if args.estimate_loc is not None:
        body["estimate_loc"] = args.estimate_loc
    if not body:
        sys.exit("Nothing to update: give at least one field.")
    call("PATCH", f"/stories/{args.id}", body)
    print(f"Updated story #{args.id}: {', '.join(body)}")
    cmd_show(args)


def cmd_comment(args):
    call("POST", f"/stories/{args.id}/comments", {"author": ACTOR, "body": text(args.text)})
    print(f"Comment added to story #{args.id}")


def cmd_move(args):
    s = call("GET", f"/stories/{args.id}")
    if s["state"] != "review":
        sys.exit(f"Story #{args.id} is {s['state']}, not review: this skill only moves a story from review.")
    reason = args.reason or "Design agreed"
    r = call("POST", f"/stories/{args.id}/transition", {"to": "design", "actor": ACTOR, "reason": reason})
    print(f"Story #{args.id} is now {r.get('state', 'design')}")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("show"); a.add_argument("id", type=int); a.set_defaults(fn=cmd_show)
    a = sub.add_parser("update"); a.add_argument("id", type=int)
    a.add_argument("--description"); a.add_argument("--acceptance-criteria", dest="acceptance_criteria")
    a.add_argument("--estimate-loc", dest="estimate_loc", type=int); a.set_defaults(fn=cmd_update)
    a = sub.add_parser("comment"); a.add_argument("id", type=int); a.add_argument("text"); a.set_defaults(fn=cmd_comment)
    a = sub.add_parser("move-to-design"); a.add_argument("id", type=int); a.add_argument("--reason"); a.set_defaults(fn=cmd_move)
    args = p.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
