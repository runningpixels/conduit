#!/usr/bin/env bash
# launch-smoke.sh <path/to/Conduit.app>: start a built macOS app and fail if it
# exits or panics within the first 20 seconds. Nothing else ever launches a
# macOS build, and a crash at launch on every Mac (issue #301) shipped for five
# weeks. A panic during setup aborts within a second; a healthy app stays up.
set -u
app="${1:?usage: launch-smoke.sh <path/to/App.app>}"
bin="$app/Contents/MacOS/$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app/Contents/Info.plist")"
log="$(mktemp)"
RUST_BACKTRACE=1 "$bin" >"$log" 2>&1 &
pid=$!
for _ in $(seq 20); do
  sleep 1
  kill -0 "$pid" 2>/dev/null || break
done
if ! kill -0 "$pid" 2>/dev/null; then
  wait "$pid"
  echo "::error::$app exited with status $? within 20 s of launch"
  cat "$log"
  exit 1
fi
kill "$pid"
wait "$pid" 2>/dev/null
if grep -q 'panicked at' "$log"; then
  echo "::error::$app panicked while starting"
  cat "$log"
  exit 1
fi
echo "$app stayed up for 20 s"
tail -n 20 "$log"
