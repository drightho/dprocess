#!/usr/bin/env python3
"""Talk to a DProcess server about a story under review (helper for the dprocess plugin's review-story skill).

  dpreview.py show ID                    the story: fields, epic, dependencies, state
  dpreview.py update ID [--name N] [--description D] [--acceptance-criteria A]
                        [--assignee W] [--estimate-loc N]
                                         change fields (only the ones given); draft stories only
  dpreview.py move-to-review ID [--reason R]
                                         move a draft story to review (the server enforces the rules)

The server is DPROCESS_URL, else the one saved by the init skill, else http://127.0.0.1:8080
(same precedence as the implement-story helper). Moves are recorded with the actor "claude"
unless DPROCESS_ACTOR is set. Only the standard library is used.
Any text option accepts "@path" to read the value from a file, which is easier for long text.
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
    for w in s.get("warnings") or []:
        print(f"Warning: {w}")


def cmd_update(args):
    s = call("GET", f"/stories/{args.id}")
    if s["state"] != "draft":
        sys.exit(f"Story #{args.id} is {s['state']}, not draft: this skill only changes draft stories.")
    body = {}
    for flag, key in (("name", "name"), ("description", "description"),
                      ("acceptance_criteria", "acceptance_criteria"), ("assignee", "assignee")):
        v = text(getattr(args, flag))
        if v is not None:
            body[key] = v
    if args.estimate_loc is not None:
        body["estimate_loc"] = args.estimate_loc
    if not body:
        sys.exit("Nothing to update: give at least one field.")
    call("PATCH", f"/stories/{args.id}", body)
    print(f"Updated story #{args.id}: {', '.join(body)}")
    cmd_show(args)


def cmd_move(args):
    s = call("GET", f"/stories/{args.id}")
    if s["state"] != "draft":
        sys.exit(f"Story #{args.id} is {s['state']}, not draft: this skill only moves draft stories to review.")
    body = {"to": "review", "actor": ACTOR}
    if args.reason:
        body["reason"] = args.reason
    r = call("POST", f"/stories/{args.id}/transition", body)
    print(f"Story #{args.id} is now {r.get('state', 'review')}")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("show"); a.add_argument("id", type=int); a.set_defaults(fn=cmd_show)
    a = sub.add_parser("update"); a.add_argument("id", type=int)
    a.add_argument("--name"); a.add_argument("--description"); a.add_argument("--acceptance-criteria", dest="acceptance_criteria")
    a.add_argument("--assignee"); a.add_argument("--estimate-loc", dest="estimate_loc", type=int); a.set_defaults(fn=cmd_update)
    a = sub.add_parser("move-to-review"); a.add_argument("id", type=int); a.add_argument("--reason"); a.set_defaults(fn=cmd_move)
    args = p.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
