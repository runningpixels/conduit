# ADR 009: File-Backed Credential Store

## Status
Accepted. Amends [ADR 004](adr-004-key-provisioning.md), which assumed the OS
keychain is always available.

## Decision
Add a second credential backend, selected by `AppSettings.keychain_mode`:

- **`os`** (default) — the platform keychain, unchanged from ADR 004.
- **`file`** — an AES-256-GCM blob under the app data directory, whose key is
  read from the `CONDUIT_CREDENTIAL_KEY` environment variable.

The file backend never derives, generates, or persists its own key.

## Context
ADR 004 stores every provider secret in the OS keychain and hands the renderer
only opaque references. That holds wherever a keychain exists, and it is the
right default. It does not hold everywhere:

- headless CI, where no Secret Service or login session is running;
- a container with no D-Bus;
- a Linux install with no keyring daemon.

On those machines the app cannot store a key at all, so it cannot be used. The
V9 design spec (§2.6) renders a "Keychain mode" row for exactly this, and the
existing `EncryptionInitError::KeyUnavailable` path already anticipates the
keychain being absent for the database's master key.

## Options Considered

**1. Keep keychain-only.** Simplest and safest, but leaves the product unusable
on the machines above, which is the problem.

**2. File store with a key file beside it.** The obvious ergonomic choice, and
rejected. A key stored next to the ciphertext it protects defends against
nothing an attacker who can read one cannot also do to the other. It would let
the Privacy page claim "File (encrypted)" while providing approximately the
protection of base64. Encryption whose key travels with the data is
obfuscation, and labelling it otherwise misinforms the person deciding whether
to switch.

**3. File store with a passphrase prompt.** Honest, and better than (2), but it
needs an interactive prompt on every launch — which defeats the headless case
that motivates the feature. Worth revisiting for a desktop user who wants it;
not the mechanism for CI.

**4. File store keyed from the environment.** Chosen. The key lives wherever
the operator already keeps secrets — a CI secret store, a systemd credential, a
password manager exporting into the shell — and never on disk next to the blob.
It costs the user a variable, and it is the only option in this list that both
works headless and describes itself accurately.

## Consequences

- **No silent downgrade.** If `file` is selected and the variable is missing or
  malformed, every credential operation fails with an error naming the variable.
  It never falls back to the keychain: that would place a secret somewhere the
  user did not choose, which is the failure mode this decision exists to avoid.
  This mirrors the non-silent-downgrade policy ADR 003 established for
  encryption tiering.

- **A wrong key reports a mismatch, not an empty store.** Decrypt failure is
  surfaced as "the key differs from the one these secrets were saved with"
  rather than "no secret found". The latter invites the user to re-enter and
  overwrite a store they still hold the real key for.

- **Switching modes does not migrate.** Re-encrypting a secret into a different
  store is a decision about where that secret lives, and a settings dropdown is
  not consent for it. After a switch the new backend reports no secret and the
  key is re-entered. This is a deliberate ergonomic cost.

- **The reference names the backend.** `credential_ref` is `keychain://…` or
  `file://…`, never both-looking. The status line and Providers page are the
  only places the weaker posture is visible, so they must not blur it.

- **It is weaker, and the UI says so.** The Privacy row does not present two
  equal options; it recommends the keychain and states what the file store
  trades away.

- **Not a secrets-management system.** This is an escape hatch for machines
  without a keychain. Key rotation, per-secret keys and audit are out of scope;
  an operator who needs those should be injecting provider keys from their own
  secret manager at run time.
