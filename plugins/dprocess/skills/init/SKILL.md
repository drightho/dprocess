---
name: init
description: Set up the dprocess plugin by telling it where the DProcess server is. Use when the user says "set up dprocess", "init dprocess", "configure the DProcess server URL", "change the DProcess port", or runs /dprocess:init, and when another dprocess skill reports that it cannot reach the server. Asks for the server URL, verifies a DProcess server answers there, and saves it so the rest of the plugin (implement-story and its helper) uses it.
argument-hint: [server URL]
---

# Set up the dprocess plugin

The plugin's other skills read story status from, and write it to, a DProcess server. This skill tells them
which one. The URL is saved in `~/.config/dprocess/config.json` (or `$XDG_CONFIG_HOME/dprocess/config.json`,
or the file named by `$DPROCESS_CONFIG`): outside the plugin, so a plugin update does not lose it.

```sh
INIT="python3 ${CLAUDE_SKILL_DIR}/scripts/dpinit.py"
$INIT show           # URL in use, where it comes from, whether the server answers
$INIT check URL      # is there a DProcess server at URL? changes nothing
$INIT set URL        # check it, then save it
```

Run scripts through their interpreter (`python3`); do not rely on executable bits. If `${CLAUDE_SKILL_DIR}`
shows up literally, find the folder that holds this `SKILL.md` and use that.

## Steps

1. Run `$INIT show` to see the current setting (it may be unset: the built-in default is `http://127.0.0.1:8080`,
   what `make run` listens on).
2. Get the URL. If the user passed one as the argument, use it. Otherwise ask with AskUserQuestion: "What is the
   URL of your DProcess server?", offering the current URL (or `http://127.0.0.1:8080` when unset) as the first
   option, labelled "(Recommended)", and letting them type another through "Other" (for example a different port,
   or `https://dprocess.example.com`). Accept a bare `host:port` by adding `http://`.
3. Run `$INIT set URL`. It verifies that `GET /api/v1/health` answers `ok` and only then saves.
   - If it cannot reach the server, tell the user exactly what it said and ask whether the address is wrong or
     the server is not running (`make run` starts it). Do not start a server yourself and do not save an
     address that does not answer; try again with the corrected address.
4. Run `$INIT show` once more and report the URL, where it is stored, and that the server answers. If it prints a
   note that `DPROCESS_URL` is set in the environment, say so: the variable takes precedence over the saved URL
   until the user unsets it.

Precedence, for the record: `DPROCESS_URL` environment variable, then the saved URL, then the default.
Never edit the database file or any server setting; this skill only records an address.
