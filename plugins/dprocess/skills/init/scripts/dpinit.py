#!/usr/bin/env python3
"""Configure which DProcess server the dprocess plugin talks to (helper for the init skill).

  dpinit.py show            the URL in use, where it comes from, and whether the server answers
  dpinit.py check URL       is there a DProcess server at URL? (changes nothing)
  dpinit.py set URL         check URL, then save it as the plugin's server

The URL is saved in a small JSON file outside the plugin (a plugin's own folder is replaced on update):
$DPROCESS_CONFIG, else $XDG_CONFIG_HOME/dprocess/config.json, else ~/.config/dprocess/config.json.
The skills' helper (dpstory.py) reads the same file. The environment variable DPROCESS_URL, if set,
still wins over the file. Only the standard library is used.
"""
import json
import os
import sys
import urllib.error
import urllib.request
from urllib.parse import urlparse

DEFAULT_URL = "http://127.0.0.1:8080"


def config_path():
    if os.environ.get("DPROCESS_CONFIG"):
        return os.environ["DPROCESS_CONFIG"]
    base = os.environ.get("XDG_CONFIG_HOME") or os.path.join(os.path.expanduser("~"), ".config")
    return os.path.join(base, "dprocess", "config.json")


def saved_url():
    try:
        with open(config_path()) as f:
            return str(json.load(f).get("url", "")).strip() or None
    except (OSError, ValueError, AttributeError):
        return None


def normalize(url):
    """http(s)://host[:port] without a trailing slash or /api/v1; exits with a message if it is not a URL."""
    u = url.strip().rstrip("/")
    if u.endswith("/api/v1"):
        u = u[: -len("/api/v1")].rstrip("/")
    p = urlparse(u)
    if p.scheme not in ("http", "https") or not p.netloc or p.query or p.fragment:
        sys.exit(f"'{url}' is not a server URL: expected something like {DEFAULT_URL}")
    return u


def check(url):
    """Returns (ok, message): does a DProcess server answer GET /api/v1/health at url?"""
    try:
        with urllib.request.urlopen(url + "/api/v1/health", timeout=5) as resp:
            body = json.loads(resp.read() or b"{}")
        if body.get("status") == "ok":
            return True, f"a DProcess server answers at {url}"
        return False, f"{url} answered, but not like a healthy DProcess server: {body}"
    except urllib.error.HTTPError as e:
        return False, f"{url} answered HTTP {e.code} for /api/v1/health: that is not a DProcess server (or it is unhealthy)"
    except (urllib.error.URLError, OSError, ValueError) as e:
        return False, f"cannot reach {url} ({getattr(e, 'reason', e)})"


def main(argv):
    cmd = argv[1] if len(argv) > 1 else "show"
    if cmd == "show":
        env, saved = os.environ.get("DPROCESS_URL"), saved_url()
        url, src = (env, "the DPROCESS_URL environment variable") if env else (saved, f"{config_path()}") if saved else (DEFAULT_URL, "the built-in default (run /dprocess:init to change it)")
        url = url.rstrip("/")
        ok, msg = check(url)
        print(f"DProcess server: {url}\nfrom: {src}\n{'OK' if ok else 'PROBLEM'}: {msg}")
        return 0 if ok else 1
    if cmd in ("check", "set") and len(argv) == 3:
        url = normalize(argv[2])
        ok, msg = check(url)
        print(("OK: " if ok else "PROBLEM: ") + msg)
        if cmd == "check":
            return 0 if ok else 1
        if not ok:
            print("Not saved. Pass the right address, or start the server first.")
            return 1
        path = config_path()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            json.dump({"url": url}, f, indent=2)
            f.write("\n")
        print(f"Saved {url} in {path}")
        if os.environ.get("DPROCESS_URL"):
            print(f"Note: DPROCESS_URL={os.environ['DPROCESS_URL']} is set in the environment and takes precedence over the saved URL.")
        return 0
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
