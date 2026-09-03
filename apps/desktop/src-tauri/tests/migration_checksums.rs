//! Guard: a migration that has already shipped must never change again.
//!
//! sqlx records a SHA-384 of each migration file in `_sqlx_migrations` and
//! refuses to run when the file on disk no longer matches:
//!
//! ```text
//! migration failed: migration 1 was previously applied but has been modified
//! ```
//!
//! It has happened here. `0001_initial_schema.sql` has carried three different
//! checksums — commit `c49e337`, commit `faa3e2f`, and an uncommitted local
//! edit — and every difference was inside a SQL *comment*. Databases on disk
//! carry all three. Each change sent existing stores down the recovery path on
//! the next launch: backed up to `conduit.sqlite.corrupt-<unix>.bak`, replaced
//! by an empty one. No build error, no failing test, just the user's data gone.
//!
//! `repair_checksum_drift` now catches that case at runtime by comparing the
//! live schema against a freshly-migrated reference and re-stamping when they
//! agree, so a repeat is survivable. This test is the layer in front of it:
//! drift should not reach a user's machine in the first place, and the repair
//! cannot help someone whose SQL genuinely changed.
//!
//! It pins the checksum of every released migration, so a change fails here —
//! including a comment, a trailing newline, or a line ending.
//!
//! **When this fails, the fix is almost never to update the constant.** Revert
//! the edit and add a new numbered migration instead; forward-only is the whole
//! contract. Update a pinned value only for a migration that has never left
//! your machine, and then say so in the commit message.

use conduit_desktop::db::migrations::MIGRATOR;

/// `(version, sha-384 hex, description)` for every migration that has shipped.
/// Append a row when you add a migration; never edit an existing one.
const PINNED: &[(i64, &str, &str)] = &[
    (
        1,
        "da1f756a80b0573b9ccf1366424f39d18c04213b102716b5f663708d8f3dc3277b0584af86eaa2875c0889f70c91c083",
        "initial schema",
    ),
    (
        4,
        "881b465851f2a84e2e20650807ef727c13a068d29a99280e97de720842b06e5ffea922f2e21bc40a5b6272bd40958a53",
        "encryption key version",
    ),
    (
        5,
        "2cbc2e3108f28058184511b6d10425402c558de278000587584067dd93fb5fbd42c193780337d18b542883acfda38866",
        "artifacts single payload",
    ),
    (
        6,
        "346c657a9985d514e88400341732dffb79fe1f613c0736d2c22e64d819373b47b56b5c7ef049717e6d75c92368248408",
        "fts search",
    ),
    (
        7,
        "0ccf1995653e4031491890cfd49aac685e158bc237f2097ca8aa940a6eecadf00cca27a69a8daa4a0d2b52e594ac25cc",
        "prompts",
    ),
    (
        8,
        "c7489037ec6ab34702f4670f0604554af6550b64cb29a2aeabfbebaa0ef32e19a9159d89531fbd6a7f3f65e835f6194c",
        "usage",
    ),
    (
        9,
        "139ee988e9c6fa36a3521a90ddcd97cfcb9ba66c388730893cfb953b28d71df84dcad7da94d334587bb87e1fb1934986",
        "retry fork",
    ),
    (
        10,
        "f5134f6de540297df0738b86187f825370286c2f26ed1861e0913d692d28d64d9afa7b75324d89c086a60840bc1ab5aa",
        "workspace root",
    ),
    (
        11,
        "efd9d106e57d7a7121a5ab0e77645def9e304b16878467fac57b8c91c9098008534d31046b5e0fbcb17aa737c5a23660",
        "conversation chat settings",
    ),
    (
        12,
        "6bbb6f2dc887321b0e0875e6f8d1bd39bd287b0ea377d2c4cc0b1d3b11769572325d078691ff1b8b65166f7917b29483",
        "conversation organization",
    ),
    (
        13,
        "351870e76f9761798e784dc0386fa49062579948d1b2ed6c94e4945be3b73b076417f7c8f3686f2f3e43a8d6460f5eb5",
        "tool approval memory",
    ),
];

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[test]
fn shipped_migrations_are_byte_stable() {
    for (version, expected, description) in PINNED {
        let migration = MIGRATOR
            .iter()
            .find(|m| m.version == *version)
            .unwrap_or_else(|| {
                panic!(
                    "migration {version} ({description}) has been deleted. Migrations are \
                     forward-only: a database that already applied it has no way back."
                )
            });

        let actual = hex(&migration.checksum);
        assert_eq!(
            &actual, expected,
            "\n\nmigration {version} ({description}) changed.\n\n\
             Every existing database recorded the old checksum, so sqlx will refuse to \
             migrate them on the next launch. `repair_checksum_drift` will rescue the stores \
             whose schema still matches, but any store it cannot vouch for gets backed up to \
             `conduit.sqlite.corrupt-<unix>.bak` and replaced by an empty one.\n\n\
             Revert the edit and put the change in a new numbered migration. Whitespace, line \
             endings, and comments all count — the hash covers the whole file.\n\n\
             If this migration has genuinely never left your machine, update the pinned value \
             above and note it in the commit message.\n"
        );
    }
}

#[test]
fn every_migration_is_pinned() {
    for migration in MIGRATOR.iter() {
        assert!(
            PINNED.iter().any(|(v, _, _)| *v == migration.version),
            "\n\nmigration {} ({}) is not pinned in `PINNED`.\n\n\
             Add it, with the checksum printed by this failure:\n    ({}, \"{}\", \"{}\"),\n\n\
             Unpinned migrations can be edited after release without anything noticing, and \
             the cost of that is every user's local data.\n",
            migration.version,
            migration.description,
            migration.version,
            hex(&migration.checksum),
            migration.description,
        );
    }
}
