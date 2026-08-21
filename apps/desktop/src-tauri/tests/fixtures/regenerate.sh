#!/usr/bin/env bash
# Regenerate SQLite fixture databases used by tests/fixture_migration.rs.
#
# Two workflows:
#
# 1. Synthetic historical fixture (use now, before the first tagged release):
#      cargo run -p conduit-desktop --bin generate-migration-fixture
#    Writes tests/fixtures/db/0001_initial_schema.sqlite — a DB at migration
#    0001 only, used to prove 0004+ migrations apply forward cleanly.
#
# 2. Release-tag fixture (use at each public schema release):
#      a. git checkout <release-tag>
#      b. cargo build -p conduit-desktop
#      c. Open an empty SQLite DB, run migrations once, quit.
#      d. Copy conduit.sqlite to tests/fixtures/db/<release-tag>.sqlite
#      e. git add -f tests/fixtures/db/<release-tag>.sqlite && git commit
#
# See tests/fixtures/db/README.md for fixture inventory and naming rules.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"

echo "Regenerating synthetic 0001 fixture..."
cargo run -p conduit-desktop --bin generate-migration-fixture
echo "Done. Commit tests/fixtures/db/0001_initial_schema.sqlite if it changed."
