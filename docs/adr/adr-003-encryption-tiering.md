# ADR 003: Encryption-at-Rest Tiering

## Status
Accepted with phased rollout.

## Decision
Secrets always live in the OS keychain, and application-level encryption for local data is treated as a first-class policy decision for regulated tiers.

## Context
The product must preserve a local-first sovereignty story while still being able to serve regulated tenants later. The shell cannot assume plaintext local storage forever.

## Options Considered
- Rely on full-disk encryption only.
- Require application-level encryption for every edition immediately.
- Introduce explicit encryption tiering and keep the storage interfaces ready.

## Consequences
- Phase 1 can implement the trust boundary without overcommitting to a storage engine choice.
- Later persistence work can add SQLCipher-compatible protection without changing the public contract.
- The product remains honest about which guarantees are baseline and which are tiered.
