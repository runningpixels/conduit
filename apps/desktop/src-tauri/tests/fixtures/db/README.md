# SQLite migration fixtures

Binary SQLite databases used by `tests/fixture_migration.rs` to prove that
older on-disk schemas migrate forward cleanly through the current migration
runner.

## Fixtures

| File | Schema level | Purpose |
|------|--------------|---------|
| `0001_initial_schema.sqlite` | Migration `0001` applied | Exercises forward migration to `0004` (encryption key-version columns) |

Each fixture is an empty database that has already applied the named migration
and has `schema_migrations` mirrored from `_sqlx_migrations`.

## Regenerating the synthetic `0001` fixture

From the repo root:

```bash
cargo run -p conduit-desktop --bin generate-migration-fixture
```

This writes `0001_initial_schema.sqlite` using the same SQL as
`migrations/0001_initial_schema.sql` and stamps migration version `1` with the
checksum sqlx expects, so `db::run_migrations()` can apply later migrations
without checksum mismatch.

## Release-tag fixtures (future)

When a public build ships with a new schema version, capture a fixture at that
release boundary using `regenerate.sh` and commit it here as
`<release-tag>.sqlite`. See `../regenerate.sh` for the release workflow.
