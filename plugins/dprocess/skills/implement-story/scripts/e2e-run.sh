#!/bin/sh
# e2e-run.sh SCRIPT.mjs
#
# Builds the web UI and the server from the working tree, runs the server on a COPY of the development
# database (never the real one, never the user's server), and runs a browser-check script against it. Run it
# from inside the DProcess repository (the repository is found from the current directory, so this works the same
# from a plugin cache):
#   node SCRIPT.mjs <scratch-dir>
# The script imports cdp.mjs from this directory. Screenshots and the browser profile go to the scratch
# directory, which is printed at the end. Exits with the script's status.
#
# Environment: E2E_DB (database to copy, default <repo>/dprocess.db), E2E_PORT (default 18083),
# E2E_TMP (scratch directory, default a new temporary directory), E2E_ROOT (repository, default: the one
# containing the current directory).
set -u
SCRIPT=${1:?usage: e2e-run.sh SCRIPT.mjs}
ROOT=${E2E_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null)} || exit 1
[ -n "$ROOT" ] || { echo "e2e-run.sh: run it from inside the DProcess repository (or set E2E_ROOT)" >&2; exit 2; }
case "$SCRIPT" in /*) ;; *) SCRIPT="$PWD/$SCRIPT" ;; esac
TMP=${E2E_TMP:-$(mktemp -d)}
PORT=${E2E_PORT:-18083}
DB_SRC=${E2E_DB:-$ROOT/dprocess.db}
for tool in node go sqlite3 google-chrome curl; do
  command -v "$tool" >/dev/null 2>&1 || { echo "e2e-run.sh: '$tool' is required but not installed" >&2; exit 2; }
done
[ -f "$DB_SRC" ] || { echo "e2e-run.sh: no database at $DB_SRC (set E2E_DB)" >&2; exit 2; }
mkdir -p "$TMP"
cd "$ROOT" || exit 1
make web >"$TMP/build-web.log" 2>&1 || { cat "$TMP/build-web.log"; exit 1; }
go build -o "$TMP/dprocess-e2e" ./cmd/dprocess || exit 1
rm -f "$TMP/e2e-copy.db" "$TMP/e2e-copy.db-wal" "$TMP/e2e-copy.db-shm"
sqlite3 -readonly "$DB_SRC" ".backup $TMP/e2e-copy.db" || exit 1
"$TMP/dprocess-e2e" --db "$TMP/e2e-copy.db" --addr "127.0.0.1:$PORT" >"$TMP/e2e-server.log" 2>&1 &
PID=$!
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do curl -sf "http://127.0.0.1:$PORT/api/v1/health" >/dev/null && break; sleep 0.3; done
E2E_APP="http://127.0.0.1:$PORT" node "$SCRIPT" "$TMP"
STATUS=$?
kill "$PID" 2>/dev/null
echo "e2e exit=$STATUS (ran against a copy of the database; scratch dir: $TMP)"
exit $STATUS
